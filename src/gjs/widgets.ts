import { type Gateway, type GatewayFrame } from "./gateway.js";
import { Gio, GLib, Gtk } from "./gi.js";
import { type SettingsDocument } from "./settings-write.js";
import { button, clear, column, confirm, errorText, label, row } from "./ui.js";
import { readWidgets, type WidgetTab, widgetKey } from "./widget-contract.js";
import { readWidgetPreferences, type WidgetPreferences as Preferences } from "./widget-preferences.js";
import { WidgetView } from "./widget-view.js";

const preferencesPath = "/api/ui/preferences";

interface BoardItem {
  tab: WidgetTab;
  signature: string;
  widget: any;
  view?: WidgetView;
}

function orderTabs(tabs: WidgetTab[], order: string[]): WidgetTab[] {
  const positions = new Map(order.map((key, index) => [key, index]));
  return [...tabs].sort((a, b) => (positions.get(widgetKey(a)) ?? Infinity) - (positions.get(widgetKey(b)) ?? Infinity));
}

export class WidgetsPage {
  readonly widget = column();
  private readonly grid = new Gtk.Grid({ column_homogeneous: true, column_spacing: 10, row_spacing: 10 });
  private readonly viewport = new Gtk.Viewport();
  private readonly status = label("", "dim-label");
  private readonly reload = button("Перечитать виджеты", () => void this.refresh());
  private readonly items = new Map<string, BoardItem>();
  private tabs: WidgetTab[] = [];
  private preferences?: Preferences;
  private arrangement = "";
  private columns = 1;
  private resize = 0;
  private read = 0;
  private active = false;
  private reading = false;
  private readCancel?: any;
  private readonly writes = new Set<any>();
  private refreshPending = false;
  private writing = false;
  private disposed = false;
  private focusSkillName = "";
  private focusTick = 0;

