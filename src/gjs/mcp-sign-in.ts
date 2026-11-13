import { Adw, Gio, GLib, Gtk } from "./gi.js";
import { type Gateway, HttpError } from "./gateway.js";
import { type Present } from "./mcp-server.js";
import { ownerHeaders } from "./settings-write.js";
import { button, clear, column, confirm, label, row, sheet } from "./ui.js";

interface Reply {
  ok: boolean;
  server?: string;
  url?: string;
  redirect_uri?: string;
  revoked?: boolean | null;
  listing?: { ok?: boolean; tool_count?: number; error?: string };
  code?: string;
  reason?: string;
  error?: string;
}

function address(value: string): any {
  const uri = GLib.Uri.parse(value, GLib.UriFlags.ENCODED_QUERY | GLib.UriFlags.ENCODED_PATH | GLib.UriFlags.SCHEME_NORMALIZE);
  if (!["http", "https"].includes(uri.get_scheme()) || !uri.get_host() || uri.get_userinfo() || uri.get_fragment()) {
    throw new Error("Ожидается адрес HTTP или HTTPS.");
  }
  return uri;
}

function parameters(uri: any): Record<string, string> {
  return GLib.Uri.parse_params(uri.get_query() ?? "", -1, "&", GLib.UriParamsFlags.WWW_FORM);
}

