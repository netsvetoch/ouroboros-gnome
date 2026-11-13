import { Adw, Gio, GLib, Gtk } from "./gi.js";
import { type Gateway, HttpError, query } from "./gateway.js";
import { field, registryEntryFacts, registryEvidence, registryFacts, registryPath, type RegistryEntry, type RegistryPreview } from "./skill-catalog.js";
import { type ShowSkillDialog } from "./skill-sources.js";
import { object, ownerHeaders } from "./settings-write.js";
import { button, clear, column, errorText, label, row, sheet } from "./ui.js";

interface RegistryPage {
  results: RegistryEntry[];
  next_cursor?: string | null;
  registry_warnings?: string[];
}

interface InstalledEntry {
  name: string;
  version?: string;
  enabled?: boolean;
  review_status?: string;
  review_stale?: boolean;
  review_gate?: unknown;
  review_findings?: unknown;
  executable_review?: boolean;
  load_error?: string | null;
  payload_root?: string;
  grants?: unknown;
  provenance?: { slug?: string; [key: string]: unknown };
}

interface Filter {
  q: string;
  official: boolean;
  plugins: boolean;
  limit: number;
}

type Operation = "install" | "update" | "uninstall";
const completed: Record<Operation, string> = {
  install: "Навык установлен", update: "Навык обновлён", uninstall: "Навык удалён",
};

function registryResult(target: any, reply: ReturnType<typeof object>): void {
  const archive = object(reply.archive);
  for (const [title, value] of [
    ["Выпуск архива", archive.version], ["Размер архива, байт", archive.size_bytes], ["SHA-256 архива", archive.sha256],
    ["Путь назначения на шлюзе", reply.target_dir],
  ]) {
    if (typeof value === "number" || typeof value === "string" && value) field(target, `${title} · ${value}`);
  }
  registryEvidence(target, "Результат адаптации", reply.adapter);
  registryEvidence(target, "Замечания проверки", reply.review_findings);
  registryEvidence(target, "Отпечаток зависимостей", reply.deps_fingerprint);
  registryEvidence(target, "Происхождение выпуска", reply.provenance);
}

function registryEntry(value: RegistryEntry): boolean {
  return Boolean(value && typeof value === "object" && typeof value.slug === "string" && value.slug
    && [value.display_name, value.summary, value.description, value.latest_version, value.license, value.homepage]
      .every(value => value === undefined || typeof value === "string")
    && [value.versions, value.requires_env, value.requires_bins, value.os].every(value => value === undefined
      || Array.isArray(value) && value.every(item => typeof item === "string"))
    && [value.badges, value.stats].every(value => value === undefined || value === object(value)));
}

function entryValidPreview(value: RegistryPreview): boolean {
  return registryEntry(value.summary) && typeof value.slug === "string" && typeof value.version === "string"
    && value.summary.slug === value.slug && value.adapter === object(value.adapter)
    && typeof value.adapter.ok === "boolean"
    && [value.adapter.warnings, value.adapter.blockers].every(value => value === undefined || Array.isArray(value));
}

function scope(dialog: any, parent?: any): { alive: () => boolean; cancel: any } {
  let open = true, signal = 0;
  const cancel = new Gio.Cancellable();
  const dispose = () => {
    if (!open) return;
    open = false;
    cancel.cancel();
    if (signal) { parent.disconnect(signal); signal = 0; }
  };
  dialog.connect("closed", dispose);
  if (parent) signal = parent.connect("closed", dispose);
  return { alive: () => open, cancel };
}

