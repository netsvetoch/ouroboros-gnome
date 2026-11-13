import { type Gateway, HttpError } from "./gateway.js";
import { Adw, Gio, GLib, Gtk } from "./gi.js";
import { object, type SettingsDocument } from "./settings-write.js";
import { button, clear, column, confirm, errorText, label, sheet } from "./ui.js";

export const callSettingsPath = "/api/extensions/live_conversation/config";

interface Choice { id: string; label?: string }
interface CallModel extends Choice {
  default?: boolean;
  voices?: Choice[];
  thinking_levels?: string[];
  thinking_default?: string;
  honours?: string[];
  notes?: [string, string][];
  facts?: { conversation_window_tokens?: number | null; accepted_input_tokens?: number | null; working_reserve_tokens?: number | null; basis?: string; source?: string; observed?: string; acceptance_can_raise?: boolean };
  vision?: boolean;
  silent_tool_results?: boolean;
}
interface CallProvider extends Choice { privacy?: string; models?: CallModel[] }
export interface CallConfig {
  enabled?: boolean;
  offered?: boolean;
  provider?: string;
  model?: string;
  voice?: string;
  instructions?: string;
  pause?: string;
  interruptions?: boolean;
  thinking?: string;
  search?: boolean;
  selected_model?: CallModel | null;
  catalogs?: CallProvider[];
}

export function readCallConfig(raw: unknown): CallConfig {
  const record = (v: unknown): v is Record<string, any> => object(v) === v;
  const strings = (v: Record<string, any>, keys: string[]) => keys.every(key => v[key] === undefined || typeof v[key] === "string");
  const list = (v: unknown) => Array.isArray(v) && v.every(value => typeof value === "string");
  const choice = (v: unknown): boolean => record(v) && typeof v.id === "string" && !!v.id && strings(v, ["label"]);
  const unique = (values: any[]) => new Set(values.map(value => value.id)).size === values.length;
  const model = (v: unknown): boolean => {
    if (!record(v) || !choice(v) || !strings(v, ["thinking_default"]) || ["default", "vision", "silent_tool_results"].some(key => v[key] !== undefined && typeof v[key] !== "boolean")
      || (v.voices !== undefined && (!Array.isArray(v.voices) || !v.voices.every(choice) || !unique(v.voices)))
      || ["thinking_levels", "honours"].some(key => v[key] !== undefined && !list(v[key]))
      || (v.notes !== undefined && (!Array.isArray(v.notes) || v.notes.some((note: unknown) => !Array.isArray(note) || note.length !== 2 || !note.every(value => typeof value === "string"))))) return false;
    if (v.facts !== undefined) {
      if (!record(v.facts) || !strings(v.facts, ["basis", "source", "observed"]) || (v.facts.acceptance_can_raise !== undefined && typeof v.facts.acceptance_can_raise !== "boolean")
        || ["conversation_window_tokens", "accepted_input_tokens", "working_reserve_tokens"].some(key => v.facts[key] != null && (!Number.isSafeInteger(v.facts[key]) || v.facts[key] < 1))) return false;
      if (v.facts.conversation_window_tokens != null && v.facts.working_reserve_tokens != null && v.facts.working_reserve_tokens >= v.facts.conversation_window_tokens) return false;
    }
    return true;
  };
  if (!record(raw) || (raw.offered === true && raw.enabled !== true) || ["enabled", "offered", "interruptions", "search"].some(key => typeof raw[key] !== "boolean")
    || ["provider", "model", "voice", "instructions", "pause", "thinking"].some(key => typeof raw[key] !== "string")
    || !Array.isArray(raw.catalogs) || !unique(raw.catalogs.filter(record)) || raw.catalogs.some(provider => !record(provider) || !choice(provider)
      || !strings(provider, ["privacy"]) || !Array.isArray(provider.models) || !provider.models.every(model) || !unique(provider.models))
    || (raw.selected_model != null && !model(raw.selected_model))) throw new Error("Шлюз не вернул пригодные настройки и каталог вызовов.");
  return raw as CallConfig;
}