function returnServer(state: string): unknown {
  const base64 = state.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = GLib.base64_decode(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  const data = JSON.parse(new TextDecoder().decode(bytes));
  return data?.v === 1 ? data.mcp : undefined;
}

export function mcpSignIn(parent: any, gateway: Gateway, present: Present, id: string, changed: () => void): void {
  const content = column();
  const dialog = sheet(`Вход в MCP · ${id}`, content);
  const fields = column();
  const client = new Gtk.Entry({ placeholder_text: "Client ID (для своей регистрации)" });
  const secret = new Gtk.PasswordEntry({ placeholder_text: "Client secret (если требуется)", show_peek_icon: true });
  const returned = new Gtk.PasswordEntry({ placeholder_text: "Адрес, на котором остановился браузер", show_peek_icon: true });
  client.set_name("mcp-sign-in-client");
  secret.set_name("mcp-sign-in-secret");
  returned.set_name("mcp-sign-in-return");
  const link = column();
  const status = label("", "dim-label");
  let pending: { state: string; callback: any } | undefined;
  let busy = false;
  let open = true;
  const cancel = new Gio.Cancellable();
  const parentSignal = parent instanceof Adw.Dialog ? parent.connect("closed", () => dialog.force_close()) : 0;
  dialog.connect("closed", () => {
    if (!open) return;
    open = false;
    cancel.cancel();
    secret.set_text("");
    returned.set_text("");
    clear(link);
    pending = undefined;
    if (parentSignal) parent.disconnect(parentSignal);
  });
  const actions = row();
  const step = async (action: "begin" | "complete" | "sign_out") => {
    if (busy || !open) return;
    busy = true;
    fields.set_sensitive(false);
    actions.set_sensitive(false);
    try {
      let body: object;
      if (action === "begin") {
        const clientId = client.get_text().trim();
        const clientSecret = secret.get_text();
        if (clientSecret && !clientId) {
          status.set_label("Для собственного Client secret укажите Client ID.");
          return;
        }
        body = { action, server_id: id, ...(clientId ? { client_id: clientId, client_secret: clientSecret } : {}) };
      } else if (action === "complete") {
        const value = returned.get_text().trim();
        try {
          const parsed = address(value);
          const { state, code, error } = parameters(parsed);
          if (!state || (!code && !error) || returnServer(state) !== id) throw new Error();
          if (pending) {
            const cb = pending.callback;
            if (state !== pending.state || parsed.get_scheme() !== cb.get_scheme() || parsed.get_host() !== cb.get_host()
              || parsed.get_port() !== cb.get_port() || parsed.get_path() !== cb.get_path()) throw new Error();
          }
        } catch {
          status.set_label("Вставьте полный адрес возврата для этого сервера и текущей попытки входа.");
          return;
        }
        body = { action, returned_url: value };
      } else {
        if (!await confirm(dialog, "Выйти из MCP?",
          "Шлюз удалит сохранённые токены и запросит отзыв доступа у провайдера, если он это поддерживает.", "Выйти") || !open) return;
        body = { action, server_id: id };
      }
      status.set_label("Шлюз связывается с провайдером…");
      const gatewayUri = GLib.Uri.parse(gateway.base, GLib.UriFlags.NONE);
      const origin = GLib.Uri.join(GLib.UriFlags.NONE, gatewayUri.get_scheme(), null, gatewayUri.get_host(), gatewayUri.get_port(), "", null, null);
      const reply = await gateway.json<Reply>("POST", "/api/mcp/sign-in", body, { ...ownerHeaders, Origin: origin }, true, cancel);
      if (!open) return;
      if (!reply.ok) {
        status.set_label(["Провайдер или шлюз отклонил вход", reply.code, reply.reason].filter(Boolean).join(" · "));
      } else if (action === "begin") {
        if (reply.server !== id || !reply.url || !reply.redirect_uri) throw new Error("Шлюз не подтвердил адрес для этого сервера.");
        const { state } = parameters(address(reply.url));
        if (!state || returnServer(state) !== id) throw new Error("Шлюз не подтвердил попытку входа для этого сервера.");
        pending = { state, callback: address(reply.redirect_uri) };
        clear(link);
        link.append(new Gtk.LinkButton({ label: "Открыть страницу входа в браузере", uri: reply.url, halign: Gtk.Align.START }));
        const callback = label(`Адрес возврата · ${reply.redirect_uri}`);
        callback.set_selectable(true);
        link.append(callback);
        client.set_text("");
        secret.set_text("");
        returned.set_text("");
        status.set_label("После входа вернитесь сюда. При необходимости вставьте полный адрес из браузера и завершите вход.");
      } else if (action === "complete") {
        pending = undefined;
        clear(link);
        returned.set_text("");
        status.set_label(reply.listing?.ok === true ? `Вход выполнен · инструментов ${reply.listing.tool_count ?? 0}`
          : "Вход выполнен. Обновление списка инструментов не подтверждено.");
      } else {
        pending = undefined;
        clear(link);
        returned.set_text("");
        status.set_label(reply.revoked === true ? "Токены удалены. Провайдер подтвердил отзыв доступа."
          : reply.revoked === false ? "Токены удалены. Провайдер не подтвердил отзыв доступа."
            : "Токены удалены на шлюзе.");
      }
    } catch (error) {
      if (open) status.set_label(error instanceof HttpError ? `HTTP ${error.status} · Шлюз не подтвердил действие. Проверьте состояние входа.`
        : "Шлюз не подтвердил действие. Проверьте состояние входа.");
    } finally {
      busy = false;
      if (open) {
        changed();
        fields.set_sensitive(true);
        actions.set_sensitive(true);
      }
    }
  };
  const credentials = column();
  credentials.append(label("Оставьте поля пустыми, чтобы шлюз использовал сохранённую регистрацию или зарегистрировал приложение автоматически.", "dim-label"));
  credentials.append(client);
  credentials.append(secret);
  fields.append(new Gtk.Expander({ label: "Собственная регистрация OAuth", child: credentials }));
  fields.append(returned);
  actions.append(button("Начать вход", () => void step("begin")));
  actions.append(button("Завершить вход", () => void step("complete")));
  actions.append(button("Выйти…", () => void step("sign_out")));
  actions.append(button("Проверить состояние входа", () => {
    if (busy || !open) return;
    busy = true;
    actions.set_sensitive(false);
    void gateway.json<{ servers: { id: string; sign_in?: { state: string; reason?: string; required_scope?: string; pending?: boolean } }[] }>(
      "GET", "/api/mcp/status", undefined, {}, false, cancel).then(({ servers }) => {
      if (!open) return;
      const state = servers.find((server) => server.id === id)?.sign_in;
      if (state?.state === "signed_in" && !state.pending) {
        pending = undefined;
        clear(link);
        returned.set_text("");
        status.set_label(state.reason === "insufficient_scope"
          ? ["Вход выполнен, но сервер требует дополнительные права. Начните вход снова.", state.required_scope].filter(Boolean).join(" · ")
          : ["Шлюз подтверждает вход.", state.reason].filter(Boolean).join(" · "));
      } else status.set_label([state?.pending ? "Шлюз ждёт завершения входа" : "Шлюз пока не подтвердил вход", state?.reason].filter(Boolean).join(" · "));
    }).catch(() => {
      if (open) status.set_label("Состояние входа недоступно.");
    }).finally(() => {
      busy = false;
      if (open) {
        actions.set_sensitive(true);
        changed();
      }
    });
  }));
  for (const widget of [fields, actions, link, status]) content.append(widget);
  present(dialog, parent);
}
