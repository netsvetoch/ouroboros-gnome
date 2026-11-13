import { showSavedSecret, type SecretSelector } from "./saved-secret.js";
import { Gio, Gtk } from "./gi.js";
import { type Gateway } from "./gateway.js";
import { type Present } from "./mcp-server.js";
import { type SettingsDocument, object, ownerHeaders } from "./settings-write.js";
import { button, clear, column, confirm, errorText, label, row, sheet } from "./ui.js";

export const connectionsKey = "OUROBOROS_CONNECTIONS";
type Field = readonly [name: string, key: string, title: string, secret?: true];
const apiKey = (key: string): Field => ["api_key", key, "Ключ API", true];
const endpoint = (key: string): Field => ["base_url", key, "Базовый URL"];
const openaiLegacy = [apiKey("OPENAI_API_KEY"), endpoint("OPENAI_BASE_URL")];
const kinds: Record<string, { title: string; fields: Field[] }> = {
  openrouter: { title: "OpenRouter", fields: [apiKey("OPENROUTER_API_KEY")] },
  openai: { title: "OpenAI", fields: [apiKey("OPENAI_API_KEY")] },
  anthropic: { title: "Anthropic", fields: [apiKey("ANTHROPIC_API_KEY")] },
  deepseek: { title: "DeepSeek", fields: [apiKey("DEEPSEEK_API_KEY")] },
  zai: { title: "Z.ai (GLM)", fields: [apiKey("ZAI_API_KEY"), ["plan", "ZAI_PLAN", "План (payg или coding)"]] },
  minimax: { title: "MiniMax", fields: [apiKey("MINIMAX_API_KEY"), ["region", "MINIMAX_REGION", "Регион (global_en или cn_zh)"]] },
  cloudru: { title: "Cloud.ru Foundation Models", fields: [apiKey("CLOUDRU_FOUNDATION_MODELS_API_KEY"), endpoint("CLOUDRU_FOUNDATION_MODELS_BASE_URL")] },
  gigachat: { title: "GigaChat", fields: [
    ["credentials", "GIGACHAT_CREDENTIALS", "Авторизационные данные", true],
    ["user", "GIGACHAT_USER", "Пользователь"], ["password", "GIGACHAT_PASSWORD", "Пароль", true],
    endpoint("GIGACHAT_BASE_URL"), ["scope", "GIGACHAT_SCOPE", "Область доступа"],
    ["verify_ssl_certs", "GIGACHAT_VERIFY_SSL_CERTS", "Проверка сертификатов (true или false)"],
  ] },
  "openai-compatible": { title: "OpenAI-совместимый", fields: [apiKey("OPENAI_COMPATIBLE_API_KEY"), endpoint("OPENAI_COMPATIBLE_BASE_URL")] },
};

function rows(value: unknown): SettingsDocument[] {
  return Array.isArray(value) ? value.filter((row) => row === object(row)) : [];
}

function masked(value: string): boolean {
  return value === "***" || value === "***set***" || (value.length === 11 && value.endsWith("..."));
}

function redact(text: string, values: unknown[]): string {
  const secrets = values.filter((value): value is string => typeof value === "string" && Boolean(value) && !masked(value));
  for (const value of secrets.sort((a, b) => b.length - a.length)) text = text.replaceAll(value, "•••");
  return text;
}

export function redactProviderConnections(text: string, value: unknown): string {
  return redact(text, rows(value).flatMap((row) => {
    const fields = kinds[String(row.kind)]?.fields ?? [];
    return fields.filter(([, , , secret]) => secret).map(([field]) => row[field]);
  }));
}

interface EditableField {
  definition: Field;
  value: () => string;
}

interface ConnectionInfo {
  kind: string;
  name: string;
  builtin: boolean;
  enabled: boolean;
  configured: boolean;
  source: string;
  cache_hints?: { refused?: boolean; learned_at?: string };
}

export class Providers {
  private dialog?: any;
  constructor(private readonly gateway: Gateway, private readonly present: Present) {}