function select(parent: any, caption: string, available: Choice[], current: string): { widget: any; value: () => string } {
  const choices = available.filter((item) => item && typeof item.id === "string");
  if (current && !choices.some((item) => item.id === current)) choices.unshift({ id: current, label: `${current} · недоступно` });
  const widget = Gtk.DropDown.new_from_strings(choices.map((item) => item.label || item.id));
  widget.set_selected(Math.max(0, choices.findIndex((item) => item.id === current)));
  parent.append(label(caption));
  parent.append(widget);
  return { widget, value: () => choices[widget.get_selected()]?.id ?? "" };
}

export class CallSettings {
  private dialog?: any;
  private disposed = false;

  constructor(private readonly parent: any, private readonly gateway: Gateway, private readonly updated: (config: CallConfig) => void,
    private readonly openDevices: (parent: any) => void) {}

  show(parent = this.parent): void {
    if (this.disposed || this.dialog) return;
    const content = column();
    const controls = column();
    const status = label("", "dim-label");
    const dialog = sheet("Настройки голосовых вызовов", content);
    dialog.set_content_width(650);
    this.dialog = dialog;
    let open = true, generation = 0, parentSignal = 0;
    const cancel = new Gio.Cancellable();
    let selectors: any[] = [], retired: any[] = [];
    let retirementIdle = 0;
    const flushRetired = () => { const old = retired; retired = []; for (const control of old) control.run_dispose(); };
    const releaseSelectors = (defer = false) => {
      const old = selectors; selectors = [];
      for (const control of old) if (control.get_parent() === controls) controls.remove(control);
      retired.push(...old);
      // A model/provider change is inside the selector's property notification.
      // Finish that notification before disposing the old native selector.
      if (defer) {
        if (retired.length && !retirementIdle) retirementIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
          retirementIdle = 0; flushRetired(); return GLib.SOURCE_REMOVE;
        });
      } else {
        if (retirementIdle) { GLib.source_remove(retirementIdle); retirementIdle = 0; }
        flushRetired();
      }
    };
    const dispose = () => {
      if (!open) return;
      open = false; ++generation; cancel.cancel(); releaseSelectors();
      if (parentSignal) { parent.disconnect(parentSignal); parentSignal = 0; }
      if (this.dialog === dialog) this.dialog = undefined;
    };
    dialog.connect("closed", dispose);
    if (parent instanceof Adw.Dialog || parent instanceof Gtk.Window) parentSignal = parent.connect(
      parent instanceof Gtk.Window ? "close-request" : "closed", () => { if (open) { dispose(); dialog.force_close(); } return false; });
    const current = () => open && this.dialog === dialog && !this.disposed;
    let config: CallConfig | undefined;
    let draft: CallConfig = {};
    let busy = false;
    let unconfirmed: SettingsDocument | undefined;
    let unconfirmedRecovery = false, readFailed = false, recoveryAfterRead = false;
    const refresh = button("Перечитать", () => void read());
    const save = button("Сохранить настройки вызовов", () => void write());
    const recovery = button("Восстановить выключенные вызовы…", () => void recover());
    recovery.add_css_class("destructive-action");
    recovery.set_visible(false);
    save.add_css_class("suggested-action");
    save.set_sensitive(false);
    const presentBusy = (value: boolean) => {
      busy = value;
      refresh.set_sensitive(!busy);
      controls.set_sensitive(!busy && Boolean(config) && !unconfirmed);
      save.set_sensitive(!busy && Boolean(config) && !unconfirmed);
      recovery.set_visible(readFailed);
      recovery.set_sensitive(!busy && readFailed && (!unconfirmed || recoveryAfterRead));
    };
    const read = async () => {
      if (!current() || busy) return;
      presentBusy(true);
      status.set_label("Читаю настройки навыка вызовов…");
      try {
        const raw = await this.gateway.json<unknown>("GET", callSettingsPath, undefined, undefined, false, cancel);
        if (!current()) return;
        const reply = readCallConfig(raw);
        config = reply;
        draft = { ...reply };
        render();
        this.updated(reply);
        const access = reply.offered ? "Вызовы доступны." : "Шлюз пока не предлагает вызовы. Проверьте настройки движка и доступ к нему.";
        const receipt = unconfirmed && (Object.entries(unconfirmed).every(([key, value]) => reply[key as keyof CallConfig] === value)
          ? unconfirmedRecovery ? "Выключенное состояние подтверждено чтением. В форме показаны текущие настройки." : "Настройки подтверждены чтением."
          : "Шлюз вернул другие значения. В форме показаны сохранённые настройки.");
        unconfirmed = undefined; unconfirmedRecovery = false; readFailed = false; recoveryAfterRead = true;
        status.set_label([receipt, access].filter(Boolean).join(" "));
      } catch (error) {
        if (current()) {
          config = undefined; readFailed = true; recoveryAfterRead = true;
          status.set_label([unconfirmed && "Предыдущая запись не подтверждена.", values && "Показаны последние прочитанные настройки. Сохранение недоступно до успешного чтения.", errorText(error)].filter(Boolean).join(" "));
        }
      } finally { if (current()) presentBusy(false); }
    };
    let values: (() => SettingsDocument) | undefined;
    const submit = async (payload: SettingsDocument, restoring: boolean) => {
      presentBusy(true);
      recoveryAfterRead = false;
      unconfirmed = undefined; unconfirmedRecovery = false;
      status.set_label(restoring ? "Восстанавливаю выключенные настройки вызовов…" : "Сохраняю настройки вызовов…");
      try {
        const raw = await this.gateway.json<unknown>("POST", callSettingsPath, payload, undefined, false, cancel);
        if (!current()) return;
        const reply = readCallConfig(raw);
        if (!Object.entries(payload).every(([key, value]) => reply[key as keyof CallConfig] === value)) throw new Error("Шлюз вернул подтверждение других настроек вызовов. Перечитайте сохранённые значения.");
        config = reply;
        draft = { ...reply };
        readFailed = false;
        render();
        this.updated(reply);
        status.set_label(restoring ? "Настройки восстановлены. Вызовы выключены. Выберите движок и параметры перед включением."
          : reply.offered ? "Настройки сохранены. Вызовы доступны." : "Настройки сохранены.");
      } catch (error) {
        if (current()) {
          if (!(error instanceof HttpError) || error.status === 408 || error.status >= 500) {
            unconfirmed = payload; unconfirmedRecovery = restoring;
          }
          status.set_label([unconfirmed && "Запись не подтверждена. Перечитайте настройки перед повтором.", errorText(error)]
            .filter(Boolean).join(" "));
        }
      } finally { if (current()) presentBusy(false); }
    };
    const write = async () => {
      if (!current() || !values || !config || busy || unconfirmed) return;
      await submit(values(), false);
    };
    const recover = async () => {
      if (!current() || busy || !readFailed || (unconfirmed && !recoveryAfterRead)) return;
      presentBusy(true);
      try {
        const warning = "Шлюз заменит настройки вызовов стандартными и выключит вызовы. Выбранные движок, голос, инструкции и другие параметры будут сброшены. Активные вызовы будут завершены."
          + (unconfirmed ? " Предыдущая запись не подтверждена; это новое действие заменит текущие настройки независимо от её исхода." : "");
        if (!await confirm(dialog, "Восстановить настройки и выключить вызовы?", warning, "Восстановить и выключить", cancel) || !current()) return;
        // The plugin supplies its own defaults; do not embed a provider or voices here.
        await submit({ enabled: false }, true);
      } finally { if (current()) presentBusy(false); }
    };
    const render = () => {
      if (!current()) return;
      const version = ++generation;
      releaseSelectors(true);
      clear(controls);
      const catalogs = Array.isArray(config?.catalogs) ? config.catalogs : [];
      const enabled = new Gtk.CheckButton({ label: "Включить голосовые вызовы (бета)", active: draft.enabled === true });
      controls.append(enabled);
      const providers = select(controls, "Движок", catalogs, draft.provider ?? "");
      const provider = catalogs.find((item) => item.id === providers.value());
      const models = Array.isArray(provider?.models) ? provider.models : [];
      const model = models.find((item) => draft.model ? item.id === draft.model : item.default);
      const supports = (knob: string) => model && (!Array.isArray(model.honours) || model.honours.includes(knob));
      if (!provider) controls.append(label("Выбранный движок отсутствует в каталоге шлюза.", "dim-label"));
      const modelChoice = select(controls, "Модель", [{ id: "", label: "По умолчанию" }, ...models], draft.model ?? "");
      const voices = select(controls, "Голос", [{ id: "", label: "По умолчанию" }, ...(model?.voices ?? [])], draft.voice ?? "");
      const pause = supports("pause") ? select(controls, "Пауза перед ответом", [
        { id: "short", label: "Короткая" }, { id: "normal", label: "Обычная" }, { id: "long", label: "Длинная" },
      ], draft.pause ?? "normal") : undefined;
      const defaultThinking = model?.thinking_default || model?.thinking_levels?.[0];
      const thinking = supports("thinking") ? select(controls, "Глубина рассуждения", [
        { id: "", label: defaultThinking ? `По умолчанию · ${defaultThinking}` : "По умолчанию" },
        ...(model?.thinking_levels ?? []).map((id) => ({ id })),
      ], draft.thinking ?? "") : undefined;
      const interrupts = new Gtk.CheckButton({ label: "Прерывать ответ голосом", active: draft.interruptions !== false });
      const search = new Gtk.CheckButton({ label: "Разрешить поиск движка", active: draft.search !== false });
      if (supports("interruptions")) controls.append(interrupts);
      if (supports("search")) controls.append(search);
      const view = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR });
      const buffer = view.get_buffer();
      buffer.set_text(draft.instructions ?? "", -1);
      controls.append(label("Инструкции для следующего вызова"));
      controls.append(new Gtk.ScrolledWindow({ child: view, min_content_height: 100 }));
      if (provider?.privacy) controls.append(label(provider.privacy, "dim-label"));
      const facts = model?.facts;
      const window = facts?.conversation_window_tokens;
      const basis = facts?.basis === "estimator" ? "токенов по оценке Ouroboros"
        : facts?.basis === "provider" ? "токенов провайдера" : "токенов";
      controls.append(label(window ? `Окно разговора · ${window.toLocaleString()} ${basis}` : "Размер окна разговора неизвестен.", "dim-label"));
      if (facts?.source) controls.append(label(facts.source, "dim-label"));
      for (const note of model?.notes ?? []) if (Array.isArray(note) && note[1]) controls.append(label(note[1], "dim-label"));
      const count = (title: string, value: number | null | undefined) => {
        if (value != null) controls.append(label(`${title} · ${value.toLocaleString()} · ${basis}`, "dim-label"));
      };
      count("Принятый объём входа", facts?.accepted_input_tokens);
      count("Рабочий резерв", facts?.working_reserve_tokens);
      if (facts?.accepted_input_tokens != null) controls.append(label("Принятый объём входа — отдельное наблюдение; он не заменяет окно разговора.", "dim-label"));
      if (facts?.observed) controls.append(label(`Дата сведений · ${facts.observed}`, "dim-label"));
      if (typeof facts?.acceptance_can_raise === "boolean") controls.append(label(facts.acceptance_can_raise
        ? "Подтверждённый вход может увеличивать окно разговора этого маршрута." : "Принятый вход не увеличивает окно разговора этого маршрута.", "dim-label"));
      if (typeof model?.vision === "boolean") controls.append(label(model.vision ? "Изображения и видео · поддерживаются" : "Изображения и видео · не поддерживаются", "dim-label"));
      if (typeof model?.silent_tool_results === "boolean") controls.append(label(model.silent_tool_results ? "Тихие результаты инструментов · поддерживаются" : "Тихие результаты инструментов · не поддерживаются", "dim-label"));
      selectors = [providers.widget, modelChoice.widget, voices.widget, pause?.widget, thinking?.widget].filter(Boolean);
      values = () => ({
        enabled: enabled.get_active(), provider: providers.value(), model: modelChoice.value(), voice: voices.value(),
        pause: pause?.value() ?? draft.pause ?? "normal", interruptions: interrupts.get_active(),
        thinking: thinking?.value() ?? draft.thinking ?? "", search: search.get_active(),
        instructions: buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false),
      });
      providers.widget.connect("notify::selected", () => {
        if (!current() || version !== generation || busy || unconfirmed) return;
        draft = { ...values?.(), model: "", voice: "", thinking: "" };
        render();
      });
      modelChoice.widget.connect("notify::selected", () => {
        if (!current() || version !== generation || busy || unconfirmed) return;
        draft = { ...values?.(), voice: "", thinking: "" };
        render();
      });
    };
    content.append(refresh);
    content.append(status);
    content.append(controls);
    content.append(save);
    content.append(recovery);
    content.append(button("Устройства вызова…", () => { if (current() && !busy) this.openDevices(dialog); }));
    dialog.present(parent);
    void read();
  }

  close(): void {
    this.disposed = true;
    this.dialog?.force_close();
  }
}
