import { Adw, Gio, Gtk } from "./gi.js";
import { type Gateway, HttpError } from "./gateway.js";
import { ownerHeaders } from "./settings-write.js";
import { column, label, sheet } from "./ui.js";

export type SecretSelector = { key: string } | { connection: string; field: string }
  | { mcp_server_id: string; header_name?: string };

/** An explicit selected read; never stages a setting or exposes a response in an error label. */
export function showSavedSecret(parent: any, gateway: Gateway,
  present: (dialog: any, parent?: any) => void, selector: SecretSelector, title = "Сохранённый секрет"): any {
  const content = column();
  const dialog = sheet(title, content);
  const status = label("Читаю выбранный секрет…");
  const value = new Gtk.PasswordEntry({ editable: false, show_peek_icon: true, placeholder_text: "Пустое значение" });
  const cancel = new Gio.Cancellable();
  let open = true;
  const parentSignal = parent instanceof Adw.Dialog ? parent.connect("closed", () => dialog.force_close()) : 0;
  dialog.connect("closed", () => {
    if (!open) return;
    open = false;
    cancel.cancel();
    value.set_text("");
    if (parentSignal) parent.disconnect(parentSignal);
  });
  content.append(label("key" in selector ? selector.key : "connection" in selector
    ? `${selector.connection} · ${selector.field}` : `${selector.mcp_server_id} · ${selector.header_name ?? "auth_token"}`, "dim-label"));
  content.append(status);
  content.append(value);
  present(dialog, parent);
  void gateway.json<{ value: string }>("POST", "/api/settings/secret", selector, ownerHeaders, false, cancel).then((result) => {
    if (!open) return;
    if (typeof result?.value !== "string") throw new Error("Invalid selected secret response");
    value.set_text(result.value);
    status.set_label(result.value ? "Нажмите значок глаза, чтобы показать значение." : "Секрет не задан.");
  }).catch((error: unknown) => {
    if (!open) return;
    const reasons: Record<string, string> = {
      secret_not_found: "Сохранённый секрет не найден.",
      invalid_secret_selector: "Не удалось выбрать секрет.",
      MCP_ID_AMBIGUOUS_SECRET: "Идентификатор MCP неоднозначен. Исправьте сохранённые записи.",
      mcp_header_unreadable: "Заголовок MCP не удаётся прочитать однозначно.",
    };
    status.set_label(error instanceof HttpError
      ? `HTTP ${error.status} · ${reasons[error.reason ?? ""] ?? "Не удалось прочитать выбранный секрет."}`
      : "Не удалось прочитать выбранный секрет.");
  });
  return dialog;
}
