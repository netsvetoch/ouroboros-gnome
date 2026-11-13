import { Adw, Gio, GLib, Gtk } from "./gi.js";
import { bindChrome } from "./native-i18n.js";
import { type Gateway, query } from "./gateway.js";
import { readI18nSnapshot, type I18nSnapshot } from "./i18n-contract.js";
import { ownerHeaders } from "./settings-write.js";
import { button, column, errorText, label, row, sheet } from "./ui.js";

interface Profile { label: string; instruction: string; direction: string; lexicon: string }
interface Header { language: string; profile: Profile; plural_select: Record<string, unknown> | null; plural_categories: string[] | null }
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const length = (text: string) => [...text].length;
function plural(value: unknown): Record<string, unknown> {
  if (!object(value) || !object(value.map) || Object.keys(value).some(key => !["map", "period"].includes(key))
    || (value.period != null && (!Number.isSafeInteger(value.period) || value.period <= 0))
    || Object.entries(value.map).some(([key, value]) => !/^\d+$/u.test(key) || Number(key) > 100
      || typeof value !== "string" || !value || length(value) > 16)) throw new Error("Правила должны содержать map для чисел 0–100 и положительный целый period либо null.");
  return { map: value.map, period: value.period ?? null };
}
function header(value: unknown, language: string): Header {
  if (!object(value) || value.language !== language || !object(value.profile)
    || !["label", "instruction", "direction", "lexicon"].every(key => typeof value.profile[key] === "string")
    || !["ltr", "rtl"].includes(value.profile.direction) || length(value.profile.lexicon) > 60_000
    || (value.plural_categories != null && (!Array.isArray(value.plural_categories) || value.plural_categories.length > 8
      || value.plural_categories.some((item: unknown) => typeof item !== "string" || !item)))) {
    throw new Error("Шлюз не вернул полный профиль выбранного языка.");
  }
  return { language, profile: { label: value.profile.label, instruction: value.profile.instruction,
    direction: value.profile.direction, lexicon: value.profile.lexicon },
    plural_select: value.plural_select == null ? null : plural(value.plural_select), plural_categories: value.plural_categories ?? null };
}
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => equal(value, b[index]));
  if (!object(a) || !object(b)) return false;
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
};