  show(settings: SettingsDocument, saved: SettingsDocument, stage: (patch: SettingsDocument) => void, allowedBuiltinKeys?: ReadonlySet<string>): void {
    if (this.dialog) return;
    const content = column(10);
    const dialog = sheet("Подключения провайдеров", content);
    this.dialog = dialog;
    const cancel = new Gio.Cancellable();
    let staged = false;
    dialog.set_content_width(690);
    const list = column();
    const flat: SettingsDocument = {};
    const original = rows(settings[connectionsKey]);
    let draft = [...original];
    let open = true;
    dialog.connect("closed", () => { open = false; cancel.cancel(); if (this.dialog === dialog) this.dialog = undefined; });
    const metadata = object(saved._meta).connections;
    const facts = Array.isArray(metadata) ? metadata as ConnectionInfo[] : [];
    let renderVersion = 0;
    const render = () => {
      if (!open) return;
      const version = ++renderVersion;
      const current = () => open && version === renderVersion;
      clear(list);
      for (const [kind, spec] of Object.entries(kinds)) {
        const group = column(4);
        group.append(label(spec.title, "heading"));
        const builtin = draft.find((item) => item.kind === kind && item.name === "default");
        const known = facts.find((item) => item.kind === kind && item.builtin);
        const enabled = builtin?.enabled !== false;
        const main = button("Встроенное подключение…", () => { if (!current()) return; this.edit(dialog, kind, builtin ?? { kind, name: "default" },
          { ...settings, ...flat }, saved, draft, (candidate, patch) => {
            if (!current()) return;
            Object.assign(flat, patch);
            if (builtin) draft = draft.map((row) => row === builtin ? candidate : row);
            else if (candidate.enabled === false) draft.push(candidate);
            render();
          }, allowedBuiltinKeys); });
        group.append(main);
        group.append(label([enabled ? "включено" : "отключено", known?.configured && (known.source === "environment" ? "ключ из окружения" : "сохранённые данные"),
          known?.cache_hints?.refused && "сервер отказался от подсказок кэша"].filter(Boolean).join(" · "), "dim-label"));
        for (const item of draft.filter((candidate) => candidate.kind === kind && candidate.name !== "default")) {
          const actions = row();
          actions.append(button(`${item.label || item.name || "Подключение"} · ${item.name}`, () => { if (!current() || !draft.includes(item)) return; this.edit(dialog, kind, item,
            { ...settings, ...flat }, saved, draft, (candidate) => {
              if (!current() || !draft.includes(item)) return;
              draft = draft.map((row) => row === item ? candidate : row);
              render();
            }); }));
          actions.append(button("Убрать…", () => {
            if (!current() || !draft.includes(item)) return;
            void confirm(dialog, `Убрать «${item.name}»?`, "После сохранения маршруты на это подключение могут стать недоступны.", "Убрать", cancel)
              .then((allowed) => { if (allowed && current()) { draft = draft.filter((row) => row !== item); render(); } });
          }));
          group.append(actions);
          const known = facts.find((fact) => fact.kind === kind && !fact.builtin && fact.name === item.name);
          group.append(label([item.enabled === false ? "отключено" : "включено", known?.configured && "ключ или адрес настроен",
            known?.cache_hints?.refused && "сервер отказался от подсказок кэша"].filter(Boolean).join(" · "), "dim-label"));
        }
        group.append(button(`Добавить подключение ${spec.title}…`, () => { if (!current()) return; this.edit(dialog, kind, { kind, name: "", enabled: true },
          { ...settings, ...flat }, saved, draft, (candidate) => { if (current()) { draft.push(candidate); render(); } }); }));
        list.append(group);
      }
    };
    content.append(label("Подключения и ключи применяются после общего сохранения настроек. Пробный запрос выполняется сразу.", "dim-label"));
    content.append(list);
    content.append(button("Применить к настройкам", () => {
      if (!open || staged) return;
      staged = true;
      stage({ ...flat, ...(JSON.stringify(draft) !== JSON.stringify(original) ? { [connectionsKey]: draft } : {}) });
      dialog.close();
    }));
    this.present(dialog);
    render();
  }

