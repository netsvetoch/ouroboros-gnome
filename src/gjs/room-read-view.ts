import type { Room } from "./chat.js";
import { Gdk, GLib, Gtk } from "./gi.js";
import { isRevision, type RoomReads } from "./room-reads.js";

type Rectangle = [number, number, number, number];
export interface ReadRow {
  widget: any;
  id?: string;
  address?: string;
  revisions?: Record<string, number>;
  version?: string;
}
interface Receipt { room: Room; revision: number; latest?: string }
interface Reading { width: number; height: number; version?: string; area: Rectangle[] }

function addArea(area: Rectangle[], rect: Rectangle): Rectangle[] {
  if (area.some(([x, y, right, bottom]) => x <= rect[0] && y <= rect[1] && right >= rect[2] && bottom >= rect[3])) return area;
  let next = rect;
  const kept = area.filter(([x, y, right, bottom]) => !(next[0] <= x && next[1] <= y && next[2] >= right && next[3] >= bottom));
  for (let index = 0; index < kept.length;) {
    const part = kept[index];
    const sameWidth = Math.abs(part[0] - next[0]) <= 0.5 && Math.abs(part[2] - next[2]) <= 0.5
      && part[1] <= next[3] + 0.5 && next[1] <= part[3] + 0.5;
    if (!sameWidth) { index++; continue; }
    next = [Math.max(part[0], next[0]), Math.min(part[1], next[1]), Math.min(part[2], next[2]), Math.max(part[3], next[3])];
    kept.splice(index, 1);
    index = 0;
  }
  return [...kept, next].slice(-64);
}

function covered(area: Rectangle[], width: number, height: number): boolean {
  const edges = [...new Set([0, height, ...area.flatMap((part) => [part[1], part[3]])])].sort((a, b) => a - b);
  for (let index = 1; index < edges.length; index++) {
    const lo = edges[index - 1], hi = edges[index];
    if (hi - lo <= 0.5) continue;
    const sections = area.filter((part) => part[1] <= lo + 0.5 && part[3] >= hi - 0.5).sort((a, b) => a[0] - b[0]);
    let right = 0;
    for (const part of sections) {
      if (part[0] > right + 0.5) break;
      right = Math.max(right, part[2]);
    }
    if (right < width - 0.5) return false;
  }
  return true;
}

export class RoomReadView {
  private room: Room;
  private rows: ReadRow[] = [];
  private readonly reading = new Map<string, Reading>();
  private readonly completed = new Set<string>();
  private readonly connections: [any, number][] = [];
  private readonly rowConnections: [any, number][] = [];
  private receipt?: Receipt;
  private landing?: string;
  private tick = 0;
  private closed = false;
  private blocked = false;
  private surface?: any;
  private surfaceSignal = 0;

  constructor(private readonly parent: any, private readonly viewport: any, private readonly scroll: any,
    private readonly reads: RoomReads, room: Room) {
    this.room = room;
    const note = () => this.schedule();
    for (const adjustment of [scroll.get_vadjustment(), scroll.get_hadjustment()]) {
      this.listen(adjustment, "value-changed", note);
      this.listen(adjustment, "changed", note);
    }
    this.listen(parent, "notify::focus-widget", note);
    if (parent.get_visible_dialog) this.listen(parent, "notify::visible-dialog", note);
    this.listen(viewport, "map", () => {
      this.surface = viewport.get_native()?.get_surface();
      if (this.surface?.get_state) this.surfaceSignal = this.surface.connect("notify::state", note);
      note();
    });
    this.listen(viewport, "unmap", () => this.disconnectSurface());
  }

  setRoom(room: Room): void {
    this.room = room;
    this.setRows([]);
    this.reading.clear();
    this.completed.clear();
    this.setReceipt();
    this.cancelLanding();
  }

  setRows(rows: ReadRow[]): void {
    this.disconnectRows();
    this.rows = rows;
    // A disclosure can expose text without changing either scroll adjustment.
    // Sample after mapping, once GTK has allocated and painted the newly shown row.
    for (const widget of new Set(rows.map((row) => row.widget))) {
      this.rowConnections.push([widget, widget.connect("map", () => this.schedule())]);
    }
    const mounted = new Set(rows.map(({ address }) => address));
    for (const address of this.reading.keys()) if (!mounted.has(address)) this.reading.delete(address);
    this.schedule();
  }

  hasRow(id: string): boolean { return this.rows.some((row) => row.id === id); }

  setReceipt(revision?: number, latest?: string): void {
    this.receipt = revision === undefined ? undefined : { room: this.room, revision, latest };
    this.schedule();
  }

