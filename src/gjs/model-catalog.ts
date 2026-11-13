import { Adw, Gio, Gtk } from "./gi.js";
import { type Gateway, query } from "./gateway.js";
import { flag, type Present } from "./mcp-server.js";
import { modelRoleOptionKeys, showModelRoleOptions } from "./model-role-options.js";
import { ModelLimits } from "./model-limits.js";
import { type SettingsDocument, object } from "./settings-write.js";
import { actionRow, button, clear, column, errorText, label, row, sheet } from "./ui.js";

const roles = {
  main: { key: "OUROBOROS_MODEL", title: "Основная модель" },
  light: { key: "OUROBOROS_MODEL_LIGHT", title: "Лёгкая модель" },
  vision: { key: "OUROBOROS_MODEL_VISION", title: "Модель зрения" },
  consciousness: { key: "OUROBOROS_MODEL_CONSCIOUSNESS", title: "Модель фоновой работы" },
  deep_review: { key: "OUROBOROS_MODEL_DEEP_SELF_REVIEW", title: "Модель глубокого саморевью" },
  fallback: { key: "OUROBOROS_MODEL_FALLBACKS", title: "Цепочка резервных моделей" },
  safety: { key: "OUROBOROS_MODEL_SAFETY", title: "Safety Supervisor" },
} as const;
type Role = keyof typeof roles;
const roleNames = Object.keys(roles) as Role[];
export const modelKeys = new Set<string>([...roleNames.filter((role) => role !== "safety").map((role) => roles[role].key), ...modelRoleOptionKeys]);

function roleOption(settings: SettingsDocument, key: string, role: Role, index: number, modelFor: (role: Role) => string): unknown {
  const raw = settings[key];
  const options = typeof raw === "string" && raw.trim() ? JSON.parse(raw) : raw;
  const values = object(options);
  if (options && values !== options) throw new Error(`Шлюз вернул недопустимое значение ${key}.`);
  if (role === "fallback") {
    if (values.fallback !== undefined && !Array.isArray(values.fallback)) throw new Error(`Шлюз вернул недопустимое значение ${key}.`);
    return values.fallback?.[index];
  }
  if (role !== "safety") return values[role];
  // Empty Supervisor slots inherit their route options along with the selected model.
  for (const inherited of ["safety", "light", "main"] as const) {
    if (values[inherited]) return values[inherited];
    if (modelFor(inherited)) break;
  }
  return undefined;
}

export interface Model {
  value: string;
  id: string;
  name?: string;
  label?: string;
  provider_id: string;
  provider_label?: string;
  provider?: string;
  source?: string;
  source_id?: string;
  credential_profile_id?: string;
  account_fingerprint?: string;
  context_window?: unknown;
  max_context_window?: unknown;
  max_output_tokens?: unknown;
  is_default?: boolean;
  input_modalities?: string[];
  reasoning_efforts?: string[];
  default_reasoning_effort?: string;
  availability?: unknown;
  problem?: unknown;
  provenance?: unknown;
  observed_at?: string;
  supported_options?: unknown;
  processing?: unknown;
}

export interface Catalog {
  items: Model[];
  errors: { provider_id?: string; error: string; stage?: string; source_id?: string; credential_profile_id?: string; code?: string }[];
  model_sources: { id: string; label?: string; credentialHarness?: unknown; processingPreferences?: unknown; accountCatalog?: unknown }[];
  account_catalogs?: Record<string, unknown>[];
  partial?: boolean;
}

