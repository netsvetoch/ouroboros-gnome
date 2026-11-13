import { AccountLogin } from "./accounts-login.js";
import { type Gateway, HttpError, query } from "./gateway.js";
import { gatewayStatePath, readGatewayState, writeGatewayState } from "./gateway-state.js";
import { Gio, GLib, Gtk } from "./gi.js";
import { LocalModel } from "./local-model.js";
import { ModelCatalog } from "./model-catalog.js";
import { type SetupReceipt, readSetupBoot, setupPath, setupReceipt, startSetupConsciousness } from "./onboarding-receipt.js";
import { setupRows, StarterSkills } from "./onboarding-starter.js";
import { connectionsKey, Providers } from "./providers.js";
import { type SettingsDocument, object, settingsFailure, unsaved } from "./settings-write.js";
import { button, clear, column, confirm, errorText, label, row, sheet } from "./ui.js";

const completionPath = setupPath + "/complete";
const subagentsKey = "OUROBOROS_SUBAGENTS";
interface SetupAttempt { id: string; stored?: true }
const localFields = {
  LOCAL_MODEL_SOURCE: "localSource", LOCAL_MODEL_FILENAME: "localFilename", LOCAL_MODEL_CONTEXT_LENGTH: "localContextLength",
  LOCAL_MODEL_N_GPU_LAYERS: "localGpuLayers", LOCAL_MODEL_CHAT_FORMAT: "localChatFormat",
};
const roleFields = [
  ["OUROBOROS_MODEL_ACCOUNTS", "modelAccounts", "Аккаунты по ролям"],
  ["OUROBOROS_MODEL_CONTEXT_WINDOWS", "modelContextWindows", "Окна контекста по ролям"],
  ["OUROBOROS_MODEL_PROCESSING_PREFERENCES", "modelProcessingPreferences", "Режимы обработки по ролям"],
] as const;

function string(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : Array.isArray(value) ? value.join(", ") : "";
}

function choice(container: any, caption: string, choices: SettingsDocument[], selected: unknown): () => string {
  const items = choices.filter((item) => typeof item.value === "string");
  if (typeof selected === "string" && selected && !items.some((item) => item.value === selected)) {
    items.push({ value: selected, label: selected });
  }
  const input = Gtk.DropDown.new_from_strings(items.map((item) => string(item.buttonLabel || item.label || item.value)));
  input.set_selected(Math.max(0, items.findIndex((item) => item.value === selected)));
  const note = label("", "dim-label");
  const sync = () => {
    const copy = string(items[input.get_selected()]?.copy);
    note.set_label(copy);
    note.set_visible(Boolean(copy));
  };
  input.connect("notify::selected", sync);
  sync();
  container.append(label(caption));
  container.append(input);
  container.append(note);
  return () => string(items[input.get_selected()]?.value);
}

function jsonField(container: any, caption: string, initial: unknown, optional = false): { read: () => unknown; set: (value: unknown) => void } {
  const view = new Gtk.TextView({ monospace: true, wrap_mode: Gtk.WrapMode.WORD_CHAR, height_request: 90 });
  const buffer = view.get_buffer();
  const set = (value: unknown) => buffer.set_text(value === undefined ? "" : JSON.stringify(value, null, 2), -1);
  set(initial);
  container.append(label(caption));
  container.append(new Gtk.ScrolledWindow({ child: view, min_content_height: 90 }));
  return { set, read: () => {
    const text = buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false).trim();
    if (!text && optional) return undefined;
    try {
      const value = JSON.parse(text);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch { /* Report the field without echoing its contents. */ }
    throw new Error(`В поле «${caption}» нужен объект JSON.`);
  } };
}

function entry(container: any, caption: string, initial: unknown, hint?: string): any {
  const input = new Gtk.Entry({ text: string(initial), hexpand: true });
  container.append(label(caption));
  container.append(input);
  if (hint) container.append(label(hint, "dim-label"));
  return input;
}

export class Onboarding {
  private readonly statePath: string;
  private readonly children = new Set<any>();
  private readonly providers: Providers;
  private readonly catalog: ModelCatalog;
  private readonly local: LocalModel;
  private readonly login: AccountLogin;
  private dialog?: any;
  private disposed = false;
  private readonly cancel = new Gio.Cancellable();

