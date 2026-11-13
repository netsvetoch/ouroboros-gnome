import { Adw, Gio, Gtk, svgRenderer } from "./gi.js";
import { mermaidRenderer, type MermaidSvg } from "./mermaid-renderer.js";
import { chatHref } from "./chat-text.js";
import { codeView } from "./code-view.js";
import { diagramImageLoader, type DiagramImageLoader } from "./diagram-images.js";
import { button, chooseFile, column, errorText, label } from "./ui.js";

/** The visible diagram and all interaction belong to GTK, with native SVG drawing. */
export class NativeMermaid {
  readonly widget = column(6);
  readonly area = new Gtk.DrawingArea();
  private readonly status = label("", "dim-label");
  private readonly scroller: any;
  private readonly scaleText = label("100%", "dim-label");
  private readonly links = new Gtk.Expander({ label: "Ссылки диаграммы", visible: false });
  private readonly raw = new Gtk.Expander({ label: "Исходник Mermaid" });
  private readonly save: any;
  private data?: MermaidSvg;
  private handle: any;
  private cancel?: any;
  private revision = 0;
  private theme = 0;
  private dark?: boolean;
  private scale = 1;
  private autoFit = true;
  private failed = false;
  private readonly image: DiagramImageLoader;

  constructor(readonly source: string, private readonly base?: string, private readonly onLink?: (href: string) => boolean, image?: DiagramImageLoader) {
    this.image = image ?? diagramImageLoader(undefined, base);
    this.widget.add_css_class("mermaid-diagram");
    this.widget.update_property([Gtk.AccessibleProperty.LABEL], ["Диаграмма Mermaid"]);
    const controls = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, column_spacing: 6, row_spacing: 4 });
    this.save = button("Сохранить SVG…", () => void this.saveSvg()); this.save.set_sensitive(false);
    for (const control of [button("По ширине", () => { this.autoFit = true; this.resize(); }),
      button("−", () => this.zoom(this.scale / 1.25)), this.scaleText, button("+", () => this.zoom(this.scale * 1.25)),
      button("Скопировать Mermaid", () => this.widget.get_clipboard().set(source)), this.save]) controls.append(control);
    this.area.update_property([Gtk.AccessibleProperty.LABEL], ["Диаграмма Mermaid. Исходник доступен ниже."]);
    this.area.set_draw_func((_area: unknown, cr: any, width: number) => {
      try {
        if (!this.handle || !this.data) return;
        const w = this.data.width * this.scale, h = this.data.height * this.scale;
        this.handle.render_document(cr, new (svgRenderer().Rectangle)({ x: Math.max(0, (width - w) / 2), y: 0, width: w, height: h }));
      } finally { cr.$dispose(); }
    });
    this.scroller = new Gtk.ScrolledWindow({ child: this.area, hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
      vscrollbar_policy: Gtk.PolicyType.AUTOMATIC, propagate_natural_height: true, max_content_height: 600, min_content_height: 40 });
    this.area.connect("resize", () => { if (this.autoFit) this.resize(); });
    this.raw.connect("notify::expanded", () => { if (this.raw.expanded && !this.raw.get_child()) this.raw.set_child(codeView(source, "mermaid")); });
    this.widget.append(controls); this.widget.append(this.status); this.widget.append(this.scroller); this.widget.append(this.links); this.widget.append(this.raw);
    this.widget.connect("map", () => {
      if (!this.theme) this.theme = Adw.StyleManager.get_default().connect("notify::dark", () => this.load());
      this.load();
    });
    this.widget.connect("unmap", () => {
      ++this.revision; this.cancel?.cancel(); this.cancel = undefined; this.handle = undefined;
      if (this.theme) Adw.StyleManager.get_default().disconnect(this.theme); this.theme = 0;
    });
  }

  private load(): void {
    if (!this.widget.get_mapped()) return;
    const dark = Boolean(Adw.StyleManager.get_default().get_dark());
    const revision = ++this.revision;
    this.cancel?.cancel(); this.cancel = undefined;
    if (this.data && dark === this.dark) {
      try { this.handle = svgRenderer().Handle.new_from_data(new TextEncoder().encode(this.data.svg)); this.resize(); }
      catch (error) { this.failure(error); }
      return;
    }
    const cancel = this.cancel = new Gio.Cancellable();
    this.status.set_label("Построение диаграммы…"); this.status.set_visible(true);
    void mermaidRenderer.render(this.source, dark, this.scroller.get_width() || 800, cancel, this.image).then(value => {
      if (revision !== this.revision || cancel.is_cancelled()) return;
      this.handle = svgRenderer().Handle.new_from_data(new TextEncoder().encode(value.svg));
      this.data = value; this.dark = dark; this.failed = false;
      this.status.set_visible(false); this.save.set_sensitive(true); this.resize(); this.showLinks(value.links);
    }).catch(error => { if (revision === this.revision && !cancel.is_cancelled()) this.failure(error); });
  }
  private failure(error: unknown): void {
    this.failed = true; this.handle = undefined; this.data = undefined; this.save.set_sensitive(false);
    this.links.set_child(null); this.links.set_visible(false);
    this.status.set_label("Не удалось построить диаграмму: " + errorText(error)); this.status.set_visible(true);
    this.raw.set_expanded(true); this.area.set_content_width(0); this.area.set_content_height(0);
  }
  private resize(): void {
    if (!this.data) return;
    if (this.autoFit) this.scale = Math.min(1, Math.max(0.005, (this.scroller.get_width() - 16 || 784) / this.data.width));
    this.area.set_content_width(Math.max(1, Math.ceil(this.data.width * this.scale)));
    this.area.set_content_height(Math.max(1, Math.ceil(this.data.height * this.scale)));
    this.scaleText.set_label(`${Math.round(this.scale * 100)}%`); this.area.queue_draw();
  }
  private zoom(scale: number): void {
    this.autoFit = false; this.scale = Math.max(0.005, Math.min(4, scale)); this.resize();
  }
  private showLinks(values: MermaidSvg["links"]): void {
    const body = column(4); let count = 0;
    const known = new Set<string>();
    for (const value of values ?? []) {
      const href = chatHref(value.href, this.base);
      if (!href || known.has(href)) continue; known.add(href); ++count;
      body.append(button(value.label || href, () => {
        if (this.onLink?.(href)) return;
        const launcher = new Gtk.UriLauncher({ uri: href });
        launcher.launch(this.widget.get_root(), null, (_launcher: unknown, result: unknown) => { try { launcher.launch_finish(result); } catch (error) { this.status.set_label(errorText(error)); this.status.set_visible(true); } });
      }));
    }
    this.links.set_child(body); this.links.set_visible(count > 0);
  }
  private async saveSvg(): Promise<void> {
    const data = this.data; if (!data) return;
    this.save.set_sensitive(false);
    try {
      const file = await chooseFile(this.widget.get_root(), "diagram.svg");
      if (file) file.replace_contents(new TextEncoder().encode(data.svg), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    } catch (error) { this.status.set_label(errorText(error)); this.status.set_visible(true); }
    finally { this.save.set_sensitive(Boolean(this.data)); }
  }
}

export function mermaidView(source: string, base?: string, onLink?: (href: string) => boolean, image?: DiagramImageLoader): any {
  return new NativeMermaid(source, base, onLink, image).widget;
}