export function readCatalog(value: unknown): Catalog {
  const record = (item: unknown): item is Record<string, any> => item !== null && typeof item === "object" && !Array.isArray(item);
  const strings = (item: Record<string, any>, keys: string[]) => keys.every(key => item[key] == null || typeof item[key] === "string");
  const lists = (item: unknown) => Array.isArray(item) && item.every(value => typeof value === "string");
  const accountCatalog = (item: unknown): boolean => record(item) && strings(item, ["sourceId", "source"])
    && (item.accounts === undefined || Array.isArray(item.accounts) && item.accounts.every((account: unknown) => record(account)
      && strings(account, ["modelSourceId", "credentialProfileId", "label"])));
  if (!record(value) || !Array.isArray(value.items) || !Array.isArray(value.errors) || !Array.isArray(value.model_sources)
    || (value.partial !== undefined && typeof value.partial !== "boolean")
    || value.items.some(item => !record(item) || ![item.value, item.id, item.provider_id].every(value => typeof value === "string" && value.length > 0)
      || !strings(item, ["name", "label", "provider", "source", "provider_label", "source_id", "credential_profile_id", "account_fingerprint", "default_reasoning_effort", "observed_at"])
      || ["input_modalities", "reasoning_efforts"].some(key => item[key] != null && !lists(item[key]))
      || (item.is_default != null && typeof item.is_default !== "boolean"))
    || value.errors.some(item => !record(item) || typeof item.error !== "string" || !strings(item, ["provider_id", "stage", "source_id", "credential_profile_id", "code"]))
    || value.model_sources.some(item => !record(item) || typeof item.id !== "string" || !strings(item, ["label"]))
    || (value.account_catalogs !== undefined && (!Array.isArray(value.account_catalogs) || !value.account_catalogs.every(accountCatalog)))) {
    throw new Error("Шлюз не вернул пригодный каталог моделей.");
  }
  return value as Catalog;
}

function field(target: any, title: string, value: unknown): void {
  if (value == null || value === "" || (typeof value === "object" && !Object.keys(value).length)) return;
  const text = typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
  const widget = label(`${title} · ${text}`);
  widget.set_selectable(true);
  target.append(widget);
}

function followParent(dialog: any, parent: any): void {
  if (!(parent instanceof Adw.Dialog) && !(parent instanceof Gtk.Window)) return;
  let closed = false;
  const signal = parent.connect(parent instanceof Gtk.Window ? "close-request" : "closed", () => { if (!closed) dialog.force_close(); return false; });
  dialog.connect("closed", () => {
    if (closed) return;
    closed = true;
    parent.disconnect(signal);
  });
}

export class ModelCatalog {
  private readonly limits: ModelLimits;

  constructor(private readonly gateway: Gateway, private readonly present: Present) {
    this.limits = new ModelLimits(gateway, present);
  }

