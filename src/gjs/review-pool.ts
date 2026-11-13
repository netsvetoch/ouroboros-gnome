import { usd } from "./cost-view.js";
import { type Gateway } from "./gateway.js";
import { Adw, Gio, Gtk } from "./gi.js";
import { type Present } from "./mcp-server.js";
import { button, clear, column, errorText, label, sheet } from "./ui.js";

interface Price {
  basis?: string;
  usd_per_review?: number | null;
  reviews?: number;
  low?: number;
  high?: number;
}

interface Execution {
  ts?: string;
  surface?: string;
  status?: string;
  review_record_id?: string;
  observed_model?: string;
  requested?: { route_kind?: string; session_target?: string; model?: string; profile_id?: string; access?: string;
    effort?: string; declared_effort?: string; processing_preference?: string };
  effective?: { route?: string; model?: string; profile_id?: string; access?: string;
    verdict_method?: string; processing?: Record<string, unknown>; prompt_cache_ttl?: Record<string, unknown>;
    effort_resolution?: { submitted?: string | null; observed?: string | null; observedSource?: string | null } };
  capability_delta?: unknown[];
  cost?: { kind?: string; usd?: number | null };
}

interface Seat {
  subagent_id: string;
  handle?: string;
  route?: { kind?: string; target_id?: string; credential_profile_id?: string };
  effort?: string;
  effort_source?: string;
  delivery?: string;
  access?: string;
  processing_preference?: string;
  minted_from?: string;
  cost?: Price;
  last_execution?: Execution | null;
}

interface ReviewPool {
  limits?: { rows?: number };
  catalog?: { present?: boolean; enabled?: boolean; rows?: number; eligible?: number };
  config_error?: string;
  pool: Seat[];
  excluded: { subagent_id: string; reason?: string }[];
  last_executions?: Record<string, Execution>;
  row_costs?: Record<string, Price>;
  pool_without_credentials?: string[];
  migration?: { snapshot?: string; trigger?: string; outcome?: string; error?: string; source?: string } | null;
}

function line(target: any, title: string, value?: string | number | null): void {
  if (value == null || value === "") return;
  const widget = label(`${title} · ${value}`);
  widget.set_selectable(true);
  target.append(widget);
}

function details(target: any, title: string): any {
  const body = column(6);
  target.append(new Gtk.Expander({ label: title, child: body }));
  return body;
}

function price(target: any, value?: Price): void {
  if (value?.basis === "subscription_seat") line(target, "Стоимость ревью", "место по подписке и время работы");
  else if (value?.basis === "local_route") line(target, "Стоимость ревью", "0 USD · локальная модель");
  else if (value?.basis === "observed_reviews" && typeof value.usd_per_review === "number") {
    line(target, "Медиана стоимости ревью", usd(value.usd_per_review));
    line(target, "Измеренных ревью", value.reviews);
    if (value.low != null && value.high != null) line(target, "Диапазон стоимости", `${usd(value.low)} – ${usd(value.high)}`);
  } else line(target, "Стоимость ревью", "неизвестна");
}

function execution(parent: any, value: Execution): void {
  const target = details(parent, "Последнее выполнение");
  line(target, "Когда", value.ts);
  line(target, "Тип ревью", value.surface);
  line(target, "Состояние", value.status);
  line(target, "Запись ревью", value.review_record_id);
  if (value.cost?.kind === "subscription") line(target, "Расход этого выполнения", "место по подписке");
  else line(target, "Расход этого выполнения", usd(value.cost?.kind === "usd" ? value.cost.usd : undefined));
  const requested = value.requested;
  line(target, "Запрошенный маршрут", [requested?.route_kind, requested?.session_target || requested?.model].filter(Boolean).join(" · "));
  line(target, "Запрошенный аккаунт", requested?.profile_id);
  line(target, "Запрошенные права", requested?.access);
  line(target, "Настройка усилия строки", requested?.effort);
  line(target, "Усилие для этого вызова", requested?.declared_effort);
  line(target, "Запрошенная обработка", requested?.processing_preference);
  const effective = value.effective;
  line(target, "Выполненный маршрут", effective?.route);
  line(target, "Фактическая модель", effective?.model || value.observed_model || "шлюз не сообщил");
  line(target, "Фактический аккаунт", effective?.profile_id);
  line(target, "Фактические права", effective?.access);
  line(target, "Переданное усилие", effective?.effort_resolution?.submitted);
  line(target, "Наблюдаемое усилие", effective?.effort_resolution?.observed);
  line(target, "Источник наблюдения усилия", effective?.effort_resolution?.observedSource);
  line(target, "Способ получения вердикта", effective?.verdict_method);
  for (const [title, facts] of [["Фактическая обработка", effective?.processing],
    ["Время жизни кеша промпта", effective?.prompt_cache_ttl], ["Изменения возможностей", value.capability_delta]] as const) {
    if (!facts || !Object.keys(facts).length) continue;
    const panel = details(target, title);
    const view = new Gtk.TextView({ editable: false, monospace: true, wrap_mode: Gtk.WrapMode.WORD_CHAR });
    view.set_name("review-pool-execution-facts");
    view.get_buffer().set_text(JSON.stringify(facts, null, 2), -1);
    panel.append(new Gtk.ScrolledWindow({ child: view, min_content_height: 80, max_content_height: 220, propagate_natural_height: true }));
  }
}

