import { ContributionChips } from "./contribution-chips.js";
import { type Gateway } from "./gateway.js";
import { Adw, Gdk, Gio, Gtk, svgRenderer } from "./gi.js";
import { contributionRoute, type ContributionArrangement, type PlacedContribution, type Placement, type UiContributions } from "./ui-contributions.js";
import { button, clear, column, errorText, label, row, sheet } from "./ui.js";

export interface ActionDraft {
  room: number;
  text: string;
  insert(text: string): boolean;
  clear(): void;
}

export interface ActionMessage { address: string; text: string }

const placements: [Placement, string][] = [
  ["composer.plus", "Меню поля ввода"], ["composer.chips", "Индикаторы навыков"], ["message.action", "Действия над ответами"],
];
const glyphs: Record<string, string> = {
  sparkle: "starred-symbolic", mic: "audio-input-microphone-symbolic", volume: "audio-volume-high-symbolic",
  list: "view-list-symbolic", plus: "list-add-symbolic", template: "text-x-generic-symbolic",
  gauge: "utilities-system-monitor-symbolic", check: "object-select-symbolic", book: "help-contents-symbolic",
  chat: "mail-message-new-symbolic", projects: "folder-symbolic", files: "folder-open-symbolic",
  skills: "application-x-addon-symbolic", widgets: "view-grid-symbolic", dashboard: "view-grid-symbolic",
  settings: "emblem-system-symbolic", "message-circle": "mail-message-new-symbolic", hash: "insert-text-symbolic",
  mail: "mail-unread-symbolic", network: "network-wired-symbolic", inbox: "mail-inbox-symbolic",
  plug: "network-wired-symbolic", globe: "web-browser-symbolic", bot: "avatar-default-symbolic", webhook: "insert-link-symbolic",
};
const geometry = /<\/?(?:svg|g|path|circle|ellipse|line|polyline|polygon|rect)(?:\s+(?:viewBox|xmlns|width|height|fill|stroke|stroke-width|stroke-linecap|stroke-linejoin|fill-rule|clip-rule|transform|d|cx|cy|r|rx|ry|x1|y1|x2|y2|points|x|y)="[^"<>&]*")*\s*\/?>/gu;
const icons = new WeakMap<PlacedContribution, { dark: boolean; texture: any }>();

