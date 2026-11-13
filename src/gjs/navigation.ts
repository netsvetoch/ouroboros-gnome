import { Adw, Gio, Gtk } from "./gi.js";
import type { Gateway } from "./gateway.js";
import { button, column, errorText, label, row } from "./ui.js";
import { chrome } from "./native-i18n.js";

interface Preferences { ok?: boolean; sidebar_width?: number }

/** Native navigation and its gateway-owned width; never mounts the gateway SPA. */
export class Navigation {
  readonly widget: any;
  private readonly split: any;
  private readonly breakpoint: any;
  private readonly cancel = new Gio.Cancellable();
  private readonly width = new Gtk.SpinButton({ adjustment: new Gtk.Adjustment({ lower: 0, upper: 560,
    step_increment: 10, page_increment: 40 }), numeric: true });
  private readonly feedback = label("");
  private readonly save: any;
  private readonly reset: any;
  private readonly reload: any;
  private busy = false;
  private ready = false;
  private closed = false;

  constructor(private readonly gateway: Gateway, stack: any, content: any,
    private readonly readingBlocked: (blocked: boolean) => void) {
    const sidebar = column();
    const switcher = new Adw.ViewSwitcherSidebar({ stack, vexpand: true });
    sidebar.append(switcher);
    const settings = column();
    for (const edge of ["top", "bottom", "start", "end"]) settings[`set_margin_${edge}`](12);
    settings.append(chrome(label("Ширина навигации"), "label", "Navigation width"));
    settings.append(this.width);
    settings.append(chrome(label("0 — стандартная ширина; 180–560 пикселей.", "dim-label"), "label", "0 uses the default width; 180–560 pixels."));
    this.save = button("Сохранить", () => void this.write(this.width.get_value_as_int()));
    this.reset = button("По умолчанию", () => void this.write(0));
    this.reload = button("Перечитать", () => this.refresh());
    chrome(this.save, "label", "Save");
    chrome(this.reset, "label", "Reset to default");
    chrome(this.reload, "label", "Check status");
    const actions = row();
    for (const action of [this.save, this.reset, this.reload]) actions.append(action);
    settings.append(actions);
    settings.append(this.feedback);
    const menu = new Gtk.MenuButton({ label: "Ширина панели", popover: new Gtk.Popover({ child: settings }) });
    chrome(menu, "label", "Panel width");
    sidebar.append(menu);
    this.split = new Adw.OverlaySplitView({ sidebar, content, sidebar_width_unit: Adw.LengthUnit.PX,
      min_sidebar_width: 280, max_sidebar_width: 280, show_sidebar: true });
    this.widget = new Adw.BreakpointBin({ child: this.split, width_request: 800, height_request: 480, vexpand: true });
    this.breakpoint = new Adw.Breakpoint({ condition: Adw.BreakpointCondition.parse("max-width: 1040px") });
    this.breakpoint.add_setter(this.split, "collapsed", true);
    this.breakpoint.add_setter(this.split, "show-sidebar", false);
    this.widget.add_breakpoint(this.breakpoint);
    const visibility = () => {
      if (!this.closed) this.readingBlocked(this.split.get_collapsed()
        && (this.split.get_show_sidebar() || sidebar.get_mapped()));
    };
    this.split.connect("notify::collapsed", visibility);
    this.split.connect("notify::show-sidebar", visibility);
    sidebar.connect("map", visibility);
    sidebar.connect("unmap", visibility);
    switcher.connect("activated", () => { if (this.split.get_collapsed()) this.split.set_show_sidebar(false); });
    this.sync();
    this.refresh();
  }

  toggle(): void { if (!this.closed) this.split.set_show_sidebar(!this.split.get_show_sidebar()); }

  refresh(): void {
    if (this.closed || this.busy) return;
    this.busy = true;
    this.sync();
    void this.gateway.json<Preferences>("GET", "/api/ui/preferences", undefined, undefined, false, this.cancel)
      .then((saved) => {
        if (this.closed) return;
        this.apply(saved);
        this.feedback.set_label("");
      }).catch((error) => {
        if (!this.closed) { this.ready = false; this.feedback.set_label(errorText(error)); }
      }).finally(() => { this.busy = false; if (!this.closed) this.sync(); });
  }

  close(): void {
    this.closed = true;
    this.cancel.cancel();
  }

  private sync(): void {
    for (const control of [this.width, this.save, this.reset]) control.set_sensitive(this.ready && !this.busy);
    this.reload.set_sensitive(!this.busy);
  }

  private apply(saved: Preferences): void {
    const value = saved?.sidebar_width;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
      || (value !== 0 && (value < 180 || value > 560))) {
      throw new Error("Шлюз не вернул корректную ширину навигации.");
    }
    const width = value || 280;
    this.split.set_max_sidebar_width(560);
    this.split.set_min_sidebar_width(width);
    this.split.set_max_sidebar_width(width);
    this.breakpoint.set_condition(Adw.BreakpointCondition.parse(`max-width: ${width + 760}px`));
    this.width.set_value(value);
    this.ready = true;
  }

  private async write(width: number): Promise<void> {
    if (this.closed || this.busy || !this.ready) return;
    this.busy = true;
    this.sync();
    this.feedback.set_label("Сохраняю…");
    chrome(this.feedback, "label", "Saving…");
    try {
      const saved = await this.gateway.json<Preferences>("POST", "/api/ui/preferences", { sidebar_width: width },
        undefined, false, this.cancel);
      if (this.closed) return;
      if (saved?.ok !== true) throw new Error("Шлюз не подтвердил сохранение ширины.");
      this.apply(saved);
      this.feedback.set_label("Сохранено.");
      chrome(this.feedback, "label", "Saved.");
    } catch (error) {
      if (!this.closed) {
        this.ready = false;
        this.feedback.set_label(`Результат записи не подтверждён. Перечитайте настройку. ${errorText(error)}`);
      }
    } finally {
      this.busy = false;
      if (!this.closed) this.sync();
    }
  }
}
