import { Gateway, gatewayUrl } from "./gateway.js";
import { Adw, Gio, GLib, Gtk } from "./gi.js";
import { probeConnection } from "./connection-probe.js";
import { button, errorText, label } from "./ui.js";

export interface GatewaySettings { baseUrl: string; password: string; chatId: number }
export const defaultGatewayBase = "http://127.0.0.1:8765";

export function readConnectionSettings(path: string, fallback: GatewaySettings): GatewaySettings {
  const key = new GLib.KeyFile();
  try { key.load_from_file(path, GLib.KeyFileFlags.NONE); } catch { return { ...fallback }; }
  const read = <T>(get: () => T, value: T): T => { try { return get(); } catch { return value; } };
  return {
    baseUrl: read(() => key.get_string("gateway", "base_url"), fallback.baseUrl) || fallback.baseUrl,
    password: read(() => key.get_string("gateway", "password"), fallback.password),
    chatId: read(() => {
      const raw = key.get_string("gateway", "chat_id").trim();
      const value = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 0) throw new Error("Недопустимый ID чата.");
      return value;
    }, fallback.chatId),
  };
}

export function writeConnectionSettings(path: string, settings: GatewaySettings): void {
  if (!Number.isSafeInteger(settings.chatId) || settings.chatId < 0) throw new Error("Недопустимый ID чата.");
  if (GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700) !== 0) throw new Error("Не удалось создать каталог настроек.");
  const key = new GLib.KeyFile();
  key.set_string("gateway", "base_url", settings.baseUrl);
  key.set_string("gateway", "password", settings.password);
  key.set_string("gateway", "chat_id", String(settings.chatId));
  GLib.file_set_contents_full(path, key.to_data()[0], GLib.FileSetContentsFlags.CONSISTENT, 0o600);
}

export function showConnectionSettings(parent: any, settings: GatewaySettings, gateway: Gateway | undefined,
  update: (settings: GatewaySettings, session?: Gateway) => void, persist: (settings: GatewaySettings) => void): any {
  const dialog = new Adw.PreferencesDialog({ title: "Настройки подключения" });
  const page = new Adw.PreferencesPage();
  const group = new Adw.PreferencesGroup({ title: "Шлюз Ouroboros" });
  const url = new Adw.EntryRow({ title: "Адрес", text: settings.baseUrl, input_purpose: Gtk.InputPurpose.URL });
  const password = new Adw.PasswordEntryRow({ title: "Пароль", text: settings.password });
  const room = new Adw.SpinRow({
    title: "Чат при запуске",
    subtitle: "1 — Main",
    adjustment: new Gtk.Adjustment({ value: settings.chatId, lower: 0, upper: Number.MAX_SAFE_INTEGER, step_increment: 1 }),
  });
  room.set_value(settings.chatId);
  const status = label(gateway?.hasSession ? "Открыт сетевой сеанс до закрытия клиента." : "");
  let open = true, saving = false;
  type Attempt = { connection: Gateway; owned: boolean; cancel: any };
  let attempt: Attempt | undefined;
  const draft = () => ({
    baseUrl: gatewayUrl(url.get_text().trim() || defaultGatewayBase),
    password: password.get_text(),
    chatId: Math.floor(room.get_value()),
  });
  const test = button("Проверить подключение", () => {
    if (!open || attempt || saving) return;
    let current: Attempt;
    try {
      const settings = draft();
      const session = gateway?.hasSession && gateway.base === settings.baseUrl && !settings.password ? gateway : undefined;
      current = { connection: session ?? new Gateway(settings.baseUrl, settings.password), owned: !session, cancel: new Gio.Cancellable() };
    } catch (error) {
      status.set_label(errorText(error));
      return;
    }
    attempt = current;
    syncButtons();
    status.set_label("Проверка…");
    void probeConnection(current.connection, current.cancel).then((message) => {
      if (attempt === current) status.set_label(message);
    }).finally(() => {
      if (attempt === current) {
        stopAttempt();
        syncButtons();
      }
    });
  });
  const stopAttempt = () => {
    const current = attempt;
    attempt = undefined;
    current?.cancel.cancel();
    if (current?.owned) current.connection.close();
  };
  const login = button("Войти на этот сеанс", () => {
    if (!open || attempt || saving) return;
    let current: Attempt;
    let settings: GatewaySettings;
    try {
      settings = draft();
      if (!settings.password) throw new Error("Введите сетевой пароль шлюза.");
      current = { connection: new Gateway(settings.baseUrl, ""), owned: true, cancel: new Gio.Cancellable() };
    } catch (error) {
      status.set_label(errorText(error));
      return;
    }
    attempt = current;
    syncButtons();
    status.set_label("Запрашиваю сетевой сеанс…");
    void current.connection.login(settings.password).then(() => {
      if (attempt !== current) return;
      const updated = { ...settings, password: "", chatId: Math.floor(room.get_value()) };
      persist(updated);
      attempt = undefined;
      open = false;
      password.set_text("");
      update(updated, current.connection);
      dialog.close();
    }).catch((error) => {
      if (attempt === current) status.set_label(errorText(error));
    }).finally(() => {
      if (attempt === current) {
        stopAttempt();
        syncButtons();
      }
    });
  });
  for (const field of [url, password]) field.connect("changed", () => {
    if (!open) return;
    stopAttempt();
    status.set_label("");
    syncButtons();
  });
  dialog.connect("closed", () => { open = false; stopAttempt(); password.set_text(""); });
  const save = button("Сохранить", () => {
    if (!open || attempt || saving) return;
    saving = true;
    syncButtons();
    try {
      const settings = draft();
      persist(settings);
      const session = gateway?.hasSession && gateway.base === settings.baseUrl && !settings.password ? gateway.copySession() : undefined;
      open = false;
      password.set_text("");
      update(settings, session);
      dialog.close();
    } catch (error) {
      saving = false;
      status.set_label(errorText(error));
      syncButtons();
    }
  });
  const syncButtons = () => {
    for (const control of [test, login, save]) control.set_sensitive(open && !attempt && !saving);
  };
  save.add_css_class("suggested-action");
  for (const widget of [url, password, room, test, status, login, save]) group.add(widget);
  page.add(group);
  dialog.add(page);
  dialog.present(parent);
  return dialog;
}

