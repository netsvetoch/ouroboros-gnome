import { Gtk } from "./gi.js";
import { FieldURL } from "./vendor/field-url.js";
import { object, type SettingsDocument } from "./settings-write.js";
import { button, clear, column, label } from "./ui.js";
import { widgetPath, widgetText } from "./widget-contract.js";

function tableHref(value: unknown, base?: string): string | undefined {
  const raw = widgetText(value).trim();
  if (!raw) return undefined;
  try {
    const uri = new FieldURL(raw, base ? new FieldURL(base).origin + "/" : undefined);
    if (!["http:", "https:"].includes(uri.protocol) || !uri.hostname || uri.username || uri.password) return undefined;
    return uri.href;
  } catch { return undefined; }
}

function numberText(value: unknown, column: SettingsDocument): string {
  if (value == null || value === "") return "—";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  const precision = column.precision;
  const digits = precision == null || precision === "" || !Number.isFinite(Number(precision)) ? undefined
    : Math.max(0, Math.min(12, Math.trunc(Number(precision))));
  const formatted = new Intl.NumberFormat(undefined, digits === undefined ? { maximumFractionDigits: 12 }
    : { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(numeric);
  return [formatted, widgetText(column.unit)].filter(Boolean).join(" ");
}

function statusClass(value: unknown): string {
  switch (widgetText(value).toLowerCase()) {
    case "ok": case "success": return "success";
    case "danger": case "error": return "error";
    case "warn": case "warning": return "warning";
    case "info": return "accent";
    default: return "dim-label";
  }
}

function cell(row: SettingsDocument, column: SettingsDocument, base?: string): any {
  const raw = widgetPath(row, column.path);
  const presentation = column.presentation || column.format;
  if (presentation === "number") {
    const value = label(numberText(raw, column));
    value.set_selectable(true);
    value.set_xalign(1);
    return value;
  }
  if (presentation === "status") {
    const record = object(raw);
    const structured = raw !== null && typeof raw === "object";
    const value = structured ? record.label ?? record.value ?? record.status : raw;
    const tone = structured ? record.tone : widgetPath(row, column.tone_path);
    const result = label(widgetText(value) || "—", statusClass(tone));
    result.set_selectable(true);
    return result;
  }
  if (presentation === "link") {
    const href = widgetPath(row, column.href_path || column.path);
    const uri = tableHref(href, base);
    const caption = widgetText(column.label_path ? widgetPath(row, column.label_path) : raw)
      || widgetText(href) || "—";
    if (uri) {
      const link = new Gtk.LinkButton({ label: caption, uri, halign: Gtk.Align.START, tooltip_text: uri });
      const child = link.get_child();
      if (child instanceof Gtk.Label) { child.set_wrap(true); child.set_max_width_chars(48); }
      return link;
    }
    const result = label(caption);
    result.set_selectable(true);
    return result;
  }
  const result = label(widgetText(raw, "—"));
  result.set_selectable(true);
  return result;
}

export function componentTable(columns: SettingsDocument[], rows: SettingsDocument[], base?: string): any {
  const host = column(4);
  const body = column();
  const position = label("", "dim-label");
  const controls = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, column_spacing: 6, row_spacing: 4 });
  const rowSize = 50, columnSize = 12;
  let rowStart = 0, columnStart = 0;
  const previousRows = button("Предыдущие строки", () => { rowStart = Math.max(0, rowStart - rowSize); render(); });
  const nextRows = button("Следующие строки", () => { if (rowStart + rowSize < rows.length) rowStart += rowSize; render(); });
  const previousColumns = button("Предыдущие столбцы", () => { columnStart = Math.max(0, columnStart - columnSize); render(); });
  const nextColumns = button("Следующие столбцы", () => { if (columnStart + columnSize < columns.length) columnStart += columnSize; render(); });
  for (const item of [previousRows, nextRows, previousColumns, nextColumns]) controls.append(item);
  const paged = rows.length > rowSize || columns.length > columnSize;
  position.set_visible(paged);
  controls.set_visible(paged);
  previousRows.set_visible(rows.length > rowSize);
  nextRows.set_visible(rows.length > rowSize);
  previousColumns.set_visible(columns.length > columnSize);
  nextColumns.set_visible(columns.length > columnSize);
  function render(): void {
    clear(body);
    const table = new Gtk.Grid({ column_spacing: 14, row_spacing: 4 });
    const visibleColumns = columns.slice(columnStart, columnStart + columnSize);
    visibleColumns.forEach((column, index) => table.attach(label(widgetText(column.label, widgetText(column.path)), "heading"), index, 0, 1, 1));
    rows.slice(rowStart, rowStart + rowSize).forEach((row, y) => visibleColumns.forEach((column, x) => table.attach(cell(row, column, base), x, y + 1, 1, 1)));
    body.append(table);
    position.set_label(`Строки ${rows.length ? rowStart + 1 : 0}–${Math.min(rows.length, rowStart + rowSize)} из ${rows.length} · Столбцы ${columns.length ? columnStart + 1 : 0}–${Math.min(columns.length, columnStart + columnSize)} из ${columns.length}`);
    previousRows.set_sensitive(rowStart > 0);
    nextRows.set_sensitive(rowStart + rowSize < rows.length);
    previousColumns.set_sensitive(columnStart > 0);
    nextColumns.set_sensitive(columnStart + columnSize < columns.length);
  }
  host.append(position);
  host.append(controls);
  host.append(new Gtk.ScrolledWindow({ child: body, hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
    vscrollbar_policy: Gtk.PolicyType.NEVER, propagate_natural_height: true }));
  render();
  return host;
}
