import { ProjectDetails, ProjectFacts } from "./project-details.js";
import { Adw, Gio, GLib, Gtk } from "./gi.js";
import { type Gateway, HttpError, query } from "./gateway.js";
import { type Room } from "./chat.js";
import { directoryPicker } from "./directory-picker.js";
import { projectDeletion } from "./project-deletion.js";
import { ProjectDirectory, projectChat, readProject, readProjects, validProjectId, type Project } from "./project-directory.js";
import { type RoomReads } from "./room-reads.js";
import { object } from "./settings-write.js";
import { button, column, errorText, label, row } from "./ui.js";

interface ProjectReceipt {
  project?: Project;
  chat_id?: number;
  created?: boolean;
  init_git_warnings?: unknown[];
  init_git_skipped?: string[];
}

function projectUpdateMatches(entry: Project, body: Record<string, unknown>): boolean {
  if (entry.lifecycle === "deleting" || entry.name !== body.name) return false;
  if (Object.hasOwn(body, "pinned") && Boolean(entry.pinned) !== body.pinned) return false;
  if (Object.hasOwn(body, "closed") && Boolean(entry.closed) !== body.closed) return false;
  if (body.closed === true) {
    const closure = object(entry.closed);
    if (["at", "by", "note"].some(key => typeof closure[key] !== "string")) return false;
  }
  return true;
}

function suggestedProjectId(name: string): string {
  const digest = () => GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, name, -1) as string;
  // Readback hint for the gateway's name-only creation. The request still lets the gateway mint the id.
  const slug = name.replace(/[^a-zA-Z0-9_.-]/gu, "-").slice(0, 64).replace(/^[-.]+|[-.]+$/g, "").toLowerCase();
  if (!validProjectId(slug)) return `proj_${digest().slice(0, 12)}`;
  const collapsed = slug.replace(/-{2,}/g, "-");
  return /[^a-zA-Z0-9_.\-\p{White_Space}\u001c-\u001f]/u.test(name) ? `${collapsed.slice(0, 55).replace(/[-.]+$/g, "")}-${digest().slice(0, 8)}`
    : collapsed;
}

const projectRoom = (project: Project): Room => ({ chatId: project.chat_id, projectId: project.id, name: project.name || project.id });

export class Projects {
  readonly widget = row();
  private readonly model = new Gtk.StringList();
  private readonly select = new Gtk.DropDown({ model: this.model, hexpand: true });
  private readonly edit = button("Изменить проект", () => this.openEditor(this.selected()));
  private readonly details = button("Сведения о проекте…", () => {
    const project = this.selected();
    if (this.disposed || !project) return;
    if (this.detailsView?.projectId === project.id) { this.detailsView.dialog.present(this.parent);return; }
    this.detailsView?.dialog.force_close();
    const view = new ProjectDetails(this.parent, this.gateway, project, this.receipts.get(project.id));
    this.detailsView = view;
    view.dialog.connect("closed", () => { if (this.detailsView === view) this.detailsView = undefined; });
    this.present(view.dialog);
  });
  private readonly remove = button("Удалить проект", () => this.removeProject());
  private readonly main: Room;
  private readonly defaultRoom?: Room;
  private projects: Project[] = [];
  private readonly receipts = new Map<string, Project>();
  private rooms: Room[];
  private disposed = false;
  private readonly cancel = new Gio.Cancellable();
  private changing = false;
  private refreshing = false;
  private dirty = false;
  private selectedIndex = 0;
  private historySelection = 0;
  private requestedChat?: number;
  private directory?: ProjectDirectory;
  private detailsView?: ProjectDetails;
  private deletionDialog?: any;
  private listProblem = "";
  private listLoaded = false;
  private readonly dialogs = new Set<any>();

