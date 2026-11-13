import { Gtk } from "./gi.js";
import { type Present } from "./mcp-server.js";
import { type SettingsDocument, object } from "./settings-write.js";
import { button, column, errorText, label, row, sheet } from "./ui.js";

const definitions = [
  ["OUROBOROS_MODEL_ACCOUNTS", "Аккаунт", "Профиль аккаунта; пустое значение — Auto"],
  ["OUROBOROS_MODEL_CONTEXT_WINDOWS", "Окно контекста", "Неотрицательное целое число; 0 — Auto"],
  ["OUROBOROS_MODEL_PROCESSING_PREFERENCES", "Обработка", "Пустое значение наследует общий режим"],
] as const;
export const modelRoleOptionKeys = new Set<string>(definitions.map(([key]) => key));
const roles = [
  ["main", "Основная модель"], ["light", "Лёгкая модель"], ["safety", "Safety Supervisor"],
  ["vision", "Модель зрения"], ["consciousness", "Модель фоновой работы"],
  ["deep_review", "Модель глубокого саморевью"], ["websearch", "Модель веб-поиска"],
] as const;
const preferences = ["", "standard", "fast", "economy"];

function read(settings: SettingsDocument, key: string): SettingsDocument {
  let raw = settings[key];
  if (typeof raw === "string") raw = raw.trim() ? JSON.parse(raw) : {};
  if (raw == null) raw = {};
  if (object(raw) !== raw) throw new Error(`${key}: требуется JSON-объект.`);
  const values = raw as SettingsDocument;
  for (const role of [...roles.map(([id]) => id), "fallback"]) {
    if (!Object.hasOwn(values, role)) continue;
    const entries = role === "fallback" ? values[role] : [values[role]];
    if (!Array.isArray(entries)) throw new Error(`${key}: fallback должен быть массивом.`);
    for (const item of entries) {
      if (key === definitions[1][0] ? typeof item !== "number" || !Number.isSafeInteger(item) || item < 0
        : key === definitions[2][0] ? item !== null && (typeof item !== "string" || !preferences.includes(item.trim().toLowerCase()))
          : typeof item !== "string") {
        throw new Error(`${key}: недопустимое значение роли ${role}.`);
      }
    }
  }
  return values;
}

