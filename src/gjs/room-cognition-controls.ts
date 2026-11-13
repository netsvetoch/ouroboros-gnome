import { Gtk } from "./gi.js";
import { cognitionScope, contextModes, effortLevels, subagentModes, type EffortRange, type RoomChange,
  type RoomCognition, validEffort } from "./room-cognition.js";
import type { Room } from "./chat.js";
import { button, column, label, row } from "./ui.js";

const contexts: Record<string, string> = { nano: "Nano", low: "Low", max: "Max" };
const agents: Record<string, string> = { off: "Выкл.", auto: "Авто", swarm: "Рой" };
const effortNames: Record<string, string> = {
  none: "Без усилия", minimal: "Минимальное", low: "Низкое", medium: "Среднее", high: "Высокое",
  xhigh: "Очень высокое", max: "Максимальное", ultra: "Ультра",
};
const effortFields = [["min", "Минимальное для субагентов"], ["recommended", "Основное"], ["max", "Максимальное для субагентов"]] as const;

function capsule(title: string): { menu: any; popover: any; content: any } {
  const menu = new Gtk.MenuButton({ label: title, focus_on_click: false, halign: Gtk.Align.START });
  menu.add_css_class("pill");
  const content = column(6);
  const popover = new Gtk.Popover({ child: content });
  menu.set_popover(popover);
  return { menu, popover, content };
}

export class RoomCognitionControls {
  readonly widget = column(2);
  private readonly context = capsule("Контекст");
  private readonly effort = capsule("Усилие");
  private readonly subagents = capsule("Субагенты");
  private readonly notice = label("", "dim-label");
  private readonly agentNotice = label("", "dim-label");
  private readonly effortNotice = label("", "error");
  private readonly contextChoices = new Map<string, any>();
  private readonly agentChoices = new Map<string, any>();
  private readonly effortSelectors = new Map<string, any>();
  private readonly applyEffort = button("Сохранить диапазон усилия", () => {
    const range = this.selectedRange();
    if (validEffort(range)) this.save({ setting: "effort-range", range }, this.effort.popover);
  });
  private scope?: string;
  private signature = "";
  private readonly off: () => void;