function confirmRegistry(parent: any, cancel: any, title: string, body: string, action: string): Promise<boolean> {
  if (cancel.is_cancelled()) return Promise.resolve(false);
  const dialog = new Adw.AlertDialog({ heading: title, body });
  dialog.add_response("cancel", "Отмена");
  dialog.add_response("ok", action);
  dialog.set_close_response("cancel");
  dialog.set_default_response("cancel");
  dialog.set_response_appearance("ok", Adw.ResponseAppearance.DESTRUCTIVE);
  return new Promise(resolve => {
    let done = false, signal = 0;
    const finish = (allowed: boolean) => {
      if (done) return;
      done = true;
      if (signal) { cancel.disconnect(signal); signal = 0; }
      resolve(allowed);
    };
    dialog.connect("response", (_dialog: unknown, response: string) => finish(response === "ok"));
    signal = cancel.connect(() => {
      GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { finish(false); if (dialog.get_mapped()) dialog.force_close(); return GLib.SOURCE_REMOVE; });
    });
    dialog.present(parent);
  });
}

export class SkillRegistry {
  private writing = false;
  private confirming = false;
  private dialog?: any;

  constructor(private readonly gateway: Gateway, private readonly present: ShowSkillDialog, private readonly changed: () => void) {}

  show(): void {
    if (this.dialog) return;
    const content = column();
    const dialog = this.dialog = sheet("Реестр ClawHub", content);
    dialog.set_content_width(690);
    dialog.set_content_height(620);
    const search = new Gtk.SearchEntry({ placeholder_text: "Поиск в ClawHub" });
    const official = new Gtk.CheckButton({ label: "Только официальные" });
    const plugins = new Gtk.CheckButton({ label: "Показывать плагины" });
    const limit = Gtk.SpinButton.new_with_range(1, 100, 1);
    limit.set_value(24);
    limit.set_tooltip_text("Размер выборки");
    const pageSize = label("Размер выборки");
    pageSize.set_mnemonic_widget(limit);
    const filters = row();
    for (const widget of [official, plugins, pageSize, limit]) filters.append(widget);
    const list = column();
    const status = label("", "dim-label");
    let open = true;
    let pending: any;
    let generation = 0;
    let loaded: Filter | undefined;
    let next: string | null | undefined;
    const entries = new Set<string>();
    const usedCursors = new Set<string>();
    dialog.connect("closed", () => { open = false; generation++; pending?.cancel(); if (this.dialog === dialog) this.dialog = undefined; });
    const load = async (append = false) => {
      if (!open) return;
      if (append && (!loaded || !next)) return;
      const filter = append && loaded ? loaded : { q: search.get_text().trim(), official: official.get_active(),
        plugins: plugins.get_active(), limit: limit.get_value_as_int() };
      const cursor = append ? next : undefined;
      const token = ++generation;
      pending?.cancel();
      const cancel = pending = new Gio.Cancellable();
      more.set_sensitive(false);
      status.set_label("Шлюз читает реестр…");
      try {
        const result = await this.gateway.json<RegistryPage>("GET",
          `${registryPath}/search${query({ q: filter.q || undefined, official: filter.official ? 1 : undefined,
            include_plugins: filter.plugins ? 1 : undefined, cursor, limit: filter.limit })}`, undefined, undefined, false, cancel);
        if (!open || token !== generation) return;
        if (!Array.isArray(result?.results) || !result.results.every(registryEntry)
          || result.next_cursor != null && typeof result.next_cursor !== "string"
          || result.registry_warnings !== undefined && (!Array.isArray(result.registry_warnings)
            || !result.registry_warnings.every(item => typeof item === "string"))) throw new Error("Шлюз не вернул список пакетов.");
        if (!append) {
          clear(list);
          entries.clear();
          usedCursors.clear();
        }
        loaded = filter;
        if (cursor) usedCursors.add(cursor);
        const repeated = Boolean(!filter.q && result.next_cursor && usedCursors.has(result.next_cursor));
        next = filter.q || repeated ? null : result.next_cursor;
        for (const item of result.results) {
          if (entries.has(item.slug)) continue;
          entries.add(item.slug);
          list.append(button(item.display_name || item.slug, () => { if (open && loaded === filter) this.inspect(dialog, item); }));
          field(list, [item.slug, item.latest_version, item.is_plugin && "Плагин", item.badges?.official === true && "Официальный",
            item.summary].filter(Boolean).join(" · "), "dim-label");
        }
        status.set_label([entries.size ? `В списке · ${entries.size}` : "По этим фильтрам пока нет результатов.",
          repeated && "Шлюз повторил уже использованный курсор.",
          ...(result.registry_warnings ?? [])].filter(Boolean).join("\n"));
        more.set_visible(Boolean(next));
        more.set_sensitive(Boolean(next));
      } catch (error) {
        if (open && token === generation) {
          status.set_label(errorText(error));
          more.set_sensitive(Boolean(next));
        }
      }
    };
    const more = button("Ещё результаты", () => void load(true));
    more.set_visible(false);
    const tools = row();
    tools.append(button("Найти", () => void load()));
    tools.append(button("Установленные из ClawHub…", () => { if (open) this.installed(dialog, "clawhub"); }));
    tools.append(button("Установленные из OuroborosHub…", () => { if (open) this.installed(dialog, "ouroboroshub"); }));
    const reset = () => {
      if (!open) return;
      pending?.cancel();
      generation++;
      loaded = undefined;
      next = undefined;
      more.set_visible(false);
      clear(list);
      status.set_label("");
    };
    search.connect("activate", () => void load());
    search.connect("changed", reset);
    official.connect("toggled", reset);
    plugins.connect("toggled", reset);
    limit.connect("value-changed", reset);
    for (const widget of [search, filters, tools, status, list, more]) content.append(widget);
    this.present(dialog);
    void load();
  }

