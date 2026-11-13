import { accountsPath } from "./accounts-quota.js";
import { type Gateway } from "./gateway.js";
import { Adw, Gio, Gtk } from "./gi.js";
import { type Present } from "./mcp-server.js";
import { object, type SettingsDocument } from "./settings-write.js";
import { button, clear, column, errorText, label, sheet } from "./ui.js";
import { exactWorkTarget } from "./work-actions.js";

function readHistory(raw: unknown): Map<string, SettingsDocument> {
  const record = (v: unknown): v is SettingsDocument => object(v) === v;
  const strings = (v: SettingsDocument, keys: string[]) => keys.every(key => v[key] == null || typeof v[key] === "string");
  const route = (v: unknown) => v == null || record(v) && strings(v, ["source", "model", "credentialProfileId"]);
  const receipt = (v: unknown): v is SettingsDocument => record(v)
    && strings(v, ["selected_subagent_id", "route", "requested_model", "requested_profile", "applied_model", "applied_profile",
      "run_id", "outcome", "failure_code", "reset_at", "occurred_at", "observed_at", "ts", "task_id", "invocation_id", "attempt_id"])
    && (v.identity == null || record(v.identity) && strings(v.identity, ["kind", "target_id", "credential_profile_id", "effort", "processing_preference", "access"]))
    && route(v.observed_route)
    && (v.fallback == null || record(v.fallback) && strings(v.fallback, ["model", "applied_model", "applied_profile", "llm_call_id", "ts"]) && route(v.fallback.observed_route));
  if (!record(raw) || !Object.hasOwn(raw, "subagent_last_delegation")) throw new Error("Шлюз не вернул сведения о выполнениях.");
  const history = raw.subagent_last_delegation;
  if (!receipt(history) || (history.latest_by_subagent !== undefined && !record(history.latest_by_subagent))) {
    throw new Error("Шлюз не вернул пригодную историю выполнений.");
  }
  const records = new Map<string, SettingsDocument>();
  for (const [id, value] of Object.entries(object(history.latest_by_subagent))) {
    if (!id || !receipt(value) || value.selected_subagent_id !== id) throw new Error("Шлюз вернул запись выполнения другой строки или неполные сведения.");
    records.set(id, value);
  }
  const { latest_by_subagent: _, ...legacy } = history;
  if (["selected_subagent_id", "run_id", "requested_model", "route", "outcome", "identity"].some(key => Object.hasOwn(legacy, key))) {
    const id = typeof legacy.selected_subagent_id === "string" ? legacy.selected_subagent_id : "";
    if (!records.has(id)) records.set(id, legacy);
  }
  return records;
}

function recordedTarget(value: SettingsDocument): string {
  const identity = object(value.identity);
  if (typeof identity.target_id === "string" && identity.target_id) return identity.target_id;
  const route = typeof value.route === "string" ? value.route : "";
  const model = typeof value.requested_model === "string" ? value.requested_model : "";
  return route === "api_model" ? model : route + (route && model ? `=${model}` : "");
}

const outcomes: Record<string, string> = {
  succeeded: "успешно", completed: "завершено", failed: "ошибка", not_started: "запуск не состоялся",
  unknown: "исход неизвестен", cancelled: "отменено", interrupted: "прервано",
};

function line(body: any, title: string, value: unknown): void {
  if (typeof value !== "string" || !value) return;
  const field = label(`${title} · ${value}`);
  field.set_selectable(true);
  body.append(field);
}

