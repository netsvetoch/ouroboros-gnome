import { showSavedSecret } from "./saved-secret.js";
import { Gio, Gtk } from "./gi.js";
import { Accounts } from "./accounts.js";
import { type Gateway, type GatewayFrame, HttpError } from "./gateway.js";
import { LocalModel, localKeys } from "./local-model.js";
import { McpSettings, mcpKeys } from "./mcp.js";
import { redactMcp } from "./mcp-server.js";
import { ModelCatalog, modelKeys } from "./model-catalog.js";
import { Onboarding } from "./onboarding.js";
import { OwnerSettings, ownerKeys } from "./owner-settings.js";
import { Places } from "./places.js";
import { Providers, connectionsKey, redactProviderConnections } from "./providers.js";
import { reviewPolicyDialog, reviewPolicyLabels } from "./review-policy.js";
import { Skills } from "./skills.js";
import { type RoomCognition } from "./room-cognition.js";
import { type SettingsDocument, object, ownerHeaders, settingsFailure, unsaved } from "./settings-write.js";
import { showSubagentCatalog, subagentKey } from "./subagent-catalog.js";
import { GatewayTranslations } from "./translations.js";
import { WebSearch, webSearchKeys } from "./web-search.js";
import { actionRow, alert, button, clear, column, confirm, errorText, label, row, sheet } from "./ui.js";

import { chrome, chromeText, watchNativeI18n } from "./native-i18n.js";

const chromeButton = (russian: string, english: string, activate: () => void) => chrome(button(russian, activate), "label", english);
const path = "/api/settings";
const safetyModelPath = "/api/owner/safety-model";
const safetyModelKeys = new Set(["OUROBOROS_MODEL_SAFETY", "OUROBOROS_MODEL_LIGHT", "OUROBOROS_MODEL",
  "USE_LOCAL_LIGHT", "USE_LOCAL_MAIN", "OUROBOROS_MODEL_ACCOUNTS", "OUROBOROS_MODEL_CONTEXT_WINDOWS",
  "OUROBOROS_MODEL_PROCESSING_PREFERENCES", subagentKey]);
const knownSecrets = new Set([
  "OPENROUTER_API_KEY", "OPENAI_API_KEY", "OPENAI_COMPATIBLE_API_KEY", "CLOUDRU_FOUNDATION_MODELS_API_KEY",
  "GIGACHAT_CREDENTIALS", "GIGACHAT_PASSWORD", "ANTHROPIC_API_KEY", "MINIMAX_API_KEY",
  "DEEPSEEK_API_KEY", "ZAI_API_KEY", "GITHUB_TOKEN", "OUROBOROS_NETWORK_PASSWORD",
]);
// Cleared custom secrets are absent from _meta.custom_secret_keys but can remain in the document.
const publicNonNamespaced = new Set([
  "OPENAI_BASE_URL", "OPENAI_COMPATIBLE_BASE_URL", "CLOUDRU_FOUNDATION_MODELS_BASE_URL", "GIGACHAT_USER",
  "GIGACHAT_SCOPE", "GIGACHAT_BASE_URL", "GIGACHAT_VERIFY_SSL_CERTS", "GIGACHAT_PROFANITY_CHECK",
  "MINIMAX_REGION", "ZAI_PLAN", "TOTAL_BUDGET", "MCP_ENABLED", "MCP_SERVERS", "MCP_TOOL_TIMEOUT_SEC", "GITHUB_REPO",
  "LOCAL_MODEL_SOURCE", "LOCAL_MODEL_FILENAME", "LOCAL_MODEL_PORT", "LOCAL_MODEL_N_GPU_LAYERS",
  "LOCAL_MODEL_CONTEXT_LENGTH", "LOCAL_MODEL_CHAT_FORMAT", "USE_LOCAL_MAIN", "USE_LOCAL_HEAVY", "USE_LOCAL_LIGHT",
  "USE_LOCAL_CONSCIOUSNESS", "USE_LOCAL_FALLBACK",
]);
const hostKeys = new Set([
  "OUROBOROS_SUBSCRIPTION_PRESET_VERSION", "OUROBOROS_SUBAGENT_PRESET_RECEIPT",
  "OUROBOROS_ONBOARDING_COMPLETED_AT", "OUROBOROS_ONBOARDING_ATTEMPT_ID", "OUROBOROS_CONTEXT_MODE_AUTO_LOW",
]);
const labels: Record<string, string> = {
  OUROBOROS_MODEL: "Основная модель", OUROBOROS_MODEL_LIGHT: "Лёгкая модель", OUROBOROS_MODEL_HEAVY: "Тяжёлая модель",
  OUROBOROS_MODEL_VISION: "Модель зрения", OUROBOROS_NETWORK_PASSWORD: "Сетевой пароль",
  OUROBOROS_SERVER_HOST: "Адрес привязки шлюза", OUROBOROS_FILE_BROWSER_DEFAULT: "Корень файлового браузера",
  OUROBOROS_MAX_WORKERS: "Число работников", TOTAL_BUDGET: "Общий бюджет (USD)",
  OUROBOROS_PER_TASK_COST_USD: "Лимит задачи (USD)", OUROBOROS_WEBSEARCH_BACKEND: "Провайдер веб-поиска",
  MCP_SERVERS: "Серверы MCP", OUROBOROS_CONNECTIONS: "Подключения провайдеров",
  OUROBOROS_UI_DIR: "Каталог интерфейса, который обслуживает шлюз",
  [subagentKey]: "Каталог субагентов",
  ...reviewPolicyLabels,
};

