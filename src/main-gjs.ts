/**
 * GTK4 + Libadwaita UI. Выполняется в GJS (org.gnome.Platform//51),
 * пишется на TypeScript и компилируется тем же tsc, что и остальное.
 *
 * v0.6: добавлена страница настроек — подключение к инстансу Ouroboros.
 * Почему: BASE был зашит в код (127.0.0.1:8765), у Артёма инстанс висит
 * в другом месте/порту — история не грузилась, а ошибка уходила только
 * в console. Теперь адрес, пароль и chat_id хранятся в
 * ~/.config/ouroboros-client/settings.ini и меняются из UI.
 *
 * Запуск внутри flatpak: `gjs /app/share/ouroboros-ts-client/main-gjs.js`
 * (кладётся манифестом). Локально без сборки: `gjs dist-gjs/main-gjs.js`.
 */

// GJS-окружение: типы gi тут не нужны, только честность на границах.
// console/imports — глобалы (см. src/globals.d.ts); imports.gi типизирован как any.
declare const imports: any;

// В рантайме лежат Gtk-3.0 и Gtk-4.0 рядом — пиним версии до первого require.
imports.gi.versions.Gtk = "4.0";
imports.gi.versions.Adw = "1";
imports.gi.versions.Soup = "3.0";

const Gtk = imports.gi.Gtk;
const Adw = imports.gi.Adw;
const Soup = imports.gi.Soup;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;

interface GatewaySettings {
  baseUrl: string;
  password: string;
  chatId: number;
}

const DEFAULT_BASE = "http://127.0.0.1:8765";

function settingsPath(): string {
  const dir = GLib.build_filenamev([GLib.get_user_config_dir(), "ouroboros-client"]);
  try {
    Gio.File.new_for_path(dir).make_directory_with_parents(null);
  } catch (_e) {
    /* уже есть — молча */
  }
  return GLib.build_filenamev([dir, "settings.ini"]);
}

function loadSettings(): GatewaySettings {
  const fallback: GatewaySettings = {
    baseUrl: GLib.getenv("OUROBOROS_URL") ?? DEFAULT_BASE,
    password: GLib.getenv("OUROBOROS_NETWORK_PASSWORD") ?? "",
    chatId: 1,
  };
  try {
    const kf = new GLib.KeyFile();
    kf.load_from_file(settingsPath(), GLib.KeyFileFlags.NONE);
    return {
      baseUrl: safeStr(kf, "gateway", "base_url", fallback.baseUrl),
      password: safeStr(kf, "gateway", "password", fallback.password),
      chatId: safeInt(kf, "gateway", "chat_id", fallback.chatId),
    };
  } catch (_e) {
    return fallback;
  }
}

function safeStr(kf: any, group: string, key: string, fb: string): string {
  try {
    const v = kf.get_string(group, key);
    return v && v.length > 0 ? v : fb;
  } catch (_e) {
    return fb;
  }
}

function safeInt(kf: any, group: string, key: string, fb: number): number {
  try {
    const v = kf.get_integer(group, key);
    return Number.isFinite(v) && v >= 0 ? v : fb;
  } catch (_e) {
    return fb;
  }
}

function saveSettings(s: GatewaySettings): void {
  const kf = new GLib.KeyFile();
  kf.set_string("gateway", "base_url", s.baseUrl);
  kf.set_string("gateway", "password", s.password);
  kf.set_integer("gateway", "chat_id", s.chatId);
  kf.save_to_file(settingsPath());
}

const settings: GatewaySettings = loadSettings();
const session = new Soup.Session();

function base(): string {
  return settings.baseUrl.replace(/\/+$/, "");
}

function authHeaders(msg: any): void {
  if (settings.password) {
    msg.request_headers.append("Authorization", "Bearer " + settings.password);
  }
}

function statusCodeOf(msg: any): number {
  try {
    return msg.get_status();
  } catch (_e) {
    return -1;
  }
}