  private inspect(parent: any, entry: RegistryEntry): void {
    const content = column();
    const dialog = sheet(entry.display_name || entry.slug, content);
    const description = column();
    const status = label("", "dim-label");
    const version = new Gtk.Entry({ text: entry.latest_version ?? "", placeholder_text: "Версия, по умолчанию последняя" });
    const read = column();
    const results = column();
    const receipt = column();
    const options = new Gtk.CheckButton({ label: "Проверить навык после установки", active: true });
    const overwrite = new Gtk.CheckButton({ label: "Разрешить замену уже установленной копии" });
    const life = scope(dialog, parent);
    let token = 0;
    let pending: any;
    let installing = false;
    life.cancel.connect(() => pending?.cancel());
    const preview = button("Посмотреть выпуск", () => {
      void (async () => {
        if (!life.alive() || installing) return;
        const current = ++token;
        pending?.cancel();
        const cancel = pending = new Gio.Cancellable();
        const requested = version.get_text().trim();
        clear(results);
        clear(receipt);
        status.set_label("Читаю выпуск…");
        try {
          const info = await this.gateway.json<RegistryPreview>("GET",
            `${registryPath}/preview/${encodeURIComponent(entry.slug)}${query({ version: requested || undefined })}`, undefined, undefined, false, cancel);
          if (!life.alive() || current !== token) return;
          if (!info || !entryValidPreview(info)) throw new Error("Шлюз не вернул сведения о выпуске.");
          if (info.slug !== entry.slug || (requested && info.version !== requested)) {
            throw new Error("Шлюз вернул сведения о другом выпуске.");
          }
          status.set_label("");
          registryFacts(results, info);
          if (info.adapter.ok !== true || info.staging?.is_plugin || info.summary.is_plugin) return;
          if (!info.version) {
            status.set_label("В ответе шлюза отсутствует номер выпуска.");
            return;
          }
          const install = button("Установить из ClawHub…", () => {
            void (async () => {
              if (!life.alive() || token !== current || installing) return;
              installing = true;
              const replace = overwrite.get_active();
              const review = options.get_active();
              install.set_sensitive(false);
              read.set_sensitive(false);
              const confirmed = await confirmRegistry(dialog, life.cancel, `Установить ${info.slug} · ${info.version}?`,
                [replace ? "Разрешена замена уже установленного навыка." : "",
                  review ? "Файлы навыка будут отправлены моделям проверки." : "Вы выбрали установку без проверки моделями."].filter(Boolean).join("\n"),
                "Установить");
              try {
                if (!life.alive() || token !== current) return;
                if (!confirmed) {
                  install.set_sensitive(true);
                  return;
                }
                await this.write("install", undefined, { slug: info.slug, version: info.version, auto_review: review, overwrite: replace },
                  status, receipt, () => life.alive() && token === current);
              } finally {
                installing = false;
                if (life.alive()) read.set_sensitive(true);
              }
            })();
          });
          for (const widget of [options, overwrite, install]) results.append(widget);
        } catch (error) {
          if (life.alive() && current === token) status.set_label(errorText(error));
        }
      })();
    });
    version.connect("changed", () => {
      pending?.cancel();
      token++;
      clear(results);
      clear(receipt);
      status.set_label("");
    });
    read.append(version);
    read.append(preview);
    for (const widget of [description, read, results, status, receipt]) content.append(widget);
    this.present(dialog, parent);
    void this.gateway.json<RegistryEntry>("GET", `${registryPath}/info/${encodeURIComponent(entry.slug)}`, undefined, undefined, false, life.cancel).then((info) => {
      if (!life.alive()) return;
      if (!registryEntry(info) || info.slug !== entry.slug) throw new Error("Шлюз не вернул сведения о выбранном пакете.");
      field(description, [info.slug, info.latest_version, info.license].filter(Boolean).join(" · "), "dim-label");
      registryEntryFacts(description, info);
      const releases = [...new Set([info.latest_version, ...(info.versions ?? [])]
        .filter((release): release is string => typeof release === "string" && Boolean(release)))];
      if (releases.length) {
        const published = Gtk.DropDown.new_from_strings(["Выпуски из реестра", ...releases]);
        published.connect("notify::selected", () => {
          const release = releases[published.get_selected() - 1];
          if (release) {
            version.set_text(release);
            published.set_selected(0);
          }
        });
        read.prepend(published);
      }
      if (!version.get_text().trim() && !token && info.latest_version) version.set_text(info.latest_version);
    }).catch((error: unknown) => {
      if (life.alive()) field(description, errorText(error));
    });
  }