// Only client-authored titles belong here. Gateway descriptors are data.
const labelSources: Record<string, string> = {
  OUROBOROS_MODEL: "Main model", OUROBOROS_MODEL_LIGHT: "Light model", OUROBOROS_MODEL_HEAVY: "Heavy model",
  OUROBOROS_MODEL_VISION: "Vision model", OUROBOROS_NETWORK_PASSWORD: "Network password",
  OUROBOROS_SERVER_HOST: "Gateway bind address", OUROBOROS_FILE_BROWSER_DEFAULT: "File browser root",
  OUROBOROS_MAX_WORKERS: "Worker count", TOTAL_BUDGET: "Total budget (USD)",
  OUROBOROS_PER_TASK_COST_USD: "Task cost limit (USD)", OUROBOROS_WEBSEARCH_BACKEND: "Web search provider",
  MCP_SERVERS: "MCP servers", OUROBOROS_CONNECTIONS: "Provider connections",
  OUROBOROS_UI_DIR: "Interface directory served by the gateway", [subagentKey]: "Subagent catalog",
  OUROBOROS_REVIEW_ENFORCEMENT: "Review enforcement", OUROBOROS_TASK_REVIEW_MODE: "Task result review",
  OUROBOROS_REVIEW_MAX_CYCLES: "Review cycle limit",
};

interface Descriptor {
  settingKey: string;
  label?: string;
  title?: string;
  note?: string;
  inputType?: string;
  min?: string | number;
  step?: string | number;
}

interface SaveReply {
  status?: string;
  ok?: boolean;
  no_changes?: boolean;
  saved?: boolean | null;
  restart_required?: boolean;
  restart_keys?: string[];
  restart_state?: { restart_keys?: string[] };
  immediate_changed?: boolean;
  next_task_changed?: boolean;
  warnings?: string[];
  ignored_keys?: Record<string, string>;
  connection_references?: unknown;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function display(value: unknown): string {
  if (value == null || value === "") return "Не задано";
  if (Array.isArray(value)) return `Элементов: ${value.length}`;
  if (typeof value === "object") return "Структурированное значение";
  const str = String(value);
  return str.length > 160 ? str.slice(0, 157) + "…" : str;
}

function notice(reply: SaveReply): string {
  const messages = [reply.no_changes ? "Шлюз не обнаружил изменений." : "Параметры сохранены."];
  if (reply.immediate_changed) messages.push("Часть изменений применяется сразу.");
  if (reply.next_task_changed) messages.push("Часть изменений применяется к следующим задачам.");
  const keys = reply.restart_state?.restart_keys ?? reply.restart_keys;
  if (keys?.length) messages.push("Ожидают перезапуска · " + keys.join(", "));
  else if (reply.restart_required) messages.push("Требуется перезапуск.");
  if (reply.ignored_keys) messages.push(...Object.entries(reply.ignored_keys).map(([key, writer]) => `Пропущено · ${key} · ${writer}`));
  if (reply.warnings) messages.push(...reply.warnings);
  if (reply.connection_references !== undefined) {
    const references = reply.connection_references;
    const fields = ["setting", "entry", "label", "route", "connection", "reason"];
    if (!Array.isArray(references) || references.some(reference => !reference || typeof reference !== "object"
      || Array.isArray(reference) || typeof reference.setting !== "string" || !reference.setting
      || fields.some(field => reference[field] !== undefined && typeof reference[field] !== "string"))) {
      messages.push(chromeText("The gateway returned an unreadable connection warning. Check the model routes before using them.", undefined,
        "Шлюз вернул нечитаемое предупреждение о подключениях. Проверьте маршруты моделей перед использованием."));
    } else if (references.length) {
      messages.push(chromeText("These model routes still name unavailable connections and cannot send. Update the routes or restore their connections:", undefined,
        "Эти маршруты моделей ссылаются на недоступные подключения и не могут отправлять запросы. Исправьте маршруты или восстановите подключения:"));
      for (const reference of references) messages.push([
        reference.setting, reference.entry, reference.label, reference.route, reference.connection, reference.reason,
      ].filter(Boolean).join(" · "));
    }
  }
  return messages.join("\n");
}

export class ServerSettings {
  private dialog?: any;
  private readonly children = new Set<any>();
  private readonly pending = new Map<string, unknown>();
  private readonly descriptors = new Map<string, Descriptor>();
  private snapshot?: SettingsDocument;
  private owner?: OwnerSettings;
  private skills?: Skills;
  private mcp?: McpSettings;
  private local?: LocalModel;
  private models?: ModelCatalog;
  private providers?: Providers;
  private accounts?: Accounts;
  private places?: Places;
  private translations?: GatewayTranslations;
  private webSearch?: WebSearch;
  private listBox?: any;
  private search?: any;
  private status?: any;
  private metadata?: any;
  private saveButton?: any;
  private recoveryButton?: any;
  private recovery?: { fields: SettingsDocument; sensitive: boolean };
  private recoveryRead?: any;
  private busy = false;
  private disposed = false;
  private readonly onboarding: Onboarding;

