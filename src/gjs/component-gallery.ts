import { type Gateway } from "./gateway.js";
import { Gtk } from "./gi.js";
import { type SettingsDocument, object } from "./settings-write.js";
import { button, clear, column, label } from "./ui.js";
import { widgetPath } from "./widget-contract.js";
import { WidgetMedia } from "./widget-media.js";

/** Keep the complete collection, but own media resources for only one page. */
export class ComponentGallery {
  readonly widget = column(4);
  private readonly position = label("", "dim-label");
  private readonly controls = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, column_spacing: 6, row_spacing: 4 });
  private readonly body = column(6);
  private readonly previous = button("Предыдущие файлы", () => this.move(-1));
  private readonly next = button("Следующие файлы", () => this.move(1));
  private readonly pageSize = 20;
  private start = 0;
  private items: unknown[] = [];
  private current: WidgetMedia[] = [];
  private identity?: string;
  private data: unknown;
  private active = true;
  private closed = false;

  constructor(private readonly gateway: Gateway | undefined, private readonly skill: string,
    private readonly spec: SettingsDocument) {
    this.controls.append(this.previous); this.controls.append(this.next);
    this.widget.append(this.position); this.widget.append(this.controls); this.widget.append(this.body);
  }

  setData(data: unknown): void {
    if (this.closed) return;
    this.data = data;
    const items = this.spec.items ?? widgetPath(data, this.spec.path || this.spec.items_key);
    const values = Array.isArray(items) ? items : [];
    const identity = JSON.stringify(values);
    if (this.identity === identity) {
      // Static item specifications may still reference changed response fields.
      for (const media of this.current) media.setData(data);
      return;
    }
    this.identity = identity; this.items = values;
    this.start = Math.min(this.start, Math.max(0, Math.ceil(values.length / this.pageSize) - 1) * this.pageSize);
    this.render();
  }

  private move(direction: number): void {
    if (this.closed) return;
    const start = this.start + direction * this.pageSize;
    if (start < 0 || start >= this.items.length) return;
    this.start = start; this.render();
  }

  private releasePage(): void {
    for (const media of this.current) media.release();
    this.current = []; clear(this.body);
  }

  private render(): void {
    this.releasePage();
    for (const value of this.items.slice(this.start, this.start + this.pageSize)) {
      const item = object(value);
      let spec: SettingsDocument = { ...item, type: item.type || "image", src: item.src ?? value };
      if (this.spec.items_key && typeof this.spec.route_prefix === "string") {
        const [route, name = "path"] = this.spec.route_prefix.trim().split("?", 2);
        const raw = String((value && typeof value === "object" ? item.path || item.src || item.url : value) || "").trim();
        spec = route && raw ? { type: this.spec.item_type || "image", route,
          query: { [name.replace(/=$/, "") || "path"]: raw } } : { type: this.spec.item_type || "image", src: raw };
      }
      const media = new WidgetMedia(this.gateway, this.skill, spec);
      this.current.push(media); this.body.append(media.widget); media.setData(this.data);
      if (!this.active) media.pause();
    }
    const count = this.items.length;
    this.position.set_label(count ? `Файлы ${this.start + 1}–${Math.min(count, this.start + this.pageSize)} из ${count}` : "В галерее нет файлов.");
    this.controls.set_visible(count > this.pageSize);
    this.previous.set_sensitive(this.start > 0);
    this.next.set_sensitive(this.start + this.pageSize < count);
  }

  setActive(active: boolean): void {
    this.active = active;
    if (!active) for (const media of this.current) media.pause();
  }

  release(): void {
    if (this.closed) return;
    this.closed = true; this.releasePage(); this.items = []; this.data = undefined; this.identity = undefined;
    this.previous.set_sensitive(false); this.next.set_sensitive(false);
  }
}