  private edit(parent: any, kind: string, original: SettingsDocument, settings: SettingsDocument, saved: SettingsDocument,
    currentRows: SettingsDocument[], apply: (row: SettingsDocument, flat: SettingsDocument) => void, allowedBuiltinKeys?: ReadonlySet<string>): void {
    const spec = kinds[kind];
    const cancel = new Gio.Cancellable();
    let open = true;
    const builtin = original.name === "default";
    const oldName = String(original.name ?? "");
    const content = column();
    const dialog = sheet(spec.title, content);
    const parentSignal = parent.connect(parent instanceof Gtk.Window ? "close-request" : "closed", () => { if (open) dialog.force_close(); return false; });
    const form = column();
    const status = label("", "dim-label");
    const models = column(4);
    const enabled = new Gtk.CheckButton({ label: "Подключение включено", active: original.enabled !== false });
    form.append(enabled);
    const name = new Gtk.Entry({ text: oldName, placeholder_text: "Идентификатор подключения" });
    const title = new Gtk.Entry({ text: String(original.label ?? ""), placeholder_text: "Отображаемое имя" });
    if (!builtin) {
      form.append(name);
      form.append(title);
    }
    const pairFields = kind === "openai-compatible" && builtin ? [...spec.fields, ...openaiLegacy] : spec.fields;
    const savedRow = rows(saved[connectionsKey]).find((row) => row.kind === kind && row.name === oldName);
    const fields = pairFields.map((definition): EditableField => {
      const [field, key, caption, secret] = definition;
      const value = String((builtin ? settings[key] : original[field]) ?? "");
      const savedValue = String((builtin ? saved[key] : savedRow?.[field]) ?? "");
      const editable = !builtin || !allowedBuiltinKeys || allowedBuiltinKeys.has(key);
      const labelText = kind === "openai-compatible" && key.startsWith("OPENAI_") && !key.startsWith("OPENAI_COMPATIBLE_")
        ? `${caption} (пара OpenAI для совместимости)` : caption;
      form.append(label(labelText));
      if (!secret) {
        const input = new Gtk.Entry({ text: value, placeholder_text: labelText, editable });
        form.append(input);
        return { definition, value: () => input.get_text().trim() };
      }
      const keep = new Gtk.CheckButton({ label: "Сохранить заданное значение", active: masked(value), visible: masked(value), sensitive: editable });
      const input = new Gtk.PasswordEntry({ text: masked(value) ? "" : value, placeholder_text: labelText, show_peek_icon: true, editable });
      form.append(input);
      form.append(keep);
      if (savedValue) form.append(button(`Показать сохранённое значение · ${labelText}…`, () => {
        if (!open || !builtin && !oldName) return;
        this.reveal(dialog, builtin ? { key } : { connection: `${kind}@${oldName}`, field });
      }));
      return { definition, value: () => input.get_text() || (keep.get_active() ? value : "") };
    });
    const routing = new Gtk.Entry({ text: typeof original.provider_routing === "object" ? JSON.stringify(original.provider_routing) : String(original.provider_routing ?? ""),
      placeholder_text: "Маршрутизация OpenRouter (пресет или JSON)" });
    if (!builtin && kind === "openrouter") form.append(routing);
    const collect = () => {
      const connection = builtin ? "default" : name.get_text().trim();
      if (!builtin && (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(connection) || connection === "default")) {
        throw new Error("Идентификатор должен начинаться с латинской строчной буквы или цифры и содержать до 32 символов.");
      }
      if (!builtin && currentRows.some((row) => row !== original && row.kind === kind && row.name === connection)) {
        throw new Error("Подключение с таким идентификатором уже есть.");
      }
      const all: Record<string, string> = {};
      const patch: SettingsDocument = {};
      const candidate: SettingsDocument = { kind, name: connection, enabled: enabled.get_active() };
      const secrets: string[] = [];
      for (const field of fields) {
        const [rowKey, key, , secret] = field.definition;
        const value = field.value();
        if (secret && value) {
          if (!builtin && masked(value) && (connection !== oldName || !savedRow)) throw new Error("Для нового идентификатора введите ключ заново.");
          secrets.push(value);
        }
        all[builtin ? key : rowKey] = value;
        if (builtin && value !== String(settings[key] ?? "")) patch[key] = value;
        else if (!builtin && value !== String(original[rowKey] ?? "")) candidate[rowKey] = value;
        else if (!builtin && Object.hasOwn(original, rowKey)) candidate[rowKey] = original[rowKey];
      }
      if (!builtin) {
        candidate.label = title.get_text().trim();
        if (kind === "openrouter" && routing.get_text().trim()) {
          const value = routing.get_text().trim();
          candidate.provider_routing = value === JSON.stringify(original.provider_routing) ? original.provider_routing : value;
        }
      }
      return { connection, all, candidate, patch, secrets };
    };
    let busy = false;

    const buttons = row();
    const run = async (discover: boolean) => {
      if (busy || !open) return;
      busy = true;
      form.set_sensitive(false);
      buttons.set_sensitive(false);
      clear(models);
      let secrets: string[] = [];
      try {
        const draft = collect();
        secrets = draft.secrets;
        const compatible = kind === "openai-compatible";
        const dedicated = Boolean(draft.all.OPENAI_COMPATIBLE_BASE_URL);
        const key = dedicated ? "OPENAI_COMPATIBLE_API_KEY" : "OPENAI_API_KEY";
        const address = dedicated ? "OPENAI_COMPATIBLE_BASE_URL" : "OPENAI_BASE_URL";
        const selector = builtin ? {} : { connection: draft.connection };
        status.set_label(discover ? "Шлюз читает список моделей…" : "Шлюз выполняет пробный запрос…");
        if (discover) {
          const baseUrl = draft.all[builtin ? address : "base_url"];
          if (!baseUrl) throw new Error("Укажите базовый URL.");
          const reply = await this.gateway.json<{ models: string[]; error?: string }>("POST", "/api/openai-compatible/models", {
            baseUrl, apiKey: draft.all[builtin ? key : "api_key"], ...selector, ...(builtin ? { apiKeySetting: key } : {}),
          }, ownerHeaders, true, cancel);
          if (!open) return;
          if (!reply || !Array.isArray(reply.models) || reply.models.some(item => typeof item !== "string")
            || (reply.error !== undefined && typeof reply.error !== "string")) throw new Error("Шлюз не подтвердил список моделей.");
          if (reply.error) throw new Error(reply.error);
          status.set_label(`Получено моделей · ${reply.models.length}`);
          const prefix = builtin ? "openai-compatible" : `openai-compatible@${draft.connection}`;
          for (const item of reply.models) {
            const model = label(`${prefix}::${item}`);
            model.set_selectable(true);
            models.append(model);
          }
        } else {
          const overrides = builtin
            ? Object.fromEntries(Object.entries(draft.all).filter(([name, value]) => value !== String(saved[name] ?? "")
              && (!compatible || name === key || name === address)))
            : draft.all;
          if (compatible && builtin) overrides.OPENAI_COMPATIBLE_BASE_URL = draft.all.OPENAI_COMPATIBLE_BASE_URL;
          const reply = await this.gateway.json<{ ok: boolean; error?: string; code?: string }>("POST", "/api/providers/test", {
            provider_id: kind, overrides, ...selector, ...(compatible && builtin ? { api_key_setting: key } : {}),
          }, ownerHeaders, true, cancel);
          if (!open) return;
          if (!reply || typeof reply.ok !== "boolean" || [reply.error, reply.code].some(value => value !== undefined && typeof value !== "string")) {
            throw new Error("Шлюз не подтвердил результат пробного запроса.");
          }
          status.set_label(reply.ok ? "Пробный запрос прошёл." : redact(["Пробный запрос отклонён", reply.code, reply.error].filter(Boolean).join(" · "), secrets));
        }
      } catch (error) {
        if (open) status.set_label(redact(errorText(error), secrets));
      } finally {
        busy = false;
        if (open) {
          form.set_sensitive(true);
          buttons.set_sensitive(true);
        }
      }
    };
    buttons.append(button("Пробный запрос", () => void run(false)));
    if (kind === "openai-compatible") buttons.append(button("Получить модели", () => void run(true)));
    buttons.append(button("Применить к черновику", () => {
      if (!open || busy) return;
      busy = true;
      try {
        const draft = collect();
        apply(draft.candidate, draft.patch);
        dialog.close();
      } catch (error) { if (open) status.set_label(errorText(error)); }
      finally { busy = false; }
    }));
    dialog.connect("closed", () => {
      if (!open) return;
      open = false; cancel.cancel();
      for (let child = form.get_first_child(); child; child = child.get_next_sibling()) {
        if (child instanceof Gtk.PasswordEntry) child.set_text("");
      }
      clear(models); form.set_sensitive(false); buttons.set_sensitive(false);
      parent.disconnect(parentSignal);
    });
    for (const widget of [form, label("Пробный запрос выполняет одно обращение к модели и может учитываться провайдером.", "dim-label"), buttons, status, models]) content.append(widget);
    this.present(dialog, parent);
  }

  private reveal(parent: any, selector: SecretSelector): void {
    showSavedSecret(parent, this.gateway, this.present, selector, "Секрет провайдера");
  }
}
