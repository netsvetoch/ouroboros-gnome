import { type Gateway, type GatewayFrame, HttpError, query } from "./gateway.js";
import { Gio, GLib, Gtk } from "./gi.js";
import { type Present } from "./mcp-server.js";
import { ownerHeaders } from "./settings-write.js";
import { button, chooseFile, clear, column, confirm, errorText, label, row, sheet } from "./ui.js";
import { refreshNativeI18n } from "./native-i18n.js";
import { editLanguageProfile } from "./language-profile.js";
import { readI18nSnapshot as readSnapshot, type I18nSnapshot as Snapshot, type Language, type Translation } from "./i18n-contract.js";

interface ImportReply { ok?: boolean; language?: string; revision?: number;
  result?: { added?: number; replaced?: number; shadowed?: number; dropped?: number } }
interface RegenerateReply { ok?: boolean; language?: string; revision?: number; removed?: number }
interface MissingReply { accepted?: number; dropped?: number; pending?: number }

const path = "/api/ui/i18n";
const sources: Record<string, string> = { generated: "Сгенерировано", owner: "От владельца", imported: "Импортировано" };
const generatorStates: Record<string, string> = { idle: "Ожидает", running: "Переводит", no_model: "Нет доступной модели", failed: "Ошибка" };
const english = (language: string) => /^en(?:-|$)/iu.test(language);
const tag = /^(?=.{1,48}$)[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,8}$/u;

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const strings = (value: unknown) => record(value) && Object.values(value).every(item => typeof item === "string");


function fact(container: any, title: string, value: unknown): void {
  if (value == null || value === "" || typeof value !== "string" && typeof value !== "number") return;
  const field = label(`${title} · ${value}`, "dim-label");
  field.set_selectable(true);
  container.append(field);
}

function pluralRules(language: string): Record<string, unknown> {
  try {
    if (!Intl.PluralRules.supportedLocalesOf([language]).length) return {};
    const rules = new Intl.PluralRules(language);
    const map = Object.fromEntries(Array.from({ length: 101 }, (_, n) => [String(n), rules.select(n)]));
    const periodic = Array.from({ length: 100 }, (_, n) => n + 101).every((n) => rules.select(n) === map[String(n % 100)]);
    return { plural_select: { map, period: periodic ? 100 : null }, plural_categories: rules.resolvedOptions().pluralCategories };
  } catch { return {}; }
}

function readMemory(file: any, cancel: any): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    file.load_contents_async(cancel, (_file: unknown, result: unknown) => {
      try {
        const [ok, bytes] = file.load_contents_finish(result);
        if (!ok) throw new Error("Не удалось прочитать выбранный файл.");
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (!record(value) || typeof value.language !== "string" || !tag.test(value.language.trim()) || english(value.language.trim())
          || (value.schema !== undefined && value.schema !== 1) || (value.entries !== undefined && !record(value.entries))) {
          throw new Error("Ожидается словарь JSON схемы 1 с языком, отличным от английского.");
        }
        resolve(value);
      } catch (error) { reject(error); }
    });
  });
}

export class GatewayTranslations {
  private view?: TranslationSheet;

  constructor(private readonly gateway: Gateway, private readonly present: Present, private readonly changed: () => void) {}

  show(parent: any): void {
    if (this.view) { this.view.dialog.present(parent); return; }
    const view = new TranslationSheet(this.gateway, () => { refreshNativeI18n(); this.changed(); },
      () => { if (this.view === view) this.view = undefined; });
    this.view = view;
    this.present(view.dialog, parent);
    void view.refresh();
  }

  frame(frame: GatewayFrame): void { this.view?.frame(frame); }
  reconnect(): void { this.view?.reconnect(); }
}