function getJson(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const msg = Soup.Message.new("GET", base() + path);
    authHeaders(msg);
    session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (_s: unknown, res: unknown) => {
      try {
        const code = statusCodeOf(msg);
        if (code < 200 || code >= 300) {
          reject(new Error("HTTP " + code + " на GET " + path));
          return;
        }
        const bytes = session.send_and_read_finish(res);
        const text = new TextDecoder().decode(bytes.get_data());
        resolve(JSON.parse(text));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function postJson(path: string, body: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const msg = Soup.Message.new("POST", base() + path);
    authHeaders(msg);
    msg.request_headers.append("Content-Type", "application/json");
    const payload = new TextEncoder().encode(JSON.stringify(body));
    msg.set_request_body_from_bytes("application/json", GLib.Bytes.new(payload));
    session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (_s: unknown, res: unknown) => {
      try {
        const code = statusCodeOf(msg);
        if (code < 200 || code >= 300) {
          reject(new Error("HTTP " + code + " на POST " + path));
          return;
        }
        const bytes = session.send_and_read_finish(res);
        const text = new TextDecoder().decode(bytes.get_data());
        resolve(text ? JSON.parse(text) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function rowLabel(text: string): any {
  const label = new Gtk.Label({ label: text, xalign: 0, wrap: true });
  label.add_css_class("card");
  return label;
}

/** Диалог настроек: адрес инстанса, пароль, chat_id + кнопка проверки. */
function openSettings(parent: any, statusLabel: any, refresh: () => void): void {
  const dlg = new Adw.PreferencesWindow({ transient_for: parent, title: "Настройки" });
  const page = new Adw.PreferencesPage({ title: "Подключение", icon_name: "network-server-symbolic" });
  dlg.add(page);
  const group = new Adw.PreferencesGroup({
    title: "Инстанс Ouroboros",
    description: "Адрес gateway, пароль (если задан OUROBOROS_NETWORK_PASSWORD) и чат",
  });
  page.add(group);

  const urlRow = new Adw.EntryRow({ title: "Адрес (Base URL)", text: settings.baseUrl });
  urlRow.set_input_purpose(Gtk.InputPurpose.URL);
  const passRow = new Adw.PasswordEntryRow({ title: "Пароль", text: settings.password });
  const chatRow = new Adw.SpinRow({
    title: "Chat ID",
    subtitle: "0 — скрытые, 1 — Main",
    adjustment: new Gtk.Adjustment({ value: settings.chatId, lower: 0, upper: 999999, step_increment: 1 }),
  });
  group.add(urlRow);
  group.add(passRow);
  group.add(chatRow);

  const testLabel = new Gtk.Label({ label: "", xalign: 0, wrap: true });
  group.add(testLabel);

  const testBtn = new Gtk.Button({ label: "Проверить подключение" });
  testBtn.add_css_class("pill");
  testBtn.connect("clicked", () => {
    const probe = String(urlRow.get_text()).trim().replace(/\/+$/, "") || DEFAULT_BASE;
    const pwd = passRow.get_text();
    const probeMsg = Soup.Message.new("GET", probe + "/api/health");
    if (pwd) probeMsg.request_headers.append("Authorization", "Bearer " + pwd);
    session.send_and_read_async(probeMsg, GLib.PRIORITY_DEFAULT, null, (_s: unknown, res: unknown) => {
      try {
        const code = statusCodeOf(probeMsg);
        if (code < 200 || code >= 300) {
          testLabel.set_label("Не отвечает: HTTP " + code + " на " + probe);
          return;
        }
        const bytes = session.send_and_read_finish(res);
        const text = new TextDecoder().decode(bytes.get_data()).slice(0, 160);
        testLabel.set_label("OK: " + probe + " → " + text);
      } catch (e) {
        testLabel.set_label("Ошибка: " + String(e).slice(0, 200));
      }
    });
  });
  const testBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8, halign: Gtk.Align.CENTER });
  testBox.append(testBtn);
  group.add(testBox);

  dlg.connect("close-request", () => {
    const url = String(urlRow.get_text()).trim().replace(/\/+$/, "") || DEFAULT_BASE;
    settings.baseUrl = url;
    settings.password = passRow.get_text();
    settings.chatId = Math.max(0, Math.floor(chatRow.get_value()));
    saveSettings(settings);
    statusLabel.set_label("Подключено к " + base() + " · chat " + settings.chatId);
    refresh();
  });
  dlg.present();
}

// GJS грузит файл как классический скрипт (не ES-модуль),
// поэтому без import/export: весь файл — один скрипт.
function main(argv: string[]): number {
  const app = new Adw.Application({ application_id: "io.github.ouroboros.Client" });

  app.connect("activate", () => {
    const win = new Adw.ApplicationWindow({ application: app, title: "Ouroboros" });
    win.set_default_size(900, 600);

    const header = new Adw.HeaderBar();
    const settingsBtn = new Gtk.Button({ icon_name: "emblem-system-symbolic", tooltip_text: "Настройки подключения" });
    const refreshBtn = new Gtk.Button({ icon_name: "view-refresh-symbolic", tooltip_text: "Обновить историю" });
    header.pack_end(settingsBtn);
    header.pack_end(refreshBtn);

    const statusLabel = new Gtk.Label({
      label: "Подключено к " + base() + " · chat " + settings.chatId,
      xalign: 0,
      wrap: true,
    });
    statusLabel.add_css_class("dim-label");

    const list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
    const scroll = new Gtk.ScrolledWindow({ child: list, vexpand: true, hexpand: true });

    const entry = new Gtk.Entry({ placeholder_text: "Сообщение…", hexpand: true });
    const sendBtn = new Gtk.Button({ label: "Отправить" });
    sendBtn.add_css_class("suggested-action");
    const composer = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 8,
      homogeneous: false,
    });
    composer.append(entry);
    composer.append(sendBtn);

    const col = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
    col.append(statusLabel);
    col.append(scroll);
    col.append(composer);
    // Отступы вокруг контента — вместо голых краёв v0.5.
    (col as any).set_margin_start?.(12);
    (col as any).set_margin_end?.(12);
    (col as any).set_margin_bottom?.(12);

    const content = new Adw.ToolbarView();
    content.add_top_bar(header);
    content.set_content(col);
    win.set_content(content);

    async function refresh(): Promise<void> {
      try {
        const h = await getJson(`/api/chat/history?chat_id=${settings.chatId}&limit=50`);
        let child = list.get_first_child();
        while (child) {
          const next = child.get_next_sibling();
          list.remove(child);
          child = next;
        }
        const msgs = h.messages ?? h.rows ?? [];
        if (msgs.length === 0) {
          statusLabel.set_label("Пусто: " + base() + " ответил, но сообщений в chat " + settings.chatId + " нет");
        } else {
          statusLabel.set_label("Подключено к " + base() + " · chat " + settings.chatId + " · " + msgs.length);
        }
        for (const m of msgs) {
          const role = m.role ?? m.author ?? "msg";
          const text = m.text ?? m.content ?? JSON.stringify(m).slice(0, 200);
          list.append(rowLabel(`[${role}] ${String(text).slice(0, 500)}`));
        }
      } catch (e) {
        const msg = String(e instanceof Error ? e.message : e);
        statusLabel.set_label("Нет связи с " + base() + ": " + msg.slice(0, 160) + " — проверь Настройки");
        console.error("history failed", e);
      }
    }

    sendBtn.connect("clicked", () => {
      const text = entry.get_text().trim();
      if (!text) return;
      entry.set_text("");
      postJson("/api/tasks", { description: text, title: text.slice(0, 60), chat_id: settings.chatId })
        .then(() => refresh())
        .catch((e: unknown) => {
          const msg = String(e instanceof Error ? e.message : e);
          statusLabel.set_label("Отправка не удалась: " + msg.slice(0, 160));
          console.error("send failed", e);
        });
    });
    entry.connect("activate", () => sendBtn.emit("clicked"));
    refreshBtn.connect("clicked", () => refresh());
    settingsBtn.connect("clicked", () => openSettings(win, statusLabel, refresh));

    win.present();
    refresh();
    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
      refresh();
      return GLib.SOURCE_CONTINUE;
    });
  });

  return app.run(argv);
}

// GJS-точка входа: `gjs main-gjs.js` вызывает main(ARGV).
if (typeof (globalThis as any).ARGV !== "undefined") {
  main((globalThis as any).ARGV);
}