  constructor(private readonly parent: any, private readonly gateway: Gateway,
    private readonly changed: () => void, private readonly restart?: () => Promise<string>) {
    this.statePath = gatewayStatePath(gateway.base, "onboarding-attempt");
    const present = (child: any, parent?: any) => {
      if (!this.dialog) return;
      this.children.add(child);
      child.connect("closed", () => this.children.delete(child));
      child.present(parent ?? this.dialog);
    };
    this.providers = new Providers(gateway, present);
    this.catalog = new ModelCatalog(gateway, present);
    this.local = new LocalModel(gateway, present);
    this.login = new AccountLogin(gateway, present, () => {});
  }

  private attempts(): SetupAttempt[] {
    try {
      const value = readGatewayState(this.statePath);
      return setupRows(value).flatMap(({ id, stored }) => typeof id === "string" && /^[a-zA-Z0-9_-]{16,128}$/.test(id)
        ? [{ id, ...(stored === true ? { stored: true as const } : {}) }] : []);
    } catch {
      return [];
    }
  }

  async check(): Promise<void> {
    if (this.disposed || this.dialog) return;
    if (this.attempts().length) { this.show(); return; }
    try {
      const status = await this.gateway.status(setupPath, this.cancel);
      if (status === 200) this.show();
    } catch { /* A manual open can show bootstrap or connection errors. */ }
  }

  show(parent = this.parent): void {
    if (this.dialog || this.disposed) return;
    const content = column();
    const dialog = sheet("Первичная настройка Ouroboros", content);
    const cancel = new Gio.Cancellable();
    dialog.set_content_width(740);
    dialog.set_content_height(680);
    this.dialog = dialog;
    dialog.connect("closed", () => {
      cancel.cancel();
      for (const child of [...this.children].reverse()) child.force_close();
      this.dialog = undefined;
    });
    dialog.present(parent);
    let loading = false, loadGeneration = 0;
    const load = async () => {
      if (loading || this.dialog !== dialog || this.disposed) return;
      loading = true;
      const generation = ++loadGeneration;
      clear(content);
      const status = label("Читаю параметры первичной настройки…", "dim-label");
      content.append(status);
      try {
        const data = await this.gateway.json<SettingsDocument>("GET", setupPath + "/bootstrap", undefined, undefined, false, cancel);
        if (this.dialog !== dialog) return;
        const bootstrap = object(data?.bootstrap);
        const contract = object(bootstrap.contract);
        const fields = ["providerFields", "subscriptionFields", "modelSlots", "localRoutingModes", "reviewModes", "runtimeModes", "budgetFields"];
        if (typeof data.ready !== "boolean" || bootstrap.initialState !== object(bootstrap.initialState)
          || fields.some(key => !Array.isArray(contract[key]) || (contract[key] as unknown[]).some(item => item !== object(item)))
          || ["providerFields", "modelSlots", "budgetFields"].some(key => setupRows(contract[key])
            .some(field => typeof field.settingKey !== "string" || !field.settingKey || typeof field.stateKey !== "string" || !field.stateKey))
          || ["localRoutingModes", "reviewModes", "runtimeModes"].some(key => !(contract[key] as unknown[]).length
            || setupRows(contract[key]).some(field => typeof field.value !== "string"))
          || setupRows(contract.subscriptionFields).some(field => typeof field.payloadKey !== "string")) {
          throw new Error("Шлюз не вернул описание первичной настройки.");
        }
        clear(content);
        this.render(content, dialog, bootstrap, data.ready === true, cancel);
      } catch (error) {
        if (this.dialog !== dialog) return;
        status.set_label(errorText(error));
        content.append(button("Перечитать параметры", () => { if (generation === loadGeneration) void load(); }));
      } finally {
        loading = false;
      }
    };
    void load();
  }

  close(): void {
    this.disposed = true;
    this.cancel.cancel();
    this.dialog?.force_close();
  }

