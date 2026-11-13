import { Gio, GLib, Gtk } from "./gi.js";
import { type Gateway, HttpError, query } from "./gateway.js";
import { type ShowSkillDialog, type SkillSource } from "./skill-sources.js";
import { object, ownerHeaders } from "./settings-write.js";
import { actionRow, button, clear, column, confirm, errorText, label, row, sheet } from "./ui.js";

export interface CatalogItem {
  id: string;
  source_id: string;
  source_name: string;
  name: string;
  title?: string;
  description?: string;
  category?: string[];
  version?: string;
  digest?: string;
  trust?: string;
  owner?: string;
  updated_at?: string;
  official?: boolean;
  recommended?: boolean;
  registry_slug?: string;
  needs_keys?: string[];
  permissions?: string[];
  withdrawn?: { reason?: string } | null;
  signals?: Record<string, unknown> | null;
  installed?: { state: string; source_name?: string; version?: string; digest?: string;
    modified?: boolean | null; update_available?: boolean } | null;
  registry_stats?: Record<string, unknown>;
  install_specs?: unknown;
}

interface Catalog {
  items: CatalogItem[];
  categories: { id: string; label: string }[];
  sources: SkillSource[];
  starter?: { state?: string };
}

interface Detail {
  item: CatalogItem;
  about?: string;
  about_error?: string;
  uses?: { kind: string; id: string; label?: string }[];
  versions?: { version: string; digest: string }[];
  links?: Record<string, string>;
}

interface InstallReply {
  ok: boolean;
  name?: string;
  job_id?: string;
  basis?: string;
  already_installed?: boolean;
  error?: string;
  code?: string;
}

export interface RegistryEntry {
  slug: string;
  display_name?: string;
  summary?: string;
  description?: string;
  latest_version?: string;
  versions?: unknown[];
  requires_env?: string[];
  requires_bins?: string[];
  primary_env?: string;
  os?: string[];
  install_specs?: unknown[];
  badges?: Record<string, unknown>;
  stats?: Record<string, unknown>;
  is_plugin?: boolean;
  license?: string;
  homepage?: string;
}

export interface RegistryPreview {
  slug: string;
  version: string;
  summary: RegistryEntry;
  metadata_only: boolean;
  adapter: { ok?: boolean; warnings?: unknown[]; blockers?: unknown[] };
  staging?: { is_plugin?: boolean };
}

export const registryPath = "/api/marketplace/clawhub";