  private installed(parent: any, registry: "clawhub" | "ouroboroshub"): void {
    const content = column();
    const title = registry === "clawhub" ? "ClawHub" : "OuroborosHub";
    const path = `/api/marketplace/${registry}`;
    const dialog = sheet(`Установленные из ${title}`, content);
    const status = label("", "dim-label");
    const receipt = column();
    const listStatus = label("", "dim-label");
    const list = column(12);
    const life = scope(dialog, parent);
    let revision = 0;
    let reading = false;
    const load = async () => {
      if (!life.alive() || reading) return;
      reading = true;
      try {
        const { skills } = await this.gateway.json<{ skills: InstalledEntry[] }>("GET", `${path}/installed`, undefined, undefined, false, life.cancel);
        if (!life.alive()) return;
        if (!Array.isArray(skills) || !skills.every(item => item && typeof item.name === "string" && item.name)) throw new Error("Шлюз не вернул список установленных навыков.");
        const current = ++revision;
        listStatus.set_label("");
        clear(list);
        if (!skills.length) field(list, "Установленных навыков из этого реестра нет.");
        for (const item of skills) {
          const group = column(4);
          field(group, [item.name, item.version, item.enabled ? "включён" : "выключен", item.review_status].filter(Boolean).join(" · "), "heading");
          field(group, item.load_error ?? "");
          if (item.payload_root) field(group, `Файлы на шлюзе · ${item.payload_root}`);
          if (item.review_stale) field(group, "Результат проверки относится к прежнему содержимому.");
          if (item.executable_review === false) field(group, "Текущая проверка не разрешает запуск.");
          registryEvidence(group, "Условия запуска", item.review_gate);
          registryEvidence(group, "Замечания проверки", item.review_findings);
          registryEvidence(group, "Разрешения", item.grants);
          registryEvidence(group, "Происхождение выпуска", item.provenance);
          if (registry === "clawhub") {
            const version = new Gtk.Entry({ placeholder_text: "Версия обновления, по умолчанию последняя" });
            const actions = row();
            actions.append(button("Обновить…", () => void this.change(dialog, item, status, receipt, version.get_text().trim(), () => life.alive() && revision === current, load, life.cancel)));
            actions.append(button("Удалить из установленных…", () => void this.change(dialog, item, status, receipt, null, () => life.alive() && revision === current, load, life.cancel)));
            group.append(version);
            group.append(actions);
          }
          list.append(group);
        }
      } catch (error) {
        if (life.alive()) listStatus.set_label(`Не удалось прочитать список. ${errorText(error)}`);
      } finally {
        reading = false;
      }
    };
    for (const widget of [button("Перечитать", () => void load()), status, receipt, listStatus, list]) content.append(widget);
    this.present(dialog, parent);
    void load();
  }

