import { type CallRoom, type CallView } from "./call-session.js";
import { GLib, Gtk, Pango } from "./gi.js";
import { button, row } from "./ui.js";

/** Window-level access to a call, including when its room is off screen. */
export class CallMark {
  readonly widget = row();
  readonly open = button("", () => {
    const current = this.current();
    if (current?.view.room) this.reveal(current.key, current.view.room);
  });
  readonly end = button("Завершить вызов", () => {
    const current = this.current();
    if (current && current.view.phase !== "closing") this.finish(current.key);
  });
  private readonly entries = new Map<string, { view: CallView; since: number }>();
  private timer = 0;

  constructor(private readonly reveal: (key: string, room: CallRoom) => void,
    private readonly finish: (key: string) => void,
    private readonly now = () => GLib.get_monotonic_time() / 1000) {
    const caption = new Gtk.Label({ ellipsize: Pango.EllipsizeMode.END, max_width_chars: 24 });
    this.open.set_child(caption);
    this.open.set_tooltip_text("Открыть текущий вызов");
    this.end.add_css_class("destructive-action");
    this.widget.append(this.open);
    this.widget.append(this.end);
    this.render();
  }

  update(key: string, view: CallView): void {
    if (!view.active) this.entries.delete(key);
    else {
      const prior = this.entries.get(key);
      const same = prior && (!prior.view.callId || prior.view.callId === view.callId);
      const since = same && prior.since || (view.phase === "live" ? this.now() : 0);
      this.entries.set(key, { view, since });
    }
    this.render();
  }

  clear(): void { this.entries.clear(); this.render(); }

  private current(): { key: string; view: CallView; since: number } | undefined {
    const first = this.entries.entries().next().value;
    return first ? { key: first[0], ...first[1] } : undefined;
  }

  private render(): void {
    const current = this.current();
    this.widget.set_visible(Boolean(current));
    if (!current) {
      if (this.timer) GLib.Source.remove(this.timer);
      this.timer = 0;
      this.end.set_sensitive(false);
      return;
    }
    const elapsed = current.since ? Math.max(0, Math.floor((this.now() - current.since) / 1000)) : undefined;
    const clock = elapsed === undefined ? "" : (elapsed >= 3600 ? `${Math.floor(elapsed / 3600)}:` : "")
      + `${Math.floor(elapsed / 60) % 60}`.padStart(2, "0") + ":" + `${elapsed % 60}`.padStart(2, "0");
    const text = ["Вызов", current.view.room?.name, clock].filter(Boolean).join(" · ");
    this.open.get_child().set_label(text);
    this.open.set_tooltip_text(`Открыть текущий вызов · ${current.view.room?.name ?? ""}`);
    this.end.set_sensitive(current.view.phase !== "closing");
    if (!this.timer) this.timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
      this.render();
      return GLib.SOURCE_CONTINUE;
    });
  }
}
