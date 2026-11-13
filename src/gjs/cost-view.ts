import { chromeText } from "./native-i18n.js";
import { Gtk } from "./gi.js";
import { clear, column, label } from "./ui.js";

interface CostPresentation {
  scope?: string;
  tracked_amount?: number | null;
  has_rows?: boolean;
  has_unpriced?: boolean;
  tracked_final?: boolean;
  accounting_open?: boolean;
}

interface CostCustody {
  status?: string;
  open_run_ids?: string[];
  unrecorded_run_ids?: string[];
  pending_invocation_ids?: string[];
}

export interface TaskCost {
  cost_presentation?: CostPresentation | null;
  cost_accounting_status?: string;
  cost_accounting_error?: string;
  cost_custody?: CostCustody | null;
  accounted_upper_bound_usd?: number | null;
  accounted_upper_bound_usd_with_children?: number | null;
  cost_final?: boolean;
  cost_with_children_partial?: boolean;
  ledger_integrity_degraded?: boolean | null;
  reserved_usd?: number | null;
  unresolved_upper_bound_usd?: number | null;
  unknown_unmetered?: number | null;
  non_final_rows?: number | null;
}

interface TaskCostSlice {
  key?: string;
  cost_presentation?: CostPresentation | null;
  model_calls?: number;
  sessions?: number;
  tokens?: number | null;
}

export interface TaskCostBreakdown {
  authority?: string;
  own_usd?: number | null;
  children_usd?: number | null;
  unattributed_usd?: number;
  delegated_disclosed_usd?: number;
  accounted_upper_bound_usd?: number | null;
  subscription_sessions?: number;
  unknown_unmetered?: number;
  non_final_rows?: number;
  cost_final?: boolean;
  cost_custody?: CostCustody | null;
  by_purpose?: TaskCostSlice[];
  by_route?: TaskCostSlice[];
}

type Document = Record<string, unknown>;
type Fact = [string, unknown];
const purposes: Record<string, string> = {
  task: "Основная работа", subagent: "Помощники", multi_model_review_review: "Ревью кода", advisory_review: "Предварительное ревью",
};

