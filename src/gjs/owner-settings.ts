import { Adw, Gio, GLib, Gtk } from "./gi.js";
import { type Gateway } from "./gateway.js";
import { contextModes, effortLevels, subagentModes, type RoomChange, type RoomCognition, validEffort } from "./room-cognition.js";
import { type SettingsDocument, object, ownerHeaders, settingsFailure, unsaved } from "./settings-write.js";
import { button, clear, column, errorText, label, row, sheet } from "./ui.js";

import { readOwnerSettings, readOwnerProjects, readOwnerDesktop, type OwnerProject, type OwnerDesktopState } from "./owner-read.js";
import { chrome, chromeText, watchNativeI18n } from "./native-i18n.js";
const titles: Record<string, string> = {
  "Доступ и безопасность":"Access and safety", "Режим доступа":"Access mode", "Автовыдача разрешений проверенным навыкам":"Automatically grant permissions to reviewed skills",
  "Безопасность задач владельца":"Owner task safety", "Безопасность фоновой работы":"Background work safety", "Модель Safety Supervisor":"Safety Supervisor model", "Правила безопасности владельца":"Owner safety rules",
  "Комната":"Room", "Общие параметры интерфейса":"Shared interface settings", "Приложение на хосте шлюза":"Gateway host application", "Контекст":"Context", "Режим субагентов":"Subagent mode",
  "Минимальное усилие":"Minimum effort", "Рекомендуемое усилие":"Recommended effort", "Максимальное усилие":"Maximum effort", "Запуск приложения шлюза при входе":"Start the gateway application at login", "Работа приложения шлюза после закрытия окна":"Keep the gateway application running after closing its window",
};
const modes: Record<string, string> = { light:"Light", advanced:"Advanced", pro:"Pro", cyber_pro:"Cyber Pro", off:"Off", on:"On", full:"Full", nano:"Nano", low:"Low", max:"Maximum", auto:"Auto", swarm:"Swarm", none:"None", minimal:"Minimal", medium:"Medium", high:"High", xhigh:"Extra high", ultra:"Ultra" };
function fieldLabel(title: string, css?: string): any {
  const widget=label(title,css); return Object.hasOwn(titles,title)?chrome(widget,"label",titles[title]):widget;
}
export const ownerKeys = new Set([
  "OUROBOROS_RUNTIME_MODE", "OUROBOROS_AUTO_GRANT_REVIEWED_SKILLS", "OUROBOROS_CONTEXT_MODE", "OUROBOROS_SUBAGENTS_MODE",
  "OUROBOROS_EFFORT_MIN", "OUROBOROS_EFFORT_TASK", "OUROBOROS_EFFORT_MAX", "OUROBOROS_SAFETY_MODE",
  "OUROBOROS_CONSCIOUSNESS_SAFETY_MODE", "OUROBOROS_MODEL_SAFETY", "OUROBOROS_SAFETY_OWNER_RULES",
  "OUROBOROS_UI_LANGUAGE", "OUROBOROS_DESKTOP_KEEP_RUNNING",
]);

const ownerPath = "/api/owner/";
const desktop = [
  { path: "/api/desktop/autostart", title: "Запуск приложения шлюза при входе" },
  { path: "/api/desktop/background", title: "Работа приложения шлюза после закрытия окна" },
];

