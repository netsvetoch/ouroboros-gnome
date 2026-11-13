import { chrome, chromeText, watchNativeI18n } from "./native-i18n.js";
import { Gtk } from "./gi.js";
import { object, type SettingsDocument } from "./settings-write.js";
import { button, column, label, sheet } from "./ui.js";

const enforcementKey = "OUROBOROS_REVIEW_ENFORCEMENT";
const resultKey = "OUROBOROS_TASK_REVIEW_MODE";
const cyclesKey = "OUROBOROS_REVIEW_MAX_CYCLES";
export const reviewPolicyLabels: Record<string, string> = {
  [enforcementKey]: "Режим ревью",
  [resultKey]: "Ревью результата задачи",
  [cyclesKey]: "Лимит циклов ревью",
};
const enforcementModes = { advisory: "Рекомендательный", blocking: "Блокирующий" };
const modeSources: Record<string, string> = { advisory: "Advisory", blocking: "Blocking", off: "Off", auto: "At Ouroboros’s request", required: "Required for created results" };
const resultModes = { off: "Выключено", auto: "По запросу Ouroboros", required: "Обязательно для созданного результата" };

function modeLabel(value: unknown): string {
  return typeof value === "string" && Object.hasOwn(enforcementModes, value)
    ? chromeText(modeSources[value], undefined, enforcementModes[value as keyof typeof enforcementModes])
    : typeof value === "string" && value ? value : chromeText("Unknown", undefined, "неизвестно");
}

function choice(values: Record<string, string>, stored: unknown, fallback: string) {
  const initial = String(stored || fallback).trim().toLowerCase();
  const options = Object.keys(values);
  if (!Object.hasOwn(values, initial)) options.push(initial);
  const model = new Gtk.StringList();
  const widget = new Gtk.DropDown({ model });
  const repaint = () => {
    const index = widget.get_selected();
    model.splice(0, model.get_n_items(), options.map(option => Object.hasOwn(values, option)
      ? chromeText(modeSources[option], undefined, values[option])
      : chromeText("Stored value · {value}", { value: option }, `Сохранённое значение · ${option}`)));
    if (index < options.length) widget.set_selected(index);
  };
  repaint();
  widget.set_selected(options.indexOf(initial));
  const selected = () => options[widget.get_selected()] ?? initial;
  return { widget, selected, repaint, changed: () => selected() !== initial };
}