  show(settings: SettingsDocument, stage: (patch: SettingsDocument) => void, focus?: string): void {
    const content = column();
    const dialog = sheet("Модели шлюза", content);
    let open = true;
    let staged = false;
    dialog.connect("closed", () => { open = false; });
    const fields = new Map<string, any>();
    const draft = { ...settings };
    const optionPatch: SettingsDocument = {};
    const status = label("", "error");
    const modelFor = (role: Role) => String(fields.get(roles[role].key)?.get_text() ?? settings[roles[role].key] ?? "").trim();
    const inspect = (role: Role) => {
      if (!open) return;
      status.set_label("");
      const own = modelFor(role);
      const inherited: Role = role === "safety" && modelFor("light") ? "light" : "main";
      const model = own || (role === "fallback" || role === "deep_review" ? "" : modelFor(inherited));
      if (!model) {
        status.set_label("Укажите модель, чтобы проверить её маршрут.");
        return;
      }
      const inspectRoute = (parent: any, selected: string, index = -1) => {
        if (!open) return;
        try {
          const account = roleOption(draft, "OUROBOROS_MODEL_ACCOUNTS", role, index, modelFor) ?? "";
          const window = roleOption(draft, "OUROBOROS_MODEL_CONTEXT_WINDOWS", role, index, modelFor) ?? 0;
          if (typeof account !== "string" || typeof window !== "number" || !Number.isSafeInteger(window) || window < 0) {
            throw new Error("Аккаунт или окно контекста этой роли имеют недопустимое значение.");
          }
          const lane = !own && (role === "vision" || role === "safety" || role === "light") ? inherited : role;
          const localFlag = lane === "main" || lane === "light" || lane === "consciousness" || lane === "fallback";
          const title = roles[role].title + (index >= 0 ? ` · ${index + 1}` : "");
          this.limits.show(parent, title, {
            model: selected,
            role: index < 0 ? role : `fallback:${index}`,
            local: selected.endsWith(" (local)") || (localFlag && flag(settings[`USE_LOCAL_${lane.toUpperCase()}`])),
            account, window,
          });
        } catch (error) { status.set_label(errorText(error)); }
      };
      if (role !== "fallback") { inspectRoute(dialog, model); return; }
      const list = column();
      const chain = sheet("Маршруты резервных моделей", list);
      let chainOpen = true;
      chain.connect("closed", () => { chainOpen = false; });
      followParent(chain, dialog);
      for (const [index, selected] of model.split(",").map((item) => item.trim()).filter(Boolean).entries()) {
        list.append(button(`${index + 1} · ${selected}`, () => { if (chainOpen) inspectRoute(chain, selected, index); }));
      }
      this.present(chain, dialog);
    };
    for (const role of roleNames) {
      const { key, title } = roles[role];
      if (role === "safety") {
        content.append(button("Лимиты Safety Supervisor…", () => inspect(role)));
        continue;
      }
      const input = new Gtk.Entry({ text: String(settings[key] ?? ""), hexpand: true, placeholder_text: title });
      fields.set(key, input);
      const controls = row();
      controls.append(input);
      controls.append(button("Из каталога…", () => { if (!open) return; this.pick(dialog, (model) => {
        if (!open) return;
        if (key === "OUROBOROS_MODEL_FALLBACKS") {
          const chain = input.get_text().split(",").map((part: string) => part.trim()).filter(Boolean);
          if (!chain.includes(model.value)) input.set_text([...chain, model.value].join(", "));
        } else input.set_text(model.value);
      }); }));
      content.append(label(title));
      content.append(controls);
      content.append(button(role === "fallback" ? "Лимиты резервных маршрутов…" : "Лимиты маршрута…", () => inspect(role)));
    }
    content.append(label("Резервные модели перечисляются через запятую в порядке использования.", "dim-label"));
    let optionsDialog: any;
    const options = () => {
      if (!open || optionsDialog) return;
      optionsDialog = showModelRoleOptions(dialog, draft, this.present, patch => {
        if (!open) return;
        Object.assign(draft, patch);
        Object.assign(optionPatch, patch);
        if (Object.keys(patch).length) status.set_label("Параметры ролей изменены в этой форме.");
      });
      optionsDialog.connect("closed", () => { optionsDialog = undefined; });
    };
    content.append(button("Параметры ролей…", options));
    content.append(status);
    content.append(button("Просмотреть каталог…", () => { if (open) this.pick(dialog); }));
    content.append(button("Применить к настройкам", () => {
      if (!open || staged) return;
      staged = true;
      const patch: SettingsDocument = { ...optionPatch };
      for (const [key, entry] of fields) {
        const value = entry.get_text().trim();
        if (value !== String(settings[key] ?? "")) patch[key] = value;
      }
      stage(patch);
      dialog.close();
    }));
    this.present(dialog);
    fields.get(focus ?? "")?.grab_focus();
    if (modelRoleOptionKeys.has(focus ?? "")) options();
  }