/** Edits authored role options; observed model/account data never creates a pin. */
export function showModelRoleOptions(parent: any, settings: SettingsDocument, present: Present,
  stage: (patch: SettingsDocument) => void): any {
  const content = column();
  const dialog = sheet("Параметры ролей моделей", content);
  let open = true;
  let staged = false;
  const parentSignal = parent.connect(parent instanceof Gtk.Window ? "close-request" : "closed", () => {
    if (open) dialog.force_close();
    return false;
  });
  dialog.connect("closed", () => { if (!open) return; open = false; parent.disconnect(parentSignal); });
  content.append(label("Параметры принадлежат роли. Аккаунт задаётся явно; выбор модели из каталога сам по себе не закрепляет аккаунт. Пустой профиль и окно 0 означают Auto. Пустая обработка наследует общий режим.", "dim-label"));
  content.append(label("Флажок задаёт явное значение роли. Снятый флажок удаляет параметр роли; её обычное наследование определяет шлюз.", "dim-label"));
  content.append(label("Safety Supervisor с пустой моделью наследует параметры вместе с маршрутом. Здесь редактируются явные значения роли.", "dim-label"));
  const status = label("", "error");
  const readers: (() => [string, SettingsDocument])[] = [];
  try {
    for (const [key, title, help] of definitions) {
      const original = read(settings, key);
      const section = column();
      section.append(label(help, "dim-label"));
      const inputs: { role: string; enabled: any; value: () => unknown }[] = [];
      const editor = (owner: any, value: unknown, identity: string): (() => unknown) => {
        if (key === definitions[2][0]) {
          const selected = typeof value === "string" ? value.trim().toLowerCase() : "";
          const control = Gtk.DropDown.new_from_strings(["Наследовать", ...preferences.slice(1)]);
          control.set_name(identity);
          const initial = preferences.indexOf(selected);
          control.set_selected(initial);
          owner.append(control);
          return () => control.get_selected() === initial && value !== undefined ? value : preferences[control.get_selected()];
        }
        const initial = String(value ?? (key === definitions[1][0] ? 0 : ""));
        const control = new Gtk.Entry({ text: initial, hexpand: true });
        control.set_name(identity);
        owner.append(control);
        return () => {
          const text = control.get_text();
          if (key !== definitions[1][0]) return text === initial && value !== undefined ? value : text.trim();
          const numberText = text.trim();
          if (!/^\d+$/.test(numberText) || !Number.isSafeInteger(Number(numberText))) throw new Error(`${title}: требуется неотрицательное целое число.`);
          return Number(numberText);
        };
      };
      for (const [role, name] of roles) {
        const controls = row();
        const enabled = new Gtk.CheckButton({ label: name, active: Object.hasOwn(original, role) });
        enabled.set_name(`${key}:${role}:enabled`);
        controls.append(enabled);
        const box = column(0);
        const value = editor(box, original[role], `${key}:${role}`);
        box.set_sensitive(enabled.active);
        enabled.connect("toggled", () => box.set_sensitive(open && enabled.active));
        controls.append(box);
        section.append(controls);
        inputs.push({ role, enabled, value });
      }
      const fallback = column();
      const enabled = new Gtk.CheckButton({ label: "Резервные модели · задать массив", active: Object.hasOwn(original, "fallback") });
      enabled.set_name(`${key}:fallback:enabled`);
      section.append(enabled);
      section.append(label("Позиции соответствуют порядку резервных моделей. Удаление строки сдвигает следующие значения. Массивы трёх параметров независимы.", "dim-label"));
      section.append(fallback);
      let entries: { widget: any; value: () => unknown }[] = [];
      const add = (value: unknown) => {
        const controls = row();
        controls.append(label(String(entries.length + 1)));
        const readValue = editor(controls, value, `${key}:fallback:value`);
        controls.append(button("Удалить позицию", () => {
          if (!open) return;
          entries = entries.filter(item => item.widget !== controls);
          fallback.remove(controls);
          entries.forEach((item, index) => item.widget.get_first_child().set_label(String(index + 1)));
        }));
        entries.push({ widget: controls, value: readValue });
        fallback.append(controls);
      };
      for (const value of original.fallback as unknown[] ?? []) add(value);
      const append = button("Добавить позицию", () => { if (open) add(key === definitions[1][0] ? 0 : ""); });
      section.append(append);
      const sync = () => { fallback.set_sensitive(open && enabled.active); append.set_sensitive(open && enabled.active); };
      enabled.connect("toggled", sync);
      sync();
      readers.push(() => {
        const result = { ...original };
        for (const input of inputs) {
          if (input.enabled.active) result[input.role] = input.value();
          else delete result[input.role];
        }
        if (enabled.active) result.fallback = entries.map(item => item.value());
        else delete result.fallback;
        return [key, result];
      });
      const unknown = Object.keys(original).filter(role => role !== "fallback" && !roles.some(([id]) => id === role));
      if (unknown.length) section.append(label(`Дополнительные роли сохранены без изменений: ${unknown.join(", ")}`, "dim-label"));
      content.append(new Gtk.Expander({ label: title, child: section }));
    }
    content.append(button("Применить параметры ролей", () => {
      if (!open || staged) return;
      try {
        const patch: SettingsDocument = {};
        for (const read of readers) {
          const [key, value] = read();
          // No normalization or new empty object is staged unless an option actually changed.
          if (JSON.stringify(value) !== JSON.stringify(readOriginal(key))) patch[key] = JSON.stringify(value);
        }
        staged = true;
        stage(patch);
        dialog.close();
      } catch (error) { status.set_label(errorText(error)); }
    }));
  } catch (error) { status.set_label(errorText(error)); }
  function readOriginal(key: string): SettingsDocument { return read(settings, key); }
  content.append(status);
  present(dialog, parent);
  return dialog;
}
