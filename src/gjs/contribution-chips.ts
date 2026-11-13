import { type Gateway } from "./gateway.js";
import { Gdk, Gio, GLib, Gtk } from "./gi.js";
import { contributionRoute, type PlacedContribution } from "./ui-contributions.js";
import { button, clear, column, errorText, label, row } from "./ui.js";

const tones = { ok: "success", warn: "warning", bad: "error" } as const;
const spacing = 6;
type Tone = keyof typeof tones;
interface ChipValue { text: string; full: string; title: string; tone?: Tone }
interface Chip {
  item: PlacedContribution;
  path?: string;
  button: any;
  caption: any;
  dot: any;
  value?: ChipValue;
  error?: string;
  failures: number;
  due: number;
  timer: number;
  cancel?: any;
}

function chipValue(reply: unknown): ChipValue {
  const answer = reply as { text?: unknown; title?: unknown; tone?: unknown } | null;
  const full = typeof answer?.text === "string" ? answer.text.trim().slice(0, 2000) : "";
  const chars = Array.from(full);
  return {
    full, text: chars.length > 24 ? chars.slice(0, 23).join("") + "…" : full,
    title: typeof answer?.title === "string" ? answer.title.trim().slice(0, 400) : "",
    tone: typeof answer?.tone === "string" && Object.hasOwn(tones, answer.tone) ? answer.tone as Tone : undefined,
  };
}

export class ContributionChips {
  readonly widget = column(0);
  private readonly sizing = new Gtk.DrawingArea({ content_height: 1, hexpand: true });
  private readonly line = row(spacing);
  private readonly more = new Gtk.MenuButton({ label: "+0", tooltip_text: "Другие индикаторы навыков", focus_on_click: false });
  private readonly popover = new Gtk.Popover();
  private readonly overflow = column(4);
  private readonly chips = new Map<string, Chip>();
  private ordered: Chip[] = [];
  private width = 0;
  private fitIdle = 0;
  private surface?: any;
  private surfaceHandler = 0;
  private active = false;
  private closed = false;

  constructor(private readonly gateway: Gateway, private readonly activate: (item: PlacedContribution) => void) {
    this.popover.set_child(new Gtk.ScrolledWindow({ child: this.overflow, max_content_height: 330,
      hscrollbar_policy: Gtk.PolicyType.NEVER, propagate_natural_height: true }));
    this.more.set_popover(this.popover);
    this.line.append(this.more);
    this.widget.append(this.sizing);
    this.widget.append(new Gtk.ScrolledWindow({ child: this.line, hscrollbar_policy: Gtk.PolicyType.EXTERNAL,
      vscrollbar_policy: Gtk.PolicyType.NEVER, propagate_natural_height: true }));
    this.widget.set_visible(false);
    this.sizing.connect("resize", (_widget: unknown, width: number) => {
      this.width = width;
      this.queueFit();
    });
    this.widget.connect("map", () => {
      if (this.closed) return;
      this.surface = this.widget.get_native()?.get_surface();
      if (this.surface?.get_state) this.surfaceHandler = this.surface.connect("notify::state", () => this.updateVisibility());
      this.updateVisibility();
    });
    this.widget.connect("unmap", () => {
      this.disconnectSurface();
      this.setActive(false);
    });
  }

  sync(items: PlacedContribution[]): void {
    if (this.closed) return;
    const live = new Map(items.map((item) => [item.key, item]));
    for (const [key, chip] of this.chips) {
      const item = live.get(key);
      if (!item || item.revision !== chip.item.revision || item.source?.url !== chip.item.source?.url
        || item.source?.refresh_s !== chip.item.source?.refresh_s) this.remove(chip);
    }
    this.ordered = items.map((item) => {
      const chip = this.chips.get(item.key) ?? this.add(item);
      chip.item = item;
      this.paint(chip);
      return chip;
    });
    let previous: any = null;
    for (const chip of this.ordered) {
      this.line.reorder_child_after(chip.button, previous);
      previous = chip.button;
    }
    this.widget.set_visible(this.ordered.length > 0);
    for (const chip of this.ordered) this.plan(chip);
    this.queueFit();
  }

  close(): void {
    this.closed = true;
    this.disconnectSurface();
    if (this.fitIdle) GLib.Source.remove(this.fitIdle);
    this.fitIdle = 0;
    for (const chip of this.chips.values()) this.remove(chip);
  }

  private disconnectSurface(): void {
    if (this.surfaceHandler) this.surface.disconnect(this.surfaceHandler);
    this.surfaceHandler = 0;
    this.surface = undefined;
  }

  private updateVisibility(): void {
    const state = this.surface?.get_state?.() ?? 0;
    const hidden = Gdk.ToplevelState.MINIMIZED | (Gdk.ToplevelState.SUSPENDED ?? 0);
    this.setActive(this.widget.get_mapped() && !(state & hidden));
  }