class TranslationSheet {
  private readonly content = column(9);
  readonly dialog = sheet("Переводы интерфейса шлюза", this.content);
  private readonly cancel = new Gio.Cancellable();
  private readCancel?: any;
  private entryViewGeneration = 0;
  private readonly status = label("", "dim-label");
  private readonly feedback = label("");
  private readonly facts = column(4);
  private readonly controls = column(6);
  private readonly language = new Gtk.Entry({ placeholder_text: "Код или название языка, например pt-BR" });
  private readonly languageLabel = new Gtk.Entry({ placeholder_text: "Название в списке (необязательно)" });
  private readonly instruction = new Gtk.Entry({ placeholder_text: "Описание для перевода (необязательно)" });
  private readonly direction = Gtk.DropDown.new_from_strings(["Направление без изменений", "Слева направо", "Справа налево"]);
  private readonly stored = new Gtk.DropDown();
  private readonly entries = column(5);
  private readonly search = new Gtk.SearchEntry({ placeholder_text: "Поиск по ключу или переводу" });
  private readonly provenance = Gtk.DropDown.new_from_strings(["Все источники", sources.owner, sources.imported, sources.generated]);
  private readonly missing = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR, monospace: true });
  private readonly context = new Gtk.Entry({ placeholder_text: "Раздел интерфейса (необязательно)" });
  private readonly choose = button("Применить язык", () => void this.chooseLanguage());
  private readonly editProfile = button("Изменить профиль текущего языка…", () => void this.editLanguageProfile());
  private readonly useStored = button("Использовать выбранный язык", () => void this.chooseLanguage(this.selected()?.language));
  private readonly reset = button("Сбросить выбор языка", () => void this.chooseLanguage(""));
  private readonly exportButton = button("Экспортировать JSON…", () => void this.exportMemory());
  private readonly regenerate = button("Пересоздать переводы…", () => void this.regenerateMemory());
  private readonly report = button("Отправить отсутствующие строки", () => void this.reportMissing());
  private readonly revisions = new Map<string, number>();
  private snapshot?: Snapshot;
  private languages: Language[] = [];
  private translated: [string, Translation][] = [];
  private entrySignature = "";
  private visible = 60;
  private expectedLanguage?: string;
  private generation = 0;
  private reading = false;
  private reread = false;
  private busy = false;
  private ready = false;
  private closed = false;
  private readonly poll: number;

  constructor(private readonly gateway: Gateway, private readonly changed: () => void, closed: () => void) {
    this.dialog.set_content_width(720);
    this.dialog.set_content_height(680);
    const languages = column();
    for (const widget of [this.language, this.languageLabel, this.instruction, this.direction, this.choose, this.editProfile, this.reset]) languages.append(widget);
    this.controls.append(new Gtk.Expander({ label: "Язык установки", child: languages }));
    const memory = column();
    memory.append(this.stored);
    for (const widget of [this.useStored, button("Импортировать JSON…", () => void this.importMemory()), this.exportButton, this.regenerate]) memory.append(widget);
    this.controls.append(new Gtk.Expander({ label: "Словари на шлюзе", child: memory }));
    const missing = column();
    missing.append(label("Введите по одному ключу или исходной строке интерфейса на строку. Шлюз добавит их в очередь перевода."));
    missing.append(new Gtk.ScrolledWindow({ child: this.missing, min_content_height: 100, hscrollbar_policy: Gtk.PolicyType.NEVER }));
    missing.append(this.context);
    missing.append(this.report);
    this.controls.append(new Gtk.Expander({ label: "Отсутствующие строки", child: missing }));
    const filters = row();
    this.search.set_hexpand(true);
    filters.append(this.search);
    filters.append(this.provenance);
    const browser = column();
    browser.append(filters);
    browser.append(this.entries);
    for (const widget of [label("Параметры языка установки и словари шлюза", "title-3"), this.facts,
      this.status, this.feedback, button("Перечитать словари", () => void this.refresh()), this.controls,
      new Gtk.Expander({ label: "Переводы текущего языка", child: browser })]) this.content.append(widget);
    this.language.connect("changed", () => this.sync());
    this.stored.connect("notify::selected", () => this.sync());
    this.missing.get_buffer().connect("changed", () => this.sync());
    const refilter = () => { this.visible = 60; this.renderEntries(); };
    this.search.connect("search-changed", refilter);
    this.provenance.connect("notify::selected", refilter);
    this.poll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
      if (!this.ready || this.snapshot?.generator.state === "running" || (this.snapshot?.stats.pending ?? 0) > 0) void this.refresh();
      return GLib.SOURCE_CONTINUE;
    });
    this.dialog.connect("closed", () => {
      this.closed = true;
      this.cancel.cancel();
      this.readCancel?.cancel();
      GLib.Source.remove(this.poll);
      this.sync();
      closed();
    });
    this.sync();
  }

  frame(frame: GatewayFrame): void {
    if (this.closed) return;
    if (typeof frame.language !== "string") return;
    if (frame.type === "ui_language_changed") this.expectedLanguage = frame.language;
    else if (frame.type === "ui_i18n_updated" && Number.isSafeInteger(frame.revision)) {
      this.requireRevision(frame.language, Number(frame.revision));
    } else return;
    this.invalidate();
  }

  reconnect(): void {
    if (this.closed) return;
    this.expectedLanguage = undefined;
    this.revisions.clear();
    this.invalidate();
  }

  private invalidate(): void {
    if (this.closed) return;
    this.generation++;
    this.readCancel?.cancel();
    this.ready = false;
    this.sync();
    void this.refresh();
  }

  private requireRevision(language: string, revision: number): void {
    this.revisions.set(language, Math.max(this.revisions.get(language) ?? 0, revision));
  }

  async refresh(): Promise<void> {
    if (this.closed) return;
    if (this.reading || this.busy) { this.reread = true; return; }
    this.reading = true;
    const cancel = new Gio.Cancellable();
    this.readCancel = cancel;
    const generation = this.generation;
    this.status.set_label("Читаю состояние словарей…");
    try {
      const reply = readSnapshot(await this.gateway.json<unknown>("GET", path, undefined, undefined, false, cancel));
      if (this.closed || generation !== this.generation) return;
      if (this.expectedLanguage !== undefined && reply.language !== this.expectedLanguage
        || reply.memory_error && this.snapshot && reply.language !== this.snapshot.language
        || !reply.memory_error && reply.revision < (this.revisions.get(reply.language) ?? 0)) {
        this.ready = false;
        this.status.set_label(reply.memory_error || "Шлюз ещё не подтвердил новый снимок словарей.");
        return;
      }
      this.expectedLanguage = undefined;
      if (!reply.memory_error) this.revisions.set(reply.language, reply.revision);
      this.snapshot = reply;
      this.ready = true;
      this.render();
      this.status.set_label(reply.memory_error || "");
    } catch (error) {
      if (!this.closed && generation === this.generation) {
        this.ready = false;
        this.status.set_label([errorText(error), this.snapshot ? "Показан последний прочитанный словарь." : ""].filter(Boolean).join("\n"));
      }
    } finally {
      if (this.readCancel === cancel) this.readCancel = undefined;
      this.reading = false;
      if (!this.closed) {
        this.sync();
        if (this.reread && !this.busy) { this.reread = false; void this.refresh(); }
      }
    }
  }

  private selected(): Language | undefined { return this.languages[this.stored.get_selected()]; }

  private sync(): void {
    const idle = this.ready && !this.busy && !this.closed;
    this.controls.set_sensitive(idle);
    const selected = this.selected();
    this.choose.set_sensitive(idle && Boolean(this.language.get_text().trim()));
    this.editProfile.set_sensitive(idle && Boolean(this.snapshot?.language && !this.snapshot.english && !this.snapshot.memory_error));
    this.reset.set_sensitive(idle && this.snapshot?.chosen === true);
    this.useStored.set_sensitive(idle && Boolean(selected && selected.language !== this.snapshot?.language));
    this.exportButton.set_sensitive(idle && Boolean(selected));
    this.regenerate.set_sensitive(idle && Boolean(selected || this.snapshot?.language && !this.snapshot.english));
    this.report.set_sensitive(idle && Boolean(this.snapshot?.language && !this.snapshot.english && this.missingText().trim()));
  }

  private render(): void {
    if (this.closed) return;
    const snapshot = this.snapshot!;
    const { profile, stats, generator } = snapshot;
    clear(this.facts);
    fact(this.facts, "Язык установки", snapshot.chosen ? [profile?.label, snapshot.language].filter(Boolean).join(" · ") : "Выбор ещё не сохранён");
    for (const [title, value] of [["Ревизия", snapshot.revision], ["Обновление словаря", snapshot.updated_at], ["Описание", profile?.instruction],
      ["Направление", profile?.direction === "rtl" ? "Справа налево" : profile?.direction === "ltr" ? "Слева направо" : ""],
      ["Символов в лексиконе", profile?.lexicon_chars], ["Формы множественного числа", snapshot.plural_categories?.join(", ")],
      ["Всего переводов", stats.entries], ["Сгенерировано", stats.generated], ["От владельца", stats.owner], ["Импортировано", stats.imported],
      ["Устаревшие строки", stats.stale === null ? "Сведения недоступны" : stats.stale], ["В очереди и в работе", stats.pending], ["Отклонено", stats.refused],
      ["Генератор", generatorStates[generator.state ?? ""] || generator.state], ["Язык генератора", generator.language],
      ["В текущей группе", generator.in_flight], ["Переведено с запуска", generator.applied], ["Обновление генератора", generator.updated_at],
      ["Сообщение генератора", generator.error]] as const) fact(this.facts, title, value);
    const plural = snapshot.plural_select;
    if (record(plural?.map)) {
      const groups = new Map<string, string[]>();
      for (const [value, category] of Object.entries(plural.map)) {
        if (typeof category !== "string") continue;
        const values = groups.get(category) ?? [];
        values.push(value);
        groups.set(category, values);
      }
      const details = column(4);
      fact(details, "Период повторения", plural?.period);
      for (const [category, values] of groups) fact(details, category, values.join(", "));
      this.facts.append(new Gtk.Expander({ label: "Сохранённые правила множественного числа", child: details }));
    }
    const languages = snapshot.languages.filter((item) => typeof item?.language === "string" && tag.test(item.language) && !english(item.language));
    if (JSON.stringify(languages) !== JSON.stringify(this.languages)) {
      const selected = this.selected()?.language ?? snapshot.language;
      this.languages = languages;
      this.stored.set_model(Gtk.StringList.new(languages.map((item) => [item.label || item.language,
        item.label && item.label !== item.language ? item.language : "", item.malformed ? "ошибка чтения" : `${item.entries ?? "?"} переводов`,
        item.pending ? `в очереди ${item.pending}` : ""].filter(Boolean).join(" · "))));
      this.stored.set_selected(Math.max(0, languages.findIndex((item) => item.language === selected)));
    }
    const signature = JSON.stringify([snapshot.language, snapshot.revision, snapshot.memory_error]);
    if (signature !== this.entrySignature) {
      this.entrySignature = signature;
      this.translated = Object.entries(snapshot.entries).filter(([, item]) => record(item)).sort(([a], [b]) => a.localeCompare(b));
      this.visible = 60;
      this.renderEntries();
    }
  }

  private renderEntries(): void {
    if (this.closed) return;
    const generation = ++this.entryViewGeneration;
    clear(this.entries);
    const source = ["", "owner", "imported", "generated"][this.provenance.get_selected()];
    const needle = this.search.get_text().trim().toLocaleLowerCase();
    const matches = this.translated.filter(([key, item]) => (!source || item.provenance === source)
      && (!needle || [key, item.source, item.text, ...Object.values(item.forms ?? {})].join(" ").toLocaleLowerCase().includes(needle)));
    this.entries.append(label(matches.length ? `Строк в выборке · ${matches.length}` : "В выборке нет переводов.", "dim-label"));
    for (const [key, item] of matches.slice(0, this.visible)) {
      const details = column(4);
      fact(details, "Ключ", key);
      fact(details, "Исходная строка", item.source);
      fact(details, "Перевод", item.text);
      if (record(item.forms)) for (const [category, text] of Object.entries(item.forms)) fact(details, category, text);
      for (const [name, value] of [["Источник", sources[item.provenance ?? ""] || item.provenance], ["Контекст", item.context],
        ["Пакет", item.pack], ["Версия пакета", item.pack_version], ["Модель", item.model], ["Дата", item.at],
        ["Попытка", item.attempt_id], ["Контрольная сумма исходника", item.source_hash]] as const) fact(details, name, value);
      const caption = (item.source || key).replace(/\s+/gu, " ");
      this.entries.append(new Gtk.Expander({ label: caption.length > 120 ? `${caption.slice(0, 120)}…` : caption, child: details }));
    }
    if (matches.length > this.visible) this.entries.append(button("Показать ещё", () => {
      if (!this.closed && generation === this.entryViewGeneration) { this.visible += 60; this.renderEntries(); }
    }));
  }

  private async perform(operation: () => Promise<string | undefined>, changes = true): Promise<void> {
    if (!this.ready || this.busy || this.closed) return;
    this.busy = true;
    this.generation++;
    this.readCancel?.cancel();
    this.feedback.set_label("");
    this.sync();
    try {
      const message = await operation();
      if (this.closed || message === undefined) return;
      this.feedback.set_label(message);
    } catch (error) {
      if (!this.closed) this.feedback.set_label(errorText(error));
    } finally {
      this.busy = false;
      if (!this.closed) {
        this.sync();
        if (changes || this.reread) { this.reread = false; void this.refresh(); }
      }
    }
  }

  private async write<T>(route: string, body: unknown, long = false): Promise<T> {
    this.ready = false;
    this.feedback.set_label("Шлюз обрабатывает запрос…");
    try { return await this.gateway.json<T>("POST", `${path}/${route}`, body, ownerHeaders, long, this.cancel); }
    catch (error) {
      if (error instanceof HttpError && (error.status < 500 && error.status !== 408 || error.reason === "memory_busy")) throw error;
      throw new Error(`Результат запроса не подтверждён. ${errorText(error)}`);
    }
  }

  private chooseLanguage(selected?: string): Promise<void> {
    const language = selected ?? this.language.get_text().trim();
    if (selected === undefined && !language) return Promise.resolve();
    return this.perform(async () => {
      const generation = this.generation;
      const direction = [undefined, "ltr", "rtl"][this.direction.get_selected()];
      const instruction = this.instruction.get_text().trim();
      const display = this.languageLabel.get_text().trim();
      const body = { language,
        ...(selected === undefined && display ? { label: display } : {}),
        ...(selected === undefined && (direction || instruction) ? { profile: { direction, instruction: instruction || undefined } } : {}),
        ...(language && !english(language) && !this.languages.some((item) => item.language.toLowerCase() === language.toLowerCase())
          && this.snapshot?.language.toLowerCase() !== language.toLowerCase() ? pluralRules(language) : {}) };
      const raw = await this.write<Snapshot & { ok?: boolean }>("language", body, true);
      if (raw?.ok !== true) {
        throw new Error("Шлюз не подтвердил запись языка.");
      }
      const result = readSnapshot(raw);
      if (this.closed) return;
      if (generation === this.generation) this.expectedLanguage = result.language;
      if (!result.memory_error) this.requireRevision(result.language, result.revision);
      this.changed();
      if (result.memory_error) return `Язык сохранён · ${result.language || "без выбора"}\n${result.memory_error}`;
      return `Язык сохранён · ${result.language || "без выбора"}`;
    });
  }

  private editLanguageProfile(): Promise<void> {
    const language = this.snapshot?.language;
    if (!language || this.snapshot?.english || this.snapshot?.memory_error) return Promise.resolve();
    return this.perform(async () => {
      const result = await editLanguageProfile(this.dialog, this.gateway, language, this.cancel);
      if (!result || this.closed) return;
      this.expectedLanguage = result.language;this.requireRevision(result.language, result.revision);this.changed();
      return `Профиль языка сохранён · ${result.language}`;
    });
  }

  private importMemory(): Promise<void> {
    return this.perform(async () => {
      const file = await chooseFile(this.dialog, undefined, this.cancel);
      if (!file || this.closed) return;
      const memory = await readMemory(file, this.cancel);
      if (this.closed || !await confirm(this.dialog, "Импортировать словарь?", [String(memory.language),
        "Импорт заменит ранее импортированные строки этого языка. Переводы владельца сохранятся."].join("\n"), "Импортировать", this.cancel)) return;
      if (this.closed) return;
      const reply = await this.write<ImportReply>("import", memory, true);
      const counts = reply?.result;
      if (reply?.ok !== true || !counts || typeof reply.language !== "string"
        || reply.language.toLowerCase() !== String(memory.language).trim().toLowerCase() || !count(reply.revision)
        || ![counts.added, counts.replaced, counts.shadowed, counts.dropped].every(count)) {
        throw new Error("Шлюз не подтвердил импорт.");
      }
      if (this.closed) return;
      this.requireRevision(reply.language, reply.revision!);
      this.changed();
      return [`Словарь импортирован · ${reply.language} · ревизия ${reply.revision}`,
        `Добавлено · ${counts.added ?? "?"}`, `Заменено · ${counts.replaced ?? "?"}`, `Под переводами владельца · ${counts.shadowed ?? "?"}`,
        `Удалено из импортированного слоя · ${counts.dropped ?? "?"}`].join("\n");
    });
  }

  private exportMemory(): Promise<void> {
    const language = this.selected()?.language;
    if (!language) return Promise.resolve();
    return this.perform(async () => {
      const destination = await chooseFile(this.dialog, `ouroboros-i18n-${language}.json`, this.cancel);
      if (!destination || this.closed) return;
      await this.gateway.download(`${path}/export${query({ language })}`, destination, true, this.cancel);
      return `Словарь сохранён · ${language}`;
    }, false);
  }

  private regenerateMemory(): Promise<void> {
    const language = this.selected()?.language ?? this.snapshot?.language;
    if (!language || english(language)) return Promise.resolve();
    return this.perform(async () => {
      if (!await confirm(this.dialog, "Пересоздать переводы?", [language,
        "Шлюз удалит сгенерированные переводы и прежние отказы. Переводы владельца и импортированные строки сохранятся."].join("\n"),
        "Пересоздать", this.cancel) || this.closed) return;
      const reply = await this.write<RegenerateReply>("regenerate", { language });
      if (reply?.ok !== true || reply.language !== language || !count(reply.revision) || !count(reply.removed)) {
        throw new Error("Шлюз не подтвердил пересоздание словаря.");
      }
      if (this.closed) return;
      this.requireRevision(reply.language, reply.revision!);
      this.changed();
      return `Пересоздание запрошено · ${reply.language} · ревизия ${reply.revision}\nУдалено сгенерированных строк · ${reply.removed}`;
    });
  }

  private missingText(): string {
    const buffer = this.missing.get_buffer();
    return buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false);
  }

  private reportMissing(): Promise<void> {
    const language = this.snapshot?.language;
    if (!language || this.snapshot?.english) return Promise.resolve();
    return this.perform(async () => {
      const keys = [...new Set(this.missingText().split(/\r?\n/u).map((key) => key.trim()).filter(Boolean))];
      if (!keys.length || keys.length > 200 || keys.some((key) => [...key].length > 2000)) {
        throw new Error("Укажите от 1 до 200 ключей длиной до 2000 символов каждый.");
      }
      const context = this.context.get_text().trim();
      const items = keys.map((key) => ({ key, ...(context ? { context: { page: context } } : {}) }));
      const reply = await this.write<MissingReply>("missing", { language, items });
      if (![reply?.accepted, reply?.dropped, reply?.pending].every(count)) {
        throw new Error("Шлюз не подтвердил постановку строк в очередь.");
      }
      this.missing.get_buffer().set_text("", -1);
      return `Принято · ${reply.accepted}\nОтклонено · ${reply.dropped}\nВ очереди · ${reply.pending}`;
    });
  }
}