export class OwnerSettings {
  private dialog?: any;
  private body?: any;
  private status?: any;
  private busy = false;
  private readReady = false;
  private cancel?: any;
  private version = 0;
  private roomVersion = 0;
  private parentSignal = 0;
  private readonly selectors = new Map<any, () => void>();
  private retired: any[] = [];
  private retirement = 0;
  private flushRetired(): void { for (const widget of this.retired.splice(0)) widget.run_dispose(); }
  private releaseSelectors(target?: any): void {
    for (const [control, stop] of [...this.selectors]) {
      let parent = control;
      while (parent && target && parent !== target) parent = parent.get_parent();
      if (target && !parent) continue;
      stop(); this.selectors.delete(control);
      control.get_parent()?.remove(control); this.retired.push(control);
    }
    if (this.retired.length && !this.retirement) this.retirement = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      this.retirement = 0; this.flushRetired(); return GLib.SOURCE_REMOVE;
    });
  }
  private disposed = false;
  private projectId = "";
  private snapshot?: SettingsDocument;
  private projects: OwnerProject[] = [];
  private readonly hosts = new Map<string, OwnerDesktopState>();
  private readonly drafts = new Map<string, { base: unknown; value: unknown }>();
  private same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
  private draft<T>(key: string, saved: T): T {
    const item = this.drafts.get(key);
    if (item && this.same(item.value, saved)) this.drafts.delete(key);
    return this.drafts.has(key) ? this.drafts.get(key)!.value as T : saved;
  }
  private remember(key: string, saved: unknown, value: unknown): void {
    if (this.same(saved, value)) this.drafts.delete(key);
    else {
      const previous = this.drafts.get(key);
      this.drafts.set(key, { base: previous ? previous.base : saved, value });
    }
  }
  private draftTools(target: any, key: string, saved: unknown, alive = () => true): () => void {
    const version = this.version, tools = row(), note = label("", "dim-label");
    note.set_hexpand(true);
    const reset = chrome(button("Сбросить черновик", () => {
      if (version !== this.version || !alive() || this.busy || !this.dialog) return;
      this.drafts.delete(key); this.render();
    }), "label", "Discard draft");
    tools.append(note); tools.append(reset); target.append(tools);
    const sync = () => {
      if (version !== this.version || !alive()) return;
      const item = this.drafts.get(key); tools.set_visible(Boolean(item));
      if (!item) return;
      const conflict = !this.same(item.base, saved);
      note.set_label(conflict ? "Значение на шлюзе изменилось. Черновик сохранён." : "Несохранённый черновик.");
      chrome(note, "label", conflict ? "The server value changed. Your draft is retained." : "Unsaved draft.");
    };
    sync(); return sync;
  }
  private readonly paintingSelectors = new Set<any>();


  constructor(private readonly parent: any, private readonly gateway: Gateway, private readonly changed: () => void,
    private readonly roomCognition?: RoomCognition, private readonly openTranslations?: (parent: any) => void) {
    if (parent instanceof Adw.Dialog || parent instanceof Gtk.Window) this.parentSignal = parent.connect(
      parent instanceof Gtk.Window ? "close-request" : "closed", () => { this.close(); return false; });
  }

  show(): void {
    if (this.disposed) return;
    if (this.dialog) { this.dialog.present(this.parent); return; }
    const content = column();
    const dialog = chrome(sheet("Управление владельца", content), "title", "Owner controls");
    this.cancel = new Gio.Cancellable();
    this.readReady = false;
    this.busy = false;
    this.dialog = dialog;
    this.body = column();
    this.status = label("");
    content.append(chrome(button("Перечитать", () => { if (this.dialog === dialog) void this.load(); }), "label", "Reload"));
    content.append(this.status);
    content.append(this.body);
    dialog.connect("closed", () => {
      if (this.dialog === dialog) {
        ++this.version; this.cancel?.cancel(); this.cancel = undefined; this.busy = false;
        this.releaseSelectors(); this.drafts.clear(); this.dialog = this.body = this.status = undefined;
      }
    });
    dialog.present(this.parent);
    void this.roomCognition?.refresh();
    void this.load();
  }

  close(): void {
    this.disposed = true;
    if (this.parentSignal) { this.parent.disconnect(this.parentSignal); this.parentSignal = 0; }
    this.dialog?.force_close();
    if (this.retirement) { GLib.Source.remove(this.retirement); this.retirement = 0; }
    this.flushRetired();
  }

  private async load(reset = true): Promise<void> {
    if (this.disposed || !this.dialog || this.busy) return;
    const dialog = this.dialog;
    this.busy = true;
    this.body.set_sensitive(false);
    if (reset) { this.status.set_label("Читаю состояние…"); chrome(this.status, "label", "Reading state…"); }
    try {
      await this.read();
      if (reset && this.dialog === dialog && !this.disposed) this.status.set_label("");
    } catch (error) {
      if (this.dialog === dialog && !this.disposed) this.status.set_label(errorText(error));
    } finally {
      if (this.dialog === dialog) { this.busy = false; this.body?.set_sensitive(this.readReady); }
    }
  }

  private async read(): Promise<void> {
    const dialog = this.dialog;
    this.readReady = false;
    const [settings, projects, ...hosts] = await Promise.allSettled([
      this.gateway.json<SettingsDocument>("GET", "/api/settings", undefined, undefined, false, this.cancel),
      this.gateway.json<unknown>("GET", "/api/projects?all=1", undefined, undefined, false, this.cancel),
      ...desktop.map((host) => this.gateway.json<unknown>("GET", host.path, undefined, undefined, false, this.cancel)),
    ] as const);
    if (this.dialog !== dialog || this.disposed) return;
    if (settings.status === "rejected") throw settings.reason;
    if (projects.status === "rejected") throw projects.reason;
    // Validate both scope and values before replacing any part of the current form.
    const nextSettings = readOwnerSettings(settings.value);
    const nextProjects = readOwnerProjects(projects.value);
    const nextHosts = new Map<string, OwnerDesktopState>();
    desktop.forEach((host, index) => {
      const result = hosts[index];
      try {
        if (result.status === "rejected") throw result.reason;
        nextHosts.set(host.path, readOwnerDesktop(result.value));
      } catch (error) { nextHosts.set(host.path, { state: "unavailable", reason: errorText(error) }); }
    });
    this.snapshot = nextSettings; this.projects = nextProjects;
    if (!this.projects.some(project => project.id === this.projectId)) this.projectId = "";
    this.hosts.clear();
    for (const [path, state] of nextHosts) this.hosts.set(path, state);
    this.render(); this.readReady = true;
  }

  private render(): void {
    if (!this.body) return;
    ++this.version; const version = this.version; this.releaseSelectors(this.body);
    clear(this.body);
    const document = this.snapshot;
    if (document) {
      const security = column();
      security.append(fieldLabel("Доступ и безопасность", "title-3"));
      const policy = object(object(object(document._meta).policy_state).access);
      const effective = [policy.configured && `Сохранено · ${policy.configured}`, policy.effective && `Действует · ${policy.effective}`].filter(Boolean);
      if (effective.length) security.append(label(effective.join("\n"), "dim-label"));
      this.choice(security, "Режим доступа", ["light", "advanced", "pro", "cyber_pro"], document.OUROBOROS_RUNTIME_MODE,
        (mode) => this.write(ownerPath + "runtime-mode", { mode }));
      this.choice(security, "Автовыдача разрешений проверенным навыкам", ["off", "on"], this.flag(document.OUROBOROS_AUTO_GRANT_REVIEWED_SKILLS),
        (value) => this.write(ownerPath + "auto-grant", { enabled: value === "on" }));
      for (const [title, key, kind] of [
        ["Безопасность задач владельца", "OUROBOROS_SAFETY_MODE", "your_work"],
        ["Безопасность фоновой работы", "OUROBOROS_CONSCIOUSNESS_SAFETY_MODE", "consciousness"],
      ] as const) {
        this.choice(security, title, ["full", "light", "off"], document[key], (mode) => this.write(ownerPath + "safety-mode", { kind, mode }));
      }
      this.textField(security, "Модель Safety Supervisor", document.OUROBOROS_MODEL_SAFETY,
        (model) => this.write(ownerPath + "safety-model", { settings: { OUROBOROS_MODEL_SAFETY: model } }));
      this.textField(security, "Правила безопасности владельца", document.OUROBOROS_SAFETY_OWNER_RULES,
        (rules) => this.write(ownerPath + "safety-rules", { rules }), true);
      this.body.append(security);

      this.body.append(fieldLabel("Комната", "title-3"));
      const rooms = Gtk.DropDown.new_from_strings(["Main", ...this.projects.map((project) => project.name || project.id)]);
      rooms.set_selected(Math.max(0, this.projects.findIndex((project) => project.id === this.projectId) + 1));
      this.body.append(rooms);
      this.selectors.set(rooms, () => {});
      const roomSettings = column();
      this.body.append(roomSettings);
      const sync = () => {
        if (!this.selectors.has(rooms)) return;
        this.projectId = this.projects[rooms.get_selected() - 1]?.id ?? "";
        this.room(roomSettings, document);
      };
      rooms.connect("notify::selected", sync);
      sync();

      if (this.openTranslations) {
        this.body.append(fieldLabel("Общие параметры интерфейса", "title-3"));
        this.body.append(chrome(button("Переводы интерфейса…", () => { if (version === this.version && this.dialog && !this.disposed) this.openTranslations?.(this.dialog); }), "label", "Interface translations…"));
      }
    }
    this.body.append(fieldLabel("Приложение на хосте шлюза", "title-3"));
    for (const host of desktop) {
      const state = this.hosts.get(host.path);
      if (state?.state === "on" || state?.state === "off") {
        this.choice(this.body, host.title, ["off", "on"], state.state, (value) => this.write(host.path, { enabled: value === "on" }));
      } else {
        this.body.append(label([host.title, state?.state || "Состояние неизвестно", state?.reason].filter(Boolean).join(" · "), "dim-label"));
      }
    }
  }

  private room(target: any, document: SettingsDocument): void {
    const roomVersion = ++this.roomVersion, version = this.version;
    this.releaseSelectors(target);
    clear(target);
    const project = this.projects.find(({ id }) => id === this.projectId);
    const project_id = project?.id;
    const context = project ? project.cognition?.context_mode : document.OUROBOROS_CONTEXT_MODE;
    const subagents = project ? project.cognition?.subagents_mode : document.OUROBOROS_SUBAGENTS_MODE;
    this.choice(target, "Контекст", contextModes, context,
      (mode) => this.changeRoom(project_id, { setting: "context-mode", mode }), JSON.stringify(["context", project_id ?? ""]));
    const availability = this.roomCognition?.availability;
    if (availability === "disabled" || availability === "unsaved") {
      target.append(label(`Субагенты сейчас выключены. Сохранённый режим · ${subagents || "auto"}`, "dim-label"));
      if (subagents !== "off") target.append(button("Сохранить режим «Выкл.»",
        () => { if (roomVersion === this.roomVersion && version === this.version) void this.changeRoom(project_id, { setting: "subagents-mode", mode: "off" }); }));
    } else {
      this.choice(target, "Режим субагентов", subagentModes, subagents,
        (mode) => this.changeRoom(project_id, { setting: "subagents-mode", mode }), JSON.stringify(["subagents", project_id ?? ""]));
    }
    const saved = project ? project.cognition?.effort_range : {
      min: document.OUROBOROS_EFFORT_MIN, recommended: document.OUROBOROS_EFFORT_TASK, max: document.OUROBOROS_EFFORT_MAX,
    };
    const effortKey = JSON.stringify(["effort", project_id ?? ""]);
    const serverRange = { min: saved?.min, recommended: saved?.recommended, max: saved?.max };
    const draftRange = this.draft(effortKey, serverRange);
    const fields = column(4);
    const selectors = new Map<string, any>();
    for (const [title, key] of [["Минимальное усилие", "min"], ["Рекомендуемое усилие", "recommended"], ["Максимальное усилие", "max"]] as const) {
      const control = this.dropdown(effortLevels, draftRange[key]);
      selectors.set(key, control);
      const field = row();
      field.append(fieldLabel(title));
      field.append(control);
      fields.append(field);
    }
    fields.append(chrome(button("Сохранить диапазон усилия", () => {
      if (![...selectors.values()].every(control => this.selectors.has(control))) return;
      const [min, recommended, max] = [...selectors.values()].map((control) => effortLevels[control.get_selected() - 1]);
      const range = { min, recommended, max };
      if (!validEffort(range)) {
        this.status.set_label("Задайте три значения. Минимальное усилие должно быть не выше максимального.");
        chrome(this.status, "label", "Choose three effort levels. Minimum effort must not exceed maximum effort.");
        return;
      }
      void this.changeRoom(project_id, { setting: "effort-range", range });
    }), "label", "Save effort range"));
    target.append(fields);
    const alive = () => [...selectors.values()].every(control => this.selectors.has(control));
    const syncDraft = this.draftTools(target, effortKey, serverRange, alive);
    for (const control of selectors.values()) control.connect("notify::selected", () => {
      if (!alive() || [...selectors.values()].some(widget => this.paintingSelectors.has(widget))) return;
      const [min, recommended, max] = [...selectors.values()].map(widget => effortLevels[widget.get_selected() - 1]);
      this.remember(effortKey, serverRange, { min, recommended, max }); syncDraft();
    });
  }

  private flag(value: unknown): string | undefined {
    return value === true || value === "true" || value === "1" ? "on"
      : value === false || value === "false" || value === "0" ? "off" : undefined;
  }

  private dropdown(options: string[], initial: unknown): any {
    const model = new Gtk.StringList();
    const control = new Gtk.DropDown({ model });
    const repaint = () => {
      if (!this.selectors.has(control)) return;
      const selected = control.get_selected();
      this.paintingSelectors.add(control);
      try {
        model.splice(0, model.get_n_items(), [chromeText("Not selected", undefined, "Не выбрано"),
          ...options.map(value => Object.hasOwn(modes, value) ? chromeText(modes[value], undefined, value) : value)]);
        if (selected <= options.length) control.set_selected(selected);
      } finally { this.paintingSelectors.delete(control); }
    };
    this.selectors.set(control, watchNativeI18n(repaint)); repaint();
    control.set_selected(typeof initial === "string" ? options.indexOf(initial) + 1 : 0);
    return control;
  }

  private choice(target: any, title: string, options: string[], initial: unknown, commit: (value: string) => void, key = JSON.stringify(["choice", title])): void {
    const version = this.version;
    const field = row();
    const name = fieldLabel(title);
    name.set_hexpand(true);
    const control = this.dropdown(options, this.draft(key, initial));
    const save = button("Сохранить", () => {
      if (version !== this.version || !this.selectors.has(control)) return;
      const selected = options[control.get_selected() - 1];
      if (selected) commit(selected);
    });
    const sync = () => {
      if (!this.selectors.has(control)) return;
      const value = options[control.get_selected() - 1];
      save.set_sensitive(Boolean(value && value !== initial));
    };
    control.connect("notify::selected", () => {
      if (!this.selectors.has(control)) return;
      if (!this.paintingSelectors.has(control)) this.remember(key, initial, options[control.get_selected() - 1]);
      sync(); syncDraft();
    });
    sync();
    field.append(name);
    field.append(control);
    chrome(save, "label", "Save");
    field.append(save);
    target.append(field);
    const syncDraft = this.draftTools(target, key, initial, () => this.selectors.has(control));
  }

  private textField(target: any, title: string, value: unknown, commit: (value: string) => void, multiline = false): void {
    const version = this.version;
    const initial = typeof value === "string" ? value : "";
    const key = JSON.stringify(["text", title]);
    const draft = this.draft(key, initial);
    let syncDraft = () => {};
    const field = column(4);
    field.append(fieldLabel(title));
    if (multiline) {
      const view = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR });
      const buffer = view.get_buffer();
      buffer.set_text(draft, -1);
      field.append(new Gtk.ScrolledWindow({ child: view, min_content_height: 75 }));
      const current = () => buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false);
      const save = chrome(button("Сохранить правила", () => { if (version === this.version && this.dialog) commit(current()); }), "label", "Save rules");
      save.set_sensitive(current() !== initial);
      buffer.connect("changed", () => {
        if (version !== this.version || !this.dialog) return;
        this.remember(key, initial, current()); save.set_sensitive(current() !== initial); syncDraft();
      });
      field.append(save);
    } else {
      const controls = row();
      const input = new Gtk.Entry({ text: draft, hexpand: true });
      const save = button("Сохранить", () => { if (version === this.version && this.dialog) commit(input.get_text()); });
      save.set_sensitive(input.get_text() !== initial);
      input.connect("changed", () => {
        if (version !== this.version || !this.dialog) return;
        this.remember(key, initial, input.get_text()); save.set_sensitive(input.get_text() !== initial); syncDraft();
      });
      controls.append(input);
      chrome(save, "label", "Save");
      controls.append(save);
      field.append(controls);
    }
    target.append(field);
    syncDraft = this.draftTools(field, key, initial);
  }

  private changeRoom(projectId: string | undefined, change: RoomChange): Promise<void> {
    const body = change.setting === "effort-range" ? change.range : { mode: change.mode };
    const cognition = this.roomCognition;
    const save = cognition ? () => cognition.save(projectId ?? "", change, this.cancel) : undefined;
    return this.write(ownerPath + change.setting, { ...body, project_id: projectId }, save);
  }

  private async write(path: string, body: SettingsDocument, roomSave?: () => Promise<{ message: string }>): Promise<void> {
    if (this.busy || !this.readReady || this.disposed || !this.dialog) return;
    const dialog = this.dialog;
    const current = () => this.dialog === dialog && !this.disposed;
    this.busy = true;
    this.body.set_sensitive(false);
    this.status.set_label("Записываю изменение…");
    chrome(this.status, "label", "Saving change…");
    let refresh = true;
    try {
      if (roomSave) {
        const result = await roomSave();
        if (current()) this.status.set_label(result.message);
      } else {
        const reply = await this.gateway.json<{ ok?: boolean; restart_required?: boolean; state?: string; reason?: string }>(
          "POST", path, body, ownerHeaders, false, this.cancel,
        );
        if (!current()) return;
        if (reply?.ok === false || reply?.state === "unavailable") throw new Error(reply.reason || "Шлюз не подтвердил сохранение.");
        this.status.set_label(reply.restart_required ? "Сохранено. Применится после перезапуска шлюза." : "Изменение сохранено.");
        chrome(this.status, "label", reply.restart_required ? "Saved. Takes effect after restarting the gateway." : "Change saved.");
      }
    } catch (error) {
      refresh = !unsaved(error);
      if (current()) this.status.set_label(settingsFailure(error));
    } finally {
      if (refresh && current()) {
        try { await this.read(); }
        catch (error) { if (current()) this.status.set_label(this.status.get_label() + "\n" + errorText(error)); }
        if (current()) this.changed();
      }
      if (current()) {
        this.busy = false;
        this.body.set_sensitive(this.readReady);
      }
    }
  }
}