function svgIcon(item: PlacedContribution, svg: string): any {
  const dark = Boolean(Adw.StyleManager.get_default().get_dark());
  const cached = icons.get(item);
  if (cached && cached.dark === dark) return cached.texture;
  let texture = null;
  if (new TextEncoder().encode(svg).length <= 8192 && svg.startsWith("<svg")
    && !svg.replace(geometry, "").trim() && !/url\s*\(/iu.test(svg)) {
    try {
      const source = svg.replace(/^<svg([^>]*)>/u, (_tag, attributes: string) =>
        `<svg${attributes.replace(/\s+(?:width|height)="[^"]*"/gu, "")} width="16" height="16">`)
        .replaceAll("currentColor", dark ? "#ffffff" : "#242424");
      const handle = svgRenderer().Handle.new_from_data(new TextEncoder().encode(source));
      texture = Gdk.Texture.new_for_pixbuf(handle.get_pixbuf_and_error());
    } catch { /* use the standard symbol if the geometry cannot be rendered */ }
  }
  icons.set(item, { dark, texture });
  return texture;
}

function actionIcon(item: PlacedContribution): any {
  const spec = item.icon_spec;
  if (spec?.kind === "svg" && spec.svg) {
    const texture = svgIcon(item, spec.svg);
    if (texture) return Gtk.Image.new_from_paintable(texture);
  }
  const name = (spec?.kind === "host" ? spec.name : item.icon) ?? "";
  return new Gtk.Image({ icon_name: glyphs[name] || "application-x-addon-symbolic" });
}

function menuList(menu: any): { popover: any; list: any } {
  const popover = new Gtk.Popover();
  const list = column(4);
  popover.set_child(new Gtk.ScrolledWindow({ child: list, max_content_height: 390,
    propagate_natural_height: true, hscrollbar_policy: Gtk.PolicyType.NEVER }));
  menu.set_popover(popover);
  return { popover, list };
}

function oneLine(value: string, limit: number): string {
  return Array.from(value.trim().replace(/\s+/gu, " ")).slice(0, limit).join("");
}

interface MessageControls { message: ActionMessage; box: any; icons: any; menu: any; popover: any }
interface ArrangementDialog { dialog: any; list: any; status: any; writing: boolean; generation: number; cancel?: any }

export class ContributionActions {
  readonly plus = new Gtk.MenuButton({ icon_name: "list-add-symbolic", tooltip_text: "Действия поля ввода", focus_on_click: false });
  readonly status = label("", "dim-label");
  readonly chips: ContributionChips;
  private readonly plusMenu = menuList(this.plus);
  private readonly plusItems = column(4);
  private readonly pending = new Map<string, any>();
  private messageRows: MessageControls[] = [];
  private messageItems: PlacedContribution[] = [];
  private messageSignature = "";
  private plusSignature = "";
  private arrangement?: ArrangementDialog;
  private closed = false;

  constructor(private readonly parent: any, private readonly gateway: Gateway, private readonly store: UiContributions,
    private readonly draft: () => ActionDraft, attach: any, private readonly openWidgets?: (skill: string) => void) {
    this.chips = new ContributionChips(gateway, (item) => void this.run(item));
    this.status.set_visible(false);
    attach.connect("clicked", () => this.plusMenu.popover.popdown());
    this.plusMenu.list.append(attach);
    this.plusMenu.list.append(this.plusItems);
    this.plusMenu.list.append(button("Элементы навыков…", () => {
      this.plusMenu.popover.popdown();
      this.showArrangement();
    }));
  }

  updated(): void {
    const plus = this.store.placed("composer.plus");
    const signature = JSON.stringify(plus);
    if (this.plusSignature !== signature) {
      this.plusSignature = signature;
      clear(this.plusItems);
      let skill = "";
      for (const item of plus) {
        if (skill !== item.skill) this.plusItems.append(label(item.skill_label || item.skill, "heading"));
        this.plusItems.append(this.menuAction(item, this.plusMenu.popover));
        skill = item.skill;
      }
    }
    this.chips.sync(this.store.placed("composer.chips"));
    const actions = this.store.placed("message.action");
    const messages = JSON.stringify(actions);
    if (messages !== this.messageSignature) {
      this.messageSignature = messages;
      this.messageItems = actions;
      for (const controls of this.messageRows) this.paintMessage(controls);
    }
    const settings = this.arrangement;
    if (settings && !settings.writing) this.renderArrangement(settings);
  }

  resetRows(): void { this.messageRows = []; }

  resetStatus(): void { this.status.set_visible(false); }

  message(message: ActionMessage): any {
    const box = row(4);
    const icons = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, min_children_per_line: 1,
      max_children_per_line: 10, column_spacing: 2, row_spacing: 2, halign: Gtk.Align.START });
    const menu = new Gtk.MenuButton({ icon_name: "view-more-symbolic", tooltip_text: "Действия навыков над ответом",
      valign: Gtk.Align.START, focus_on_click: false });
    const { popover, list } = menuList(menu);
    box.append(icons);
    box.append(menu);
    const controls = { message, box, icons, menu: list, popover };
    this.messageRows.push(controls);
    this.paintMessage(controls);
    return box;
  }

  close(): void {
    this.closed = true;
    this.chips.close();
    this.resetRows();
    for (const cancel of this.pending.values()) cancel.cancel();
    this.pending.clear();
    this.arrangement?.dialog.force_close();
  }

  private menuAction(item: PlacedContribution, popover: any, message?: ActionMessage): any {
    const content = row(6);
    content.append(actionIcon(item));
    content.append(label(item.label));
    const control = new Gtk.Button({ child: content, focus_on_click: false });
    control.update_property([Gtk.AccessibleProperty.LABEL], [item.label]);
    control.set_tooltip_text(item.title || null);
    control.connect("clicked", () => {
      popover.popdown();
      void this.run(item, message);
    });
    return control;
  }

  private paintMessage({ message, box, icons, menu, popover }: MessageControls): void {
    clear(icons);
    clear(menu);
    box.set_visible(this.messageItems.length > 0);
    for (const item of this.messageItems) {
      const shortcut = new Gtk.Button({ child: actionIcon(item), tooltip_text: item.title || item.label, focus_on_click: false });
      shortcut.add_css_class("flat");
      shortcut.update_property([Gtk.AccessibleProperty.LABEL], [item.label]);
      shortcut.connect("clicked", () => void this.run(item, message));
      icons.append(shortcut);
      menu.append(this.menuAction(item, popover, message));
    }
  }

  private async run(item: PlacedContribution, message?: ActionMessage): Promise<void> {
    if (this.closed || !this.store.current.contributions?.some(current => current.key === item.key && JSON.stringify(current) === JSON.stringify(item))) return;
    const draft = this.draft();
    const say = (text: string, failure = false) => {
      if (this.closed || this.draft().room !== draft.room) return;
      this.status.set_label(oneLine(text, 300));
      this.status.set_css_classes(failure ? ["error"] : ["dim-label"]);
      this.status.set_visible(true);
    };
    if (this.store.error) { say(this.store.error, true); return; }
    const action = item.action;
    try {
      switch (action?.verb) {
        case "draft.insert":
          if (!draft.insert(action.text ?? "")) say("Черновик сейчас нельзя изменить.", true);
          return;
        case "notice":
          say(action.text ?? "");
          return;
        case "open.tab":
          if (!this.openWidgets) throw new Error("Доска виджетов недоступна.");
          this.openWidgets(item.skill);
          return;
        case "skill.request": {
          const path = contributionRoute(item.skill, action.url || item.route_url);
          if (!path) throw new Error("Шлюз не сообщил маршрут действия навыка.");
          const key = JSON.stringify([item.key, draft.room, message?.address]);
          if (this.pending.has(key)) return;
          const payload = action.with === "draft" ? { text: draft.text }
            : action.with === "message" ? { text: message?.text ?? "", row_id: message?.address ?? "" } : {};
          const cancel = new Gio.Cancellable();
          this.pending.set(key, cancel);
          try {
            const reply = await this.gateway.optionalJson("POST", path, payload, cancel) as { notice?: unknown } | null;
            if (this.closed) return;
            if (action.with === "draft" && action.then === "clear_draft") draft.clear();
            say(typeof reply?.notice === "string" && reply.notice.trim() ? reply.notice : `${item.label} · Готово`);
          } finally { this.pending.delete(key); }
          return;
        }
        default:
          throw new Error("Клиент не распознаёт действие навыка.");
      }
    } catch (error) {
      say(`${item.label} · ${oneLine(errorText(error), 200)}`, true);
    }
  }

  private showArrangement(): void {
    if (this.closed || this.arrangement) return;
    const content = column();
    const dialog = sheet("Элементы навыков", content);
    const settings = { dialog, list: column(6), status: label("Читаю настройки…", "dim-label"), writing: false, generation: 0, cancel: undefined as any };
    this.arrangement = settings;
    content.append(settings.status);
    content.append(settings.list);
    dialog.connect("closed", () => { settings.cancel?.cancel(); if (this.arrangement === settings) this.arrangement = undefined; });
    dialog.present(this.parent);
    void this.store.refresh();
  }

  private renderArrangement(settings: ArrangementDialog): void {
    const generation = ++settings.generation;
    clear(settings.list);
    settings.status.set_label(this.store.error);
    const hidden = new Set(this.store.current.preferences?.contributions?.hidden ?? []);
    let hasItems = false;
    for (const [placement, heading] of placements) {
      const items = this.store.placed(placement, true);
      if (!items.length) continue;
      hasItems = true;
      settings.list.append(label(heading, "heading"));
      for (const [index, item] of items.entries()) {
        const line = row(4);
        const shown = new Gtk.CheckButton({ label: `${item.label} · ${item.skill_label || item.skill}`, active: !hidden.has(item.key),
          hexpand: true });
        shown.connect("toggled", () => {
          if (generation !== settings.generation) return;
          const visible = shown.get_active();
          void this.write(settings, (latest) => {
            const keys = new Set(latest.hidden ?? []);
            if (visible) keys.delete(item.key); else keys.add(item.key);
            return { hidden: [...keys] };
          });
        });
        line.append(shown);
        for (const [direction, icon, name] of [[-1, "go-up-symbolic", "Раньше в списке"], [1, "go-down-symbolic", "Позже в списке"]] as const) {
          const move = new Gtk.Button({ icon_name: icon, tooltip_text: name, sensitive: index + direction >= 0 && index + direction < items.length });
          move.update_property([Gtk.AccessibleProperty.LABEL], [`${name} · ${item.label}`]);
          move.connect("clicked", () => { if (generation === settings.generation) void this.write(settings, (latest) => this.move(item, direction, latest)); });
          line.append(move);
        }
        settings.list.append(line);
      }
    }
    if (!hasItems) settings.list.append(label("Навыки пока не добавили элементов в чат.", "dim-label"));
  }

  private move(item: PlacedContribution, direction: -1 | 1, latest: ContributionArrangement): ContributionArrangement | undefined {
    const keys = this.store.placed(item.placement, true, latest).map(({ key }) => key);
    const index = keys.indexOf(item.key);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= keys.length) return undefined;
    [keys[index], keys[target]] = [keys[target], keys[index]];
    const order = latest.order ?? [];
    const ranked = new Set(order);
    let end = Math.max(index, target);
    for (const [position, key] of keys.entries()) if (ranked.has(key)) end = Math.max(end, position);
    const thisPlacement = new Set(keys);
    return { order: [...order.filter((key) => !thisPlacement.has(key)), ...keys.slice(0, end + 1)] };
  }

  private async write(settings: ArrangementDialog, change: (latest: ContributionArrangement) => ContributionArrangement | undefined): Promise<void> {
    if (this.closed || this.arrangement !== settings || settings.writing) return;
    settings.writing = true;
    settings.cancel = new Gio.Cancellable();
    settings.list.set_sensitive(false);
    let failure = "";
    try { await this.store.saveArrangement(change, settings.cancel); }
    catch (error) { failure = errorText(error); }
    finally {
      settings.writing = false;
      settings.cancel = undefined;
      if (this.arrangement === settings) {
        this.renderArrangement(settings);
        if (failure) settings.status.set_label(failure);
        settings.list.set_sensitive(true);
      }
    }
  }
}
