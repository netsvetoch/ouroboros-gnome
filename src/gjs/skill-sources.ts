import { Gio, GLib, Gtk } from "./gi.js";
import { type Gateway, HttpError } from "./gateway.js";
import { directoryPicker } from "./directory-picker.js";
import { ownerHeaders } from "./settings-write.js";
import { button, clear, column, confirm, errorText, label, row, sheet } from "./ui.js";

export const sourcesPath = "/api/skill-sources";

export interface SkillSource {
  id: string;
  name: string;
  kind: string;
  trust: string;
  confirmed: boolean;
  url?: string;
  ref?: string;
  commit?: string;
  path?: string;
  part?: string;
  state?: string;
  last_read_at?: string;
  error?: string;
  problems?: string[];
  refreshing?: boolean;
  managed?: boolean;
}

interface Suggestion {
  name: string;
  url: string;
  ref?: string;
  commit?: string;
  path?: string;
  about?: string;
  connected: boolean;
}

interface Sources {
  sources: SkillSource[];
  materialized: boolean;
  problem: string;
  suggestions: Suggestion[];
}

interface Probe {
  kind: string;
  suggested_name: string;
  owner?: string;
  found: string[];
  problems?: string[];
  commit?: string;
  warning?: string;
  error?: string;
}

interface SourceReply {
  ok?: boolean;
  source?: SkillSource;
  repository?: string;
  created?: boolean;
  private?: boolean;
  error?: string;
  code?: string;
}

export type ShowSkillDialog = (dialog: any, parent?: any) => void;
type Location = { path: string } | { url: string; revision?: string; subfolder?: string };

const trustOptions = ["review", "trusted"];
const trustLabels = ["Проверять навыки", "Доверять источнику"];
const sourceStates: Record<string, string> = {
  ready: "Прочитан", reading: "Читается", error: "Ошибка чтения", search: "Доступен через поиск",
};

function refreshPending(source?: SkillSource): boolean {
  return Boolean(source?.refreshing || source?.state === "reading");
}

function refreshMessage(source?: SkillSource): string {
  if (!source) return "Шлюз не вернул состояние источника.";
  if (refreshPending(source)) return "Шлюз читает источник.";
  if (source.error) return `Обновление источника завершилось с ошибкой. ${source.error}`;
  if (source.state === "error") return "Шлюз сообщил об ошибке чтения источника.";
  return source.state === "ready" ? "Источник прочитан." : "Состояние чтения источника неизвестно.";
}

function selectedTrust(dropdown: any): string {
  return trustOptions[dropdown.get_selected()];
}

function trustText(trust: string): string {
  return trustLabels[trustOptions.indexOf(trust)] ?? trust;
}

export class SkillSources {
  private dialog?: any;
  private snapshot?: Sources;
  private poll = 0;
  private reading?: { dialog: any };
  private refreshingSource?: string;
  private writing = false;
  private cancel?: any;
  private readonly list = column();
  private readonly status = label("", "dim-label");

  constructor(private readonly gateway: Gateway, private readonly present: ShowSkillDialog, private readonly changed: () => void) {}

  private own(dialog: any, parent: any): any {
    const cancel = new Gio.Cancellable();
    let open = true;
    const signal = parent.connect("closed", () => dialog.force_close());
    dialog.connect("closed", () => {
      if (!open) return;
      open = false;
      cancel.cancel();
      parent.disconnect(signal);
    });
    return cancel;
  }

