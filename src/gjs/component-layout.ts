import { GObject, Gtk } from "./gi.js";
import { column } from "./ui.js";

function count(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? Math.max(1, Math.min(4, value)) : fallback;
}

/** FlowBox keeps child widgets intact while adapting grid and cluster groups. */
export function componentGroup(layout: unknown, columns: unknown): any {
  if (layout !== "grid" && layout !== "cluster") return column();
  return new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, homogeneous: layout === "grid",
    min_children_per_line: 1, max_children_per_line: layout === "grid" ? count(columns, 2) : 256,
    column_spacing: 8, row_spacing: 8, valign: Gtk.Align.START });
}

type Field = { widget: any; field: Record<string, unknown> };

// Gtk.Box owns disposal of its child; the custom measurement keeps the form's
// minimum height consistent with its current number of columns inside scrollers.
const ComponentFields = GObject.registerClass(class ComponentFields extends Gtk.Box {
  declare private grid: any;
  declare private fields: Field[];
  declare private maximum: number;
  declare private current: number;

  _init(fields: Field[], columns: unknown): void {
    super._init({ orientation: Gtk.Orientation.VERTICAL });
    this.fields = fields;
    this.maximum = count(columns, 1);
    this.current = 0;
    this.grid = new Gtk.Grid({ column_spacing: 10, row_spacing: 10, column_homogeneous: true });
    for (const [index, { widget }] of fields.entries()) {
      widget.set_hexpand(true);
      this.grid.attach(widget, 0, index, 1, 1);
    }
    this.append(this.grid);
    this.set_layout_manager(null);
    this.add_css_class("component-fields");
    this.arrange(this.maximum);
  }

  private arrange(size: number): void {
    if (size === this.current) return;
    this.current = size;
    let x = 0, y = 0;
    for (const { widget, field } of this.fields) {
      const span = Math.min(size, count(field.span, 1));
      if (x + span > size) { x = 0; y++; }
      const placement = this.grid.get_layout_manager().get_layout_child(widget);
      placement.set_column(x);
      placement.set_row(y);
      placement.set_column_span(span);
      x += span;
      if (x === size) { x = 0; y++; }
    }
  }

  vfunc_get_request_mode(): number { return Gtk.SizeRequestMode.HEIGHT_FOR_WIDTH; }

  private columnsFor(width: number): number {
    let unit = 190;
    for (const { widget, field } of this.fields) {
      const [minimum] = widget.measure(Gtk.Orientation.HORIZONTAL, -1);
      unit = Math.max(unit, Math.ceil(minimum / Math.min(this.maximum, count(field.span, 1))));
    }
    return width <= unit * this.maximum + (this.maximum - 1) * 10 ? 1 : this.maximum;
  }

  vfunc_measure(orientation: number, forSize: number): number[] {
    if (!this.grid) return [0, 0, -1, -1];
    if (orientation === Gtk.Orientation.HORIZONTAL) {
      let minimum = 0, unit = 0;
      for (const { widget, field } of this.fields) {
        const [min, natural] = widget.measure(orientation, -1);
        minimum = Math.max(minimum, min);
        unit = Math.max(unit, Math.ceil(natural / count(field.span, 1)));
      }
      return [minimum, Math.max(minimum, unit * this.maximum + (this.maximum - 1) * 10), -1, -1];
    }
    if (forSize >= 0) this.arrange(this.columnsFor(forSize));
    return this.grid.measure(orientation, forSize);
  }

  vfunc_size_allocate(width: number, height: number, baseline: number): void {
    this.arrange(this.columnsFor(width));
    this.grid.allocate(width, height, baseline, null);
  }
});

/** Move coordinates without replacing or reparenting input widgets. */
export function componentFields(fields: Field[], columns: unknown): any {
  return new ComponentFields(fields, columns);
}
