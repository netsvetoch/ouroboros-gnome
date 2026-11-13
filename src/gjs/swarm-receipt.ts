import { Gtk, Pango } from "./gi.js";
import { column, label } from "./ui.js";
import { usd } from "./cost-view.js";

type Data = Record<string, unknown>;
export interface SwarmFields { metadata?: { subagents_mode?: string; parent_task_id?: string }; parent_task_id?: string;
  swarm_efficiency?: unknown; swarm_receipt?: unknown }
const record = (v: unknown): v is Data => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string => typeof v === "string" ? v : "";
const numeric = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const started = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v)
  || typeof v === "string" && !!v.trim() && Number.isFinite(Date.parse(v));

/** Saved measurements retain their scope and uncertainty; they never authorize a control action. */
export function renderSwarmReceipt(task: SwarmFields, id: string, expanded = new Map<string, boolean>()): any {
  if (task.metadata?.subagents_mode !== "swarm" || task.parent_task_id || task.metadata.parent_task_id) return;
  const body = column(5), panel = new Gtk.Expander({ label: "Отчёт о работе роя", child: body });
  const retain = (widget: any, key: string) => {
    widget.set_expanded(expanded.get(key) === true);
    widget.connect("notify::expanded", () => expanded.set(key, widget.get_expanded()));
    return widget;
  };
  retain(panel, "report");
  let malformed = false;
  const add = (target: any, caption: string, value?: unknown) => {
    if (value === undefined) return;
    if (typeof value !== "string" && typeof value !== "boolean" && !numeric(value)) { malformed = true;return; }
    const field = label(caption ? `${caption} · ${value}` : String(value));
    field.set_selectable(true);field.set_wrap_mode(Pango.WrapMode.WORD_CHAR);field.set_max_width_chars(64);target.append(field);
  };
  const group = (caption: string) => { const content = column(4);body.append(retain(new Gtk.Expander({ label: caption, child: content }), caption));return content; };
  const fields = (target: any, raw: Data, names: readonly (readonly [string, string])[]) => {
    for (const [key, caption] of names) if (raw[key] != null) add(target, caption, raw[key]);
  };
  const rows = (value: unknown): Data[] => {
    if (!Array.isArray(value)) { if (value !== undefined) malformed = true;return []; }
    if (value.some(v => !record(v))) malformed = true;
    return value.filter(record);
  };
  // Open dictionaries (account routes, wait facts and mind-authored comparison)
  // stay literal data, without converting them to status or performance claims.
  const document = (target: any, value: unknown, depth = 0) => {
    if (depth > 8) { add(target, "", "Вложенные сведения превышают глубину просмотра.");malformed = true;return; }
    if (value === null) { add(target, "", "Не указано");return; }
    if (record(value) || Array.isArray(value)) {
      for (const [key, entry] of Object.entries(value)) {
        if (entry !== null && typeof entry === "object") {
          const content = column(3);target.append(new Gtk.Expander({ label: key, child: content }));document(content, entry, depth + 1);
        } else add(target, key, entry === null ? "Не указано" : entry);
      }
    } else add(target, "", value);
  };
  const efficiency = record(task.swarm_efficiency) ? task.swarm_efficiency : {};
  if (numeric(efficiency.subagent_count) && Number.isSafeInteger(efficiency.subagent_count)) add(body, "Запрошено субагентов", efficiency.subagent_count);
  const receipt = task.swarm_receipt;
  if (!record(receipt) || receipt.root_task_id !== id) {
    add(body, "", receipt == null ? "Шлюз пока не вернул подтверждённые сведения о запусках." : "Принадлежность и структура отчёта не подтверждены.");
    return panel;
  }
  fields(body, receipt, [["state", "Состояние отчёта"], ["revision", "Ревизия отчёта"], ["published_at", "Опубликован"], ["schema_version", "Версия схемы"]]);
  const actors = rows(receipt.actor_intervals), supervisors = new Set([id, ...actors.filter(a => a.kind === "supervisor").map(a => text(a.task_id))]);
  const helpers = new Set<string>(), pending = new Set<string>();
  for (const actor of actors) {
    const child = text(actor.task_id) && !supervisors.has(text(actor.task_id));
    const key = child ? `task:${actor.task_id}` : text(actor.id);
    if (!key) continue;
    if (actor.kind === "task" && child && started(actor.start) || actor.kind === "delegated_run" && started(actor.start)) helpers.add(key);
    else if (actor.kind === "delegated_run" || actor.kind === "delegated_start") pending.add(key);
  }
  for (const key of helpers) pending.delete(key);
  if (Array.isArray(receipt.actor_intervals) && receipt.actor_intervals.every(record)) {
    add(body, "Записано запусков с подтверждённым началом", helpers.size);
  } else add(body, "", "Число подтверждённых запусков неизвестно.");
  if (pending.size) add(body, "Ожидают подтверждения", pending.size);
  const coverage = record(receipt.coverage) ? receipt.coverage : {};
  if (!Array.isArray(receipt.actor_intervals) || coverage.tree !== "complete") add(body, "", "Дерево запусков известно не полностью; отсутствие записей не подтверждает отсутствие запусков.");
  if (receipt.refused_starts === undefined) add(body, "", "Сведений об отклонённых запусках нет.");
  else {
    const refusals = rows(receipt.refused_starts);
    if (Array.isArray(receipt.refused_starts) && receipt.refused_starts.every(record)) add(body, "Отклонено запусков", refusals.length);
    else add(body, "", "Число отклонённых запусков неизвестно.");
    for (const refusal of refusals) fields(body, refusal, [["invocation_id", "Запрос запуска"], ["task_id", "Задача"], ["reason", "Причина отказа"]]);
  }
  const covered = group("Покрытие измерений");
  fields(covered, coverage, [["tree", "Дерево"], ["usage", "Учёт расходов"], ["causal_edges", "Причинные связи"], ["history_before_instrumentation", "Ранняя история"], ["actors_observed", "Наблюдалось участников"], ["intervals_observed", "Наблюдалось интервалов"]]);
  if (coverage.gaps !== undefined) document(covered, coverage.gaps);
  if (receipt.actor_intervals !== undefined) document(group("Записанные интервалы участников"), receipt.actor_intervals);
  if (receipt.selected_waits !== undefined) document(group("Записанные ожидания"), receipt.selected_waits);
  if (receipt.causal_edges !== undefined) document(group("Записанные причинные связи"), receipt.causal_edges);
  if (record(receipt.parallelism)) {
    const target = group("Наблюдаемое пересечение интервалов");
    fields(target, receipt.parallelism, [["observed_actor_seconds", "Сумма наблюдаемых секунд участников"], ["observed_union_sec", "Объединение интервалов, с"], ["overlap_sec", "Пересечение интервалов, с"], ["peak_observed_actors", "Пик наблюдаемых участников"], ["mean_observed_parallelism", "Среднее пересечение"], ["basis", "Основание измерения"]]);
    add(target, "", "Пересечение интервалов не является оценкой производительности или рекомендацией размера команды.");
  } else if (receipt.parallelism != null) malformed = true;
  if (record(receipt.longest_causal_path)) {
    const target = group("Причинный путь"), path = receipt.longest_causal_path;
    fields(target, path, [["coverage", "Покрытие пути"]]);
    if (numeric(path.seconds) && path.coverage === "complete") add(target, "Подтверждённый причинный путь, с", path.seconds);
    else add(target, "", "Полная длительность причинного пути неизвестна.");
    if (numeric(path.observed_seconds)) add(target, "Наблюдаемая часть пути, с", path.observed_seconds);
    if (path.actor_ids !== undefined) document(target, path.actor_ids);
    if (path.rejected_edges !== undefined) document(group("Непринятые связи пути"), path.rejected_edges);
  } else if (receipt.longest_causal_path != null) malformed = true;
  if (record(receipt.cost)) {
    const cost = receipt.cost, target = group("Расходы отчёта роя");
    add(target, "Подтверждённая известная часть", usd(cost.known_final_usd));
    add(target, "Полная стоимость", usd(coverage.usage === "complete" && cost.unknown_attempts === 0 ? cost.total_usd : undefined));
    if (cost.unknown_attempts != null) add(target, "Попытки с неподтверждённой стоимостью", cost.unknown_attempts);
    const attempts = rows(cost.attempts), models = [...new Set(attempts.map(a => text(a.model)).filter(Boolean))];
    if (models.length) add(body, "Модели", models.join(", "));
    const sessions = new Set(attempts.filter(a => a.kind === "subscription_session").map(a => text(a.task_id) || text(a.attempt_id)).filter(Boolean));
    if (sessions.size) add(body, "Сеансы подписки", sessions.size);
    if (cost.attempts !== undefined) document(group("Попытки и маршруты учёта"), cost.attempts);
  } else if (receipt.cost != null) malformed = true;
  if (receipt.supervisor_context_pressure !== undefined) document(group("Наблюдения контекста руководителя"), receipt.supervisor_context_pressure);
  if (receipt.mind_comparison !== undefined) {
    const target = group("Сравнение, записанное агентом");document(target, receipt.mind_comparison);
    add(target, "", "Сравнение принадлежит указанному автору; измерения сами по себе его не подтверждают.");
  }
  if (malformed) add(body, "", "Часть сведений отчёта прочитать не удалось.");
  return panel;
}