function renderPool(body: any, result: ReviewPool): void {
  if (!Array.isArray(result?.pool) || !Array.isArray(result.excluded)
    || result.pool.some(seat => !seat || typeof seat.subagent_id !== "string")
    || result.excluded.some(seat => !seat || typeof seat.subagent_id !== "string")) throw new Error("Шлюз не вернул состав пула ревью.");
  const catalog = result.catalog;
  line(body, "Строк в каталоге", catalog?.rows);
  line(body, "Лимит строк", result.limits?.rows);
  line(body, "Отмечено для ревью", catalog?.eligible);
  if (result.config_error) line(body, "Ошибка конфигурации", result.config_error);
  else if (!result.pool.length) body.append(label("Пул пуст. Ревью выполняет основная модель Main."));
  else if (catalog?.enabled === false) body.append(label("Делегирование выключено. Отмеченные строки продолжают участвовать в ревью."));
  const poolIds = new Set(result.pool.map(seat => seat.subagent_id));
  for (const seat of result.pool) {
    const target = details(body, seat.handle ? `${seat.handle} · ${seat.subagent_id}` : seat.subagent_id);
    line(target, "Маршрут", seat.route?.target_id);
    line(target, "Закреплённый аккаунт", seat.route?.credential_profile_id);
    line(target, "Права сессии", seat.access);
    line(target, "Способ получения материалов", seat.delivery === "packet" ? "подготовленный пакет"
      : seat.delivery === "session" || seat.delivery === "native" ? "чтение инструментами" : seat.delivery);
    line(target, "Режим обработки", seat.processing_preference);
    line(target, "Усилие", [seat.effort, seat.effort_source === "model_name" ? "из имени модели"
      : seat.effort_source === "pin" ? "задано в каталоге" : seat.effort_source === "auto" ? "автоматическое" : seat.effort_source].filter(Boolean).join(" · "));
    line(target, "Происхождение строки", seat.minted_from);
    if (result.pool_without_credentials?.includes(seat.subagent_id)) line(body, "У модели нет учётных данных", seat.subagent_id);
    price(target, seat.cost ?? result.row_costs?.[seat.subagent_id]);
    const last = seat.last_execution ?? result.last_executions?.[seat.subagent_id];
    if (last) execution(target, last);
  }
  for (const item of result.excluded) line(body, "Исключённая строка", `${item.subagent_id} · ${item.reason === "row_disabled" ? "выключена" : item.reason || "причина неизвестна"}`);
  const otherIds = new Set([...Object.keys(result.row_costs ?? {}), ...Object.keys(result.last_executions ?? {})].filter(id => !poolIds.has(id)));
  if (otherIds.size) {
    const other = details(body, "Строки вне текущего пула");
    for (const id of otherIds) {
      other.append(label(id, "heading"));
      if (result.row_costs?.[id]) price(other, result.row_costs[id]);
      if (result.last_executions?.[id]) execution(other, result.last_executions[id]);
    }
  }
  const migration = result.migration;
  if (migration) {
    if (migration.source === "environment") body.append(label("Шлюз использует каталог из окружения."));
    if (migration.outcome === "error" && migration.source !== "history") line(body, "Ошибка миграции пула", migration.error || "причина неизвестна");
    const target = details(body, migration.source === "history" ? "История миграции пула" : "Миграция пула");
    line(target, "Исход", migration.outcome);
    line(target, "Источник", migration.source);
    line(target, "Причина запуска", migration.trigger);
    line(target, "Снимок", migration.snapshot);
    line(target, "Ошибка", migration.error);
  }
  const raw = details(body, "Полный ответ JSON");
  const text = label(JSON.stringify(result, null, 2));
  text.set_selectable(true);
  raw.append(text);
}

export function showReviewPool(gateway: Gateway, present: Present, parent: any): void {
  const content = column();
  const dialog = sheet("Пул ревью", content);
  const body = column();
  const status = label("");
  let open = true;
  let loading = false;
  let snapshot = false;
  const cancel = new Gio.Cancellable();
  const signal = parent instanceof Adw.Dialog ? parent.connect("closed", () => dialog.force_close()) : 0;
  dialog.connect("closed", () => {
    if (!open) return;
    open = false;
    cancel.cancel();
    if (signal) parent.disconnect(signal);
  });
  const reload = button("Перечитать", () => void load());
  const load = async () => {
    if (!open || loading) return;
    loading = true;
    reload.set_sensitive(false);
    status.set_label("Читаю сохранённый пул шлюза…");
    try {
      const result = await gateway.json<ReviewPool>("GET", "/api/review-pool", undefined, {}, false, cancel);
      if (!open) return;
      const next = column();
      renderPool(next, result);
      clear(body);
      body.append(next);
      snapshot = true;
      status.set_label("");
    } catch (error) {
      if (open) status.set_label((snapshot ? "Показан последний подтверждённый пул. " : "") + errorText(error));
    } finally {
      loading = false;
      if (open) reload.set_sensitive(true);
    }
  };
  for (const item of [reload, status, body]) content.append(item);
  present(dialog, parent);
  void load();
}