function record(value: unknown): Document {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Document : {};
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function usd(value: unknown): string {
  const amount = number(value);
  if (amount === undefined) return "неизвестно";
  if (amount > 0 && amount < 0.000001) return `${amount.toExponential()} USD`;
  return `${amount.toLocaleString("ru", { maximumFractionDigits: 6 })} USD`;
}

function facts(target: any, values: Fact[]): void {
  const lines = values.flatMap(([title, value]) => {
    if (typeof value === "number" && Number.isFinite(value)) return [`${title} · ${value.toLocaleString("ru")}`];
    if (typeof value === "string" && value) return [`${title} · ${value}`];
    return [];
  });
  if (!lines.length) return;
  const widget = label(lines.join("\n"));
  widget.set_selectable(true);
  target.append(widget);
}

function basicTaskCostSummary(task: TaskCost, live = false): string {
  if (task.cost_accounting_status === "unavailable") return "Учёт недоступен";
  const scope = task.cost_presentation;
  const legacy = task.accounted_upper_bound_usd_with_children === undefined
    ? task.accounted_upper_bound_usd : task.accounted_upper_bound_usd_with_children;
  const amount = number(scope ? scope.has_rows === true ? scope.tracked_amount : undefined : legacy);
  const final = scope ? scope.tracked_final === true : task.cost_final === true && task.cost_with_children_partial !== true;
  const pending = scope ? scope.accounting_open === true
    : task.cost_final === false || task.cost_with_children_partial === true || task.cost_accounting_status === "available";
  if (scope === undefined && amount === 0 && (number(task.unknown_unmetered) ?? 0) > 0) {
    if (task.ledger_integrity_degraded === true || task.cost_custody?.status === "unavailable") return "Неизвестно";
    return (number(task.non_final_rows) ?? 0) > (task.unknown_unmetered ?? 0) ? "Учёт ещё открыт" : "Цена не установлена";
  }
  if (scope === null || amount === undefined || (amount === 0 && !scope && !final && !pending)) {
    if (scope === null || task.ledger_integrity_degraded === true || task.cost_custody?.status === "unavailable") return "Неизвестно";
    if (pending && scope && (scope.has_rows || scope.has_unpriced)) return "Учёт ещё открыт";
    return scope?.has_rows && scope.has_unpriced ? "Цена не установлена" : "Неизвестно";
  }
  return `${scope?.has_unpriced ? "Только учтённая часть · " : ""}${final ? "" : "до "}${usd(amount)}`
    + (live || scope?.accounting_open ? " на текущий момент" : "");
}

function integrityNotice(task: TaskCost): string | undefined {
  const marker = task.ledger_integrity_degraded;
  if (marker === undefined || marker === false) return;
  if (marker === true) return chromeText("Ledger integrity is degraded; recorded amounts may be incomplete.", undefined,
    "Целостность журнала нарушена; учтённые суммы могут быть неполными.");
  if (marker === null) return chromeText("Ledger integrity is unavailable.", undefined, "Целостность журнала неизвестна.");
  return chromeText("Ledger integrity status could not be read.", undefined, "Состояние целостности журнала прочитать не удалось.");
}

export function taskCostSummary(task: TaskCost, live = false): string {
  return [basicTaskCostSummary(task, live), integrityNotice(task)].filter(Boolean).join(" · ");
}

function accountingDetails(target: any, task: TaskCost): boolean {
  const notice = integrityNotice(task);
  if (notice) target.append(label(notice, "warning"));
  const hasMoney = task.reserved_usd !== undefined || task.unresolved_upper_bound_usd !== undefined;
  if (!hasMoney) return Boolean(notice);
  const scope = task.cost_presentation?.scope;
  const scopeText = scope === "own" ? chromeText("This task", undefined, "Эта задача")
    : scope === "root_tree" ? chromeText("Task tree", undefined, "Дерево задачи")
    : chromeText("Scope not stated by the gateway", undefined, "Область не указана шлюзом");
  target.append(label(chromeText("Reservation and unresolved charge scope · {scope}", { scope: scopeText }, `Область резерва и неразрешённых расходов · ${scopeText}`), "dim-label"));
  for (const [key, english, russian] of [
    ["reserved_usd", "Reserved for calls not yet sent · {amount}", "Зарезервировано для ещё не отправленных вызовов"],
    ["unresolved_upper_bound_usd", "Upper bound for calls without a known price · {amount}", "Верхняя граница вызовов без известной цены"],
  ] as const) {
    if (task[key] !== undefined) {
      const amount = usd(task.cost_accounting_status === "unavailable" ? null : task[key]);
      const item = label(chromeText(english, { amount }, `${russian} · ${amount}`));
      item.set_selectable(true);target.append(item);
    }
  }
  return true;
}

function custodyFacts(target: any, custody?: CostCustody | null): void {
  if (!custody) return;
  const ids = (value?: string[]) => Array.isArray(value) ? value.filter((id) => typeof id === "string" && id).join(", ") : undefined;
  facts(target, [
    ["Покрытие делегированных запусков", custody.status === "unavailable" ? "Неизвестно" : undefined],
    ["Открытые запуски", ids(custody.open_run_ids)], ["Запуски без записи учёта", ids(custody.unrecorded_run_ids)],
    ["Ожидают запуска", ids(custody.pending_invocation_ids)],
  ]);
}

function slices(target: any, title: string, rows: TaskCostSlice[] | undefined, word: (key: string) => string): void {
  if (!Array.isArray(rows) || !rows.length) return;
  target.append(label(title, "heading"));
  for (const slice of rows) {
    if (!slice || typeof slice !== "object") continue;
    facts(target, [
      [word(slice.key || ""), taskCostSummary({ cost_presentation: slice.cost_presentation })],
      ["Вызовы модели", slice.model_calls], ["Сессии", slice.sessions], ["Токены", number(slice.tokens)],
    ]);
  }
}

export function renderTaskCost(target: any, task?: TaskCost & { cost_breakdown?: TaskCostBreakdown | null }): boolean {
  clear(target);
  if (!task) return false;
  const hasAccountingDetails = accountingDetails(target, task);
  const view = task.cost_breakdown;
  const hasBreakdown = view?.authority === "physical_attempt_ledger";
  const hasSummary = task.cost_presentation !== undefined || task.cost_accounting_status !== undefined
    || task.accounted_upper_bound_usd !== undefined || task.accounted_upper_bound_usd_with_children !== undefined;
  if (hasSummary) {
    const own = task.cost_presentation?.scope === "own";
    const tree = task.cost_presentation?.scope === "root_tree"
      || (task.cost_presentation === undefined && task.accounted_upper_bound_usd_with_children !== undefined);
    facts(target, [[own ? "Собственные расходы" : tree ? "Расходы с подзадачами" : "Расходы", basicTaskCostSummary(task)],
      ["Ошибка учёта", task.cost_accounting_error]]);
    if (!hasBreakdown) {
      facts(target, [["Вызовы без цены", task.unknown_unmetered], ["Записи без окончательной суммы", task.non_final_rows]]);
      custodyFacts(target, task.cost_custody);
    }
  }
  if (!hasBreakdown) return hasSummary || hasAccountingDetails;
  const subtotal = number(view.accounted_upper_bound_usd);
  const tracked = (view.unknown_unmetered ?? 0) > 0 ? "Только учтённая часть · " : "";
  facts(target, [
    ["Учтено по дереву задачи", subtotal === undefined ? usd(null) : tracked + (view.cost_final === true ? "" : "до ") + usd(subtotal)],
    ["Доля основной задачи", usd(view.own_usd)], ["Доля подзадач", usd(view.children_usd)],
    ["Известная сумма без привязки к задаче", usd(view.unattributed_usd)],
    ["Известные расходы делегированных сессий", usd(view.delegated_disclosed_usd)], ["Сессии по подписке", view.subscription_sessions],
    ["Вызовы без цены", view.unknown_unmetered], ["Записи без окончательной суммы", view.non_final_rows],
  ]);
  custodyFacts(target, view.cost_custody);
  slices(target, "По назначению", view.by_purpose, (key) => purposes[key] ?? (key || "Без назначения"));
  slices(target, "По маршрутам", view.by_route, (key) => key || "Без маршрута");
  return true;
}

function bucketOpen(bucket: Document): boolean {
  const explicit = number(bucket.accounting_open_rows);
  if (explicit !== undefined) return explicit > 0;
  const nonFinal = number(bucket.non_final_rows);
  return nonFinal !== undefined && nonFinal > (number(bucket.unknown_unmetered) ?? 0);
}

function bucketAmount(bucket: Document): string {
  const raw = bucket.cost === undefined ? bucket.settled_usd : bucket.cost;
  const amount = number(raw);
  if (amount === undefined) return usd(null);
  const unpriced = (number(bucket.unknown_unmetered) ?? 0) > 0;
  const open = bucketOpen(bucket);
  if (amount === 0 && (unpriced || open)) return open ? "Учёт ещё открыт" : "Цена не установлена";
  return `${unpriced ? "Только учтённая часть · " : ""}${usd(amount)}${open ? " · учёт ещё открыт" : ""}`;
}

function cacheFacts(value: unknown): Fact[] {
  return Object.entries(record(value)).map(([ttl, count]) => [`Срок записи в кэш · ${ttl}`, count]);
}

export function renderCostDashboard(target: any, result: Document): string {
  clear(target);
  const ledger = record(result.accounting);
  const known = number(ledger.settled_usd === undefined ? result.total_cost : ledger.settled_usd);
  if (ledger.available === false || known === undefined) return "Учёт расходов недоступен.";
  const limit = number(ledger.limit_usd);
  facts(target, [
    ["Известные расходы", usd(known)],
    ["Общий лимит", limit === undefined ? undefined : limit > 0 ? usd(limit) : "Не установлен"],
    ["Остаток по известным расходам", limit === 0 ? undefined : ledger.remaining_known_usd === undefined
      ? undefined : usd(ledger.remaining_known_usd)],
  ]);
  if (limit !== undefined && limit > 0 && known >= limit) target.append(label("Достигнут лимит известных расходов.", "warning"));
  facts(target, [
    ["Подтверждено", usd(ledger.confirmed_usd)], ["Оценено", usd(ledger.estimated_usd)], ["Зарезервировано", usd(ledger.reserved_usd)],
    ["Верхняя граница неразрешённых расходов", usd(ledger.unresolved_upper_bound_usd)],
    ["Учтённая верхняя граница", ledger.accounted_usd === undefined ? undefined : usd(ledger.accounted_usd)],
    ["Вызовы без цены", ledger.unknown_unmetered], ["Открытые записи", ledger.accounting_open_rows],
    ["Записи без окончательной суммы", ledger.non_final_rows], ["Вызовы", result.total_calls],
    ["Входные токены", result.total_prompt_tokens], ["Выходные токены", result.total_completion_tokens],
    ["Из кэша", result.total_cached_tokens], ["Записано в кэш", result.total_cache_write_tokens], ...cacheFacts(result.prompt_cache_ttls),
  ]);
  const attempts = Object.entries(record(ledger.attempt_counts));
  if (attempts.length) {
    const body = column(4);
    facts(body, attempts);
    target.append(new Gtk.Expander({ label: "Попытки по состояниям", child: body }));
  }
  for (const [title, key] of [
    ["По моделям", "by_model"], ["По провайдерам", "by_api_key"],
    ["По ролям моделей", "by_model_category"], ["По категориям задач", "by_task_category"], ["Без привязки", "unattributed"],
  ]) {
    const groups = Object.entries(record(result[key]));
    if (!groups.length) continue;
    const body = column();
    for (const [id, value] of groups) {
      const bucket = record(value);
      facts(body, [[id === "unattributed" ? "Без привязки" : id, bucketAmount(bucket)], ["Вызовы", bucket.calls ?? bucket.physical_calls],
        ["Вызовы без цены", bucket.unknown_unmetered], ["Открытые записи", bucket.accounting_open_rows],
        ["Входные токены", bucket.prompt_tokens], ["Выходные токены", bucket.completion_tokens],
        ["Из кэша", bucket.cached_tokens], ["Записано в кэш", bucket.cache_write_tokens], ...cacheFacts(bucket.prompt_cache_ttls)]);
    }
    target.append(new Gtk.Expander({ label: title, child: body }));
  }
  if (ledger.cost_final !== false) return "Сведения из учёта шлюза.";
  if (ledger.accounting_open_rows === 0) return (number(ledger.unknown_unmetered) ?? 0) > 0
    ? "Часть расходов без цены." : "Учёт содержит неокончательные суммы.";
  return "Учёт ещё не завершён.";
}