  private setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    for (const chip of this.ordered) {
      if (active) this.plan(chip);
      else this.stop(chip);
    }
  }

  private add(item: PlacedContribution): Chip {
    const control = new Gtk.Button({ focus_on_click: false, halign: Gtk.Align.START });
    control.add_css_class("pill");
    const content = row(5);
    const dot = new Gtk.Image({ icon_name: "media-record-symbolic", pixel_size: 8 });
    const caption = label("");
    caption.set_wrap(false);
    content.append(dot);
    content.append(caption);
    control.set_child(content);
    const path = contributionRoute(item.skill, item.source?.url);
    const chip: Chip = { item, path, button: control, caption, dot, due: 0, timer: 0, failures: 0,
      error: path ? undefined : "Шлюз не сообщил маршрут источника." };
    this.chips.set(item.key, chip);
    control.connect("clicked", () => this.activate(chip.item));
    this.line.append(control);
    return chip;
  }

  private remove(chip: Chip): void {
    this.stop(chip);
    this.line.remove(chip.button);
    this.chips.delete(chip.item.key);
  }

  private stop(chip: Chip): void {
    if (chip.timer) GLib.Source.remove(chip.timer);
    chip.timer = 0;
    const cancel = chip.cancel;
    chip.cancel = undefined;
    cancel?.cancel();
  }

  private plan(chip: Chip): void {
    if (!this.active || !chip.path || chip.cancel || chip.timer || this.closed) return;
    const delay = Math.max(1, Math.ceil((chip.due - GLib.get_monotonic_time()) / 1000));
    chip.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
      chip.timer = 0;
      if (this.active) void this.poll(chip);
      return GLib.SOURCE_REMOVE;
    });
  }

  private async poll(chip: Chip): Promise<void> {
    const cancel = new Gio.Cancellable();
    chip.cancel = cancel;
    try {
      const answer = await this.gateway.extensionResult("GET", chip.path!, undefined, cancel);
      if (chip.cancel !== cancel) return;
      chip.value = chipValue(answer);
      chip.error = undefined;
      chip.failures = 0;
    } catch (error) {
      if (chip.cancel !== cancel) return;
      chip.error = errorText(error).slice(0, 250);
      chip.failures++;
    }
    chip.cancel = undefined;
    const interval = Math.min(3600, Math.max(15, Number(chip.item.source?.refresh_s) || 15));
    chip.due = GLib.get_monotonic_time() + interval * 1_000_000 * 2 ** Math.min(chip.failures, 4);
    this.paint(chip);
    this.queueFit();
    this.plan(chip);
  }

  private face(chip: Chip): [string, string] {
    const value = chip.error ? "—" : chip.value?.text;
    const caption = value ? `${chip.item.label} · ${value}` : chip.item.label;
    const description = chip.error ? `${chip.item.label} · ${chip.error}`
      : [chip.value?.title, chip.value && chip.value.full !== chip.value.text ? chip.value.full : ""].filter(Boolean).join("\n")
        || chip.item.title || "";
    return [caption, description];
  }

  private paint(chip: Chip): void {
    const [caption, description] = this.face(chip);
    chip.caption.set_label(caption);
    chip.button.update_property([Gtk.AccessibleProperty.LABEL], [caption]);
    chip.button.set_tooltip_text(description || null);
    chip.button.set_css_classes(chip.error ? ["pill", "dim-label"] : ["pill"]);
    const tone = chip.error ? undefined : chip.value?.tone;
    chip.dot.set_visible(Boolean(tone));
    chip.dot.set_css_classes(tone ? [tones[tone]] : []);
  }

  private queueFit(): void {
    if (this.fitIdle || this.closed) return;
    this.fitIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this.fitIdle = 0;
      this.fit();
      return GLib.SOURCE_REMOVE;
    });
  }

  private fit(): void {
    for (const chip of this.ordered) chip.button.set_visible(true);
    const widths = this.ordered.map(({ button }) => button.measure(Gtk.Orientation.HORIZONTAL, -1)[1] + spacing);
    let keep = widths.length;
    if (widths.reduce((sum, value) => sum + value, 0) - spacing > this.width) {
      this.more.set_visible(true);
      this.more.set_label(`+${widths.length}`);
      let free = this.width - this.more.measure(Gtk.Orientation.HORIZONTAL, -1)[1];
      keep = 0;
      while (keep < widths.length && widths[keep] <= free) free -= widths[keep++];
    }
    const folded = this.ordered.slice(keep);
    for (const chip of folded) chip.button.set_visible(false);
    this.more.set_visible(folded.length > 0);
    this.more.set_label(`+${folded.length}`);
    this.more.update_property([Gtk.AccessibleProperty.LABEL], [`Ещё индикаторов навыков: ${folded.length}`]);
    clear(this.overflow);
    for (const chip of folded) {
      const [caption, description] = this.face(chip);
      const control = button(caption, () => { this.popover.popdown(); this.activate(chip.item); });
      control.set_tooltip_text(description || null);
      this.overflow.append(control);
    }
  }
}
