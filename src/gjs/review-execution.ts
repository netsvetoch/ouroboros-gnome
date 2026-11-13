import { Gtk, Pango } from "./gi.js";
import { chrome } from "./native-i18n.js";
import { column, label } from "./ui.js";
import { reviewDiagnostic } from "./review-diagnostic.js";

const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Render reported execution/failure facts; a requested route supplies none of them. */
export function renderReviewExecution(target: any, raw: unknown): void {
  raw = reviewDiagnostic(raw);
  if (!object(raw)) return;
  let unreadable = false;
  const text = (parent: any, value: string, css?: string) => {
    const item = label(value, css);item.set_selectable(true);item.set_wrap_mode(Pango.WrapMode.WORD_CHAR);item.set_max_width_chars(64);parent.append(item);return item;
  };
  const fact = (key: string, english: string, russian: string) => {
    const value = raw[key];
    if (value === undefined || value === null || value === "") return;
    if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) { unreadable = true;return; }
    chrome(text(target, `${russian} · ${value}`, "dim-label"), "label", english, { value });
  };
  if (Object.hasOwn(raw, "observed_model")) {
    if (raw.observed_model === "" || raw.observed_model === "unknown") chrome(text(target, "Наблюдаемая модель не сообщена.", "dim-label"), "label", "The observed model was not reported.");
    else if (typeof raw.observed_model === "string") fact("observed_model", "Observed model · {value}", "Наблюдаемая модель");
    else unreadable = true;
  }
  for (const [key, english, russian] of [
    ["operation_state", "Review operation · {value}", "Операция ревью"],
    ["failure_code", "Failure code · {value}", "Код отказа"],
    ["http_status", "HTTP status · {value}", "HTTP-статус"],
    ["reset_at", "Limit reset · {value}", "Сброс лимита"],
    ["reported_cause", "Reported cause · {value}", "Сообщённая причина"],
  ]) fact(key!, english!, russian!);
  if (raw.failure_details != null) {
    if (!object(raw.failure_details)) unreadable = true;
    else if (Object.keys(raw.failure_details).length) {
      const body = column(4);text(body, JSON.stringify(raw.failure_details, null, 2));
      target.append(chrome(new Gtk.Expander({ label: "Подробности отказа", child: body }), "label", "Failure details"));
    }
  }
  const executions: unknown[] = [];
  if (raw.executions !== undefined) {
    if (Array.isArray(raw.executions)) executions.push(...raw.executions);
    else unreadable = true;
  }
  if (raw.execution !== undefined) executions.push(raw.execution);
  const seen = new Set<string>();
  for (const value of executions) {
    if (!object(value) || typeof value.kind !== "string" || !value.kind
      || ["harness_id", "model"].some(key => value[key] !== undefined && typeof value[key] !== "string")) { unreadable = true;continue; }
    const identity = JSON.stringify([value.kind, value.harness_id, value.model]);
    if (seen.has(identity)) continue;seen.add(identity);
    const detail = [value.kind, value.harness_id, value.model].filter(Boolean).join(" · ");
    chrome(text(target, "Наблюдение исполнения · " + detail, "dim-label"), "label", "Execution observation · {value}", { value: detail });
  }
  if (unreadable) chrome(text(target, "Часть сведений об исполнении или отказе недоступна.", "warning"), "label", "Some execution or failure details are unavailable.");
}