  private render(content: any, dialog: any, bootstrap: SettingsDocument, ready: boolean, cancel: any): void {
    const contract = object(bootstrap.contract);
    const initial = object(bootstrap.initialState);
    const current = () => this.dialog === dialog && !this.disposed && !cancel.is_cancelled();
    const action = (caption: string, activate: () => void) => button(caption, () => { if (current()) activate(); });
    const status = label(ready ? "Шлюз уже видит доступный источник моделей." : "Настройте доступ хотя бы к одной основной модели.");
    status.set_selectable(true);
    content.append(status);
    const form = column();
    const stack = new Gtk.Stack({ hhomogeneous: false, vhomogeneous: false });
    const tabs = new Gtk.StackSwitcher({ stack, halign: Gtk.Align.CENTER });
    form.append(tabs);
    form.append(stack);
    const page = (id: string, title: string) => {
      const body = column();
      stack.add_titled(body, id, title);
      return body;
    };

    const access = page("access", "Доступ");
    const providerFields = setupRows(contract.providerFields).filter((field) =>
      typeof field.settingKey === "string" && typeof field.stateKey === "string");
    const providerDraft: SettingsDocument = { [connectionsKey]: initial.connections ?? [] };
    for (const field of providerFields) providerDraft[string(field.settingKey)] = initial[string(field.stateKey)] ?? "";
    const providerKeys = new Set(providerFields.map((field) => string(field.settingKey)));
    const savedProviders = { ...providerDraft, OPENAI_BASE_URL: initial.legacyCompatibleBaseUrl };
    const providerInputs = new Map<string, any>();
    dialog.connect("closed", () => {
      for (const field of providerFields) if (field.inputType === "password") {
        providerInputs.get(string(field.settingKey))?.set_text("");
        providerDraft[string(field.settingKey)] = "";
      }
    });
    const more = column(5);
    for (const field of providerFields) {
      const key = string(field.settingKey);
      const group = field.group === "more" ? more : access;
      group.append(label(string(field.label || key)));
      const options = { text: string(providerDraft[key]), placeholder_text: string(field.placeholder), hexpand: true };
      const input = field.inputType === "password" ? new Gtk.PasswordEntry({ ...options, show_peek_icon: true }) : new Gtk.Entry(options);
      providerInputs.set(key, input);
      group.append(input);
      if (field.note) group.append(label(string(field.note), "dim-label"));
    }
    if (more.get_first_child()) access.append(new Gtk.Expander({ label: "Другие провайдеры", child: more }));
    const providerValues = () => ({ ...providerDraft, ...Object.fromEntries([...providerInputs].map(([key, input]) => [key, input.get_text().trim()])) });
    access.append(action("Подключения и проверка провайдеров…", () => {
      if (!current()) return;
      this.providers.show({ ...providerValues(), OPENAI_BASE_URL: initial.legacyCompatibleBaseUrl }, savedProviders, (patch) => {
        if (!current() || busy || completed) return;
        for (const [key, value] of Object.entries(patch)) {
          if (key === connectionsKey) providerDraft[key] = value;
          else providerInputs.get(key)?.set_text(string(value));
        }
      }, providerKeys);
    }));
    if (initial.legacyCompatibleBaseUrl) access.append(label(`Сохранённый адрес OpenAI · ${initial.legacyCompatibleBaseUrl}`, "dim-label"));
    access.append(action("Войти в аккаунт Claudexor…", () => { if (current()) this.login.show(dialog); }));
    const subscriptions = new Map<string, any>();
    for (const field of setupRows(contract.subscriptionFields)) {
      if (typeof field.payloadKey !== "string") continue;
      const toggle = new Gtk.CheckButton({ label: string(field.label || field.payloadKey) });
      access.append(toggle);
      if (field.note) access.append(label(string(field.note), "dim-label"));
      subscriptions.set(field.payloadKey, toggle);
    }

    const models = page("models", "Модели");
    const modelInputs = new Map<string, any>();
    const modelSlots = setupRows(contract.modelSlots);
    for (const field of modelSlots) {
      const key = string(field.settingKey);
      if (!key || !field.stateKey) continue;
      const input = entry(models, string(field.label || key), initial[string(field.stateKey)], string(field.note));
      modelInputs.set(key, input);
      models.append(action("Выбрать из каталога…", () => this.catalog.pick(dialog, (model) => {
        if (!current()) return;
        if (field.slot === "fallback") {
          const chain: string[] = input.get_text().split(",").map((part: string) => part.trim()).filter(Boolean);
          if (!chain.includes(model.value)) input.set_text([...chain, model.value].join(", "));
        } else input.set_text(model.value);
      })));
    }
    const defaults = object(bootstrap.modelDefaults);
    const profiles = object(contract.providerProfiles);
    if (Object.keys(defaults).length) {
      const profile = choice(models, "Профиль моделей", Object.keys(defaults).map((value) => ({
        value, label: object(profiles[value]).label ?? value, copy: object(profiles[value]).modelCopy,
      })), initial.providerProfile);
      models.append(action("Заполнить модели из профиля", () => {
        const settings = object(defaults[profile()]);
        for (const slot of modelSlots) modelInputs.get(string(slot.settingKey))?.set_text(string(settings[string(slot.slot)]));
      }));
    }
    if (Array.isArray(bootstrap.modelSuggestions) && bootstrap.modelSuggestions.length) {
      const examples = label(bootstrap.modelSuggestions.map(string).filter(Boolean).join("\n"));
      examples.set_selectable(true);
      models.append(new Gtk.Expander({ label: "Примеры идентификаторов моделей", child: examples }));
    }
    const advanced = column();
    const processing = entry(advanced, "Общий режим обработки", initial.processingPreference);
    const modelRoles = roleFields.map(([key, state, title]) => [key, jsonField(advanced, title, initial[state] ?? {})] as const);
    advanced.prepend(label("Объекты используют имена ролей main, light, safety, vision, consciousness и массив fallback в порядке резервных моделей.", "dim-label"));
    models.append(new Gtk.Expander({ label: "Аккаунты, контекст и обработка", child: advanced }));

    const local = column();
    const localDraft: SettingsDocument = Object.fromEntries(Object.entries(localFields).map(([key, state]) => [key, initial[state]]));
    const source = entry(local, "Источник локальной модели", localDraft.LOCAL_MODEL_SOURCE);
    const filename = entry(local, "Имя файла", localDraft.LOCAL_MODEL_FILENAME);
    const context = entry(local, "Длина контекста", localDraft.LOCAL_MODEL_CONTEXT_LENGTH ?? 0);
    const gpu = entry(local, "Слои GPU", localDraft.LOCAL_MODEL_N_GPU_LAYERS ?? -1);
    const format = entry(local, "Формат чата", localDraft.LOCAL_MODEL_CHAT_FORMAT);
    const integer = (input: any, minimum: number, fallback: number) => {
      const value = Number(input.get_text().trim() || fallback);
      if (!Number.isSafeInteger(value) || value < minimum) throw new Error("Проверьте длину контекста и количество слоёв GPU.");
      return value;
    };
    const localValues = () => ({
      LOCAL_MODEL_SOURCE: source.get_text().trim(), LOCAL_MODEL_FILENAME: filename.get_text().trim(),
      LOCAL_MODEL_CONTEXT_LENGTH: integer(context, 0, 0), LOCAL_MODEL_N_GPU_LAYERS: integer(gpu, -1, -1),
      LOCAL_MODEL_CHAT_FORMAT: format.get_text().trim(),
    });
    const setLocal = (settings: SettingsDocument) => {
      if (!current()) return;
      for (const [key, widget] of Object.entries({
        LOCAL_MODEL_SOURCE: source, LOCAL_MODEL_FILENAME: filename, LOCAL_MODEL_CONTEXT_LENGTH: context,
        LOCAL_MODEL_N_GPU_LAYERS: gpu, LOCAL_MODEL_CHAT_FORMAT: format,
      })) if (Object.hasOwn(settings, key)) widget.set_text(string(settings[key]));
    };
    const routing = choice(local, "Локальная маршрутизация", setupRows(contract.localRoutingModes), initial.localRoutingMode);
    const localPresets = object(bootstrap.localPresets);
    if (Object.keys(localPresets).length) {
      const preset = choice(local, "Готовая локальная модель", Object.entries(localPresets).map(([value, item]) => ({
        value, label: object(item).label ?? value,
      })), initial.localPreset);
      local.append(action("Заполнить параметры локальной модели", () => {
        const item = object(localPresets[preset()]);
        setLocal({ LOCAL_MODEL_SOURCE: item.source, LOCAL_MODEL_FILENAME: item.filename,
          LOCAL_MODEL_CONTEXT_LENGTH: item.contextLength, LOCAL_MODEL_CHAT_FORMAT: item.chatFormat });
      }));
    }
    if (bootstrap.supportsLocalRuntimeControls === true) local.append(action("Управление локальным рантаймом…", () => {
      try { this.local.show(localValues(), setLocal, true); }
      catch (error) { status.set_label(errorText(error)); }
    }));
    models.append(new Gtk.Expander({ label: "Локальная модель", child: local }));

    const review = page("review", "Агенты");
    const reviewMode = choice(review, "Режим проверки", setupRows(contract.reviewModes), initial.reviewEnforcement);
    const agents = jsonField(review, "Состав агентов и проверяющих", undefined, true);
    const emptyReview = new Gtk.CheckButton({ label: "Разрешить сохранение без проверяющих агентов" });
    review.append(emptyReview);
    const preview = column();
    review.append(preview);

    const finish = page("finish", "Завершение");
    const runtime = choice(finish, "Режим работы шлюза", setupRows(contract.runtimeModes), initial.runtimeMode);
    const repo = entry(finish, "Путь к репозиторию навыков", initial.skillsRepoPath);
    const budgets = setupRows(contract.budgetFields).map((field) => [field,
      entry(finish, string(field.title || field.label || field.settingKey), initial[string(field.stateKey)], string(field.note))] as const);
    const starter = new StarterSkills(this.gateway, current, cancel);
    finish.append(starter.widget);
    const consciousness = object(bootstrap.consciousnessOffer);
    const startBackground = new Gtk.CheckButton({ label: "Запустить фоновую активность после завершения" });
    if (consciousness.offered === true) {
      finish.append(label(`Фоновая активность · ${consciousness.autonomy ?? "—"} · ${consciousness.dailyUsd ?? "—"} USD за сутки · одновременно задач ${consciousness.maxTasks ?? "—"}`));
      finish.append(consciousness.enabled === true ? label("Фоновая активность уже включена.") : startBackground);
    }

    const payload = (): SettingsDocument => {
      const result: SettingsDocument = { ...providerValues(), ...localValues(),
        OUROBOROS_REVIEW_ENFORCEMENT: reviewMode(), OUROBOROS_RUNTIME_MODE: runtime(), OUROBOROS_SKILLS_REPO_PATH: repo.get_text().trim(),
        OUROBOROS_PROCESSING_PREFERENCE: processing.get_text().trim(), ...starter.payload(),
      };
      result.LOCAL_ROUTING_MODE = result.LOCAL_MODEL_SOURCE ? routing() : "cloud";
      for (const [key, input] of modelInputs) result[key] = input.get_text().trim();
      for (const [key, field] of modelRoles) result[key] = field.read();
      for (const [key, toggle] of subscriptions) if (toggle.get_active()) result[key] = true;
      for (const [field, input] of budgets) {
        const text = input.get_text().trim();
        if (!text) continue;
        const value = Number(text);
        if (!Number.isFinite(value) || value < Number(field.min ?? 0)) throw new Error(`Проверьте сумму в поле «${field.title ?? field.label}».`);
        result[string(field.settingKey)] = value;
      }
      const draft = agents.read();
      if (draft !== undefined) result[subagentsKey] = draft;
      if (emptyReview.get_active()) result.allow_empty_review_pool = true;
      return result;
    };

    const showFailure = (error: unknown, fallback: string) => {
      const info = error instanceof HttpError ? object(error.body) : {};
      const diagnostics = setupRows(info.diagnostics).map((item) => string(item.message || item.code));
      status.set_label([fallback, ...diagnostics].filter(Boolean).join("\n"));
      const skip = subscriptions.get("skipSubscriptionPresets");
      if (info.can_skip === true && skip) {
        status.set_label(status.get_label() + "\nВ разделе «Доступ» можно выбрать завершение без автоматических настроек агентов.");
      }
    };

    const previewButton = action("Рассчитать состав агентов", () => void requestPreview());
    review.insert_child_after(previewButton, emptyReview);
    let previewBusy = false, previewGeneration = 0;
    const requestPreview = async () => {
      if (!current() || previewBusy || busy || completed) return;
      previewBusy = true;
      const generation = ++previewGeneration;
      previewButton.set_sensitive(false);
      clear(preview);
      try {
        const body = payload();
        const result = await this.gateway.json<SettingsDocument>("POST", setupPath + "/subagents/preview", body, undefined, false, cancel);
        if (!current()) return;
        const available = object(result?.available_subagents);
        if (result?.ok !== true || available !== result.available_subagents || typeof available.enabled !== "boolean"
          || !Array.isArray(available.items) || available.items.some(item => item !== object(item))
          || (result.model_settings !== undefined && result.model_settings !== object(result.model_settings))) {
          throw new Error("Шлюз не вернул состав агентов.");
        }
        status.set_label("Шлюз рассчитал состав агентов.");
        preview.append(label([result.source, ...setupRows(result.diagnostics).map((item) => item.message || item.code)]
          .filter(Boolean).join("\n"), "dim-label"));
        const output = label(JSON.stringify(result.available_subagents, null, 2));
        output.set_selectable(true);
        preview.append(new Gtk.Expander({ label: "Состав и роли", child: output }));
        preview.append(action("Принять состав и назначения моделей", () => {
          if (!current() || busy || completed || generation !== previewGeneration) return;
          try {
            if (JSON.stringify(body) !== JSON.stringify(payload())) throw new Error("Черновик изменился. Рассчитайте состав ещё раз.");
            agents.set(result.available_subagents);
            const resolved = object(result.model_settings);
            for (const [key, input] of modelInputs) if (Object.hasOwn(resolved, key)) input.set_text(string(resolved[key]));
            for (const [key, field] of modelRoles) if (Object.hasOwn(resolved, key)) field.set(resolved[key]);
            if (Object.hasOwn(resolved, "OUROBOROS_PROCESSING_PREFERENCE")) processing.set_text(string(resolved.OUROBOROS_PROCESSING_PREFERENCE));
            ++previewGeneration;
            clear(preview);
            status.set_label("Назначения добавлены в черновик.");
          } catch (error) { status.set_label(errorText(error)); }
        }));
      } catch (error) {
        if (current()) showFailure(error, errorText(error));
      } finally {
        previewBusy = false;
        if (current()) previewButton.set_sensitive(true);
      }
    };

    let attempts = this.attempts();
    let busy = false;
    let completed = false;
    let mayRetry = false;
    let background: { id: string; since: string } | undefined;
    const controls = row();
    const save = action("Завершить настройку", () => void submit(false));
    save.add_css_class("suggested-action");
    const check = action("Проверить квитанцию", () => void recover());
    const retry = action("Начать новую попытку…", () => void submit(true));
    for (const widget of [save, check, retry]) controls.append(widget);
    content.append(controls);
    content.append(form);

    const sync = () => {
      form.set_sensitive(!busy && !completed && (!attempts.length || mayRetry));
      save.set_visible(!completed && !attempts.length);
      save.set_sensitive(!busy);
      check.set_visible(!completed && Boolean(attempts.length));
      check.set_sensitive(!busy);
      retry.set_visible(!completed && mayRetry && Boolean(attempts.length));
      retry.set_sensitive(!busy);
      dialog.set_can_close(!busy);
    };
    const remember = (pending: SetupAttempt[]) => {
      writeGatewayState(this.statePath, pending);
      attempts = pending;
    };
    const reconcile = (pending: SetupAttempt[]) => {
      try { remember(pending); }
      catch { attempts = pending; }
    };
    const confirmed = (id: string, receipt: SetupReceipt) => {
      completed = true;
      reconcile([]);
      status.set_label([`Настройка сохранена · режим ${receipt.runtimeMode}`,
        `Настройки агентов · ${receipt.preset}${receipt.harnesses.length ? " · " + receipt.harnesses.join(", ") : ""}`,
        receipt.restartRequired ? "Требуется перезапуск шлюза." : ""].filter(Boolean).join("\n"));
      this.changed();
      if (receipt.restartRequired && this.restart) {
        let restarting = false;
        const restart = action("Перезапустить шлюз…", () => {
          if (restarting) return;
          restarting = true;
          restart.set_sensitive(false);
          void Promise.resolve().then(() => this.restart!()).then((message) => {
            if (current() && message) result.set_label(message);
          }).catch(error => {
            if (current()) result.set_label(errorText(error));
          }).finally(() => { restarting = false; if (current()) restart.set_sensitive(true); });
        });
        controls.append(restart);
      }
      if (background?.id === id) void startSetupConsciousness(this.gateway, background.since, current,
        (message) => bgStatus.set_label(message), cancel);
      background = undefined;
    };
    const result = label("", "dim-label");
    const bgStatus = label("", "dim-label");
    content.insert_child_after(result, status);
    content.insert_child_after(bgStatus, result);

    const checkAttempts = async () => {
      mayRetry = false;
      let newerUnknown = false;
      for (const { id, stored } of [...attempts]) {
        const reply = await this.gateway.json<SettingsDocument>("GET", completionPath + query({ attempt: id }), undefined, undefined, false, cancel);
        if (!current()) return;
        const receipt = reply?.saved === true ? setupReceipt(reply.receipt) : undefined;
        if (reply?.saved === true || stored) {
          if (!stored && !receipt) reconcile(attempts.map((attempt) => attempt.id === id ? { id, stored: true } : attempt));
          if (newerUnknown) status.set_label("Шлюз видит запись предыдущей попытки. Итог более поздней попытки пока неизвестен.");
          else if (receipt) confirmed(id, receipt);
          else status.set_label(["Параметры записаны. Квитанция завершения пока недоступна.", reply?.error].filter(Boolean).join("\n"));
          return;
        }
        if (reply?.saved === false) {
          reconcile(attempts.filter((attempt) => attempt.id !== id));
          if (background?.id === id) background = undefined;
          status.set_label(["Шлюз подтвердил, что попытка ничего не записала.", reply.error].filter(Boolean).join("\n"));
        } else if (reply?.saved === null) newerUnknown = true;
        else throw new Error("Шлюз вернул ответ без состояния записи.");
      }
      if (attempts.length) {
        mayRetry = true;
        status.set_label("Итог попытки пока неизвестен. Можно проверить квитанцию ещё раз.");
      }
    };
    const recover = async () => {
      if (!current() || busy || !attempts.length) return;
      busy = true;
      sync();
      try { await checkAttempts(); }
      catch (error) { if (current()) status.set_label(`Не удалось проверить квитанцию. ${errorText(error)}`); }
      finally { busy = false; if (current()) sync(); }
    };
    const submit = async (replacing: boolean) => {
      if (!current() || busy || completed || (attempts.length && (!replacing || !mayRetry))) return;
      busy = true;
      sync();
      let id: string | undefined;
      try {
        if (replacing && (!await confirm(dialog, "Начать новую попытку?",
          "Предыдущая запись может ещё выполняться. Новая попытка отправит значения из открытой формы.", "Начать новую попытку", cancel) || !current())) return;
        const body = payload();
        let since: unknown;
        const start = startBackground.get_active();
        if (start) {
          try { since = (await readSetupBoot(this.gateway, cancel)).since; } catch { /* The save is independent of background start. */ }
          if (!current()) return;
        }
        const next: string = GLib.uuid_string_random();
        remember([{ id: next }, ...attempts]);
        id = next;
        background = start ? { id: next, since: string(since) } : undefined;
        mayRetry = false;
        status.set_label("Шлюз сохраняет первичную настройку…");
        const reply = await this.gateway.json<unknown>("POST", completionPath, { ...body, attempt_id: id }, undefined, false, cancel);
        if (!current()) return;
        const receipt = setupReceipt(reply);
        if (receipt) confirmed(next, receipt);
        else {
          status.set_label("Шлюз ответил без квитанции. Проверяю попытку.");
          try { await checkAttempts(); } catch { /* Keep the attempt available for explicit readback. */ }
        }
      } catch (error) {
        if (!current()) return;
        if (!id) status.set_label(errorText(error));
        else if (unsaved(error)) {
          reconcile(attempts.filter((attempt) => attempt.id !== id));
          background = undefined;
          mayRetry = Boolean(attempts.length);
          showFailure(error, settingsFailure(error));
        } else {
          if (error instanceof HttpError && object(error.body).saved === true) {
            reconcile(attempts.map((attempt) => attempt.id === id ? { ...attempt, stored: true } : attempt));
          }
          showFailure(error, settingsFailure(error));
          try { await checkAttempts(); } catch { /* Keep the attempt available for explicit readback. */ }
        }
      } finally {
        busy = false;
        if (current()) sync();
      }
    };
    sync();
    if (attempts.length) void recover();
  }
}