  constructor(private readonly store: RoomCognition, changed: () => void) {
    const flow = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, min_children_per_line: 1,
      max_children_per_line: 3, column_spacing: 6, row_spacing: 4, halign: Gtk.Align.START });
    for (const control of [this.subagents, this.context, this.effort]) {
      flow.append(control.menu);
      control.popover.connect("map", () => {
        if (control === this.effort) this.paintRange(true);
        if (this.scope !== undefined) void this.store.refresh(this.scope);
      });
    }
    this.widget.append(flow);
    this.widget.append(this.notice);
    this.context.content.append(label("Размер рабочего контекста для новых участников.", "dim-label"));
    for (const mode of contextModes) {
      const choice = button(contexts[mode], () => this.save({ setting: "context-mode", mode }, this.context.popover));
      this.context.content.append(choice);
      this.contextChoices.set(mode, choice);
    }
    this.subagents.content.append(this.agentNotice);
    for (const mode of subagentModes) {
      const choice = button(agents[mode], () => this.save({ setting: "subagents-mode", mode }, this.subagents.popover));
      this.subagents.content.append(choice);
      this.agentChoices.set(mode, choice);
    }
    this.effort.content.append(label("Основное усилие выбирается независимо от диапазона субагентов.", "dim-label"));
    for (const [key, title] of effortFields) {
      const field = row(8);
      const caption = label(title);
      caption.set_hexpand(true);
      const select = Gtk.DropDown.new_from_strings(["—", ...effortLevels.map((tier) => effortNames[tier])]);
      select.update_property([Gtk.AccessibleProperty.LABEL], [title]);
      select.connect("notify::selected", () => this.syncEffort());
      field.append(caption);
      field.append(select);
      this.effort.content.append(field);
      this.effortSelectors.set(key, select);
    }
    this.effort.content.append(this.effortNotice);
    this.effort.content.append(this.applyEffort);
    this.off = this.store.subscribe(() => { this.render(); changed(); });
    this.render();
  }

  setRoom(room: Room): void {
    const scope = cognitionScope(room);
    if (scope !== this.scope) {
      this.scope = scope;
      for (const control of [this.context, this.effort, this.subagents]) control.popover.popdown();
      this.paintRange(true);
      this.render();
    }
    this.refresh();
  }

  refresh(): void {
    if (this.scope !== undefined) void this.store.refresh(this.scope);
  }

  close(): void { this.off(); }

  private selectedRange(): EffortRange {
    const tier = (key: string) => effortLevels[this.effortSelectors.get(key)?.get_selected() - 1] ?? "";
    return { min: tier("min"), recommended: tier("recommended"), max: tier("max") };
  }

  private syncEffort(): void {
    const range = this.selectedRange();
    const valid = validEffort(range);
    const saved = this.store.get(this.scope)?.effort_range;
    const changed = effortFields.some(([key]) => range[key] !== saved?.[key]);
    const outOfOrder = range.min && range.max && effortLevels.indexOf(range.min) > effortLevels.indexOf(range.max);
    this.effortNotice.set_label(outOfOrder ? "Минимальное усилие должно быть не выше максимального." : "");
    this.effortNotice.set_visible(Boolean(outOfOrder));
    this.applyEffort.set_sensitive(this.scope !== undefined && !this.store.pending(this.scope) && valid && changed);
  }

  private paintRange(reset = false): void {
    const saved = this.store.get(this.scope)?.effort_range;
    const signature = JSON.stringify(saved ?? null);
    if (reset || signature !== this.signature) {
      this.signature = signature;
      for (const [key] of effortFields) this.effortSelectors.get(key)?.set_selected(effortLevels.indexOf(saved?.[key] ?? "") + 1);
    }
    this.syncEffort();
  }

  private render(): void {
    const saved = this.store.get(this.scope);
    const saving = Boolean(this.store.pending(this.scope));
    const availability = this.store.availability;
    const locked = availability === "disabled" || availability === "unsaved";
    const mode = saved?.subagents_mode;
    this.widget.set_visible(this.scope !== undefined);
    this.context.menu.set_label(`Контекст · ${contexts[saved?.context_mode ?? ""] || "—"}`);
    this.effort.menu.set_label(`Усилие · ${effortNames[saved?.effort_range?.recommended ?? ""] || "—"}`);
    this.effort.menu.set_tooltip_text(saved?.effort_range ? `Диапазон субагентов · ${effortNames[saved.effort_range.min]} — ${effortNames[saved.effort_range.max]}` : null);
    this.subagents.menu.set_label(`Субагенты · ${locked ? agents.off : agents[mode ?? ""] || "—"}`);
    const details = availability === "disabled" ? "Субагенты отключены в настройках шлюза."
      : availability === "unsaved" ? "На шлюзе ещё не сохранены настройки субагентов."
        : availability === "available" ? "Режим применяется к новым запускам в этой комнате."
          : "Доступность субагентов пока неизвестна.";
    this.agentNotice.set_label([details, locked && mode ? `Сохранённый режим · ${agents[mode]}` : ""].filter(Boolean).join("\n"));
    this.subagents.menu.set_tooltip_text(this.agentNotice.get_label());
    for (const [key, control] of this.contextChoices) control.set_sensitive(!saving && Boolean(saved?.context_mode) && key !== saved?.context_mode);
    for (const [key, control] of this.agentChoices) control.set_sensitive(!saving && (!locked || key === "off") && Boolean(mode) && key !== mode);
    for (const control of this.effortSelectors.values()) control.set_sensitive(!saving && Boolean(saved?.effort_range));
    const feedback = saving ? "Сохраняю настройки комнаты…" : this.store.feedback(this.scope);
    this.notice.set_label(feedback);
    this.notice.set_visible(Boolean(feedback));
    this.paintRange();
  }

  private save(change: RoomChange, popover: any): void {
    if (this.scope === undefined || this.store.pending(this.scope)) return;
    popover.popdown();
    void this.store.save(this.scope, change);
  }
}
