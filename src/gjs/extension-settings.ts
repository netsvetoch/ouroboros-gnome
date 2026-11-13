import { mountComponents } from "./card-components.js";
import { type Gateway, HttpError } from "./gateway.js";
import { Adw, Gio, Gtk } from "./gi.js";
import { object, type SettingsDocument } from "./settings-write.js";
import { button, clear, column, errorText, label, sheet } from "./ui.js";
import { widgetRoute, widgetRows, widgetText } from "./widget-contract.js";

const methods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

interface RouteState { busy: boolean; revision: number }

function hydrate(field: SettingsDocument, values: SettingsDocument): SettingsDocument {
  const name = widgetText(field.name);
  const type = widgetText(field.type, "text").toLowerCase();
  const value = Object.hasOwn(values, name) ? values[name] : field.default;
  if (type !== "select" || value == null) return { ...field, type, default: type === "password" ? "" : value };
  const options = Array.isArray(field.options) ? field.options : [];
  const selected = widgetText(value);
  return { ...field, type, default: selected, options: options.some(option => widgetText(object(option).value ?? option) === selected)
    ? options : [{ value: selected, label: selected || "—" }, ...options] };
}

function replyText(reply: SettingsDocument, action: boolean): string {
  const message = widgetText(reply.message).trim();
  if (message) return message;
  const states = Object.entries(reply).flatMap(([key, value]) => {
    const item = object(value);
    return typeof item.state === "string" && item.state
      ? [[key, item.state, item.reason_code || item.message].filter(Boolean).join(" · ")] : [];
  });
  return states.join("\n") || (action ? "Шлюз подтвердил выполнение действия." : "Настройки сохранены.");
}