function recordedSettings(receipt: SettingsDocument, current: SettingsDocument | undefined, inherited: unknown): string {
  if (!current) return receipt.selected_subagent_id ? "Этой строки больше нет в текущем составе."
    : "Шлюз не указал, к какой строке относится этот запуск.";
  const route = object(current.route);
  const identity = object(receipt.identity);
  const expected: SettingsDocument = {
    kind: route.kind, target_id: route.target_id, credential_profile_id: route.credential_profile_id || "",
    effort: current.effort || "", processing_preference: current.processing_preference || inherited || "",
  };
  if (route.kind === "agent_session") expected.access = current.access || "full";
  const keys = Object.keys(expected);
  if (keys.some(key => typeof identity[key] !== "string" || typeof expected[key] !== "string")) {
    return "Запись содержит неполные сведения для сверки с текущим маршрутом.";
  }
  return keys.every(key => identity[key] === expected[key])
    ? "Маршрут совпадает с текущими параметрами строки." : "Запуск относится к прежним параметрам строки.";
}

function execution(body: any, value: SettingsDocument, current: SettingsDocument | undefined,
  inherited: unknown, openTask?: (id: string) => void): void {
  body.append(label(recordedSettings(value, current, inherited), "dim-label"));
  const identity = object(value.identity);
  const fallback = object(value.fallback);
  if (typeof value.outcome === "string" && value.outcome) {
    line(body, "Исход запуска", Object.hasOwn(outcomes, value.outcome) ? outcomes[value.outcome] : value.outcome);
  } else body.append(label("Шлюз не сообщил исход запуска.", "dim-label"));
  line(body, "Причина", value.failure_code);
  line(body, "Сброс ограничения", value.reset_at);
  line(body, "Время выполнения", value.occurred_at);
  line(body, "Наблюдение записано", value.observed_at || value.ts);
  if (Object.hasOwn(value, "occurred_at") && !value.occurred_at) body.append(label("Время выполнения не указано.", "dim-label"));
  line(body, "Строка каталога", value.selected_subagent_id);
  line(body, "Запрошенный маршрут", recordedTarget(value));
  line(body, "Запрошенная модель", value.requested_model);
  line(body, "Запрошенный аккаунт", typeof value.requested_profile === "string" ? value.requested_profile || "Auto" : undefined);
  line(body, "Запрошенные права", identity.access);
  line(body, "Запрошенное усилие", typeof identity.effort === "string" ? identity.effort || "Auto" : undefined);
  line(body, "Запрошенная обработка", typeof identity.processing_preference === "string" ? identity.processing_preference || "Не задана" : undefined);
  line(body, "Фактическая модель", value.applied_model || "шлюз не сообщил");
  line(body, "Фактический аккаунт", value.applied_profile);
  const observed = object(value.observed_route);
  line(body, "Наблюдаемый источник попытки", observed.source);
  line(body, "Наблюдаемая модель попытки", observed.model);
  line(body, "Наблюдаемый аккаунт попытки", observed.credentialProfileId);
  if (Object.keys(observed).length) {
    const raw = label(JSON.stringify(observed, null, 2)); raw.set_selectable(true);
    body.append(new Gtk.Expander({ label: "Наблюдаемый маршрут попытки", child: raw }));
  }
  line(body, "Запрошенная резервная модель", fallback.model);
  line(body, "Фактическая резервная модель", fallback.applied_model);
  line(body, "Аккаунт резервной модели", fallback.applied_profile);
  line(body, "Вызов резервной модели", fallback.llm_call_id);
  line(body, "Время резервной попытки", fallback.ts);
  const fallbackObserved = object(fallback.observed_route);
  line(body, "Наблюдаемый источник резерва", fallbackObserved.source);
  line(body, "Наблюдаемая модель резерва", fallbackObserved.model);
  line(body, "Наблюдаемый аккаунт резерва", fallbackObserved.credentialProfileId);
  if (Object.keys(fallbackObserved).length) {
    const raw = label(JSON.stringify(fallbackObserved, null, 2)); raw.set_selectable(true);
    body.append(new Gtk.Expander({ label: "Наблюдаемый маршрут резерва", child: raw }));
  }
  line(body, "Запуск", value.run_id);
  line(body, "Вызов", value.invocation_id);
  line(body, "Попытка", value.attempt_id);
  line(body, "Задача", value.task_id);
  const task = value.task_id;
  if (openTask && exactWorkTarget(task)) body.append(button("Открыть задачу выполнения", () => openTask(task)));
  const raw = label(JSON.stringify(value, null, 2));
  raw.set_selectable(true);
  body.append(new Gtk.Expander({ label: "Запись JSON", child: raw }));
}

