import { type Gateway, query } from "./gateway.js";
import { Adw, Gio, Gtk } from "./gi.js";
import { actionRow, button, column, errorText, label, row, sheet } from "./ui.js";

export interface Project {
  id: string;
  name: string;
  chat_id: number;
  lifecycle?: string;
  pinned?: boolean;
  closed?: object;
  working_dir?: string;
  created?: boolean;
  visible_revision?: number | null;
  delete_error?: string;
}

type Address = { id: string } | { chat_id: number };

export const validProjectId = (id: string): boolean => /^[a-z0-9_](?:[a-z0-9_.-]{0,62}[a-z0-9_])?$/.test(id)
  && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id);

export function projectChat(project?: Project): project is Project {
  return typeof project?.id === "string" && validProjectId(project.id)
    && Number.isSafeInteger(project.chat_id) && project.chat_id > 1
    && (project.lifecycle === undefined || project.lifecycle === "active" || project.lifecycle === "deleting")
    && [project.name, project.working_dir, project.delete_error].every(value => value === undefined || typeof value === "string")
    && (project.pinned === undefined || typeof project.pinned === "boolean")
    && (project.closed == null || typeof project.closed === "object" && !Array.isArray(project.closed))
    && (project.visible_revision == null || Number.isSafeInteger(project.visible_revision) && project.visible_revision >= 0);
}

export function readProjects(value: any): Project[] {
  const projects = value?.projects;
  if (!Array.isArray(projects) || projects.some(project => !projectChat(project?.lifecycle === "tombstoned"
    ? { ...project, lifecycle: "active" } : project))
    || new Set(projects.map(project => project.id)).size !== projects.length
    || new Set(projects.map(project => project.chat_id)).size !== projects.length) {
    throw new Error("Шлюз не вернул читаемый однозначный список проектов.");
  }
  return projects.filter(projectChat);
}

export async function readProject(gateway: Gateway, address: Address, cancel?: any): Promise<Project | undefined> {
  const response = await gateway.json<{ projects?: Project[] }>("GET", "/api/projects" + query(address),
    undefined, undefined, false, cancel);
  if (!Array.isArray(response?.projects) || response.projects.length > 1) throw new Error("Шлюз не вернул однозначную запись проекта.");
  if (!response.projects.length) return undefined;
  const [project] = response.projects;
  if (!projectChat(project) || ("id" in address ? project.id !== address.id
    : project.chat_id !== address.chat_id || project.lifecycle === "deleting")) {
    throw new Error("Шлюз вернул другую или недоступную комнату проекта.");
  }
  return project;
}

const page = 50;
const fold = (text: string) => text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
const orderedPins = (a: Project, b: Project) => Number(b.pinned === true) - Number(a.pinned === true);

export class ProjectDirectory {
  private readonly content = column();
  readonly dialog = sheet("Проекты на шлюзе", this.content);
  private readonly cancel = new Gio.Cancellable();
  private readonly search = new Gtk.SearchEntry({ placeholder_text: "Название, ID или номер комнаты", hexpand: true });
  private readonly status = label("", "dim-label");
  private readonly lookupStatus = label("");
  private readonly list = new Adw.PreferencesGroup();
  private readonly more = button("Показать ещё", () => { if (!this.cancel.is_cancelled()) { this.limit += page; this.render(); } });
  private readonly byId = button("Открыть по ID", () => void this.lookup({ id: this.search.get_text().trim() }));
  private readonly byRoom = button("Открыть по номеру комнаты", () => void this.lookup({ chat_id: Number(this.search.get_text().trim()) }));
  private projects: Project[] = [];
  private limit = page;
  private reading = false;
  private opening = false;
  private problem = "";
  private loaded = false;
  private rows: { id: string; widget: any }[] = [];

  constructor(private readonly gateway: Gateway, refresh: () => void,
    private readonly open: (project: Project) => void, private readonly unread: (project: Project) => number | undefined) {
    const tools = row();
    for (const item of [this.byId, this.byRoom, button("Перечитать список", () => {
      if (!this.cancel.is_cancelled()) refresh();
    })]) tools.append(item);
    for (const item of [this.search, tools, this.lookupStatus, this.status, this.list, this.more]) this.content.append(item);
    this.dialog.set_content_width(740);
    this.dialog.set_content_height(620);
    this.search.connect("changed", () => {
      this.limit = page;
      this.lookupStatus.set_label("");
      this.render();
    });
    this.dialog.connect("closed", () => this.cancel.cancel());
  }

