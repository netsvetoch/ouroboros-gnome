import { type Gateway, HttpError } from "./gateway.js";
import { Adw, Gio, Gtk } from "./gi.js";
import { object, type SettingsDocument } from "./settings-write.js";
import { button, clear, column, errorText, label, sheet } from "./ui.js";

const modelKeys = ["OUROBOROS_MODEL", "OUROBOROS_MODEL_LIGHT", "OUROBOROS_MODEL_SAFETY", "OUROBOROS_MODEL_VISION",
  "OUROBOROS_MODEL_CONSCIOUSNESS", "OUROBOROS_MODEL_FALLBACKS"];
const optionKeys = ["OUROBOROS_MODEL_ACCOUNTS", "OUROBOROS_MODEL_CONTEXT_WINDOWS", "OUROBOROS_MODEL_PROCESSING_PREFERENCES",
  "OUROBOROS_PROCESSING_PREFERENCE"];
const localKeys = ["LOCAL_MODEL_SOURCE", "LOCAL_MODEL_FILENAME", "LOCAL_MODEL_CONTEXT_LENGTH", "LOCAL_MODEL_N_GPU_LAYERS", "LOCAL_MODEL_CHAT_FORMAT"];
const localFlags = ["USE_LOCAL_MAIN", "USE_LOCAL_LIGHT", "USE_LOCAL_CONSCIOUSNESS", "USE_LOCAL_FALLBACK"];

function diagnostics(value: unknown): string {
  return Array.isArray(value) ? value.map(object).map(item => item.message || item.detail || item.code)
    .filter(Boolean).map(item => typeof item === "string" ? item : JSON.stringify(item)).join("\n") : "";
}

function previewPayload(settings: SettingsDocument, saved: SettingsDocument, selection: number, localMode: string, keepDraft: boolean, emptyReview: boolean): SettingsDocument {
  const keys = [...modelKeys, ...optionKeys, ...localKeys, "OUROBOROS_RUNTIME_MODE", "OUROBOROS_REVIEW_ENFORCEMENT"];
  const body: SettingsDocument = {};
  for (const key of keys) if (Object.hasOwn(settings, key)) body[key] = settings[key];
  const providerFields = object(object(saved._meta).setup_contract).providerFields;
  if (Array.isArray(providerFields)) {
    for (const raw of providerFields) {
      const field = object(raw);
      const key = field.settingKey;
      if (typeof key !== "string" || typeof saved[key] !== "string") continue;
      const value = saved[key];
      body[key] = field.inputType === "password" && value ? "***set***" : value;
    }
  }
  if (keepDraft && Object.hasOwn(settings, "OUROBOROS_SUBAGENTS")) {
    body.OUROBOROS_SUBAGENTS = settings.OUROBOROS_SUBAGENTS;
    if (emptyReview) body.allow_empty_review_pool = true;
  }
  body.LOCAL_ROUTING_MODE = localMode;
  body.subscriptionsConnected = selection !== 0;
  body.skipSubscriptionPresets = selection === 2;
  return body;
}