export function safeLink(target: any, title: string, uri?: string): void {
  if (!uri || !/^https?:\/\//i.test(uri)) return;
  try {
    const url = GLib.Uri.parse(uri, GLib.UriFlags.NONE);
    if (url.get_host() && !url.get_userinfo()) target.append(new Gtk.LinkButton({ label: title, uri, halign: Gtk.Align.START }));
  } catch { /* malformed link */ }
}

export function field(target: any, value: string, style?: string): void {
  if (!value) return;
  const widget = label(value, style);
  widget.set_selectable(true);
  target.append(widget);
}

export function registryEvidence(target: any, title: string, value: unknown): void {
  if (value == null || value === "" || typeof value === "object" && !Object.keys(value).length) return;
  const section = new Gtk.Expander({ label: title });
  const body = label(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  body.set_selectable(true);
  body.add_css_class("monospace");
  section.set_child(body);
  target.append(section);
}

export function registryEntryFacts(target: any, summary: RegistryEntry): void {
  field(target, summary.description || summary.summary || "");
  if (summary.is_plugin) field(target, "Плагин ClawHub");
  if (summary.os?.length) field(target, `Системы · ${summary.os.join(", ")}`);
  if (summary.requires_env?.length) field(target, `Ключи и переменные · ${summary.requires_env.join(", ")}`);
  if (summary.primary_env) field(target, `Основная переменная · ${summary.primary_env}`);
  if (summary.requires_bins?.length) field(target, `Программы · ${summary.requires_bins.join(", ")}`);
  registryEvidence(target, "Метки реестра", summary.badges);
  registryEvidence(target, "Статистика реестра", summary.stats);
  registryEvidence(target, "Сведения об установке зависимостей", summary.install_specs);
  safeLink(target, "Страница в реестре", summary.homepage);
}

export function registryFacts(target: any, { summary, version, metadata_only: metadata, adapter, staging }: RegistryPreview): void {
  field(target, [summary.display_name ?? summary.slug, version, summary.license].filter(Boolean).join(" · "), "heading");
  if (metadata) field(target, "Предпросмотр метаданных. Архив навыка ещё не загружен.", "dim-label");
  registryEntryFacts(target, { ...summary, is_plugin: summary.is_plugin || staging?.is_plugin });
  for (const issue of [...(adapter.warnings ?? []), ...(adapter.blockers ?? [])]) {
    field(target, typeof issue === "string" ? issue : JSON.stringify(issue));
  }
}

const catalogPath = "/api/skill-catalog";
const pageSize = 50;

export class SkillCatalog {
  private dialog?: any;
  private view?: Catalog;
  private result?: CatalogItem[];
  private catalogRead = 0;
  private catalogLoading = false;
  private searchRead = 0;
  private searched = false;
  private updatingOptions = false;
  private poll = 0;
  private displayed = pageSize;
  private cancel?: any;
  private readonly details = new Set<any>();
  private readonly search = new Gtk.SearchEntry({ placeholder_text: "Поиск по каталогу и ClawHub" });
  private readonly source = Gtk.DropDown.new_from_strings(["Все источники"]);
  private readonly category = Gtk.DropDown.new_from_strings(["Все категории"]);
  private readonly shelf = Gtk.DropDown.new_from_strings(["Все навыки", "Только официальные", "Рекомендованные"]);
  private readonly catalogStatus = label("", "dim-label");
  private readonly searchStatus = label("", "dim-label");
  private readonly list = column(6);

  constructor(
    private readonly gateway: Gateway, private readonly present: ShowSkillDialog,
    private readonly installed: (name: string) => void,
    private readonly blocked: (name: string) => boolean,
    private readonly track: (name: string, job: string) => void,
  ) {
    this.search.connect("activate", () => void this.loadSearch());
    this.search.connect("changed", () => this.resetSearch());
    this.source.connect("notify::selected", () => {
      if (!this.updatingOptions) this.resetSearch();
    });
    for (const filter of [this.category, this.shelf]) filter.connect("notify::selected", () => {
      if (!this.updatingOptions) {
        this.displayed = pageSize;
        this.render();
      }
    });
  }

  show(search?: string): void {
    if (search !== undefined) this.search.set_text(search);
    if (this.dialog) {
      if (search?.trim()) void this.loadSearch();
      return;
    }
    const content = column();
    const dialog = sheet("Каталог навыков", content);
    dialog.set_content_width(700);
    dialog.set_content_height(640);
    this.dialog = dialog;
    this.cancel = new Gio.Cancellable();
    const controls = row();
    controls.append(button("Обновить каталог", () => void this.load(true)));
    controls.append(button("Искать на шлюзе", () => void this.loadSearch()));
    const filters = column(4);
    for (const widget of [this.source, this.category, this.shelf]) filters.append(widget);
    for (const widget of [controls, this.catalogStatus, this.search, filters, this.searchStatus, this.list]) content.append(widget);
    dialog.connect("closed", () => {
      this.dialog = undefined;
      this.cancel.cancel();
      for (const detail of [...this.details]) detail.force_close();
      this.catalogRead++;
      this.catalogLoading = false;
      this.resetSearch();
      if (this.poll) GLib.Source.remove(this.poll);
      this.poll = 0;
      for (const widget of [this.source, this.category, this.shelf]) filters.remove(widget);
      for (const widget of [this.catalogStatus, this.search, this.searchStatus, this.list]) content.remove(widget);
    });
    this.present(dialog);
    this.render();
    this.poll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
      if (!this.catalogLoading && this.view?.sources.some((item) => item.refreshing || item.state === "reading")) void this.load();
      return GLib.SOURCE_CONTINUE;
    });
    void this.load();
    if (search?.trim()) void this.loadSearch();
  }

  invalidate(): void {
    if (!this.dialog) return;
    void this.load();
    if (this.searched) void this.loadSearch();
  }

  private resetSearch(): void {
    this.searchRead++;
    this.searched = false;
    this.result = undefined;
    this.displayed = pageSize;
    this.searchStatus.set_label("");
    this.render();
  }

  private async load(refresh = false): Promise<void> {
    const dialog = this.dialog;
    if (!dialog) return;
    const token = ++this.catalogRead;
    this.catalogLoading = true;
    if (refresh || !this.view) this.catalogStatus.set_label(refresh ? "Запрашиваю обновление каталога…" : "Читаю каталог…");
    try {
      const result = await this.gateway.json<Catalog>("GET", catalogPath + query({ refresh: refresh ? 1 : undefined }), undefined, {}, false, this.cancel);
      if (this.dialog !== dialog || token !== this.catalogRead) return;
      if (!Array.isArray(result?.items) || !Array.isArray(result.sources) || !Array.isArray(result.categories)) {
        throw new Error("Шлюз не вернул каталог навыков.");
      }
      const previous = this.view;
      const source = previous?.sources[this.source.get_selected() - 1]?.id;
      this.view = result;
      this.updatingOptions = true;
      if (JSON.stringify(previous?.sources.map((item) => [item.id, item.name])) !== JSON.stringify(result.sources.map((item) => [item.id, item.name]))) {
        this.options(this.source, previous?.sources.map((item) => item.id) ?? [],
          result.sources.map((item) => ({ id: item.id, label: item.name })));
      }
      if (JSON.stringify(previous?.categories) !== JSON.stringify(result.categories)) {
        this.options(this.category, previous?.categories.map((item) => item.id) ?? [], result.categories);
      }
      this.updatingOptions = false;
      if (source && !result.sources.some((item) => item.id === source)) this.resetSearch();
      const pending = result.sources.filter((item) => item.refreshing || item.state === "reading").map((item) => item.name);
      const errors = result.sources.filter((item) => item.error).map((item) => `${item.name} · ${item.error}`);
      this.catalogStatus.set_label([pending.length ? `Шлюз читает источники · ${pending.join(", ")}` : "", ...errors].filter(Boolean).join("\n"));
      this.render();
    } catch (error) {
      if (this.dialog === dialog && token === this.catalogRead) this.catalogStatus.set_label(
        (this.view ? "Показан последний загруженный каталог. " : "") + errorText(error));
    } finally {
      this.updatingOptions = false;
      if (token === this.catalogRead) this.catalogLoading = false;
    }
  }

  private options(widget: any, old: string[], items: { id: string; label: string }[]): void {
    const selected = old[widget.get_selected() - 1];
    const model = widget.get_model();
    model.splice(1, model.get_n_items() - 1, items.map((item) => item.label));
    widget.set_selected(items.findIndex((item) => item.id === selected) + 1);
  }

  private async loadSearch(): Promise<void> {
    const dialog = this.dialog;
    if (!dialog) return;
    const q = this.search.get_text().trim();
    if (!q) {
      this.resetSearch();
      await this.load();
      return;
    }
    const token = ++this.searchRead;
    this.searched = true;
    const source = this.view?.sources[this.source.get_selected() - 1]?.id;
    this.searchStatus.set_label("Ищу на шлюзе и в подключённых реестрах…");
    try {
      const result = await this.gateway.json<{ items: CatalogItem[]; registry_error?: string }>(
        "GET", `${catalogPath}/search${query({ q, source })}`, undefined, {}, false, this.cancel);
      if (this.dialog !== dialog || token !== this.searchRead) return;
      if (!Array.isArray(result?.items)) throw new Error("Шлюз не вернул результаты поиска.");
      this.result = result.items;
      this.displayed = pageSize;
      this.searchStatus.set_label(result.registry_error ?? "");
      this.render();
    } catch (error) {
      if (this.dialog === dialog && token === this.searchRead) this.searchStatus.set_label(errorText(error));
    }
  }

  private render(): void {
    if (!this.dialog) return;
    clear(this.list);
    const source = this.view?.sources[this.source.get_selected() - 1]?.id;
    const category = this.view?.categories[this.category.get_selected() - 1]?.id;
    const shelf = this.shelf.get_selected();
    const words = this.result ? [] : this.search.get_text().trim().toLocaleLowerCase().split(/\s+/);
    const items = (this.result ?? this.view?.items ?? []).filter((item) =>
      (!source || item.source_id === source) && (!category || item.category?.includes(category))
      && (shelf === 0 || (shelf === 1 ? item.official : item.recommended))
      && words.every((word: string) => [item.name, item.title, item.description].join(" ").toLocaleLowerCase().includes(word)));
    const list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
    list.add_css_class("boxed-list");
    field(this.list, `Найдено · ${items.length}`, "dim-label");
    if (shelf === 0 && !source && !category && !this.search.get_text().trim() && this.view?.starter?.state === "upgrade"
      && items.some((item) => item.recommended && item.installed?.state !== "installed")) {
      this.list.append(button("Рекомендации после обновления", () => this.shelf.set_selected(2)));
    }
    for (const item of items.slice(0, this.displayed)) {
      const entry = actionRow({
        title: item.title || item.name, use_markup: false,
        subtitle: [item.source_name, item.version, item.official && "Официальный", item.recommended && "Рекомендуется",
          item.withdrawn && "Отозван", item.installed?.state === "installed" && "Установлен",
          item.installed?.state === "name_taken" && "Имя занято"].filter(Boolean).join(" · "),
      });
      const open = button("Подробнее", () => this.open(item));
      open.set_valign(Gtk.Align.CENTER);
      entry.add_suffix(open);
      entry.set_activatable_widget(open);
      list.append(entry);
    }
    if (items.length) this.list.append(list);
    if (items.length > this.displayed) this.list.append(button("Показать ещё", () => {
      this.displayed += pageSize;
      this.render();
    }));
  }

  private itemPath(item: CatalogItem): string {
    return `${catalogPath}/item/${encodeURIComponent(item.source_id)}/${encodeURIComponent(item.name)}`;
  }

  private open(initial: CatalogItem): void {
    const parent = this.dialog;
    if (!parent) return;
    const content = column();
    const dialog = sheet(initial.title || initial.name, content);
    let open = true;
    let reading = false;
    const cancel = new Gio.Cancellable();
    const current = () => open && this.dialog === parent;
    this.details.add(dialog);
    dialog.connect("closed", () => {
      open = false;
      cancel.cancel();
      this.details.delete(dialog);
    });
    const status = label("", "dim-label");
    const detail = column();
    const load = async () => {
      if (!current() || reading) return;
      reading = true;
      clear(detail);
      status.set_label("Читаю выпуск…");
      try {
        if (initial.registry_slug) {
          const preview = await this.gateway.json<RegistryPreview>("GET",
            `${registryPath}/preview/${encodeURIComponent(initial.registry_slug)}${query({ version: initial.version })}`, undefined, {}, false, cancel);
          if (!current()) return;
          status.set_label("");
          registryFacts(detail, preview);
          if (preview.adapter.ok !== false) this.installForm(dialog, detail, status, { ...initial, version: preview.version }, current, cancel);
          return;
        }
        const result = await this.gateway.json<Detail>("GET", this.itemPath(initial), undefined, {}, false, cancel);
        if (!current()) return;
        const item = result.item;
        if (item.id !== initial.id) throw new Error("Шлюз вернул сведения о другом навыке.");
        status.set_label("");
        field(detail, [item.source_name, item.owner, item.version, item.updated_at, item.digest, item.official && "Официальный"].filter(Boolean).join(" · "));
        field(detail, item.description ?? "");
        if (item.installed?.state === "installed") {
          field(detail, [item.installed.version && `Установлен выпуск ${item.installed.version}`, item.installed.digest,
            item.installed.modified && "Есть локальные изменения", item.installed.update_available && "Доступно обновление"].filter(Boolean).join(" · "));
        }
        registryEvidence(detail, "Статистика реестра", item.registry_stats);
        registryEvidence(detail, "Сведения об установке зависимостей", item.install_specs);
        field(detail, result.about_error ?? "");
        field(detail, result.about ?? "");
        if (item.signals) {
          field(detail, Object.entries(item.signals).filter(([, value]) => typeof value === "number").map(([name, value]) => `${name} · ${value}`).join(", "));
        }
        for (const use of result.uses ?? []) field(detail, [use.kind, use.id, use.label].filter(Boolean).join(" · "));
        for (const release of result.versions ?? []) field(detail, [release.version, release.digest].filter(Boolean).join(" · "));
        for (const [key, uri] of Object.entries(result.links ?? {})) safeLink(detail, key, uri);
        if (item.withdrawn) field(detail, ["Выпуск отозван", item.withdrawn.reason].filter(Boolean).join(" · "));
        else if (item.installed?.state === "installed") {
          detail.append(button("Открыть установленный навык", () => {
            dialog.force_close();
            this.dialog?.force_close();
            this.installed(item.name);
          }));
        } else if (item.digest && this.view?.sources.find((source) => source.id === item.source_id)?.kind !== "local") {
          this.installForm(dialog, detail, status, item, current, cancel);
        }
      } catch (error) {
        if (!current()) return;
        status.set_label(errorText(error));
        detail.append(button("Повторить чтение", () => void load()));
      } finally {
        reading = false;
      }
    };
    content.append(status);
    content.append(detail);
    this.present(dialog, parent);
    void load();
  }

  private installForm(dialog: any, content: any, status: any, item: CatalogItem, current: () => boolean, cancel: any): void {
    const turnOn = new Gtk.CheckButton({ label: "Включить, когда навык будет готов", active: true });
    const source = this.view?.sources.find((source) => source.id === item.source_id);
    const trust = item.trust ?? source?.trust;
    const basis = trust === "trusted"
      ? "Источник настроен на установку без проверки моделями." : "Шлюз отправит навык на проверку моделями.";
    field(content, basis);
    const occupant = label("");
    let collision = item.installed?.state === "name_taken";
    if (collision) occupant.set_label(`Имя занято · ${item.installed?.source_name ?? item.name}`);
    const install = button(collision ? "Заменить установленный навык…" : "Установить…", () => {
      void (async () => {
        if (!current() || !install.get_sensitive()) return;
        if (this.blocked(item.name)) {
          status.set_label("Операция с этим навыком уже выполняется. Её состояние видно в очереди.");
          return;
        }
        install.set_sensitive(false);
        turnOn.set_sensitive(false);
        const enable = turnOn.get_active();
        const replace = collision;
        let retry = true;
        try {
          const warning = replace ? `Шлюз заменит навык с этим именем и сохранит резервную копию.\n${occupant.get_label()}` : "";
          if (!await confirm(dialog, `Установить ${item.title ?? item.name}?`,
            [item.source_name, item.version, basis, warning, enable ? "Шлюз попробует включить навык после подготовки." : ""].filter(Boolean).join("\n"),
            replace ? "Заменить и установить" : "Установить") || !current()) return;
          if (this.blocked(item.name)) throw new Error("В очереди уже появилась операция с этим навыком.");
          if (item.digest) {
            const { item: latest } = await this.gateway.json<Detail>("GET", this.itemPath(item), undefined, {}, false, cancel);
            if (!current()) return;
            if (latest.id !== item.id || latest.digest !== item.digest || latest.trust !== trust || latest.withdrawn) {
              retry = false;
              throw new Error("Выпуск или режим доверия изменился. Откройте сведения заново.");
            }
          } else if (item.registry_slug && item.version) {
            const latest = await this.gateway.json<RegistryPreview>("GET", `${registryPath}/preview/${encodeURIComponent(item.registry_slug)}`, undefined, {}, false, cancel);
            if (!current()) return;
            if (latest.version !== item.version || latest.adapter.ok === false) {
              retry = false;
              throw new Error("Выпуск в реестре изменился. Откройте сведения заново.");
            }
          }
          status.set_label("Отправляю запрос установки…");
          retry = false;
          const reply = await this.gateway.json<InstallReply>("POST", `${catalogPath}/install`, {
            id: item.id, turn_on_when_ready: enable, ...(replace ? { replace: true } : {}),
          }, ownerHeaders, false, cancel);
          if (reply.job_id && reply.ok) this.track(reply.name || item.name, reply.job_id);
          if (!current()) return;
          if (!reply.ok) throw new Error(reply.error || reply.code || "Шлюз отклонил установку.");
          status.set_label(reply.job_id
            ? [`Запрос принят · ${reply.job_id}`, reply.basis, "Итог появится в очереди операций."].filter(Boolean).join(" · ")
            : reply.already_installed ? "Этот выпуск уже установлен." : "Шлюз принял запрос. Идентификатор операции отсутствует.");
          this.invalidate();
        } catch (error) {
          if (!current()) return;
          if (error instanceof HttpError && error.status === 409 && error.reason === "name_taken" && !replace) {
            const known = object(object(error.body).occupant);
            collision = true;
            retry = true;
            occupant.set_label([`Имя занято · ${known.name || item.name}`, known.source,
              Array.isArray(known.locations) ? known.locations.join(", ") : ""].filter(Boolean).join(" · "));
            install.set_label("Заменить установленный навык…");
          }
          status.set_label(error instanceof HttpError || retry ? errorText(error) : `Проверьте каталог и очередь операций. ${errorText(error)}`);
        } finally {
          if (current() && retry) {
            install.set_sensitive(true);
            turnOn.set_sensitive(true);
          }
        }
      })();
    });
    for (const widget of [occupant, turnOn, install]) content.append(widget);
  }
}
