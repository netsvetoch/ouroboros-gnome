import { Gio, Gtk } from "./gi.js";
import { type Gateway, query } from "./gateway.js";
import type { Present } from "./mcp-server.js";
import type { SettingsDocument } from "./settings-write.js";
import { button, clear, column, errorText, label, sheet } from "./ui.js";

const backendKey = "OUROBOROS_WEBSEARCH_BACKEND";
const modelKey = "OUROBOROS_WEBSEARCH_MODEL";
export const webSearchKeys = new Set([backendKey, modelKey]);
const names: Record<string, string> = {
  auto: "Автоматически", openai: "OpenAI", openrouter: "OpenRouter", anthropic: "Anthropic", ddgs: "DuckDuckGo",
};
const causes: Record<string, string> = {
  no_credentials: "Нет учётных данных", package_missing: "На шлюзе отсутствует пакет",
  legacy_openai_base_url: "Старый адрес OpenAI несовместим с этим поиском",
};

interface Leg {
  source: string;
  backend?: string;
  model?: string;
  model_source?: string;
  connection?: string;
  unavailable_reason?: string;
}

interface Preview {
  scope: "builtin_web_search";
  source: string;
  model: string;
  legs: Leg[];
  unavailable: Leg[];
  error?: string;
  note?: string;
  ignored_legacy_model?: string;
  unapplied_model?: string;
}

function preview(value: Preview): Preview {
  const strings = (value: unknown, keys: string[]) => value !== null && typeof value === "object"
    && keys.every(key => (value as Record<string, unknown>)[key] === undefined
      || typeof (value as Record<string, unknown>)[key] === "string");
  const leg = (value: Leg) => strings(value, ["backend", "model", "model_source", "connection", "unavailable_reason"])
    && typeof value.source === "string" && Boolean(value.source);
  if (value?.scope !== "builtin_web_search" || typeof value.source !== "string" || typeof value.model !== "string"
    || !strings(value, ["error", "note", "ignored_legacy_model", "unapplied_model"])
    || !Array.isArray(value.legs) || !value.legs.every(leg)
    || !Array.isArray(value.unavailable) || !value.unavailable.every(leg)) {
    throw new Error("Шлюз не вернул сведения о маршрутах встроенного поиска.");
  }
  return value;
}

function lines(content: any, legs: Leg[]): void {
  for (const leg of legs) {
    const name = names[leg.source] ?? leg.source;
    const reason = leg.unavailable_reason ? causes[leg.unavailable_reason] ?? leg.unavailable_reason : undefined;
    const detail = label([name, leg.connection, leg.model, leg.backend, leg.model_source === "provider_default" && leg.model
      ? "Рекомендованная модель" : "", reason].filter(Boolean).join(" · "));
    detail.set_selectable(true);
    content.append(detail);
  }
}

export class WebSearch {
  private dialog?: any;

  constructor(private readonly gateway: Gateway, private readonly present: Present) {}

  show(settings: SettingsDocument, saved: SettingsDocument, stage: (patch: SettingsDocument) => void, parent?: any): void {
    if (this.dialog) return;
    const content = column();
    const dialog = this.dialog = sheet("Встроенный веб-поиск", content);
    const initialBackend = String(settings[backendKey] || "auto");
    const initialModel = String(settings[modelKey] || "");
    const backends = Object.keys(names);
    if (!backends.includes(initialBackend)) backends.push(initialBackend);
    const backend = Gtk.DropDown.new_from_strings(backends.map((key) => names[key] ?? key));
    backend.set_selected(backends.indexOf(initialBackend));
    const model = new Gtk.Entry({ text: initialModel, placeholder_text: "Рекомендованная модель источника" });
    const status = label("", "dim-label");
    const data = column(4);
    let open = true;
    let pending: any;
    let shown = false;
    let parentSignal = 0;
    const dispose = () => {
      if (!open) return;
      open = false;
      pending?.cancel();
      pending = undefined;
      if (this.dialog === dialog) this.dialog = undefined;
      if (parentSignal) { parent.disconnect(parentSignal); parentSignal = 0; }
    };
    dialog.connect("closed", dispose);
    if (parent) parentSignal = parent.connect("closed", () => {
      dispose();
      if (dialog.get_mapped()) dialog.force_close();
    });
    const selection = () => {
      const source = backends[backend.get_selected()] ?? "auto";
      const value = model.get_text().trim();
      const changed = source !== String(saved[backendKey] || "auto") || value !== String(saved[modelKey] || "").trim();
      return { changed, backend: source, model: changed && source === "anthropic" && value
        && !value.includes("::") && !value.startsWith("anthropic/") ? `anthropic::${value}` : value };
    };
    const read = async () => {
      if (!open) return;
      pending?.cancel();
      const cancel = new Gio.Cancellable();
      pending = cancel;
      const draft = selection();
      status.set_label("Читаю варианты маршрута…");
      try {
        const raw = await this.gateway.json<Preview>("GET", "/api/settings" + query({
          websearch_preview: 1, backend: draft.changed ? draft.backend : undefined, model: draft.changed ? draft.model : undefined,
        }), undefined, undefined, false, cancel);
        if (!open || pending !== cancel) return;
        const result = preview(raw);
        if (result.source !== draft.backend.trim().toLowerCase() || result.model !== draft.model) {
          throw new Error("Шлюз вернул маршруты для другого выбора источника или модели.");
        }
        clear(data);
        shown = true;
        status.set_label(result.error || "");
        if (result.legs.length) {
          data.append(label("Возможные маршруты в порядке попытки", "heading"));
          lines(data, result.legs);
        } else if (!result.error) data.append(label("У шлюза сейчас нет доступного маршрута.", "dim-label"));
        if (result.unavailable.length) {
          data.append(label("Недоступные маршруты", "heading"));
          lines(data, result.unavailable);
        }
        if (result.ignored_legacy_model) data.append(label(`Сохранённая модель не применяется · ${result.ignored_legacy_model}`));
        if (result.unapplied_model) data.append(label(`Автовыбор не применяет указанную модель · ${result.unapplied_model}`));
        if (result.note) data.append(label(result.note, "dim-label"));
      } catch (error) {
        if (open && pending === cancel) status.set_label([shown ? "Показан последний прочитанный маршрут." : "", errorText(error)].filter(Boolean).join(" "));
      } finally {
        if (pending === cancel) pending = undefined;
      }
    };
    const edited = () => {
      if (!open) return;
      pending?.cancel();
      pending = undefined;
      clear(data);
      shown = false;
      status.set_label("Выбор изменился. Обновите предпросмотр.");
    };
    backend.connect("notify::selected", edited);
    model.connect("changed", edited);
    model.connect("activate", () => void read());
    for (const widget of [label("Источник"), backend, label("Модель"), model,
      label("Предпросмотр использует сохранённые подключения шлюза. Источник и модель можно проверить до сохранения.", "dim-label"),
      button("Проверить маршруты", () => void read()), status, data, button("Применить к настройкам", () => {
        if (!open) return;
        const draft = selection();
        const patch: SettingsDocument = {};
        if (draft.backend !== initialBackend) patch[backendKey] = draft.backend;
        if (draft.model !== initialModel.trim()) patch[modelKey] = draft.model;
        dispose();
        stage(patch);
        dialog.close();
      })]) content.append(widget);
    this.present(dialog, parent);
    void read();
  }
}