export function showSubagentExecutions(gateway: Gateway, parent: any, present: Present, rows: SettingsDocument[],
  inherited: unknown, openTask?: (id: string) => void): void {
  const content = column();
  const dialog = sheet("Выполнения субагентов", content);
  const status = label("");
  const body = column();
  const select = Gtk.DropDown.new_from_strings([]);
  const captured: SettingsDocument[] = rows.map(row => ({ ...row, route: { ...object(row.route) } }));
  const current = new Map(captured.filter(row => typeof row.subagent_id === "string").map(row => [row.subagent_id as string, row]));
  let records = new Map<string, SettingsDocument>();
  let ids: string[] = [];
  let open = true, loading = false, confirmed = false, generation = 0, parentSignal = 0;
  let pending: any;
  const dispose = () => {
    if (!open) return;
    open = false; ++generation;
    pending?.cancel(); pending = undefined;
    if (parentSignal) { parent.disconnect(parentSignal); parentSignal = 0; }
    content.remove(select); select.run_dispose();
  };
  dialog.connect("closed", dispose);
  if (parent instanceof Adw.Dialog || parent instanceof Gtk.Window) parentSignal = parent.connect(
    parent instanceof Gtk.Window ? "close-request" : "closed", () => { if (open) { dispose(); dialog.force_close(); } return false; });
  const render = () => {
    if (!open || loading) return;
    const version = ++generation;
    clear(body);
    const id = ids[select.get_selected()];
    const receipt = records.get(id);
    const navigate = openTask ? (task: string) => { if (open && version === generation) openTask(task); } : undefined;
    if (receipt) execution(body, receipt, current.get(id), inherited, navigate);
    else if (id !== undefined) body.append(label("Для этого субагента шлюз не вернул запись выполнения."));
  };
  const reload = button("Перечитать", () => void load());
  const load = async () => {
    if (loading || !open) return;
    loading = true;
    const cancel = pending = new Gio.Cancellable();
    reload.set_sensitive(false);
    select.set_sensitive(false);
    const selected = ids[select.get_selected()];
    status.set_label("Читаю сохранённые выполнения…");
    try {
      const response = await gateway.json<unknown>("GET", `${accountsPath}/status`, undefined, undefined, true, cancel);
      if (!open) return;
      const next = readHistory(response);
      records = next;
      ids = [...new Set([...current.keys(), ...records.keys()])];
      const captions = ids.map(id => {
        const record = records.get(id), target = record ? recordedTarget(record) : "";
        return [id || "Старая запись без ID субагента", target].filter(Boolean).join(" · ");
      });
      const model = select.get_model();
      model.splice(0, model.get_n_items(), captions);
      select.set_selected(Math.max(0, ids.indexOf(selected)));
      confirmed = true;
      status.set_label(!records.size ? "Сохранённых выполнений нет." : "");
      loading = false;
      render();
    } catch (error) {
      if (open) status.set_label([confirmed ? "Показаны последние прочитанные выполнения." : "", errorText(error)].filter(Boolean).join(" "));
    } finally {
      if (pending === cancel) pending = undefined;
      loading = false;
      if (open) { reload.set_sensitive(true); select.set_sensitive(confirmed && Boolean(ids.length)); }
    }
  };
  select.connect("notify::selected", render);
  for (const item of [label("Здесь показаны сохранённые запуски и их параметры. Сверка использует параметры формы на момент открытия.", "dim-label"), reload, status, select, body]) content.append(item);
  present(dialog, parent);
  void load();
}