export function showExtensionSettings(gateway: Gateway, skill: string, present: (dialog: any) => void, parent?: any, sectionId?: string): void {
  const cancel = new Gio.Cancellable();
  const routes = new Map<string, RouteState>();
  const content = column();
  const dialog = sheet("Разделы настроек навыка", content);
  const parentClosed = parent instanceof Adw.Dialog || parent instanceof Gtk.Window ? parent.connect(
    parent instanceof Gtk.Window ? "close-request" : "closed", () => { dialog.force_close(); return false; }) : undefined;
  dialog.connect("closed", () => {
    if (cancel.is_cancelled()) return;
    cancel.cancel();
    if (parentClosed !== undefined) parent.disconnect(parentClosed);
    const erase = (widget: any) => {
      if (widget instanceof Gtk.PasswordEntry) widget.set_text("");
      for (let child = widget.get_first_child?.(); child; child = child.get_next_sibling()) erase(child);
    };
    erase(content);
  });
  const alive = () => !cancel.is_cancelled();
  const request = (method: string, path: string, body?: SettingsDocument) =>
    gateway.json<unknown>(method, path, body, undefined, false, cancel);

  function form(spec: SettingsDocument): any {
    const host = column(5);
    host.set_name("extension-settings-form");
    const rawRoute = spec.route || spec.api_route;
    const method = widgetText(spec.method, "POST").toUpperCase();
    let path: string;
    try { path = widgetRoute(skill, rawRoute); }
    catch { return label("Маршрут настроек недоступен.", "dim-label"); }
    if (!methods.has(method)) return label("Метод запроса настроек не поддерживается.", "dim-label");

    const state = routes.get(path) ?? { busy: false, revision: 0 };
    routes.set(path, state);
    const fields = widgetRows(spec.fields);
    const action = spec.type === "action";
    const editor = column(5);
    const recovery = column();
    const feedback = label("", "dim-label");
    const reread = button("Перечитать значения", () => void read());
    reread.set_visible(fields.length > 0);
    host.append(editor);
    host.append(reread);
    host.append(recovery);
    host.append(feedback);
    let reading = false;
    let ready = !fields.length;

    function render(values: SettingsDocument): void {
      if (!alive()) return;
      ready = true;
      clear(recovery);
      clear(editor);
      const revision = state.revision;
      const caption = widgetText(spec.submit_label ?? spec.label, action ? "Выполнить" : "Сохранить");
      const mounted = mountComponents([{ ...spec, type: "form", condition_key: undefined,
        title: spec.title, fields: fields.map(field => hydrate(field, values)), submit_label: caption, submit: { id: "settings" } }],
      {}, (control, values) => {
        if (!alive() || !ready || control.disabled || reading || state.busy) return;
        if (fields.length && state.revision !== revision) {
          editor.set_sensitive(false);
          feedback.set_label("Состояние маршрута изменилось. Перечитайте значения перед записью.");
          return;
        }
        void submit(values ?? {}, control.widget, caption);
      }, {});
      editor.set_sensitive(true);
      editor.append(mounted.widget);
    }

    async function submit(values: SettingsDocument, control: any, caption: string): Promise<void> {
      if (!alive() || state.busy || !ready) return;
      state.busy = true;
      const writing = method !== "GET" && method !== "HEAD";
      editor.set_sensitive(false);
      reread.set_sensitive(false);
      control.set_label(widgetText(spec.busy_label, "Выполняю запрос…"));
      feedback.set_label("Выполняю запрос…");
      try {
        const raw = await gateway.optionalJson(method, writing ? path : widgetRoute(skill, rawRoute, values), writing ? values : undefined, cancel);
        if (!alive()) return;
        const reply = object(raw);
        if ((reply.ok === false && !fields.some(field => field.name === "ok"))
          || (reply.error && !fields.some(field => field.name === "error"))) {
          feedback.set_label(widgetText(reply.error || reply.message, "Шлюз отклонил запрос."));
          return;
        }
        if (writing) state.revision++;
        const outcome = replyText(reply, action || !writing);
        if (fields.length && writing) await read(outcome);
        else feedback.set_label(outcome);
      } catch (error) {
        if (!alive()) return;
        const uncertain = writing && (!(error instanceof HttpError) || error.status >= 500 || error.status === 408);
        if (uncertain) { state.revision++; if (fields.length) ready = false; }
        feedback.set_label([uncertain ? "Результат записи неизвестен." : "", errorText(error),
          uncertain && fields.length ? "Перечитайте значения перед повтором." : ""].filter(Boolean).join(" "));
      } finally {
        state.busy = false;
        if (alive()) {
          control.set_label(caption);
          editor.set_sensitive(ready);
          reread.set_sensitive(true);
        }
      }
    }

    async function read(outcome = ""): Promise<void> {
      if (!alive() || reading || state.busy && !outcome) return;
      reading = true;
      reread.set_sensitive(false);
      ready = false;
      editor.set_sensitive(false);
      clear(recovery);
      feedback.set_label([outcome, "Читаю сохранённые значения…"].filter(Boolean).join(" "));
      const revision = state.revision;
      try {
        const values = await request("GET", path);
        if (!alive()) return;
        if (values !== object(values) || (object(values).error && !fields.some(field => field.name === "error"))
          || (object(values).ok === false && !fields.some(field => field.name === "ok"))) throw new Error("Шлюз не вернул сохранённые значения.");
        if (state.revision !== revision) throw new Error("Значения изменились во время чтения.");
        render(object(values));
        feedback.set_label(outcome);
      } catch (error) {
        if (!alive()) return;
        const unsupported = error instanceof HttpError && [404, 405].includes(error.status);
        if (unsupported && spec.disabled !== true) {
          recovery.append(button("Редактировать без чтения", () => {
            if (!alive() || reading || state.busy) return;
            render({});
            feedback.set_label("Проверьте все поля. Форма заполнена значениями по умолчанию.");
          }));
        }
        feedback.set_label([outcome, unsupported ? "Маршрут не выдаёт сохранённые значения."
          : `Не удалось прочитать значения. ${errorText(error)}`].filter(Boolean).join(" "));
      } finally {
        reading = false;
        if (alive()) reread.set_sensitive(true);
      }
    }

    if (fields.length) void read();
    else render({});
    return host;
  }

  async function load(): Promise<void> {
    clear(content);
    content.append(label("Читаю разделы настроек…", "dim-label"));
    try {
      const result = object(await request("GET", widgetRoute(skill, "settings_section")));
      if (!alive()) return;
      if (result.skill !== skill || !Array.isArray(result.sections)
        || result.sections.some(section => !section || typeof section !== "object" || section.skill !== skill
          || !Array.isArray(object(section.render).components))) throw new Error("Шлюз не вернул разделы выбранного навыка.");
      const sections = widgetRows(result.sections).filter(item => item.skill === skill && (sectionId === undefined || item.section_id === sectionId));
      if (sectionId !== undefined && !sections.length) throw new Error("Заявленный раздел настроек коннектора не найден.");
      clear(content);
      for (const section of sections) {
        const components = widgetRows(object(section.render).components);
        content.append(label(widgetText(section.title ?? section.section_id, skill), "title-4"));
        for (const spec of components) {
          if (spec.type === "form" || spec.type === "action") content.append(form(spec));
          else if (spec.type === "markdown" || spec.type === "json") {
            content.append(mountComponents([{ ...spec, target: undefined, path: undefined, condition_key: undefined }],
              spec.value ?? spec.data ?? {}, () => {}, { base: gateway.base }).widget);
          } else content.append(label("Компонент настроек не поддерживается.", "dim-label"));
        }
      }
      if (!content.get_first_child()) content.append(label("У навыка нет зарегистрированных разделов настроек.", "dim-label"));
    } catch (error) {
      if (!alive()) return;
      clear(content);
      content.append(label(errorText(error), "error"));
      content.append(button("Повторить чтение", () => void load()));
    }
  }

  present(dialog);
  void load();
}