  constructor(private readonly parent: any, private readonly gateway: Gateway, private readonly openPinned: (tab: WidgetTab) => void) {
    const content = column(0);
    const sizing = new Gtk.DrawingArea({ content_height: 1, hexpand: true });
    sizing.connect("resize", (_widget: unknown, width: number) => {
      const next = Math.max(1, Math.min(4, Math.floor(width / 310)));
      if (this.resize) GLib.Source.remove(this.resize);
      this.resize = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        this.resize = 0;
        if (!this.disposed && this.columns !== next) { this.columns = next; this.layout(); }
        return GLib.SOURCE_REMOVE;
      });
    });
    content.append(sizing);
    content.append(this.grid);
    this.widget.append(this.reload);
    this.widget.append(this.status);
    this.viewport.set_child(content);
    this.widget.append(new Gtk.ScrolledWindow({ child: this.viewport, vexpand: true, hscrollbar_policy: Gtk.PolicyType.NEVER }));
  }

  setActive(active: boolean): void {
    if (this.disposed) return;
    this.active = active;
    if (!active) this.clearFocus();
    for (const item of this.items.values()) item.view?.setActive(active);
    if (active) void this.refresh();
  }

  close(): void {
    this.disposed = true;
    this.read++;
    this.readCancel?.cancel();
    for (const cancel of this.writes) cancel.cancel();
    this.writes.clear();
    this.clearFocus();
    if (this.resize) GLib.Source.remove(this.resize);
    for (const item of this.items.values()) item.view?.close();
    this.items.clear();
  }

  focusSkill(skill: string): void {
    this.clearFocus();
    this.focusSkillName = skill;
    if (!this.scheduleFocus() && this.active && !this.reading && !this.writing) void this.refresh();
  }

  private clearFocus(): void {
    if (this.focusTick) this.viewport.remove_tick_callback(this.focusTick);
    this.focusTick = 0;
    this.focusSkillName = "";
  }

  private scheduleFocus(): boolean {
    if (!this.focusSkillName || !this.active) return false;
    if (this.focusTick) return true;
    const tab = orderTabs(this.tabs, this.preferences?.widget_order ?? []).find(({ skill }) => skill === this.focusSkillName);
    const frame = tab ? this.items.get(widgetKey(tab))?.widget : undefined;
    if (!frame) return false;
    let frames = 0;
    this.focusTick = this.viewport.add_tick_callback(() => {
      // The board's responsive grid can be reattached on the first frame.
      if (++frames <= 8 && (!frame.get_mapped() || !frame.get_width() || !frame.get_height() || this.resize)) {
        return GLib.SOURCE_CONTINUE;
      }
      this.focusTick = 0;
      this.focusSkillName = "";
      if (frame.get_mapped() && frame.get_height()) {
        frame.grab_focus();
        this.viewport.scroll_to(frame, null);
      }
      return GLib.SOURCE_REMOVE;
    });
    return true;
  }

  frame(frame: GatewayFrame): void {
    if (frame.type === "extension_lifecycle") {
      if (this.active || this.items.size) void this.refresh();
    }
    for (const item of this.items.values()) item.view?.frame(frame);
  }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    if (this.writing || this.reading) { this.refreshPending = true; return; }
    const version = ++this.read;
    const cancel = new Gio.Cancellable();
    this.readCancel = cancel;
    this.reading = true;
    this.reload.set_sensitive(false);
    this.status.set_label("Читаю виджеты…");
    try {
      const [tabs, preferences] = await Promise.all([
        readWidgets(this.gateway, cancel, true),
        this.gateway.json("GET", preferencesPath, undefined, undefined, false, cancel).then(value => readWidgetPreferences(value)).catch(() => undefined),
      ]);
      if (this.disposed || version !== this.read) return;
      this.tabs = tabs;
      if (preferences) this.preferences = preferences;
      this.reconcile();
      this.status.set_label(tabs.length ? preferences ? "" : "Порядок и размеры виджетов сейчас недоступны." : "Доступных виджетов пока нет.");
      if (this.focusSkillName && !this.scheduleFocus()) {
        this.status.set_label(`На доске нет виджетов навыка ${this.focusSkillName}.`);
        this.clearFocus();
      }
    } catch (error) {
      if (!this.disposed && version === this.read) this.status.set_label(errorText(error));
    } finally {
      if (this.readCancel === cancel) this.readCancel = undefined;
      this.reading = false;
      if (!this.disposed) {
        this.reload.set_sensitive(!this.writing);
        this.followUp();
      }
    }
  }

  private followUp(): void {
    if (this.refreshPending && !this.reading && !this.writing) {
      this.refreshPending = false;
      void this.refresh();
    }
  }

  private reconcile(): void {
    const valid = new Set(this.tabs.map(widgetKey));
    for (const [key, item] of this.items) if (!valid.has(key)) this.remove(key, item);
    for (const tab of this.tabs) {
      const key = widgetKey(tab);
      const previous = this.items.get(key);
      const signature = JSON.stringify([tab.title, tab.render, tab.revision, tab.ws_prefix, tab.pinned_card,
        tab.render.entry_type === "module" ? tab.generation : undefined]);
      if (previous?.signature === signature) {
        previous.tab = tab;
        previous.view?.updateTab(tab);
        previous.view?.setLaunchMode(this.preferences?.widget_start_mode?.[key]);
        continue;
      }
      if (previous) this.remove(key, previous);
      this.items.set(key, this.create(tab, signature));
    }
    this.layout();
  }

  private remove(key: string, item: BoardItem): void {
    item.view?.close();
    if (item.widget.get_parent() === this.grid) this.grid.remove(item.widget);
    this.items.delete(key);
    this.arrangement = "";
  }

  private layout(): void {
    const tabs = orderTabs(this.tabs, this.preferences?.widget_order ?? []);
    const widths = tabs.map((tab) => {
      const preferred = this.preferences?.widget_size?.[widgetKey(tab)]?.w;
      const span = Number(preferred || tab.span || tab.grid_span || 1);
      return Math.min(this.columns, Math.max(1, Math.trunc(span) || 1));
    });
    const layout = JSON.stringify([this.columns, tabs.map(widgetKey), widths]);
    if (layout === this.arrangement) return;
    this.arrangement = layout;
    clear(this.grid);
    let x = 0;
    let y = 0;
    for (const [index, tab] of tabs.entries()) {
      const item = this.items.get(widgetKey(tab));
      if (!item) continue;
      const width = widths[index];
      if (x + width > this.columns) { x = 0; y++; }
      this.grid.attach(item.widget, x, y, width, 1);
      x += width;
    }
  }

  private create(tab: WidgetTab, signature: string): BoardItem {
    const content = column();
    content.set_margin_top(10);
    content.set_margin_bottom(10);
    content.set_margin_start(10);
    content.set_margin_end(10);
    const heading = row();
    const title = label(tab.title || tab.tab_id, "title-4");
    title.set_hexpand(true);
    heading.append(title);
    const options = new Gtk.MenuButton({ icon_name: "view-more-symbolic", tooltip_text: "Настройки виджета" });
    const menu = new Gtk.Popover();
    const actions = column(4);
    actions.set_margin_top(6);
    actions.set_margin_bottom(6);
    actions.set_margin_start(6);
    actions.set_margin_end(6);
    menu.set_child(actions);
    options.set_popover(menu);
    heading.append(options);
    content.append(heading);
    content.append(label(tab.pinned_card ? "Закреплённая карточка" : tab.skill, "dim-label"));
    const frame = new Gtk.Frame({ child: content, hexpand: true, valign: Gtk.Align.START, focusable: true });
    const item: BoardItem = { tab, signature, widget: frame };
    if (tab.pinned_card) {
      content.append(button("Открыть снимок…", () => { if (!this.disposed && this.items.get(widgetKey(item.tab)) === item) this.openPinned(item.tab); }));
    } else {
      item.view = new WidgetView(this.gateway, tab, {}, { mode: this.preferences?.widget_start_mode?.[widgetKey(tab)] });
      content.append(item.view.widget);
      item.view.setActive(this.active);
    }
    const add = (title: string, run: () => void) => actions.append(button(title, () => {
      if (this.disposed || this.items.get(widgetKey(item.tab)) !== item) return;
      menu.popdown(); run();
    }));
    add("Раньше в списке", () => void this.move(tab, -1));
    add("Позже в списке", () => void this.move(tab, 1));
    for (const [width, caption] of [[null, "Ширина по умолчанию"], [1, "Одна колонка"], [2, "Две колонки"],
      [3, "Три колонки"], [12, "На всю ширину"]] as const) {
      add(caption, () => void this.savePreferences(() => ({ widget_size: { [widgetKey(tab)]: width ? { w: width, h: 0 } : null } })));
    }
    if (tab.pinned_card) add("Открепить…", () => void this.unpin(item.tab));
    if (tab.render.kind === "module" || tab.render.kind === "iframe") {
      for (const [mode, caption] of [["auto", "Запускать автоматически"], ["manual", "Запускать вручную"],
        ["retain", "Оставлять работающим"], ["", "Режим запуска по умолчанию"]]) {
        add(caption, () => void this.savePreferences((latest) => {
          const modes = { ...latest.widget_start_mode };
          if (mode) modes[widgetKey(tab)] = mode;
          else delete modes[widgetKey(tab)];
          return { widget_start_mode: modes };
        }));
      }
    }
    return item;
  }

  private async move(tab: WidgetTab, direction: -1 | 1): Promise<void> {
    await this.savePreferences((latest) => {
      const order = latest.widget_order ?? [];
      const visible = orderTabs(this.tabs, order).map(widgetKey);
      const index = visible.indexOf(widgetKey(tab));
      const target = index + direction;
      if (index < 0 || target < 0 || target >= visible.length) return;
      [visible[index], visible[target]] = [visible[target], visible[index]];
      const live = new Set(visible);
      let next = 0;
      const merged = order.map((key) => live.has(key) ? visible[next++] : key);
      return { widget_order: [...merged, ...visible.slice(next)] };
    });
  }

  private async savePreferences(patch: (latest: Preferences) => SettingsDocument | undefined): Promise<void> {
    if (this.disposed || this.writing) return;
    this.writing = true;
    if (this.reading) this.refreshPending = true;
    this.read++;
    this.readCancel?.cancel();
    const cancel = new Gio.Cancellable();
    this.writes.add(cancel);
    let attempted = false;
    this.reload.set_sensitive(false);
    try {
      const latest = readWidgetPreferences(await this.gateway.json("GET", preferencesPath, undefined, undefined, false, cancel));
      if (this.disposed) return;
      const changes = patch(latest);
      attempted = Boolean(changes);
      const result = changes ? readWidgetPreferences(await this.gateway.json("POST", preferencesPath, changes, undefined, false, cancel), true) : latest;
      if (this.disposed) return;
      this.preferences = result;
      this.reconcile();
      this.status.set_label(changes ? "Настройки виджетов сохранены." : "");
    } catch (error) {
      if (!this.disposed) this.status.set_label(attempted ? `Результат записи настроек неизвестен. ${errorText(error)}` : errorText(error));
    } finally {
      this.writes.delete(cancel);
      this.writing = false;
      if (!this.disposed) {
        this.reload.set_sensitive(!this.reading);
        this.followUp();
      }
    }
  }

  private async unpin(tab: WidgetTab): Promise<void> {
    if (!await confirm(this.parent, "Открепить карточку?", "Снимок исчезнет с доски виджетов.", "Открепить") || this.disposed) return;
    try {
      const reply = await this.gateway.json<{ ok?: boolean; pinned?: boolean }>("DELETE",
        "/api/cards/" + encodeURIComponent(tab.tab_id) + "/pin");
      if (reply?.ok !== true || reply.pinned !== false) throw new Error("Шлюз не подтвердил открепление карточки.");
      if (!this.disposed) void this.refresh();
    } catch (error) {
      if (!this.disposed) this.status.set_label(errorText(error));
    }
  }
}