  land(id: string): void {
    this.landing = id;
    this.schedule();
  }

  cancelLanding(): void { this.landing = undefined; }

  setBlocked(blocked: boolean): void {
    this.blocked = blocked;
    this.schedule();
  }

  close(): void {
    this.closed = true;
    this.disconnectSurface();
    this.disconnectRows();
    if (this.tick) this.viewport.remove_tick_callback(this.tick);
    for (const [object, id] of this.connections) object.disconnect(id);
    this.connections.length = 0;
  }

  private listen(object: any, signal: string, callback: () => void): void {
    this.connections.push([object, object.connect(signal, callback)]);
  }

  private disconnectRows(): void {
    for (const [widget, id] of this.rowConnections) widget.disconnect(id);
    this.rowConnections.length = 0;
  }

  private disconnectSurface(): void {
    if (this.surfaceSignal) this.surface.disconnect(this.surfaceSignal);
    this.surfaceSignal = 0;
    this.surface = undefined;
  }

  private shown(): boolean {
    if (this.blocked || !this.viewport.get_mapped()) return false;
    const dialog = this.parent.get_visible_dialog?.();
    if (dialog && !this.viewport.is_ancestor(dialog)) return false;
    const state = this.surface?.get_state?.() ?? 0;
    if (state & (Gdk.ToplevelState.MINIMIZED | (Gdk.ToplevelState.SUSPENDED ?? 0))) return false;
    for (let focus = this.parent.get_focus?.(); focus; focus = focus.get_parent()) if (focus instanceof Gtk.Popover) return false;
    return true;
  }

  private schedule(): void {
    if (this.closed || this.tick || !this.viewport.get_mapped()) return;
    let frames = 0;
    this.tick = this.viewport.add_tick_callback(() => {
      if (++frames < 2) return GLib.SOURCE_CONTINUE;
      this.tick = 0;
      if (this.shown()) this.sample();
      return GLib.SOURCE_REMOVE;
    });
  }

  private bounds(widget: any): Rectangle | undefined {
    if (!widget.get_mapped()) return undefined;
    const [valid, rect] = widget.compute_bounds(this.viewport);
    const x = rect.get_x(), y = rect.get_y();
    const width = rect.get_width(), height = rect.get_height();
    return valid && width > 0 && height > 0 ? [x, y, x + width, y + height] : undefined;
  }

  private sample(): void {
    const width = this.viewport.get_width(), height = this.viewport.get_height();
    if (width <= 0 || height <= 0) return;
    const box = (id: string) => {
      const node = this.rows.find((row) => row.id === id)?.widget;
      const bounds = node ? this.bounds(node) : undefined;
      return { node, visible: bounds && bounds[2] > 0 && bounds[3] > 0 && bounds[0] < width && bounds[1] < height };
    };
    if (this.landing) {
      const { node, visible } = box(this.landing);
      this.landing = undefined;
      if (node && !visible) {
        this.viewport.scroll_to(node, null);
        this.schedule();
        return;
      }
    }
    const receipt = this.receipt;
    if (receipt) {
      const adjustment = this.scroll.get_vadjustment();
      const visible = receipt.latest ? box(receipt.latest).visible
        : adjustment.get_upper() - adjustment.get_page_size() - adjustment.get_value() <= 2;
      if (visible) this.reads.acknowledge(receipt.room, receipt.revision);
    }
    for (const row of this.rows) {
      const address = row.address;
      if (!address || this.completed.has(address) || !Object.entries(row.revisions ?? {})
        .some(([chat, revision]) => chat !== String(this.room.chatId) && isRevision(revision) && revision > 0)) continue;
      const bounds = this.bounds(row.widget);
      if (!bounds) continue;
      const [left, top, right, bottom] = bounds;
      const rect: Rectangle = [Math.max(0, -left), Math.max(0, -top),
        Math.min(width, right) - left, Math.min(height, bottom) - top];
      if (rect[2] <= rect[0] || rect[3] <= rect[1]) continue;
      const rowWidth = right - left, rowHeight = bottom - top;
      const previous = this.reading.get(address);
      const area = addArea(previous?.width === rowWidth && previous.height === rowHeight && previous.version === row.version
        ? previous.area : [], rect);
      if (covered(area, rowWidth, rowHeight)) {
        this.reading.delete(address);
        this.completed.add(address);
        this.reads.recordShared(address);
      } else {
        this.reading.set(address, { width: rowWidth, height: rowHeight, version: row.version, area });
      }
    }
  }
}