  constructor(private readonly parent: any, private readonly gateway: Gateway, private readonly openTask?: (id: string) => void,
    setupChanged?: () => void, restart?: () => Promise<string>, private readonly roomCognition?: RoomCognition,
    private readonly openCallSettings?: (parent: any) => void) {
    this.onboarding = new Onboarding(parent, gateway, () => {
      if (this.dialog && !this.busy) void this.load(false);
      setupChanged?.();
      void this.roomCognition?.refresh();
    }, restart);
  }

  checkSetup(): void {
    void this.onboarding.check();
  }

  frame(frame: GatewayFrame): void { this.translations?.frame(frame); }
  reconnected(): void { this.translations?.reconnect(); }

  show(): void {
    if (this.disposed) return;
    if (this.dialog) {
      this.dialog.present(this.parent);
      return;
    }
    const content = column();
    const dialog = chrome(sheet("Настройки шлюза", content), "title", "Gateway settings");
    dialog.set_content_width(740);
    dialog.set_content_height(690);
    this.dialog = dialog;
    const unwatch = watchNativeI18n(() => { if (this.dialog === dialog) this.render(); });
    const tools = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, column_spacing: 6, row_spacing: 6 });
    const owners = chromeButton("Управление владельца…", "Owner controls…", () => this.openOwner());
    const reload = chromeButton("Перечитать", "Reload", () => void this.reload());
    const setup = chromeButton("Первичная настройка…", "Initial setup…", () => this.onboarding.show(dialog));
    const add = chromeButton("Добавить секрет…", "Add secret…", () => this.addSecret());
    const skills = chromeButton("Навыки…", "Skills…", () => {
      this.openSkills();
    });
    const mcp = chromeButton("Серверы MCP…", "MCP servers…", () => this.openMcp());
    const models = chromeButton("Модели…", "Models…", () => this.openModels());
    const subagents = chromeButton("Субагенты…", "Subagents…", () => this.openSubagents());
    const reviewPolicy = chromeButton("Политика ревью…", "Review policy…", () => this.openReviewPolicy());
    const webSearch = chromeButton("Веб-поиск…", "Web search…", () => this.openWebSearch());
    const providers = chromeButton("Провайдеры…", "Providers…", () => this.openProviders());
    const local = chromeButton("Локальная модель…", "Local model…", () => this.openLocal());
    const translations = chromeButton("Переводы интерфейса…", "Interface translations…", () => this.openTranslations(dialog));
    const accounts = chromeButton("Аккаунты…", "Accounts…", () => {
      this.accounts ??= new Accounts(this.gateway, this.presentSetting);
      this.accounts.show();
    });
    const places = chromeButton("Места…", "Places…", () => {
      if (!this.disposed && this.dialog === dialog) this.placeView().show(dialog);
    });
    for (const widget of [setup, owners, skills, mcp, models, subagents, reviewPolicy, webSearch, providers, local, accounts, places, translations, reload, add]) tools.append(widget);
    this.search = chrome(new Gtk.SearchEntry({ placeholder_text: "Поиск по настройкам" }), "placeholder-text", "Search settings");
    this.search.connect("search-changed", () => this.render());
    this.status = label("");
    this.metadata = label("", "dim-label");
    this.saveButton = chromeButton("Сохранить изменения", "Save changes", () => void this.save());
    this.saveButton.add_css_class("suggested-action");
    this.recoveryButton = chromeButton("Проверить результат записи", "Check save outcome", () => void this.checkSave());
    this.listBox = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
    this.listBox.add_css_class("boxed-list");
    for (const widget of [tools, this.metadata, this.status, this.search, this.saveButton, this.recoveryButton, this.listBox]) content.append(widget);
    dialog.connect("close-attempt", () => {
      if (this.busy) return;
      const body = this.recovery ? "Результат записи пока неизвестен. Закрытие уберёт черновик и возможность проверки из этого окна." : "Изменения в форме ещё не записаны.";
      void confirm(this.parent, "Закрыть настройки?", body, "Закрыть без сохранения", undefined, { heading: "Close settings?", body: this.recovery ? "The save outcome is unknown. Closing removes this draft and its recovery controls." : "Changes in the form have not been saved yet.", action: "Close without saving" })
        .then((allowed) => { if (allowed && this.dialog === dialog) dialog.force_close(); });
    });
    dialog.connect("closed", () => {
      unwatch();
      if (this.dialog !== dialog) return;
      this.pending.clear();
      this.recovery = undefined;
      this.recoveryRead?.cancel(); this.recoveryRead = undefined;
      this.busy = false;
      this.snapshot = undefined;
      this.dialog = undefined;
      this.status = this.listBox = this.search = this.metadata = this.saveButton = this.recoveryButton = undefined;
    });
    dialog.present(this.parent);
    this.sync();
    void this.load();
  }

  close(): void {
    this.disposed = true;
    this.onboarding.close();
    this.owner?.close();
    this.skills?.close();
    this.places?.close();
    for (const child of [...this.children].reverse()) child.force_close();
    this.dialog?.force_close();
    this.pending.clear();
  }

  private showChild(dialog: any, parent = this.parent): void {
    this.children.add(dialog);
    dialog.connect("closed", () => this.children.delete(dialog));
    dialog.present(parent);
  }

  private openMcp(): void {
    if (!this.snapshot || this.busy) return;
    this.mcp ??= new McpSettings(this.gateway, this.presentSetting);
    this.mcp.show({ ...this.snapshot, ...Object.fromEntries(this.pending) }, this.snapshot, (patch) => this.stageSettings(patch));
  }

  private readonly presentSetting = (dialog: any, parent?: any) => this.showChild(dialog, parent ?? this.dialog);

  private placeView(): Places {
    return this.places ??= new Places(this.gateway, this.presentSetting, () => this.openSkills(), this.openTask);
  }

  openWakeRoom(chatId: number): void {
    if (!this.disposed) this.placeView().openWakeRoom(this.parent, chatId);
  }

  private openOwner(): void {
    this.owner ??= new OwnerSettings(this.parent, this.gateway, () => void this.load(false), this.roomCognition,
      (parent) => this.openTranslations(parent));
    this.owner.show();
  }

  private openTranslations(parent: any): void {
    this.translations ??= new GatewayTranslations(this.gateway, this.presentSetting, () => void this.load(false));
    this.translations.show(parent);
  }

  openSkills(search?: string): void {
    this.skills ??= new Skills(this.parent, this.gateway, this.openTask, this.openCallSettings);
    if (search === undefined) this.skills.show();
    else this.skills.browse(search);
  }

  private openModels(key?: string): void {
    if (!this.snapshot || this.busy) return;
    this.models ??= new ModelCatalog(this.gateway, this.presentSetting);
    this.models.show({ ...this.snapshot, ...Object.fromEntries(this.pending) }, (patch) => this.stageSettings(patch), key);
  }

  private openSubagents(): void {
    if (!this.snapshot || this.busy) return;
    const settings = { ...this.snapshot, ...Object.fromEntries(this.pending) };
    this.models ??= new ModelCatalog(this.gateway, this.presentSetting);
    try { showSubagentCatalog(settings, this.snapshot, this.gateway, this.models, this.presentSetting,
      patch => this.stageSettings(patch), this.openTask); }
    catch { this.edit(subagentKey, true); }
  }

  private openReviewPolicy(): void {
    if (!this.snapshot || this.busy) return;
    const settings = { ...this.snapshot, ...Object.fromEntries(this.pending) };
    this.presentSetting(reviewPolicyDialog(settings, patch => this.stageSettings(patch)));
  }

  private openWebSearch(): void {
    if (!this.snapshot || this.busy) return;
    this.webSearch ??= new WebSearch(this.gateway, this.presentSetting);
    const parent = this.dialog;
    this.webSearch.show({ ...this.snapshot, ...Object.fromEntries(this.pending) }, this.snapshot, (patch) => {
      if (this.dialog === parent) this.stageSettings(patch);
    }, parent);
  }

  private openProviders(): void {
    if (!this.snapshot || this.busy) return;
    this.providers ??= new Providers(this.gateway, this.presentSetting);
    this.providers.show({ ...this.snapshot, ...Object.fromEntries(this.pending) }, this.snapshot, (patch) => this.stageSettings(patch));
  }

  private openLocal(): void {
    if (!this.snapshot || this.busy) return;
    this.local ??= new LocalModel(this.gateway, this.presentSetting);
    this.local.show({ ...this.snapshot, ...Object.fromEntries(this.pending) }, (patch) => this.stageSettings(patch));
  }

  private isSecret(key: string): boolean {
    return knownSecrets.has(key) || list(object(this.snapshot?._meta).custom_secret_keys).includes(key)
      || this.descriptors.get(key)?.inputType === "password"
      || /^[A-Z][A-Z0-9_]{2,}$/.test(key) && !key.startsWith("OUROBOROS_") && !publicNonNamespaced.has(key)
        && (typeof this.snapshot?.[key] === "string" || !Object.hasOwn(this.snapshot ?? {}, key));
  }

  private async load(resetMessage = true): Promise<void> {
    if (!this.dialog || this.disposed || this.busy || this.pending.size || this.recovery) return;
    const dialog = this.dialog;
    this.busy = true;
    this.sync();
    if (resetMessage) this.status?.set_label("Читаю настройки…");
    try {
      const document = await this.read();
      if (this.dialog !== dialog || this.disposed) return;
      this.apply(document);
      if (resetMessage) this.status?.set_label("");
    } catch (error) {
      if (this.dialog === dialog) this.status?.set_label(errorText(error));
    } finally {
      if (this.dialog === dialog) { this.busy = false; this.sync(); }
    }
  }

  private async reload(): Promise<void> {
    if (this.busy) return;
    if (this.recovery) { await this.checkSave(); return; }
    if (this.pending.size && !await confirm(this.parent, "Перечитать настройки?", "Изменения в форме будут сброшены.", "Перечитать", undefined, { heading: "Reload settings?", body: "Changes in the form will be discarded.", action: "Reload" })) return;
    this.pending.clear();
    await this.load();
  }

  private async read(cancel?: any): Promise<SettingsDocument> {
    const document = await this.gateway.json<SettingsDocument>("GET", path, undefined, undefined, false, cancel);
    if (!document || !Object.keys(object(document)).some((key) => key !== "_meta")) throw new Error("Шлюз не вернул настройки.");
    return document;
  }

  private apply(document: SettingsDocument): void {
    this.snapshot = document;
    this.descriptors.clear();
    const meta = object(document._meta);
    const contract = object(meta.setup_contract);
    for (const section of ["providerFields", "modelSlots", "budgetFields", "subscriptionFields"]) {
      for (const field of Array.isArray(contract[section]) ? contract[section] : []) {
        if (typeof field?.settingKey === "string") this.descriptors.set(field.settingKey, field as Descriptor);
      }
    }
    const restart = list(object(meta.restart_state).restart_keys);
    this.metadata?.set_label([meta.bind_host && `Адрес привязки · ${meta.bind_host}`,
      meta.recommended_url && `Адрес подключения · ${meta.recommended_url}`,
      restart.length && `Ожидают перезапуска · ${restart.join(", ")}`].filter(Boolean).join("\n"));
    this.render();
  }

  private render(): void {
    if (!this.listBox || !this.snapshot) return;
    const filter = this.search.get_text().trim().toLowerCase();
    const keys = new Set([...Object.keys(this.snapshot), ...this.pending.keys()]);
    clear(this.listBox);
    for (const key of [...keys].sort((a, b) => Number(Boolean(labels[b])) - Number(Boolean(labels[a])) || a.localeCompare(b))) {
      if (key.startsWith("_")) continue;
      const descriptor = this.descriptors.get(key);
      const title = labels[key] || descriptor?.label || descriptor?.title || key;
      const source = Object.hasOwn(labelSources, key) ? labelSources[key] : undefined;
      const translated = source ? chromeText(source) : "";
      if (filter && !`${title} ${translated} ${key}`.toLowerCase().includes(filter)) continue;
      const pending = this.pending.has(key);
      const value = pending ? this.pending.get(key) : this.snapshot[key];
      const shown = this.isSecret(key) ? value ? "Секрет задан" : "Секрет не задан" : display(value);
      const item = actionRow({ title,
        subtitle: [key === title ? "" : key, pending ? "Изменено в форме" : "", shown].filter(Boolean).join(" · "),
        subtitle_lines: 2,
      });
      if (source) chrome(item, "title", source);
      if (!ownerKeys.has(key) && !hostKeys.has(key)) {
        const edit = chrome(new Gtk.Button({ icon_name: "document-edit-symbolic", valign: Gtk.Align.CENTER, tooltip_text: "Изменить" }), "tooltip-text", "Edit");
        edit.connect("clicked", () => this.edit(key));
        item.add_suffix(edit);
        item.set_activatable_widget(edit);
      } else if (ownerKeys.has(key)) {
        const edit = chromeButton("Управление владельца", "Owner controls", () => this.openOwner());
        item.add_suffix(edit);
        item.set_activatable_widget(edit);
      }
      this.listBox.append(item);
    }
  }

  private sync(): void {
    this.dialog?.set_can_close(!this.busy && !this.pending.size && !this.recovery);
    this.saveButton?.set_sensitive(!this.busy && !this.recovery && this.pending.size > 0);
    this.recoveryButton?.set_visible(Boolean(this.recovery));
    this.recoveryButton?.set_sensitive(!this.busy);
    this.saveButton?.set_label(this.pending.size ? `Сохранить изменения (${this.pending.size})` : "Сохранить изменения");
    if (this.saveButton) chrome(this.saveButton, "label", this.pending.size ? "Save changes ({n})" : "Save changes", { n: this.pending.size });
    this.listBox?.set_sensitive(!this.busy);
  }

  private edit(key: string, raw = false): void {
    if (!this.snapshot || this.busy) return;
    if (key === subagentKey && !raw) { this.openSubagents(); return; }
    if (Object.hasOwn(reviewPolicyLabels, key)) { this.openReviewPolicy(); return; }
    if (mcpKeys.has(key)) { this.openMcp(); return; }
    if (localKeys.has(key)) { this.openLocal(); return; }
    if (modelKeys.has(key)) { this.openModels(key); return; }
    if (webSearchKeys.has(key)) { this.openWebSearch(); return; }
    if (key === connectionsKey) { this.openProviders(); return; }
    if (this.isSecret(key)) { this.editSecret(key); return; }
    const saved = this.snapshot[key];
    const value = this.pending.has(key) ? this.pending.get(key) : saved;
    const descriptor = this.descriptors.get(key);
    const content = column();
    const dialog = sheet(labels[key] || descriptor?.label || key, content);
    if (Object.hasOwn(labelSources, key)) chrome(dialog, "title", labelSources[key]);
    const problem = label("", "error");
    content.append(label(key, "dim-label"));
    if (descriptor?.note) content.append(label(descriptor.note, "dim-label"));
    const editor = settingInput(value, descriptor);
    content.append(editor.widget);
    content.append(problem);
    content.append(chromeButton("Применить в форме", "Apply to form", () => {
      try { this.stage(key, editor.value()); dialog.close(); }
      catch (error) { problem.set_label(errorText(error)); }
    }));
    if (this.pending.has(key)) content.append(chromeButton("Сбросить изменение", "Reset change", () => { this.stage(key, saved); dialog.close(); }));
    this.showChild(dialog);
  }

  private addSecret(): void {
    if (!this.snapshot || this.busy) return;
    const content = column();
    const dialog = chrome(sheet("Новый секрет", content), "title", "New secret");
    const key = chrome(new Gtk.Entry({ placeholder_text: "ИМЯ_СЕКРЕТА" }), "placeholder-text", "SECRET_NAME");
    const problem = label("");
    content.append(key);
    content.append(problem);
    content.append(chromeButton("Продолжить", "Continue", () => {
      const name = key.get_text().trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9_]{2,}$/.test(name) || name.startsWith("OUROBOROS_")
        || Object.hasOwn(this.snapshot!, name) && !this.isSecret(name)) {
        problem.set_label("Укажите новое имя секрета из букв A–Z, цифр и подчёркиваний.");
        return;
      }
      dialog.close();
      this.editSecret(name);
    }));
    this.showChild(dialog);
  }

  private editSecret(key: string): void {
    const content = column();
    const dialog = sheet(key, content);
    const input = chrome(new Gtk.PasswordEntry({ placeholder_text: "Новое значение", show_peek_icon: true }), "placeholder-text", "New value");
    const status = label("");
    const replacement = chromeButton("Заменить в форме", "Replace in form", () => {
      const secret = input.get_text();
      const mask = secret.trim();
      if (!mask || mask === "***set***" || mask === "***" || /^.{8}\.\.\.$/.test(mask)) {
        status.set_label("Введите новое значение. Для удаления используйте отдельную кнопку.");
        return;
      }
      this.stage(key, secret);
      input.set_text("");
      dialog.close();
    });
    content.append(chrome(label("Значение шлюза скрыто. Изменение вступит в силу после сохранения формы.", "dim-label"), "label", "The gateway value is hidden. Changes take effect after saving the form."));
    content.append(input);
    content.append(status);
    content.append(replacement);
    if (this.snapshot?.[key]) {
      content.append(chromeButton("Показать сохранённое значение…", "Show saved value…", () => void this.reveal(key)));
      content.append(chromeButton("Очистить в форме", "Clear in form", () => { this.stage(key, ""); dialog.close(); }));
    }
    if (this.pending.has(key)) content.append(chromeButton("Сбросить изменение", "Reset change", () => { this.stage(key, this.snapshot?.[key]); dialog.close(); }));
    dialog.connect("closed", () => input.set_text(""));
    this.showChild(dialog);
  }

  private reveal(key: string): void {
    showSavedSecret(this.dialog, this.gateway, (dialog) => this.showChild(dialog), { key });
  }

  private stage(key: string, value: unknown): void {
    this.stageSettings({ [key]: value });
  }

  private stageSettings(patch: SettingsDocument): void {
    if (this.busy || !this.snapshot) return;
    for (const [key, value] of Object.entries(patch)) {
      if (same(value, this.snapshot[key])) this.pending.delete(key);
      else this.pending.set(key, value);
    }
    this.render();
    this.sync();
  }

  private async save(): Promise<void> {
    if (!this.dialog || !this.snapshot || this.busy || this.recovery || !this.pending.size) return;
    const dialog = this.dialog;
    const body = Object.fromEntries(this.pending);
    const alive = () => !this.disposed && this.dialog === dialog;
    const secretKeys = Object.keys(body).filter((key) => this.isSecret(key) || key === connectionsKey || key === "MCP_SERVERS");
    const redact = (text: string) => {
      for (const key of secretKeys) if (typeof body[key] === "string" && body[key]) text = text.replaceAll(body[key] as string, "•••");
      return redactProviderConnections(redactMcp(text, body.MCP_SERVERS), body[connectionsKey]);
    };
    this.busy = true;
    this.status.set_label("Проверяю текущие значения…");
    this.sync();
    let sent = false;
    let patch = body;
    let owner = false;
    let allowEmpty = false;
    try {
      while (true) {
        const current = await this.read();
        if (!alive()) return;
        const moved = Object.keys(patch).filter(key => !same(current[key], this.snapshot?.[key]));
        if (moved.length) {
          this.status.set_label("Параметры изменились на шлюзе. Перечитайте настройки · " + moved.join(", "));
          return;
        }
        let reply: SaveReply;
        try {
          const extra = allowEmpty ? { allow_empty_review_pool: true } : {};
          sent = true;
          reply = await this.gateway.json<SaveReply>("POST", owner ? safetyModelPath : path,
            owner ? { settings: patch, ...extra } : { ...patch, ...extra }, ownerHeaders);
        } catch (error) {
          if (!(error instanceof HttpError) || !unsaved(error)) throw error;
          sent = false;
          if (!alive()) return;
          const issue = object(error.body);
          if (!allowEmpty && Object.hasOwn(patch, subagentKey) && issue.code === "empty_review_pool") {
            if (!await confirm(dialog, "Сохранить пустой пул ревью?",
              "После сохранения в пуле не будет включённых рецензентов. Шлюз будет использовать основную модель Main.", "Сохранить", undefined, { heading: "Save an empty review pool?", body: "The pool will have no enabled reviewers. The gateway will use the Main model.", action: "Save" })) {
              if (alive()) this.status.set_label("Изменения каталога остались в форме.");
              return;
            }
            if (!alive()) return;
            allowEmpty = true;
            continue;
          }
          if (owner || issue.error !== "The resolved Safety Supervisor is owner-controlled; use /api/owner/safety-model.") throw error;
          const safety = Object.fromEntries(Object.entries(patch).filter(([key]) => safetyModelKeys.has(key)));
          if (!Object.keys(safety).length) throw error;
          if (!await confirm(dialog, "Подтвердить изменения Safety Supervisor?",
            "Выбранные настройки меняют маршрут Safety Supervisor. Шлюз требует подтвердить эти поля как владелец. Остальные правки останутся в форме.", "Сохранить настройки маршрута", undefined, { heading: "Confirm Safety Supervisor changes?", body: "These settings change the Safety Supervisor route. The gateway requires owner confirmation. Other edits will remain in the form.", action: "Save route settings" })) {
            if (alive()) this.status.set_label("Изменения остались в форме.");
            return;
          }
          if (!alive()) return;
          patch = safety;
          owner = true;
          continue;
        }
        if (!alive()) return;
        if (reply?.status !== "saved" && reply?.ok !== true) throw new Error("Шлюз не подтвердил сохранение.");
        for (const key of Object.keys(patch)) this.pending.delete(key);
        const passwordChanged = Object.hasOwn(patch, "OUROBOROS_NETWORK_PASSWORD");
        const remaining = this.pending.size ? "\nОстальные изменения остались в форме." : "";
        this.status.set_label(redact(notice(reply)) + remaining
          + (passwordChanged ? "\nПри необходимости обновите пароль в настройках подключения." : ""));
        break;
      }
    } catch (error) {
      if (!alive()) return;
      if (sent && !unsaved(error)) {
        if (error instanceof HttpError && object(error.body).saved === true) {
          for (const key of Object.keys(patch)) this.pending.delete(key);
        } else {
          const fields: SettingsDocument = {};
          let sensitive = false;
          for (const [key, value] of Object.entries(patch)) {
            if (secretKeys.includes(key)) {
              this.pending.delete(key); sensitive = true;
            } else fields[key] = JSON.parse(JSON.stringify(value));
          }
          this.recovery = { fields, sensitive };
        }
      }
      this.status.set_label(redact(sent || error instanceof HttpError && unsaved(error) ? settingsFailure(error) : errorText(error)));
    } finally {
      for (const key of secretKeys) delete body[key];
      if (alive() && sent) {
        void this.roomCognition?.refresh();
        const cancel = this.recovery ? new Gio.Cancellable() : undefined;
        if (cancel) this.recoveryRead = cancel;
        try {
          const current = await this.read(cancel);
          if (alive()) {
            if (this.recovery) this.reconcileSave(current);
            else {
              for (const key of this.pending.keys()) current[key] = this.snapshot?.[key];
              this.apply(current);
            }
          }
        } catch (error) {
          if (alive()) this.status.set_label(`${this.status.get_label()}\nПеречитать настройки не удалось. ${errorText(error)}`);
        } finally {
          if (cancel && this.recoveryRead === cancel) this.recoveryRead = undefined;
        }
      }
      if (alive()) { this.busy = false; this.render(); this.sync(); }
    }
  }

  private reconcileSave(document: SettingsDocument): void {
    const recovery = this.recovery;
    if (!recovery) return;
    const matches = Object.entries(recovery.fields).every(([key, value]) => same(document[key], value));
    this.apply(document);
    for (const [key, value] of this.pending) if (same(document[key], value)) this.pending.delete(key);
    this.recovery = undefined;
    this.status?.set_label((matches && Object.keys(recovery.fields).length
      ? "Текущие значения совпадают с отправленными. Исходная квитанция записи не подтверждена."
      : this.pending.size ? "Текущие значения перечитаны. Черновик сохранён; проверьте его перед новым сохранением."
        : "Текущие значения перечитаны. Исходная квитанция записи не подтверждена.")
      + (recovery.sensitive ? " Секретные поля и чувствительные структурированные настройки очищены; их запись этим чтением не проверяется." : ""));
  }

  private async checkSave(): Promise<void> {
    if (!this.dialog || this.disposed || this.busy || !this.recovery) return;
    const dialog = this.dialog, cancel = new Gio.Cancellable();
    this.recoveryRead = cancel; this.busy = true; this.sync();
    try {
      const document = await this.read(cancel);
      if (this.dialog === dialog && !this.disposed) this.reconcileSave(document);
    } catch (error) {
      if (this.dialog === dialog && !this.disposed) this.status?.set_label("Результат записи остаётся неизвестным. " + errorText(error));
    } finally {
      if (this.recoveryRead === cancel) this.recoveryRead = undefined;
      if (this.dialog === dialog) { this.busy = false; this.render(); this.sync(); }
    }
  }
}

