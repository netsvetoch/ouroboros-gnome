import { Adw, Gio, Gtk, Pango } from "./gi.js";
import type { Gateway } from "./gateway.js";
import type { ChatPage, Room } from "./chat.js";
import { button, column, errorText, label, row } from "./ui.js";
import { chrome } from "./native-i18n.js";

interface Preferences { ok?: boolean; project_panel_width?: number }

/** A persistent project chat in a native dialog; Main keeps its own view and draft. */
export class ProjectPanel {
  readonly dialog = new Adw.Dialog({ title: "Проект", content_width: 440, content_height: 720 });
  private readonly toolbar = new Adw.ToolbarView();
  private readonly title = new Gtk.Label({ wrap: true, ellipsize: Pango.EllipsizeMode.END, max_width_chars: 18 });
  private readonly cancel = new Gio.Cancellable();
  private readonly width = new Gtk.SpinButton({ adjustment: new Gtk.Adjustment({ lower: 0, upper: 1100,
    step_increment: 20, page_increment: 100 }), numeric: true });
  private readonly feedback = label("");
  private readonly save: any;
  private readonly reset: any;
  private readonly reload: any;
  private page?: ChatPage;
  private busy = false;
  private ready = false;
  private disposed = false;
  private draining?: Promise<void>;
  active = false;

  constructor(private readonly parent: any, private readonly gateway: Gateway,
    private readonly create: (room: Room) => ChatPage, private readonly dismissed: () => void) {
    const header = new Adw.HeaderBar({ title_widget: this.title });
    const refresh = new Gtk.Button({ icon_name: "view-refresh-symbolic", tooltip_text: "Обновить проект" });
    chrome(refresh, "tooltip-text", "Refresh project");
    refresh.connect("clicked", () => { this.page?.refresh(); this.refresh(); });
    header.pack_end(refresh);
    const form = column();
    for (const edge of ["top", "bottom", "start", "end"]) form[`set_margin_${edge}`](12);
    form.append(chrome(label("Ширина панели проекта"), "label", "Project panel width"));
    form.append(this.width);
    form.append(chrome(label("0 — стандартная ширина; 320–1100 пикселей.", "dim-label"), "label", "0 uses the default width; 320–1100 pixels."));
    this.save = button("Сохранить", () => void this.write(this.width.get_value_as_int()));
    this.reset = button("По умолчанию", () => void this.write(0));
    this.reload = button("Перечитать", () => this.refresh());
    chrome(this.save, "label", "Save");
    chrome(this.reset, "label", "Reset to default");
    chrome(this.reload, "label", "Check status");
    const actions = row();
    for (const action of [this.save, this.reset, this.reload]) actions.append(action);
    form.append(actions);
    form.append(this.feedback);
    header.pack_end(chrome(new Gtk.MenuButton({ icon_name: "view-more-symbolic", tooltip_text: "Ширина панели проекта",
      popover: new Gtk.Popover({ child: form }) }), "tooltip-text", "Project panel width"));
    this.toolbar.add_top_bar(header);
    this.dialog.set_child(this.toolbar);
    this.dialog.connect("closed", () => {
      this.active = false;
      if (!this.disposed) this.dismissed();
    });
    this.sync();
    this.refresh();
  }

  get chat(): ChatPage | undefined { return this.page; }

  open(room: Room): ChatPage {
    if (this.disposed || !room.projectId || room.chatId <= 1) throw new Error("Не подтверждена комната проекта.");
    if (!this.page) {
      this.page = this.create(room);
      this.toolbar.set_content(this.page.widget);
    } else this.page.setRoom(room);
    this.title.set_label(room.name);
    this.dialog.set_title(room.name);
    this.active = true;
    this.dialog.present(this.parent);
    return this.page;
  }

  hide(): void {
    this.active = false;
    this.page?.leaveQuestions();
    this.dialog.close();
  }

  refresh(): void {
    if (this.disposed || this.busy) return;
    this.busy = true;
    this.sync();
    void this.gateway.json<Preferences>("GET", "/api/ui/preferences", undefined, undefined, false, this.cancel)
      .then((saved) => {
        if (!this.disposed) { this.apply(saved); this.feedback.set_label(""); }
      }).catch((error) => {
        if (!this.disposed) { this.ready = false; this.feedback.set_label(errorText(error)); }
      }).finally(() => { this.busy = false; if (!this.disposed) this.sync(); });
  }

  close(): Promise<void> | undefined {
    if (this.disposed) return this.draining;
    this.disposed = true;
    this.active = false;
    this.cancel.cancel();
    this.dialog.force_close();
    this.draining = this.page?.close();
    return this.draining;
  }

  private sync(): void {
    for (const control of [this.width, this.save, this.reset]) control.set_sensitive(this.ready && !this.busy);
    this.reload.set_sensitive(!this.busy);
  }

  private apply(saved: Preferences): void {
    const value = saved?.project_panel_width;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
      || (value !== 0 && (value < 320 || value > 1100))) throw new Error("Шлюз не вернул корректную ширину проекта.");
    this.width.set_value(value);
    this.dialog.set_content_width(value || 440);
    this.ready = true;
  }

  private async write(width: number): Promise<void> {
    if (this.disposed || this.busy || !this.ready) return;
    this.busy = true;
    this.sync();
    this.feedback.set_label("Сохраняю…");
    chrome(this.feedback, "label", "Saving…");
    try {
      const saved = await this.gateway.json<Preferences>("POST", "/api/ui/preferences", { project_panel_width: width },
        undefined, false, this.cancel);
      if (this.disposed) return;
      if (saved?.ok !== true) throw new Error("Шлюз не подтвердил сохранение ширины.");
      this.apply(saved);
      this.feedback.set_label("Сохранено.");
      chrome(this.feedback, "label", "Saved.");
    } catch (error) {
      if (!this.disposed) {
        this.ready = false;
        this.feedback.set_label(`Результат записи не подтверждён. Перечитайте настройку. ${errorText(error)}`);
      }
    } finally {
      this.busy = false;
      if (!this.disposed) this.sync();
    }
  }
}