  pick(parent: any, choose?: (model: Model) => void): void {
    const content = column(10);
    const dialog = sheet("Каталог моделей", content);
    dialog.set_content_width(730);
    dialog.set_content_height(680);
    const scope = new Gtk.Entry({ placeholder_text: "Идентификатор источника аккаунта" });
    const profile = new Gtk.Entry({ placeholder_text: "Профиль аккаунта (необязательно)" });
    const options = column();
    const sourceList = column(4);
    const accountInfo = column(4);
    const status = label("", "dim-label");
    const search = new Gtk.SearchEntry({ placeholder_text: "Фильтр по модели, провайдеру или аккаунту" });
    const output = column();
    let data: Catalog | undefined;
    let open = true;
    let reads = 0;
    let ready = false;
    let loadedScope = "";
    let readCancel: any;
    let viewGeneration = 0;
    let visible = 70;
    const details = new Set<any>();
    const closeDetails = () => { for (const item of [...details]) item.force_close(); };
    followParent(dialog, parent);
    dialog.connect("closed", () => { open = false; readCancel?.cancel(); closeDetails(); });
    const render = () => {
      if (!open) return;
      const generation = ++viewGeneration;
      clear(output);
      const snapshot = data;
      const needle = search.get_text().trim().toLocaleLowerCase();
      const items = (data?.items ?? []).filter((item) => [item.name, item.id, item.value, item.provider_id,
        item.provider_label, item.source_id, item.credential_profile_id].join(" ").toLocaleLowerCase().includes(needle));
      if (!items.length) {
        output.append(label(data ? "В полученной выборке нет совпадений." : "", "dim-label"));
        return;
      }
      output.append(label(`Моделей в выборке · ${items.length}`, "dim-label"));
      const list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
      list.add_css_class("boxed-list");
      for (const item of items.slice(0, visible)) {
        const control = actionRow({ title: item.label || item.name || item.id, use_markup: false,
          subtitle: [item.value, item.credential_profile_id, item.is_default && "по умолчанию"].filter(Boolean).join(" · ") });
        const inspect = button("Подробнее…", () => {
          if (!open || !snapshot || data !== snapshot || generation !== viewGeneration) return;
          const detail = this.details(dialog, item, choose && ready ? () => {
            if (!open || !ready || data !== snapshot) return;
            choose(item);
            dialog.force_close();
          } : undefined);
          details.add(detail);
          detail.connect("closed", () => details.delete(detail));
        });
        inspect.set_valign(Gtk.Align.CENTER);
        control.add_suffix(inspect);
        control.set_activatable_widget(inspect);
        list.append(control);
      }
      output.append(list);
      if (items.length > visible) output.append(button("Показать ещё", () => { if (open && generation === viewGeneration) { visible += 70; render(); } }));
    };
    const load = async () => {
      if (!open) return;
      const generation = ++reads;
      ready = false;
      readCancel?.cancel();
      closeDetails();
      const source_id = scope.get_text().trim() || undefined;
      const credential_profile_id = profile.get_text().trim() || undefined;
      if (!source_id && credential_profile_id) {
        status.set_label("Для профиля аккаунта укажите источник.");
        return;
      }
      status.set_label(["Шлюз читает каталоги провайдеров…", data ? `Показан последний прочитанный каталог · ${loadedScope}` : ""].filter(Boolean).join("\n"));
      const token = new Gio.Cancellable();
      readCancel = token;
      try {
        const value = await this.gateway.json<unknown>("GET", `/api/model-catalog${query({ source_id, credential_profile_id })}`, undefined, undefined, true, token);
        if (!open || generation !== reads) return;
        const result = readCatalog(value);
        data = result;
        ready = true;
        loadedScope = [source_id || "все источники", credential_profile_id].filter(Boolean).join(" / ");
        clear(accountInfo);
        const errors = result.errors.map((error) => [error.provider_id, error.source_id, error.credential_profile_id, error.stage,
          error.code, error.error].filter(Boolean).join(" · "));
        status.set_label([result.partial ? "Шлюз вернул частичный каталог." : "", ...errors].filter(Boolean).join("\n"));
        clear(sourceList);
        for (const source of result.model_sources) {
          sourceList.append(button(`Источник · ${source.label || source.id}`, () => {
            if (!open || data !== result) return;
            scope.set_text(source.id);
            profile.set_text("");
            void load();
          }));
          const info = column(4);
          for (const [title, value] of [["Идентификатор источника", source.id], ["Инструмент входа", source.credentialHarness],
            ["Режимы обработки", source.processingPreferences], ["Каталоги по аккаунтам", source.accountCatalog]] as const) field(info, title, value);
          sourceList.append(new Gtk.Expander({ label: `Сведения об источнике · ${source.label || source.id}`, child: info }));
        }
        for (const catalog of result.account_catalogs ?? []) {
          if (!Array.isArray(catalog.accounts)) continue;
          for (const account of catalog.accounts) {
            const source = String(account?.modelSourceId ?? catalog.sourceId ?? catalog.source ?? source_id ?? "");
            const id = String(account?.credentialProfileId ?? "");
            if (source && id) {
              const block = column(4);
              block.append(button(`Аккаунт · ${account.label || id}`, () => {
                if (!open || data !== result) return;
                scope.set_text(source);
                profile.set_text(id);
                void load();
              }));
              const info = column(4);
              const snapshot = object(account.catalog);
              for (const [title, value] of [["Источник", source], ["Профиль", id], ["Доступность", account.availability ?? "Нет сведений"],
                ["Проблема", account.problem], ["Отпечаток аккаунта", snapshot.accountFingerprint], ["Источник сведений", snapshot.provenance],
                ["Время проверки", snapshot.observedAt], ["Моделей в снимке", Array.isArray(snapshot.models) ? snapshot.models.length : undefined]] as const) field(info, title, value);
              if (Object.hasOwn(account, "catalog")) field(info, "Снимок каталога", account.catalog === null ? "Недоступен"
                : account.catalog === snapshot ? "Получен" : "Формат неизвестен");
              block.append(new Gtk.Expander({ label: `Состояние аккаунта · ${account.label || id}`, child: info }));
              accountInfo.append(block);
            }
          }
        }
        visible = 70;
        render();
      } catch (error) {
        if (open && generation === reads) status.set_label([errorText(error), data ? `Показан последний прочитанный каталог · ${loadedScope}. Выбор маршрута недоступен до успешного чтения.` : ""].filter(Boolean).join("\n"));
      } finally { if (readCancel === token) readCancel = undefined; }
    };
    search.connect("search-changed", () => { if (open) { visible = 70; render(); } });
    const editedScope = () => { if (open) { reads++; readCancel?.cancel(); readCancel = undefined; ready = false; closeDetails(); status.set_label("Параметры источника изменены. Загрузите каталог перед выбором маршрута."); } };
    scope.connect("changed", editedScope);
    profile.connect("changed", editedScope);
    scope.connect("activate", () => void load());
    profile.connect("activate", () => void load());
    for (const widget of [scope, profile, button("Загрузить каталог", () => void load()), sourceList, accountInfo]) options.append(widget);
    for (const widget of [new Gtk.Expander({ label: "Источник и аккаунт", child: options }), status, search, output]) content.append(widget);
    this.present(dialog, parent);
    void load();
  }