export function reviewPolicyDialog(settings: SettingsDocument, stage: (patch: SettingsDocument) => void): any {
  const content = column();
  const dialog = chrome(sheet("Политика ревью", content), "title", "Review policy");
  let open = true, submitted = false;
  const enforcement = choice(enforcementModes, settings[enforcementKey], "advisory");
  const result = choice(resultModes, settings[resultKey], "auto");
  const storedCycles = String(settings[cyclesKey] || "2").trim().toLowerCase();
  const unlimitedAtStart = ["unlimited", "inf", "∞"].includes(storedCycles);
  const unlimited = chrome(new Gtk.CheckButton({ label: "Без лимита циклов", active: unlimitedAtStart }), "label", "Unlimited review cycles");
  const cycles = new Gtk.Entry({ text: unlimitedAtStart ? "" : storedCycles, input_purpose: Gtk.InputPurpose.DIGITS });
  cycles.set_sensitive(!unlimitedAtStart);
  unlimited.connect("toggled", () => { if (open) cycles.set_sensitive(!unlimited.get_active()); });

  const policy = object(object(settings._meta).policy_state);
  const review = object(policy.review);
  const access = object(policy.access);
  const nowAccess = access.current_process ?? access.effective;
  const nextAccess = settings.OUROBOROS_RUNTIME_MODE ?? access.configured;
  const reviewFacts = label("");
  const refreshFacts = () => {
    if (!open || !Object.keys(review).length) return;
    const saved = modeLabel(review.configured), current = modeLabel(review.current_process ?? review.effective), next = modeLabel(review.next_task);
    reviewFacts.set_label(chromeText("Saved · {saved}\nCurrent process · {current}\nNext task · {next}",
      { saved, current, next }, `Сохранено · ${saved}\nТекущий процесс · ${current}\nСледующая задача · ${next}`));
  };
  refreshFacts();
  const note = label("", "dim-label");
  const refreshNote = () => {
    if (!open) return;
    const notices: string[] = [];
    if (nowAccess === "cyber_pro") notices.push(chromeText("Reviews are advisory in the current Cyber Pro process.", undefined, "В текущем процессе Cyber Pro выводы ревью носят рекомендательный характер."));
    if (enforcement.selected() === "blocking" && nextAccess === "cyber_pro" && nowAccess !== "cyber_pro") {
      notices.push(chromeText("Reviews will be advisory after switching to Cyber Pro.", undefined, "После перехода на Cyber Pro выводы ревью будут рекомендательными."));
    }
    if (enforcement.selected() === "blocking" && nowAccess === "cyber_pro" && ["light", "advanced", "pro"].includes(String(nextAccess))) {
      notices.push(chromeText("Blocking enforcement takes effect after starting with the saved access mode.", undefined, "Блокирующий режим вступит в силу после запуска с сохранённым режимом доступа."));
    }
    note.set_label(notices.join("\n"));
    note.set_visible(Boolean(notices.length));
  };
  enforcement.widget.connect("notify::selected", refreshNote);
  refreshNote();

  const feedback = label("", "error");
  const submit = chrome(button("Применить в форме", () => {
    if (!open || submitted) return;
    const patch: SettingsDocument = {};
    if (enforcement.changed()) patch[enforcementKey] = enforcement.selected();
    if (result.changed()) patch[resultKey] = result.selected();
    const entered = cycles.get_text().trim();
    const cap = unlimited.get_active() ? "unlimited" : entered.replace(/^0+(?=[0-9])/, "");
    if (cap !== (unlimitedAtStart ? "unlimited" : storedCycles)) {
      if (cap !== "unlimited" && !/^[1-9][0-9]*$/.test(cap)) {
        feedback.set_label("Введите положительное целое число или включите «Без лимита циклов».");
        chrome(feedback, "label", "Enter a positive integer or enable unlimited review cycles.");
        return;
      }
      patch[cyclesKey] = cap;
    }
    submitted = true;
    stage(patch);
    dialog.close();
  }), "label", "Apply to form");
  submit.add_css_class("suggested-action");
  content.append(chrome(label("Влияние замечаний ревью", "heading"), "label", "Effect of review findings"));
  content.append(chrome(label("Блокирующий режим может остановить коммит и активацию проверяемого навыка при нерешённых критических замечаниях."), "label", "Blocking enforcement can stop a commit or skill activation when critical findings remain unresolved."));
  if (Object.keys(review).length) {
    content.append(reviewFacts);
    if (review.active_task_snapshot === true) content.append(chrome(label("Запущенная задача сохраняет политику, с которой стартовала.", "dim-label"), "label", "A running task keeps the policy it started with."));
  }
  for (const item of [enforcement.widget, note, chrome(label("Ревью результата задачи", "heading"), "label", "Task result review"),
    chrome(label("В обязательном режиме шлюз также проверяет созданные материалы и наблюдаемые эффекты. При выключении новые ревью результата перестают запускаться."), "label", "Required mode also reviews created materials and observed effects. Off stops new task-result reviews."),
    result.widget, chrome(label("Лимит оплачиваемых циклов", "heading"), "label", "Paid review cycle limit"),
    chrome(label("Лимит действует для ревью результатов, коммитов и навыков. Для запросов ревью плана шлюз учитывает бюджет и срок."), "label", "The limit applies to result, commit and skill reviews. Plan-review requests use the budget and deadline."),
    cycles, unlimited, feedback, submit]) content.append(item);
  const unwatch = watchNativeI18n(() => {
    if (!open) return;
    enforcement.repaint(); result.repaint(); refreshNote(); refreshFacts();
  });
  dialog.connect("closed", () => {
    if (!open) return;
    open = false; unwatch();
    for (const selected of [enforcement, result]) {
      content.remove(selected.widget); selected.widget.run_dispose();
    }
  });
  return dialog;
}