/** The full lexicon is owner export data, deliberately absent from ordinary GET. */
export function editLanguageProfile(parent: any, gateway: Gateway, language: string, ownerCancel: any): Promise<I18nSnapshot | undefined> {
  if (ownerCancel.is_cancelled()) return Promise.resolve(undefined);
  const cancel = new Gio.Cancellable(), stops: (() => void)[] = [];
  const caption = (widget: any, property: string, english: string, params?: Record<string, string | number>): any => {
    stops.push(bindChrome(widget, property, english, params)); return widget;
  };
  const content = column(8), fields = column(8), feedback = label("Читаю полный профиль языка…");
  const dialog = sheet("Профиль языка", content);
  dialog.set_name("language-profile-editor");dialog.set_content_width(680);dialog.set_content_height(680);
  caption(dialog, "title", "Language profile");
  content.append(caption(label(`Язык · ${language}`), "label", "Language · {id}", { id: language }));
  const name = new Adw.EntryRow({ title: "Название языка" });name.set_name("language-label");caption(name, "title", "Language name");fields.append(name);
  const area = (title: string, english: string, name: string, monospace = false): any => {
    fields.append(caption(label(title), "label", english));
    const widget = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR, monospace });widget.set_name(name);
    fields.append(new Gtk.ScrolledWindow({ child: widget, min_content_height: 100, hscrollbar_policy: Gtk.PolicyType.NEVER }));return widget;
  };
  const instruction = area("Описание для переводчика", "Translation instructions", "language-instruction");
  const direction = new Gtk.CheckButton({ label: "Текст справа налево" });caption(direction, "label", "Right-to-left text");fields.append(direction);
  const lexicon = area("Лексикон и правила языка", "Language lexicon and rules", "language-lexicon");
  const select = area("Правила множественного числа · JSON", "Plural selection rules · JSON", "language-plural-select", true);
  fields.append(caption(label("Пустое поле сохраняет правила. Объект {\"map\":{},\"period\":null} очищает сопоставления."), "label",
    "Leave blank to keep the rules. Use {\"map\":{},\"period\":null} to clear the mappings."));
  const changeCategories = new Gtk.CheckButton({ label: "Записать список форм" });changeCategories.set_name("language-set-categories");caption(changeCategories, "label", "Write plural categories");fields.append(changeCategories);
  const categories = new Adw.EntryRow({ title: "Формы множественного числа через запятую" });categories.set_name("language-categories");caption(categories, "title", "Plural categories, comma-separated");fields.append(categories);
  changeCategories.connect("toggled", () => categories.set_sensitive(changeCategories.get_active()));
  fields.append(caption(label("Снимите галочку, чтобы сохранить список. Пустой список с галочкой очищает категории. Существующие переводы не изменяются."), "label", "Uncheck to keep the categories. A checked empty list clears them. Existing translations are preserved."));
  content.append(fields);content.append(feedback);fields.set_sensitive(false);
  const text = (widget: any): string => { const b = widget.get_buffer();return b.get_text(b.get_start_iter(), b.get_end_iter(), false); };
  const set = (widget: any, value: string) => widget.get_buffer().set_text(value, -1);
  const read = async (): Promise<Header> => header(await gateway.json("GET", `/api/ui/i18n/export${query({ language })}`, undefined, ownerHeaders, false, cancel), language);
  return new Promise(resolve => {
    let settled = false, busy = false, baseline: Header | undefined, attempted = false, ownerSignal = 0;
    const parents: [any, number][] = [];
    const finish = (value?: I18nSnapshot) => {
      if (settled) return;settled = true;cancel.cancel();
      for (const [object, signal] of parents.splice(0)) object.disconnect(signal);
      if (ownerSignal) GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { ownerCancel.disconnect(ownerSignal);return GLib.SOURCE_REMOVE; });
      for (const stop of stops.splice(0)) stop();resolve(value);
      if (dialog.get_parent()) dialog.force_close();
    };
    const load = async () => {
      if (settled || busy) return;busy = true;sync();
      try {
        const value = await read();if (settled) return;baseline = value;attempted = false;
        name.set_text(value.profile.label);set(instruction, value.profile.instruction);set(lexicon, value.profile.lexicon);
        direction.set_active(value.profile.direction === "rtl");set(select, value.plural_select ? JSON.stringify(value.plural_select, null, 2) : "");
        categories.set_text(value.plural_categories?.join(", ") ?? "");changeCategories.set_active(value.plural_categories !== null);categories.set_sensitive(changeCategories.get_active());feedback.set_label("");
      } catch (error) { if (!settled) feedback.set_label(errorText(error)); }
      finally { busy = false;if (!settled) sync(); }
    };
    const save = async () => {
      if (settled || busy || !baseline) return;busy = true;sync();
      try {
        const profile: Profile = { label: name.get_text().trim() || language, instruction: text(instruction).trim(), direction: direction.get_active() ? "rtl" : "ltr", lexicon: text(lexicon) };
        if (length(profile.label) > 120 || length(profile.instruction) > 4000 || length(profile.lexicon) > 60_000) throw new Error("Пределы: название — 120 символов, описание — 4000, лексикон — 60000.");
        const raw = text(select).trim();let selection: Record<string, unknown> | undefined;
        if (raw) { let value: unknown;try { value = JSON.parse(raw); } catch { throw new Error("Правила множественного числа содержат ошибку JSON."); }selection = plural(value); }
        const rawCategories = categories.get_text().trim(), forms: string[] = rawCategories ? rawCategories.split(",").map((value: string) => value.trim()) : [];
        if (changeCategories.get_active() && (forms.length > 8 || forms.some(value => !value))) throw new Error("Укажите не более восьми непустых категорий через запятую.");
        const declared = changeCategories.get_active() ? [...new Set(forms)] : undefined;
        const current = readI18nSnapshot(await gateway.json("GET", "/api/ui/i18n", undefined, undefined, false, cancel));
        if (settled) return;
        if (current.language !== language || current.memory_error) throw new Error("Выбранный язык или доступность словаря изменились. Черновик сохранён.");
        const fresh = await read();if (settled) return;
        const desired: Header = { language, profile, plural_select: selection ?? fresh.plural_select, plural_categories: declared ?? fresh.plural_categories };
        if (!equal(fresh, baseline)) {
          if (attempted && equal(fresh, desired)) { finish(current);return; }
          throw new Error("Профиль изменился на шлюзе. Черновик сохранён; перечитайте параметры перед новой записью.");
        }
        attempted = true;
        const result = await gateway.json<any>("POST", "/api/ui/i18n/language", { language, profile,
          ...(selection === undefined ? {} : { plural_select: selection }), ...(declared === undefined ? {} : { plural_categories: declared }) }, ownerHeaders, true, cancel);
        if (settled) return;
        const snapshot = readI18nSnapshot(result);
        if (result.ok !== true || snapshot.language !== language || snapshot.memory_error) throw new Error(snapshot.memory_error || "Шлюз не подтвердил профиль этого языка. Проверьте сохранённое состояние перед повтором.");
        const stored = await read();if (settled) return;
        if (!equal(stored, desired)) throw new Error("Шлюз не подтвердил точные параметры профиля. Черновик сохранён.");
        finish(snapshot);
      } catch (error) { if (!settled) feedback.set_label(errorText(error)); }
      finally { busy = false;if (!settled) sync(); }
    };
    const controls = row();
    controls.append(caption(button("Отмена", () => finish()), "label", "Cancel"));
    const reload = caption(button("Перечитать параметры (заменить черновик)", () => void load()), "label", "Reload settings (replace draft)");controls.append(reload);
    const submit = caption(button("Сохранить профиль", () => void save()), "label", "Save language profile");submit.add_css_class("suggested-action");controls.append(submit);content.append(controls);
    const sync = () => { fields.set_sensitive(!busy && Boolean(baseline));submit.set_sensitive(!busy && Boolean(baseline));reload.set_sensitive(!busy); };
    dialog.connect("closed", () => finish());
    const follow = (object: any, signal: string) => parents.push([object, object.connect(signal, () => { finish();return false; })]);
    if (parent instanceof Adw.Dialog) follow(parent, "closed");
    const window = parent instanceof Gtk.Window ? parent : parent?.get_root?.();if (window instanceof Gtk.Window) follow(window, "close-request");
    ownerSignal = ownerCancel.connect(() => finish());
    if (!settled) { dialog.present(parent);void load(); }
  });
}