  private details(parent: any, model: Model, choose?: () => void): any {
    const content = column();
    const dialog = sheet(model.label || model.name || model.id, content);
    let open = true;
    dialog.connect("closed", () => { open = false; });
    followParent(dialog, parent);
    for (const [title, value] of [
      ["Маршрут", model.value], ["Провайдер", model.provider_label || model.provider || model.provider_id], ["Источник", model.source], ["Идентификатор источника", model.source_id],
      ["Профиль", model.credential_profile_id], ["Отпечаток аккаунта", model.account_fingerprint],
      ["Контекст", model.context_window], ["Максимальный контекст", model.max_context_window],
      ["Максимум токенов ответа", model.max_output_tokens], ["Вход", model.input_modalities?.join(", ")],
      ["Уровни рассуждения", model.reasoning_efforts?.join(", ")], ["Уровень по умолчанию", model.default_reasoning_effort],
      ["Доступность", model.availability], ["Проблема", model.problem], ["Обработка", model.processing],
      ["Параметры", model.supported_options], ["Источник сведений", model.provenance], ["Время проверки", model.observed_at],
    ] as const) field(content, title, value);
    if (choose) content.append(button("Выбрать этот маршрут", () => {
      if (!open) return;
      dialog.force_close();
      choose();
    }));
    this.present(dialog, parent);
    return dialog;
  }
}
