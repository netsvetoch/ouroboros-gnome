import { Pango } from "./gi.js";
import { chrome, chromeText } from "./native-i18n.js";
import { column, label } from "./ui.js";

interface Hold { label?: string; reason?: string; detail?: string }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** An observation of accepted work waiting for scope evidence; never an owner command. */
export function projectHold(task: { project_admission_hold?: unknown }): Hold | "unavailable" | undefined {
  const value = task.project_admission_hold;
  if (value == null) return undefined;
  if (!object(value) || ["label", "reason", "detail"].some(key => value[key] != null && typeof value[key] !== "string")) return "unavailable";
  const hold = value as Hold;
  return [hold.label, hold.reason, hold.detail].some(value => value?.trim()) ? hold : undefined;
}

export function projectHoldCaption(task: { project_admission_hold?: unknown }): string {
  const hold = projectHold(task);
  return hold === "unavailable" ? chromeText("Project waiting details are unavailable", undefined, "Сведения об ожидании проекта недоступны")
    : hold ? hold.label || chromeText("Waiting for Project verification", undefined, "Ожидает проверки проекта") : "";
}

export function projectHoldPanel(task: { project_admission_hold?: unknown }): any | undefined {
  const hold = projectHold(task);
  if (!hold) return undefined;
  const box = column(4);
  const append = (value: string, style?: string) => {
    const field = label(value, style);
    field.set_selectable(true);field.set_wrap_mode(Pango.WrapMode.WORD_CHAR);field.set_max_width_chars(64);
    box.append(field);
    return field;
  };
  if (hold === "unavailable") {
    chrome(append("Сведения об ожидании проекта недоступны", "warning"), "label", "Project waiting details are unavailable");
    return box;
  }
  if (hold.label) append(hold.label, "heading");
  else chrome(append("Ожидает проверки проекта", "heading"), "label", "Waiting for Project verification");
  chrome(append("Задача принята. Шлюз проверяет исходный доступ к проекту или области работы.", "dim-label"), "label",
    "The task was accepted. The gateway is checking its original Project or task scope authority.");
  if (hold.detail) append(hold.detail);
  if (hold.reason) chrome(append(`Причина · ${hold.reason}`, "dim-label"), "label", "Reason · {reason}", { reason: hold.reason });
  return box;
}