  private async change(dialog: any, item: InstalledEntry, status: any, receipt: any, version: string | null,
    current: () => boolean, reload: () => Promise<void>, cancel: any): Promise<void> {
    if (!current() || this.writing || this.confirming) return;
    this.confirming = true;
    const removing = version === null;
    let allowed = false;
    try { allowed = await confirmRegistry(dialog, cancel, `${removing ? "Удалить" : "Обновить"} ${item.name}?`,
      removing ? "Шлюз удалит установленную копию ClawHub." : `Шлюз установит ${version || "последнюю версию"} поверх текущей и запустит проверку.`,
      removing ? "Удалить" : "Обновить"); } finally { this.confirming = false; }
    if (!allowed || !current()) return;
    await this.write(removing ? "uninstall" : "update", item.name, version ? { version } : {}, status, receipt, current);
    await reload();
  }

  private async write(operation: Operation, name: string | undefined, body: object, status: any, receipt: any,
    current: () => boolean): Promise<void> {
    if (!current()) return;
    if (this.writing) {
      if (current()) status.set_label("Операция с реестром уже выполняется.");
      return;
    }
    this.writing = true;
    clear(receipt);
    status.set_label("Шлюз обрабатывает запрос. За ходом операции можно следить в очереди навыков.");
    const show = (reply: ReturnType<typeof object>) => {
      const review = reply.review_status === "blockers" ? "Проверка выявила блокирующие замечания" : reply.review_status;
      const deps = reply.deps_status === "failed" ? "Сбой установки зависимостей" : reply.deps_status;
      status.set_label([reply.ok ? completed[operation] : "Шлюз сообщил о сбое операции",
        reply.sanitized_name, review, reply.review_error, deps, reply.deps_error, reply.error].filter(Boolean).join(" · "));
      registryResult(receipt, reply);
    };
    try {
      const path = `${registryPath}/${operation}${name ? "/" + encodeURIComponent(name) : ""}`;
      const reply = object(await this.gateway.json("POST", path, body, ownerHeaders, true));
      if (!current()) return;
      if (typeof reply.ok !== "boolean" || reply.ok && (typeof reply.sanitized_name !== "string"
        || !reply.sanitized_name || name !== undefined && reply.sanitized_name !== name)) throw new Error("Шлюз не вернул результат операции.");
      show(reply);
    } catch (error) {
      if (!current()) return;
      const reply = error instanceof HttpError ? object(error.body) : {};
      if (reply.ok === false) show(reply);
      else status.set_label(error instanceof HttpError && error.status < 500 ? errorText(error)
        : `Итог неизвестен. Проверьте очередь. ${errorText(error)}`);
    } finally {
      this.writing = false;
      this.changed();
    }
  }
}
