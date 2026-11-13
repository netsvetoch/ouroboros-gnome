import { Adw, Gdk, GObject, Gtk, Pango, svgRenderer } from "./gi.js";
import { renderMathSvg, type MathSvg } from "./math-svg.js";
import { mathRuns } from "./markdown-math.js";
import { MathContext } from "./math-context.js";
import { type MarkdownNode, markdownEscape } from "./markdown-document.js";
import { button, column, errorText, label } from "./ui.js";

let styled = false;
function styles(): void {
  if (styled) return;
  const provider = new Gtk.CssProvider();
  provider.load_from_string("textview.markdown-math, textview.markdown-math text { background: transparent; } menubutton.math-formula > button { padding: 0; min-width: 0; min-height: 0; border: 0; background: transparent; }");
  Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
  styled = true;
}

const MathArea = GObject.registerClass(class MathArea extends Gtk.DrawingArea {
  declare geometry: MathSvg;
  vfunc_measure(orientation: number, _forSize: number): number[] {
    if (!this.geometry) return [1, 1, -1, -1];
    const size = orientation === Gtk.Orientation.HORIZONTAL ? this.geometry.width : this.geometry.height;
    const baseline = orientation === Gtk.Orientation.VERTICAL ? this.geometry.baseline : -1;
    return [size, size, baseline, baseline];
  }
});

/** MathML permits ink outside its logical box (rules, raises, overlaps, smash). */
export function fitMathInk(shape: MathSvg): MathSvg {
  const Rsvg = svgRenderer();
  const handle = Rsvg.Handle.new_from_data(new TextEncoder().encode(shape.svg));
  const [ok, ink] = handle.get_geometry_for_layer(null, new Rsvg.Rectangle({ x: 0, y: 0, width: shape.width, height: shape.height }));
  if (!ok) return shape;
  const left = Math.floor(Math.min(0, ink.x)), top = Math.floor(Math.min(0, ink.y));
  const width = Math.ceil(Math.max(shape.width, ink.x + ink.width)) - left;
  const height = Math.ceil(Math.max(shape.height, ink.y + ink.height)) - top;
  if (!Number.isFinite(width + height) || width > 16384 || height > 8192 || width * height > 16 * 1024 * 1024) throw new Error("Размер формулы превышает предел отображения.");
  if (left === 0 && top === 0 && width === shape.width && height === shape.height) return shape;
  const color = shape.svg.match(/^<svg color="(#[\da-f]{6})"/iu)?.[1] ?? "#242424";
  const inner = shape.svg.replace(/^<svg color="#[\da-f]{6}"/iu, '<svg overflow="visible"');
  return { svg: `<svg color="${color}" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${left} ${top} ${width} ${height}">${inner}</svg>`, width, height, baseline: shape.baseline - top };
}

/** librsvg draws embedded font paths into GTK's Cairo context at native scale. */
export class NativeFormula {
  readonly area = new MathArea();
  readonly widget: any;
  private handle: any;
  private theme = 0;
  private geometry: MathSvg;
  constructor(readonly source: string, readonly display: boolean, readonly em = 16, prepared?: MathSvg) {
    styles();
    svgRenderer();
    const scale = Math.max(8, Math.min(64, em)) / 16;
    const width = prepared ? Math.max(1, Math.ceil(prepared.width * scale)) : 0;
    const height = prepared ? Math.max(1, Math.ceil(prepared.height * scale)) : 0;
    const shape = prepared ? { ...prepared, width, height, baseline: Math.round(prepared.baseline * scale),
      svg: prepared.svg.replace(/width="[^"]*"/u, `width="${width}"`).replace(/height="[^"]*"/u, `height="${height}"`) } : renderMathSvg(source, display, em);
    this.geometry = fitMathInk(shape);
    this.area.geometry = this.geometry;
    this.widget = new Gtk.MenuButton({ child: this.area, has_frame: false, tooltip_text: source, valign: Gtk.Align.BASELINE });
    this.widget.add_css_class("math-formula");
    this.widget.update_property([Gtk.AccessibleProperty.LABEL], ["Формула: " + source]);
    const detail = column(4), raw = label(source); raw.set_selectable(true);
    detail.append(raw); detail.append(button("Скопировать TeX", () => this.widget.get_clipboard().set(source)));
    this.widget.set_popover(new Gtk.Popover({ child: detail }));
    this.area.set_draw_func((_area: unknown, cr: any, width: number, height: number) => {
      if (this.handle) this.handle.render_document(cr, new (svgRenderer().Rectangle)({ x: 0, y: 0, width, height }));
    });
    this.widget.connect("map", () => {
      this.refresh();
      if (!this.theme) this.theme = Adw.StyleManager.get_default().connect("notify::dark", () => this.refresh());
    });
    this.widget.connect("unmap", () => {
      if (this.theme) Adw.StyleManager.get_default().disconnect(this.theme);
      this.theme = 0; this.handle = undefined;
    });
  }
  private refresh(): void {
    const color = Adw.StyleManager.get_default().get_dark() ? "#ffffff" : "#242424";
    const svg = this.geometry.svg.replace(/^<svg color="#[\da-f]{6}"/iu, `<svg color="${color}"`);
    this.handle = svgRenderer().Handle.new_from_data(new TextEncoder().encode(svg));
    this.area.queue_draw();
  }
}