function settingInput(value: unknown, descriptor?: Descriptor): { widget: any; value: () => unknown } {
  if (typeof value === "boolean" || value === "true" || value === "false") {
    const widget = chrome(new Gtk.CheckButton({ label: "Включено", active: value === true || value === "true" }), "label", "Enabled");
    return { widget, value: () => typeof value === "string" ? String(widget.get_active()) : widget.get_active() };
  }
  if (typeof value === "number") {
    const widget = new Gtk.Entry({ input_purpose: Gtk.InputPurpose.NUMBER, text: String(value) });
    return { widget, value: () => {
      const input = widget.get_text().trim().replace(",", ".");
      const number = Number(input);
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(input) || !Number.isFinite(number)) throw new Error("Введите число.");
      if (descriptor?.min != null && number < Number(descriptor.min)) throw new Error(`Минимальное значение · ${descriptor.min}`);
      return number;
    } };
  }
  if (value && typeof value === "object" || typeof value === "string" && (value.includes("\n") || /^[\[{]/.test(value.trim()))) {
    const view = new Gtk.TextView({ monospace: true, wrap_mode: Gtk.WrapMode.WORD_CHAR });
    const buffer = view.get_buffer();
    buffer.set_text(typeof value === "string" ? value : JSON.stringify(value, null, 2), -1);
    const widget = new Gtk.ScrolledWindow({ child: view, min_content_height: 180 });
    return { widget, value: () => {
      const raw = buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false);
      if (typeof value === "string") return raw;
      let parsed;
      try { parsed = JSON.parse(raw); } catch { throw new Error("Введите корректный JSON."); }
      if (Array.isArray(value) ? !Array.isArray(parsed) : !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(Array.isArray(value) ? "Ожидается массив JSON." : "Ожидается объект JSON.");
      }
      return parsed;
    } };
  }
  const widget = new Gtk.Entry({ text: value == null ? "" : String(value) });
  return { widget, value: () => widget.get_text() };
}