  constructor(
    private readonly parent: any,
    private readonly gateway: Gateway,
    defaultChat: number,
    private readonly selectRoom: (room: Room) => void,
    private readonly roomReads?: RoomReads,
  ) {
    this.main = { name: "Main", chatId: 1 };
    this.defaultRoom = defaultChat !== 1 ? { name: `Чат ${defaultChat}`, chatId: defaultChat } : undefined;
    this.rooms = this.defaultRoom ? [this.main, this.defaultRoom] : [this.main];
    this.widget.append(this.select);
    this.widget.append(button("Найти проект…", () => this.showDirectory()));
    this.widget.append(button("Новый проект", () => this.openEditor()));
    this.widget.append(this.edit);
    this.widget.append(this.details);
    this.widget.append(this.remove);
    for (const room of this.rooms) this.model.append(room.name);
    this.selectedIndex = this.defaultRoom ? 1 : 0;
    this.select.set_selected(this.selectedIndex);
    this.syncButtons();
    this.select.connect("notify::selected", () => {
      if (this.changing || this.disposed) return;
      this.requestedChat = undefined;
      this.selectedIndex = this.select.get_selected();
      this.syncButtons();
      this.selectRoom(this.currentRoom());
    });
    void this.refresh(defaultChat);
  }

  close(): void {
    this.disposed = true;
    this.cancel.cancel();
    this.receipts.clear();
    this.select.set_sensitive(false);
    this.syncButtons();
    for (const dialog of this.dialogs) dialog.force_close();
  }

  projectRooms(): Room[] {
    return this.rooms.filter((room) => room.projectId);
  }

  selectHistoryRoom(room: Room): void {
    if (this.disposed) return;
    this.historySelection++;
    this.requestedChat = undefined;
    let index = this.rooms.findIndex((item) => item.chatId === room.chatId);
    if (index < 0) {
      index = this.rooms.length;
      this.rooms.push(room);
    } else {
      this.rooms[index] = room;
    }
    this.selectedIndex = index;
    this.readStateChanged();
    this.syncButtons();
    if (room.projectId && !this.selected()) void this.refresh();
  }

  readStateChanged(): void {
    if (this.disposed) return;
    const metadata = new Map(this.projects.map((project) => [project.id, project]));
    const names = this.rooms.map((room) => {
      const project = room.projectId ? metadata.get(room.projectId) : undefined;
      const suffix = project?.lifecycle === "deleting" ? " · удаляется" : project?.closed ? " · закрыт" : "";
      const count = this.roomReads?.unread(room);
      return `${project?.pinned ? "★ " : ""}${room.name}${suffix}${count ? ` · Непрочитано ${count}` : ""}`;
    });
    this.changing = true;
    if (names.length !== this.model.get_n_items() || names.some((name, index) => name !== this.model.get_string(index))) {
      this.model.splice(0, this.model.get_n_items(), names);
    }
    this.select.set_selected(this.selectedIndex);
    this.changing = false;
    this.updateDirectory();
  }