/** TextView anchors keep math inline with selectable, wrapped and styled prose. */
export function mathTextView(nodes: MarkdownNode[], base?: string, css?: string, onLink?: (href: string) => boolean, context?: MathContext): any | undefined {
  const runs = mathRuns(nodes, base);
  if (!runs.some(run => run.kind === "math")) return undefined;
  context ??= new MathContext(nodes);
  styles();
  const view = new Gtk.TextView({ editable: false, cursor_visible: true, wrap_mode: Gtk.WrapMode.WORD_CHAR, hexpand: true });
  view.add_css_class("markdown-math"); if (css) view.add_css_class(css);
  const buffer = view.get_buffer(), links = new Map<any, string>();
  const annotations: { tag: any; from: number; to: number }[] = [];
  const annotate = (tag: any, from: number) => { buffer.get_tag_table().add(tag); annotations.push({ tag, from, to: buffer.get_char_count() }); };
  const description = view.get_pango_context().get_font_description();
  const em = description?.get_size() ? description.get_size() / Pango.SCALE * 96 / 72 : 16;
  const append = (markup: string) => buffer.insert_markup(buffer.get_end_iter(), markup, -1);
  for (const run of runs) {
    if (run.kind === "text") {
      const from = buffer.get_char_count(); append(run.markup);
      if (run.href && buffer.get_char_count() > from) {
        const tag = new Gtk.TextTag({ underline: Pango.Underline.SINGLE });
        annotate(tag, from); links.set(tag, run.href);
      }
    } else {
      try {
        const formula = new NativeFormula(run.source, run.display, em, context.formula(run));
        if (run.display && buffer.get_char_count() && !buffer.get_end_iter().starts_line()) buffer.insert(buffer.get_end_iter(), "\n", -1);
        const from = buffer.get_char_count();
        const anchor = buffer.create_child_anchor(buffer.get_end_iter());
        view.add_child_at_anchor(formula.widget, anchor);
        if (run.display) {
          buffer.insert(buffer.get_end_iter(), "\n", -1);
          annotate(new Gtk.TextTag({ justification: Gtk.Justification.CENTER }), from);
        }
      } catch (error) {
        const from = buffer.get_char_count(); append(markdownEscape(run.raw));
        annotate(new Gtk.TextTag({ underline: Pango.Underline.ERROR }), from);
        view.set_tooltip_text("Не удалось отобразить формулу: " + errorText(error));
      }
    }
  }
  for (const { tag, from, to } of annotations) buffer.apply_tag(tag, buffer.get_iter_at_offset(from), buffer.get_iter_at_offset(to));
  const linkAt = (x: number, y: number) => {
    const [bx, by] = view.window_to_buffer_coords(Gtk.TextWindowType.WIDGET, Math.floor(x), Math.floor(y));
    const [inside, iter] = view.get_iter_at_location(bx, by);
    if (inside) for (const tag of iter.get_tags()) if (links.has(tag)) return links.get(tag);
    return undefined;
  };
  const gesture = new Gtk.GestureClick({ button: 1 });
  gesture.set_name("markdown-math-links");
  gesture.connect("released", (_gesture: unknown, count: number, x: number, y: number) => {
    const href = count === 1 && !buffer.get_has_selection() ? linkAt(x, y) : undefined;
    if (!href || onLink?.(href)) return;
    const launcher = new Gtk.UriLauncher({ uri: href });
    launcher.launch(view.get_root(), null, (_launcher: unknown, result: unknown) => { try { launcher.launch_finish(result); } catch (error) { view.set_tooltip_text(errorText(error)); } });
  });
  view.add_controller(gesture);
  const motion = new Gtk.EventControllerMotion();
  motion.connect("motion", (_motion: unknown, x: number, y: number) => view.set_cursor_from_name(linkAt(x, y) ? "pointer" : "text"));
  motion.connect("leave", () => view.set_cursor_from_name("text")); view.add_controller(motion);
  return new Gtk.ScrolledWindow({ child: view, hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
    vscrollbar_policy: Gtk.PolicyType.NEVER, propagate_natural_height: true });
}