  show(): void {
    if (this.dialog) return;
    const content = column();
    const dialog = sheet("Источники навыков", content);
    this.dialog = dialog;
    this.cancel = new Gio.Cancellable();
    this.snapshot = undefined;
    clear(this.list);
    this.status.set_label("Читаю источники…");
    const tools = row();
    tools.append(button("Перечитать", () => void this.load(true)));
    tools.append(button("Добавить…", () => this.add()));
    tools.append(button("Мои навыки на GitHub…", () => void this.mySkills(dialog)));
    for (const widget of [tools, this.status, this.list]) content.append(widget);
    dialog.connect("closed", () => {
      if (this.poll) GLib.Source.remove(this.poll);
      this.poll = 0;
      this.dialog = undefined;
      this.cancel.cancel();
      this.refreshingSource = undefined;
      content.remove(this.list);
      content.remove(this.status);
    });
    this.present(dialog);
    this.poll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
      if (this.refreshingSource || this.snapshot?.sources.some(refreshPending)) void this.load();
      return GLib.SOURCE_CONTINUE;
    });
    void this.load();
  }

  private async load(explicit = false): Promise<void> {
    const dialog = this.dialog;
    if (!dialog || this.reading?.dialog === dialog || this.writing) return;
    const read = { dialog };
    this.reading = read;
    try {
      const result = await this.gateway.json<Sources>("GET", sourcesPath, undefined, {}, false, this.cancel);
      if (this.dialog !== dialog || this.reading !== read) return;
      if (!Array.isArray(result?.sources) || !Array.isArray(result.suggestions)) throw new Error("Шлюз не вернул список источников.");
      if (JSON.stringify(result) !== JSON.stringify(this.snapshot)) this.render(result);
      this.snapshot = result;
      if (this.refreshingSource) {
        const source = result.sources.find((item) => item.id === this.refreshingSource);
        this.status.set_label(refreshMessage(source));
        if (!refreshPending(source)) this.refreshingSource = undefined;
      } else if (explicit || this.status.get_label() === "Читаю источники…") this.status.set_label("");
    } catch (error) {
      if (this.dialog === dialog && this.reading === read) this.status.set_label(errorText(error));
    } finally {
      if (this.reading === read) this.reading = undefined;
    }
  }

  private render(result: Sources): void {
    clear(this.list);
    if (!result.materialized) this.list.append(label("Шлюз использует список, полученный из прежних настроек.", "dim-label"));
    if (result.problem) this.list.append(label(result.problem));
    for (const source of result.sources) {
      const item = column(5);
      item.append(label(source.name, "heading"));
      const part = source.part === "official" ? "Официальный раздел" : source.part === "community" ? "Раздел сообщества" : source.part;
      item.append(label([source.kind, part, trustText(source.trust), !source.confirmed && "ожидает подтверждения",
        source.managed && "предложен сборкой", source.refreshing && "обновляется", source.state && (sourceStates[source.state] ?? source.state)]
        .filter(Boolean).join(" · "), "dim-label"));
      for (const value of [source.url, [source.ref, source.commit, source.path].filter(Boolean).join(" · "),
        source.last_read_at, source.error, ...(source.problems ?? [])]) {
        if (value) {
          const field = label(value);
          field.set_selectable(true);
          item.append(field);
        }
      }
      const actions = row();
      actions.append(button("Изменить…", () => this.edit(source)));
      if (["hub", "git", "local"].includes(source.kind)) actions.append(button("Обновить источник", () => {
        void this.write(`${sourcesPath}/${encodeURIComponent(source.id)}/refresh`, {}, this.status, (reply) => {
          if (refreshPending(reply.source)) this.refreshingSource = source.id;
          return refreshMessage(reply.source);
        });
      }));
      actions.append(button("Отключить…", () => void this.remove(source)));
      item.append(actions);
      this.list.append(item);
    }
    if (!result.sources.length) this.list.append(label("Источников навыков нет."));
    for (const suggestion of result.suggestions) {
      this.list.append(label([suggestion.name, suggestion.about, suggestion.url, suggestion.commit || suggestion.ref,
        suggestion.path, suggestion.connected && "подключён"].filter(Boolean).join(" · ")));
      if (!suggestion.connected) this.list.append(button(`Проверить ${suggestion.name}…`, () => this.add(suggestion)));
    }
  }

  private async write(path: string, body: object, status: any, success: (reply: SourceReply) => string,
    current: () => boolean = () => Boolean(this.dialog), after?: () => void, cancel = this.cancel): Promise<void> {
    if (this.writing || !current()) return;
    const parent = this.dialog;
    const active = () => this.dialog === parent && current();
    this.writing = true;
    this.reading = undefined;
    this.refreshingSource = undefined;
    status.set_label("Жду ответа шлюза…");
    try {
      const reply = await this.gateway.json<SourceReply>("POST", path, body, ownerHeaders, false, cancel);
      if (reply?.ok === false) {
        if (active()) status.set_label(reply.error ?? reply.code ?? "Шлюз отклонил запрос.");
        return;
      }
      if (reply?.ok !== true) throw new Error("Шлюз не подтвердил результат запроса.");
      if (active()) {
        this.status.set_label(success(reply));
        after?.();
      }
      this.changed();
    } catch (error) {
      const uncertain = !(error instanceof HttpError) || error.status >= 500;
      if (active()) status.set_label(uncertain ? `Итог запроса неизвестен. ${errorText(error)}` : errorText(error));
      if (uncertain) this.changed();
    } finally {
      this.writing = false;
      void this.load();
    }
  }

  private async remove(source: SkillSource): Promise<void> {
    const dialog = this.dialog;
    const consequence = source.kind === "local"
      ? "Шлюз перестанет загружать навыки из этой папки. Файлы в папке сохранятся."
      : "Источник исчезнет из каталога. Уже установленные навыки сохранятся.";
    if (!await confirm(dialog, `Отключить «${source.name}»?`, consequence, "Отключить") || this.dialog !== dialog) return;
    await this.write(`${sourcesPath}/${encodeURIComponent(source.id)}/remove`, {}, this.status, () => "Источник отключён.");
  }

  private async mySkills(dialog: any): Promise<void> {
    if (!await confirm(dialog, "Подключить «Мои навыки»?",
      "Шлюз использует токен GitHub из настроек. Он подключит существующий репозиторий ouroboros-skills или создаст закрытый репозиторий с этим именем.",
      "Подключить") || this.dialog !== dialog) return;
    await this.write(`${sourcesPath}/my-skills`, {}, this.status, (reply) =>
      [reply.created ? "Создан репозиторий" : "Подключён репозиторий", reply.repository,
        reply.private === true ? "закрытый" : reply.private === false ? "публичный" : ""].filter(Boolean).join(" · "));
  }

  private edit(source: SkillSource): void {
    const parent = this.dialog;
    if (!parent) return;
    const content = column();
    const dialog = sheet(`Источник «${source.name}»`, content);
    const cancel = this.own(dialog, parent);
    const name = new Gtk.Entry({ text: source.name, placeholder_text: "Название источника" });
    const trust = Gtk.DropDown.new_from_strings(trustLabels);
    trust.set_selected(source.trust === "trusted" ? 1 : 0);
    const status = label("", "dim-label");
    let open = true;
    const current = () => open && this.dialog === parent;
    dialog.connect("closed", () => { open = false; });
    const save = button(source.confirmed ? "Сохранить" : "Подтвердить и сохранить", () => {
      void (async () => {
        if (!current() || !save.is_sensitive()) return;
        const value = name.get_text().trim();
        const mode = selectedTrust(trust);
        if (!value || !mode) {
          status.set_label("Укажите название и режим доверия.");
          return;
        }
        const body = {
          ...(value !== source.name ? { name: value } : {}),
          ...(mode !== source.trust ? { trust: mode } : {}),
          ...(!source.confirmed ? { confirmed: true } : {}),
        };
        if (!Object.keys(body).length) {
          dialog.close();
          return;
        }
        save.set_sensitive(false);
        if (mode === "trusted" && (mode !== source.trust || !source.confirmed) && !await confirm(dialog,
          `Доверять источнику «${value}»?`, "Новые навыки из этого источника смогут запускаться без проверки моделями.", "Доверять")) {
          save.set_sensitive(true);
          return;
        }
        await this.write(`${sourcesPath}/${encodeURIComponent(source.id)}`, body, status,
          () => "Настройки источника сохранены.", current, () => dialog.close(), cancel);
        if (open) save.set_sensitive(true);
      })();
    });
    for (const widget of [name, trust, label("Режим доверия действует для будущих установок.", "dim-label"), status, save]) content.append(widget);
    this.present(dialog, parent);
  }

  private add(suggestion?: Suggestion): void {
    const parent = this.dialog;
    if (!parent) return;
    const content = column();
    const dialog = sheet("Подключение источника навыков", content);
    const kind = Gtk.DropDown.new_from_strings(["Репозиторий Git", "Папка на шлюзе"]);
    const address = new Gtk.Entry({ text: suggestion?.url ?? "", placeholder_text: "URL репозитория" });
    const revision = new Gtk.Entry({ text: suggestion?.commit || suggestion?.ref || "", placeholder_text: "Ветка, тег или полный коммит" });
    const subfolder = new Gtk.Entry({ text: suggestion?.path ?? "", placeholder_text: "Подпапка в репозитории" });
    const status = label("", "dim-label");
    const form = column();
    let open = true;
    let probe = 0;
    const cancel = this.own(dialog, parent);
    dialog.connect("closed", () => { open = false; });
    let directoryDialog: any;
    const browse = button("Выбрать папку на шлюзе…", () => {
      if (!open || kind.get_selected() !== 1 || directoryDialog) return;
      const picker = directoryPicker(this.gateway, address.get_text().trim(), (path) => {
        if (open && kind.get_selected() === 1) address.set_text(path);
      }, dialog);
      directoryDialog = picker;
      picker.connect("closed", () => { if (directoryDialog === picker) directoryDialog = undefined; });
      this.own(picker, dialog);
      this.present(picker, dialog);
    });
    const chooseKind = () => {
      const local = kind.get_selected() === 1;
      address.set_placeholder_text(local ? "Абсолютный путь папки на шлюзе" : "URL репозитория");
      revision.set_visible(!local);
      subfolder.set_visible(!local);
      browse.set_visible(local);
    };
    kind.connect("notify::selected", chooseKind);
    const review = column();
    const check = button("Проверить адрес", () => {
      if (!open || !form.is_sensitive()) return;
      const value = address.get_text().trim();
      if (!value) {
        status.set_label("Укажите адрес.");
        return;
      }
      const location: Location = kind.get_selected() === 1 ? { path: value } : {
        url: value, revision: revision.get_text().trim() || undefined, subfolder: subfolder.get_text().trim() || undefined,
      };
      const token = ++probe;
      const current = () => open && this.dialog === parent && probe === token;
      form.set_sensitive(false);
      clear(review);
      status.set_label("Шлюз читает источник…");
      void this.gateway.json<Probe>("POST", `${sourcesPath}/probe`, location, ownerHeaders, false, cancel)
        .then((result) => {
          if (!current()) return;
          if (result.warning === "not_encrypted") review.append(label("Шлюз прочитал источник по HTTP. Соединение с источником не шифруется."));
          if (result.error || !result.kind) throw new Error(result.error ?? "Источник не распознан.");
          status.set_label("");
          this.probed(dialog, review, status, location, result, suggestion?.name, current, cancel, () => {
            probe++;
            clear(review);
            form.set_sensitive(true);
          });
        }).catch((error: unknown) => {
          if (!current()) return;
          form.set_sensitive(true);
          status.set_label(errorText(error));
        });
    });
    for (const widget of [kind, address, revision, subfolder, browse, check]) form.append(widget);
    for (const widget of [form, status, review]) content.append(widget);
    chooseKind();
    this.present(dialog, parent);
  }

  private probed(dialog: any, review: any, status: any, location: Location, result: Probe,
    suggestedName: string | undefined, current: () => boolean, cancel: any, edit: () => void): void {
    const probe = label([result.kind, result.owner, result.commit].filter(Boolean).join(" · "));
    probe.set_selectable(true);
    review.append(probe);
    review.append(label(result.found?.length ? `Найдены навыки · ${result.found.join(", ")}` : "Шлюз не нашёл навыков."));
    for (const problem of result.problems ?? []) review.append(label(problem));
    const name = new Gtk.Entry({ text: suggestedName || result.suggested_name || "", placeholder_text: "Название источника" });
    const trust = Gtk.DropDown.new_from_strings(trustLabels);
    const pinnedCommit = "url" in location && /^[a-f\d]{40}$/i.test(result.commit ?? "")
      && !/^[a-f\d]{40}$/i.test(location.revision ?? "") ? result.commit : undefined;
    const pin = new Gtk.CheckButton({ label: "Закрепить проверенный коммит" });
    pin.set_visible(Boolean(pinnedCommit));
    const add = button("Подключить источник", () => {
      void (async () => {
        if (!current() || !add.is_sensitive()) return;
        const value = name.get_text().trim();
        const mode = selectedTrust(trust);
        if (!value || !mode) {
          status.set_label("Укажите название и режим доверия.");
          return;
        }
        review.set_sensitive(false);
        if (mode === "trusted" && !await confirm(dialog, `Доверять источнику «${value}»?`,
          "Новые навыки из этого источника смогут запускаться без проверки моделями.", "Доверять")) {
          review.set_sensitive(true);
          return;
        }
        const target = pinnedCommit && pin.get_active() ? { ...location, revision: pinnedCommit } : location;
        await this.write(sourcesPath, { ...target, name: value, trust: mode }, status,
          () => "Источник подключён.", current, () => dialog.close(), cancel);
        if (current()) review.set_sensitive(true);
      })();
    });
    for (const widget of [name, trust, pin, add, button("Изменить адрес", edit)]) review.append(widget);
  }
}