  async refresh(chatId?: number): Promise<void> {
    if (this.disposed) return;
    if (chatId !== undefined) this.requestedChat = chatId;
    if (this.refreshing) {
      this.dirty = true;
      return;
    }
    this.refreshing = true;
    this.updateDirectory();
    const historySelection = this.historySelection;
    try {
      const projects = readProjects(await this.gateway.json<unknown>("GET", "/api/projects" + query({ all: 1 }), undefined, undefined, false, this.cancel));
      if (this.disposed) return;
      const previous = this.currentRoom();
      if (historySelection !== this.historySelection && previous.projectId) {
        this.dirty = true;
        return;
      }
      this.projects = projects.filter(projectChat).sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true));
      this.listLoaded = true;
      this.listProblem = "";
      const target = this.requestedChat ?? previous.chatId;
      this.requestedChat = undefined;
      this.rooms = [this.main, ...this.projects.map(projectRoom)];
      if (this.defaultRoom && !this.rooms.some((room) => room.chatId === this.defaultRoom?.chatId)) {
        this.rooms.push(this.defaultRoom);
      }
      const index = this.rooms.findIndex((room) => room.chatId === target);
      this.selectedIndex = Math.max(0, index);
      this.readStateChanged();
      this.select.set_tooltip_text(null);
      this.syncButtons();
      const current = this.currentRoom();
      if (current.chatId !== previous.chatId || current.name !== previous.name || current.projectId !== previous.projectId) {
        this.selectRoom(current);
      }
      this.roomReads?.observeProjects(this.projects);
    } catch (error) {
      if (!this.disposed) {
        this.listProblem = "Не удалось загрузить проекты · " + errorText(error);
        this.select.set_tooltip_text(this.listProblem);
      }
    } finally {
      this.refreshing = false;
      if (this.dirty) {
        this.dirty = false;
        void this.refresh();
      } else this.updateDirectory();
    }
  }

  private updateDirectory(): void {
    this.directory?.update(this.projects, this.listLoaded, this.refreshing, this.listProblem);
  }

  private showDirectory(): void {
    if (this.disposed || this.directory) return;
    const view = new ProjectDirectory(this.gateway, () => void this.refresh(), project => {
      this.projects = [...this.projects.filter(item => item.id !== project.id), project];
      const room = projectRoom(project);
      this.selectHistoryRoom(room);
      this.roomReads?.observeProjects([project]);
      this.selectRoom(room);
      void this.refresh();
    }, project => this.roomReads?.unread(projectRoom(project)));
    this.directory = view;
    view.dialog.connect("closed", () => { if (this.directory === view) this.directory = undefined; });
    this.present(view.dialog);
    this.updateDirectory();
    if (!this.refreshing) void this.refresh();
  }

  private selected(): Project | undefined {
    const id = this.currentRoom().projectId;
    return id ? this.projects.find((project) => project.id === id) : undefined;
  }

  private currentRoom(): Room {
    return this.rooms[this.selectedIndex] ?? this.main;
  }

  private syncButtons(): void {
    const project = this.selected();
    this.details.set_sensitive(!this.disposed && Boolean(project));
    this.edit.set_sensitive(!this.disposed && Boolean(project && project.lifecycle !== "deleting"));
    this.remove.set_sensitive(!this.disposed && Boolean(project));
    this.remove.set_label(project?.lifecycle === "deleting" ? "Статус удаления…" : "Удалить проект");
  }

  private openEditor(project?: Project): void {
    if (this.disposed) return;
    const dialog = new Adw.AlertDialog({ heading: project ? "Изменить проект" : "Новый проект" });
    const fields = column();
    const identity = new Adw.PreferencesGroup();
    const name = new Adw.EntryRow({ title: "Название", text: project?.name ?? "" });
    const id = new Adw.EntryRow({ title: "ID проекта (необязательно)" });
    identity.add(name);
    if (!project) identity.add(id);
    fields.append(identity);
    const status = label("");
    const readCancel = new Gio.Cancellable();
    const facts = new ProjectFacts();
    const receiptFacts = new Gtk.Expander({ label: "Сведения из квитанции создания", child: facts.widget, visible: false });
    fields.append(receiptFacts);
    dialog.connect("closed", () => { readCancel.cancel();facts.close(); });
    const gitDetails = label("");
    gitDetails.set_selectable(true);
    const gitScroll = new Gtk.ScrolledWindow({ child: gitDetails, hscrollbar_policy: Gtk.PolicyType.NEVER,
      max_content_height: 180, propagate_natural_height: true, visible: false });
    const sourceNames = ["Без рабочей папки", "Создать рабочую папку", "Подключить папку на шлюзе", "Клонировать Git"];
    const source = Gtk.DropDown.new_from_strings(sourceNames);
    const path = new Adw.EntryRow({ title: "Путь на шлюзе или URL репозитория" });
    const initGit = new Gtk.CheckButton({ label: "Инициализировать Git" });
    const pinned = new Gtk.CheckButton({ label: "Закрепить проект", active: project?.pinned ?? false });
    const closed = new Gtk.CheckButton({ label: "Закрыть проект", active: Boolean(project?.closed) });
    let requestId = project?.id ?? "";
    let baseline = project;
    let submittedUpdate: Record<string, unknown> | undefined;
    let found: Project | undefined;
    let reading = false;
    let writing = false;
    let picker: any;
    if (project) {
      if (project.working_dir) fields.append(label(project.working_dir, "dim-label"));
      fields.append(pinned);
      fields.append(closed);
    } else {
      fields.append(source);
      const target = new Adw.PreferencesGroup();
      target.add(path);
      fields.append(target);
      const browse = button("Выбрать папку на шлюзе…", () => {
        if (this.disposed || writing || !this.dialogs.has(dialog) || picker) return;
        picker = directoryPicker(this.gateway, path.get_text().trim(), (selected) => {
          if (this.dialogs.has(dialog)) path.set_text(selected);
        }, dialog);
        picker.connect("closed", () => { picker = undefined; });
        this.present(picker, dialog);
      });
      fields.append(browse);
      fields.append(initGit);
      const sync = () => {
        const index = source.get_selected();
        target.set_visible(index === 2 || index === 3);
        browse.set_visible(index === 2);
        initGit.set_visible(index === 1 || index === 2);
      };
      source.connect("notify::selected", sync);
      sync();
    }
    fields.append(status);
    fields.append(gitScroll);
    dialog.set_extra_child(fields);
    dialog.add_response("cancel", "Отмена");
    dialog.set_close_response("cancel");
    const finish = (chatId: number) => {
      if (!this.dialogs.has(dialog)) return;
      dialog.close();
      void this.refresh(chatId);
    };
    const openProject = button("Открыть проект", () => { if (found) finish(found.chat_id); });
    openProject.set_visible(false);
    const receipt = (entry: Project, message: string, fromReceipt = true) => {
      found = entry;
      facts.update(entry);receiptFacts.set_label(fromReceipt ? "Сведения из квитанции создания" : "Сведения из текущего списка");receiptFacts.set_visible(true);
      status.set_label([message, `ID · ${entry.id}`, entry.working_dir && `Папка · ${entry.working_dir}`].filter(Boolean).join("\n"));
      openProject.set_visible(true);
    };
    const unlock = () => {
      writing = false;save.set_sensitive(true);identity.set_sensitive(true);
      pinned.set_sensitive(true);closed.set_sensitive(true);source.set_sensitive(true);path.set_sensitive(true);initGit.set_sensitive(true);
    };
    const readback = button("Проверить запись на шлюзе", () => {
      if (!requestId || reading || !this.dialogs.has(dialog)) return;
      reading = true;
      readback.set_sensitive(false);
      status.set_label(`Ищу проект · ${requestId}`);
      void readProject(this.gateway, { id: requestId }, readCancel).then(entry => {
        if (!this.dialogs.has(dialog)) return;
        if (!entry) {
          status.set_label(`Проект ${requestId} пока не найден. Результат запроса остаётся неизвестным.`);
          return;
        }
        if (project && submittedUpdate) {
          if (entry.chat_id !== project.chat_id || entry.lifecycle === "deleting") throw new Error("Шлюз не подтвердил исходную доступную комнату проекта.");
          baseline = entry;readback.set_visible(false);unlock();
          if (projectUpdateMatches(entry, submittedUpdate)) receipt(entry, "Текущее состояние совпадает с запросом. Квитанция изменения неизвестна.", false);
          else {
            found = undefined;openProject.set_visible(false);facts.update(entry);
            receiptFacts.set_label("Текущее состояние на шлюзе");receiptFacts.set_visible(true);
            status.set_label("Текущее состояние отличается от запроса. Черновик сохранён; проверьте его перед новой отправкой.");
          }
          return;
        }
        readback.set_visible(false);
        receipt(entry, "Проект найден по ID. Квитанция запроса и результат подготовки Git недоступны.", false);
      }).catch((error: unknown) => {
        if (this.dialogs.has(dialog)) status.set_label(`Проверка проекта ${requestId} не удалась. ${errorText(error)}`);
      }).finally(() => {
        reading = false;
        if (this.dialogs.has(dialog)) readback.set_sensitive(true);
      });
    });
    readback.set_visible(false);
    const save = button(project ? "Сохранить" : "Создать", () => {
      if (this.disposed || writing || !this.dialogs.has(dialog)) return;
      const title = name.get_text().trim();
      if ([...title].length > 80 || (!title && (project || !id.get_text().trim()))) {
        status.set_label(project ? "Введите название проекта длиной от 1 до 80 символов."
          : "Введите название до 80 символов или укажите ID проекта.");
        return;
      }
      const body: Record<string, unknown> = { name: title };
      let sourceRequested = false;
      if (project) {
        if (pinned.get_active() !== Boolean(baseline?.pinned)) body.pinned = pinned.get_active();
        if (closed.get_active() !== Boolean(baseline?.closed)) body.closed = closed.get_active();
      } else {
        const requested = id.get_text().trim();
        if (requested && !validProjectId(requested)) {
          status.set_label("ID допускает до 64 строчных латинских букв, цифр и символов «_», «.» и «-». Начните и закончите ID буквой, цифрой или «_».");
          return;
        }
        requestId = requested || suggestedProjectId(title);
        if (requested) body.id = requested;
        const index = source.get_selected();
        const target = path.get_text().trim();
        if ((index === 2 || index === 3) && !target) {
          status.set_label(index === 2 ? "Введите путь к папке." : "Введите URL репозитория.");
          return;
        }
        if (index === 1) body.with_workspace = true;
        if (index === 2) body.path = target;
        if (index === 3) body.git_url = target;
        if ((index === 1 || index === 2) && initGit.get_active()) body.init_git = true;
        sourceRequested = index !== 0;
      }
      writing = true;
      if (project) submittedUpdate = { ...body };
      readback.set_visible(false);openProject.set_visible(false);receiptFacts.set_visible(false);
      save.set_sensitive(false);
      pinned.set_sensitive(false);closed.set_sensitive(false);
      identity.set_sensitive(false);
      source.set_sensitive(false);
      path.set_sensitive(false);
      initGit.set_sensitive(false);
      status.set_label(project ? "Сохраняю проект…" : "Шлюз обрабатывает создание проекта…");
      const route = project ? `/api/projects/${encodeURIComponent(project.id)}/update` : "/api/projects";
      void this.gateway.json<ProjectReceipt>("POST", route, body).then((result) => {
        if (!this.dialogs.has(dialog)) return;
        if (project) {
          const entry = result?.project;
          if (!projectChat(entry) || entry.id !== project.id || entry.chat_id !== project.chat_id || !projectUpdateMatches(entry, body)) {
            throw new Error("Ответ шлюза не подтвердил изменение выбранного проекта и запрошенных значений.");
          }
          this.receipts.set(project.id, entry);
          finish(entry.chat_id); return;
        }
        const entry = result?.project;
        if (!projectChat(entry) || (body.id && entry.id !== body.id)) throw new Error("Шлюз не вернул квитанцию с ID проекта и комнаты.");
        this.receipts.set(entry.id, entry);
        const warnings = Array.isArray(result.init_git_warnings) ? result.init_git_warnings.map(item =>
          typeof item === "string" ? item : JSON.stringify(item)) : [];
        const skipped = Array.isArray(result.init_git_skipped) ? result.init_git_skipped.filter(item => typeof item === "string") : [];
        const missingWorkspace = sourceRequested && !entry.working_dir;
        const existing = (entry.created ?? result.created) === false;
        if (!warnings.length && !skipped.length && !missingWorkspace && !existing) {
          finish(entry.chat_id);
          return;
        }
        const details = [
          warnings.length && ["Предупреждения при подготовке Git", ...warnings].join("\n"),
          skipped.length && ["Файлы, пропущенные при подготовке Git", ...skipped].join("\n"),
        ].filter(Boolean).join("\n");
        gitDetails.set_label(details);
        gitScroll.set_visible(Boolean(details));
        receipt(entry, [
          existing ? "Проект с этим ID уже существовал." : "Шлюз вернул запись проекта.",
          missingWorkspace && "Рабочая папка в квитанции отсутствует.",
        ].filter(Boolean).join("\n"));
      }).catch((error: unknown) => {
        if (!this.dialogs.has(dialog)) return;
        const refused = error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 408;
        if (!refused) {
          status.set_label(`Результат ${project ? "изменения" : "создания"} проекта ${requestId} неизвестен. ${errorText(error)}`);
          readback.set_visible(true);
          return;
        }
        const code = error instanceof HttpError ? object(error.body).error_code : undefined;
        unlock();
        status.set_label(code === "auth_required" ? `Репозиторий требует авторизации на шлюзе. ${errorText(error)}` : errorText(error));
      });
    });
    const edited = () => { if (project && !writing && found) { found = undefined;openProject.set_visible(false);status.set_label("Черновик изменён. Сохраните новые значения отдельным запросом."); } };
    name.connect("changed", edited);pinned.connect("toggled", edited);closed.connect("toggled", edited);
    save.add_css_class("suggested-action");
    fields.append(save);
    fields.append(readback);
    fields.append(openProject);
    this.present(dialog);
  }

  private present(dialog: any, parent = this.parent): void {
    this.dialogs.add(dialog);
    dialog.connect("closed", () => this.dialogs.delete(dialog));
    dialog.present(parent);
  }

  private removeProject(): void {
    const project = this.selected();
    if (project && !this.disposed && !this.deletionDialog) {
      const dialog = projectDeletion(this.gateway, project, () => void this.refresh());
      this.deletionDialog = dialog;
      dialog.connect("closed", () => { if (this.deletionDialog === dialog) this.deletionDialog = undefined; });
      this.present(dialog);
    }
  }
}