  update(projects: Project[], loaded: boolean, reading: boolean, problem: string): void {
    if (this.cancel.is_cancelled()) return;
    try { this.projects = readProjects({ projects }); }
    catch (error) { this.reading = false; this.problem = errorText(error); this.render(); return; }
    this.loaded = loaded;
    this.reading = reading;
    this.problem = problem;
    this.render();
  }

  private render(): void {
    if (this.cancel.is_cancelled()) return;
    const search = this.search.get_text().trim();
    const words = fold(search).split(/\s+/u).filter(Boolean);
    this.byId.set_sensitive(!this.opening && validProjectId(search));
    this.byRoom.set_sensitive(!this.opening && /^\d+$/.test(search) && Number.isSafeInteger(Number(search)) && Number(search) > 1);
    const found = this.projects.filter(item => {
      const name = fold(`${item.name || item.id} ${item.id} ${item.chat_id}`);
      return words.every(word => name.includes(word));
    }).sort(orderedPins);
    const count = found.length;
    this.status.set_label(this.reading ? "Читаю список проектов…" : this.problem
      ? `${this.loaded ? "Показан последний прочитанный список. " : ""}${this.problem}`
      : count ? `Показано ${Math.min(this.limit, count)} из ${count}`
        : this.loaded ? (words.length ? "В списке нет совпадений." : "На шлюзе нет доступных проектов.") : "");
    this.more.set_visible(count > this.limit);
    this.more.set_sensitive(!this.opening);
    const visible = found.slice(0, this.limit).map(project => {
      const count = this.unread(project);
      const subtitle = [`ID · ${project.id}`, `Комната · ${project.chat_id}`, project.pinned && "Закреплён",
        project.lifecycle === "deleting" ? "Удаляется" : project.closed ? "Закрыт" : "",
        count ? `Непрочитано · ${count}` : "", project.delete_error].filter(Boolean).join(" · ");
      return { id: project.id, title: project.name || project.id, subtitle, deleting: project.lifecycle === "deleting" };
    });
    const changed = this.rows.findIndex((item, index) => item.id !== visible[index]?.id);
    if (changed >= 0) {
      for (const { widget } of this.rows.splice(changed)) this.list.remove(widget);
    }
    visible.forEach((project, index) => {
      let item = this.rows[index];
      if (!item) {
        const widget = actionRow({ use_markup: false });
        const open = button("Открыть", () => {
          if (this.rows.some(row => row.widget === widget)
            && this.projects.some(item => item.id === project.id && item.lifecycle !== "deleting")) void this.lookup({ id: project.id });
        });
        open.set_valign(Gtk.Align.CENTER);
        open.set_tooltip_text(`Открыть проект ${project.id}`);
        widget.add_suffix(open);
        widget.set_activatable_widget(open);
        this.list.add(widget);
        item = { id: project.id, widget };
        this.rows.push(item);
      }
      item.widget.set_title(project.title);
      item.widget.set_subtitle(project.subtitle);
      item.widget.get_activatable_widget().set_sensitive(!this.opening && !project.deleting);
    });
  }

  private async lookup(address: Address): Promise<void> {
    if (this.opening || this.cancel.is_cancelled()) return;
    if ("id" in address ? !validProjectId(address.id) : !Number.isSafeInteger(address.chat_id) || address.chat_id <= 1) {
      this.lookupStatus.set_label("Укажите ID проекта или целый номер комнаты больше 1.");
      return;
    }
    this.opening = true;
    this.search.set_sensitive(false);
    this.list.set_sensitive(false);
    this.render();
    this.lookupStatus.set_label("Проверяю адрес проекта на шлюзе…");
    try {
      const project = await readProject(this.gateway, address, this.cancel);
      if (this.cancel.is_cancelled()) return;
      if (!project) {
        this.lookupStatus.set_label("Шлюз не нашёл проект по этому адресу.");
        return;
      }
      if (project.lifecycle === "deleting") {
        this.lookupStatus.set_label(["Проект удаляется. Комната недоступна для перехода.", project.delete_error].filter(Boolean).join("\n"));
        return;
      }
      this.cancel.cancel();
      this.open(project);
      this.dialog.close();
    } catch (error) {
      if (!this.cancel.is_cancelled()) this.lookupStatus.set_label(errorText(error));
    } finally {
      this.opening = false;
      if (!this.cancel.is_cancelled()) {
        this.search.set_sensitive(true);
        this.list.set_sensitive(true);
        this.render();
      }
    }
  }
}