export function showSubagentPreview(gateway: Gateway, settings: SettingsDocument, saved: SettingsDocument, parent: any,
  present: (dialog: any, parent: any) => void, apply: (catalog: SettingsDocument, models: SettingsDocument) => void): any {
  const content = column();
  const dialog = sheet("Предложенный состав субагентов", content);
  const mode = Gtk.DropDown.new_from_strings(["По настройкам моделей", "Учесть подключённые подписки", "Использовать Main для ревью"]);
  const localModes = ["cloud", "fallback", "all"];
  const local = Gtk.DropDown.new_from_strings(["Облачные модели", "Локальная резервная модель", "Все роли локальные"]);
  const flags = localFlags.map(key => /^(?:1|true|yes|on)$/i.test(String(settings[key] ?? "")));
  const hasLocal = Boolean(settings.LOCAL_MODEL_SOURCE);
  const mixed = hasLocal && flags.slice(0, 3).some(Boolean) && !flags.every(Boolean);
  local.set_selected(flags.every(Boolean) || mixed ? 2 : flags[3] ? 1 : 0);
  const keepDraft = new Gtk.CheckButton({ label: "Сохранить текущие строки и отметки ревью", active: Object.hasOwn(settings, "OUROBOROS_SUBAGENTS") });
  const emptyReview = new Gtk.CheckButton({ label: "Разрешить пустой пул ревью", active: false });
  const status = label("");
  const output = column();
  let open = true;
  let generation = 0;
  let pending: any;
  let applied = false;
  let parentSignal = 0;
  const dispose = () => {
    if (!open) return;
    open = false;
    ++generation;
    pending?.cancel();
    pending = undefined;
    if (parentSignal) { parent.disconnect(parentSignal); parentSignal = 0; }
    for (const control of [mode, local]) {
      if (control.get_parent() === content) content.remove(control);
      control.run_dispose();
    }
  };
  dialog.connect("closed", dispose);
  if (parent instanceof Adw.Dialog || parent instanceof Gtk.Window) parentSignal = parent.connect(
    parent instanceof Gtk.Window ? "close-request" : "closed", () => { if (open) { dispose(); dialog.force_close(); } return false; });
  const calculate = button("Рассчитать состав", () => void load());
  const invalidate = () => {
    if (!open) return;
    ++generation;
    pending?.cancel();
    pending = undefined;
    clear(output);
    calculate.set_sensitive(true);
    status.set_label("");
  };
  mode.connect("notify::selected", invalidate);
  local.connect("notify::selected", invalidate);
  keepDraft.connect("toggled", () => { if (open) emptyReview.set_sensitive(keepDraft.get_active()); invalidate(); });
  emptyReview.connect("toggled", invalidate);
  emptyReview.set_sensitive(keepDraft.get_active());
  const load = async () => {
    if (!open || pending || applied) return;
    const cancel = pending = new Gio.Cancellable();
    const read = ++generation;
    const selection = mode.get_selected();
    clear(output);
    status.set_label("Шлюз рассчитывает состав…");
    calculate.set_sensitive(false);
    try {
      const reply = await gateway.json<SettingsDocument>("POST", "/api/onboarding/subagents/preview",
        previewPayload(settings, saved, selection, hasLocal ? localModes[local.get_selected()] : "cloud", keepDraft.get_active(), emptyReview.get_active()), undefined, true, cancel);
      if (!open || read !== generation) return;
      const catalog = object(reply.available_subagents);
      const record = (v: unknown): v is SettingsDocument => object(v) === v;
      const strings = (v: SettingsDocument, keys: string[]) => keys.every(key => v[key] == null || typeof v[key] === "string");
      const ids = new Set<string>();
      if (reply.ok !== true || typeof catalog.enabled !== "boolean" || !Array.isArray(catalog.items)
        || catalog.items.some(item => !record(item) || typeof item.subagent_id !== "string" || !item.subagent_id
          || ids.has(item.subagent_id) || !ids.add(item.subagent_id) || typeof item.recommended_use !== "string"
          || !record(item.route) || !["api_model", "agent_session"].includes(String(item.route.kind))
          || typeof item.route.target_id !== "string" || !item.route.target_id || !strings(item.route, ["credential_profile_id"])
          || !strings(item, ["effort", "processing_preference", "access", "delivery", "minted_from"])
          || ["enabled", "review_eligible", "rechecks_flags"].some(key => item[key] != null && typeof item[key] !== "boolean"))
        || (reply.source !== undefined && typeof reply.source !== "string")
        || (reply.diagnostics !== undefined && (!Array.isArray(reply.diagnostics) || reply.diagnostics.some(v => !record(v))))
        || !record(reply.model_settings)
        || modelKeys.some(key => Object.hasOwn(reply.model_settings as SettingsDocument, key) && typeof object(reply.model_settings)[key] !== "string")
        || (Object.hasOwn(object(reply.model_settings), "OUROBOROS_PROCESSING_PREFERENCE")
          && typeof object(reply.model_settings).OUROBOROS_PROCESSING_PREFERENCE !== "string")
        || optionKeys.some(key => Object.hasOwn(reply.model_settings as SettingsDocument, key)
          && typeof object(reply.model_settings)[key] !== "string" && !record(object(reply.model_settings)[key]))) {
        throw new Error("Шлюз не вернул пригодный состав субагентов.");
      }
      const notices = diagnostics(reply.diagnostics);
      status.set_label(["Шлюз рассчитал состав.", notices].filter(Boolean).join("\n"));
      if (typeof reply.source === "string") output.append(label(`Источник предложения · ${reply.source}`, "dim-label"));
      output.append(label(`Предложено строк · ${catalog.items.length}`, "heading"));
      for (const item of catalog.items) {
        const route = object(item.route);
        output.append(label([item.subagent_id, route.target_id, route.credential_profile_id,
          item.review_eligible === true && "Ревью", item.enabled === false && "Выключен"].filter(Boolean).join(" · ")));
      }
      const offered = object(reply.model_settings);
      const assignments = Object.fromEntries([...modelKeys, ...optionKeys].filter(key => Object.hasOwn(offered, key))
        .map(key => [key, offered[key]]));
      const withModels = new Gtk.CheckButton({ label: "Также перенести предложенные назначения моделей" });
      if (Object.keys(assignments).length) {
        output.append(label(Object.entries(assignments).map(([key, value]) => `${key} · ${typeof value === "string" ? value || "по умолчанию" : JSON.stringify(value)}`).join("\n")));
        output.append(withModels);
      }
      output.append(button("Заменить состав в черновике", () => {
        if (!open || applied || read !== generation) return;
        applied = true;
        apply(catalog, withModels.get_active() ? assignments : {});
        dialog.close();
      }));
    } catch (error) {
      if (!open || read !== generation) return;
      const detail = error instanceof HttpError ? object(error.body) : {};
      status.set_label([errorText(error), diagnostics(detail.diagnostics),
        detail.can_skip === true && "Для расчёта без проверки подписок выберите «Использовать Main для ревью»."].filter(Boolean).join("\n"));
    } finally {
      if (pending === cancel) pending = undefined;
      if (open && read === generation) calculate.set_sensitive(true);
    }
  };
  content.append(label("Предложение можно перенести в черновик каталога. Для расчёта используются сохранённые подключения провайдеров.", "dim-label"));
  content.append(mode);
  content.append(keepDraft);
  content.append(label("Без сохранения текущих строк шлюз создаст новый состав. Если пул ревью пуст и разрешение не задано, шлюз может дополнить его стандартными рецензентами.", "dim-label"));
  content.append(emptyReview);
  if (hasLocal) {
    content.append(label(mixed ? "Текущая маршрутизация смешанная. Для расчёта выберите один из профилей шлюза." : "Профиль локальных моделей для расчёта"));
    content.append(local);
  }
  for (const item of [calculate, status, output]) content.append(item);
  present(dialog, parent);
  return dialog;
}
