import { Adw, GLib, Gtk } from "./gi.js";
import { CairoCanvas } from "./cairo-canvas.js";
import { Chart, BasicPlatform } from "./vendor/chart-engine.js";
import { type ChartConfig } from "./markdown-chart.js";
import { column, errorText, label } from "./ui.js";

Chart.defaults.font.family = "Sans";

export class NativeChart {
  readonly widget = column(4);
  readonly area = new Gtk.DrawingArea({ content_height: 320, hexpand: true });
  private readonly status = label("", "dim-label");
  private canvas?: CairoCanvas;
  private chart: any;
  private signal = 0;
  private failed = false;
  private themeIdle = 0;
  private hiddenSeries: boolean[] = [];
  private hiddenPoints: boolean[] = [];
  private readonly style = Adw.StyleManager.get_default();
  constructor(private readonly config: ChartConfig, title = "График", private readonly authored: Record<string, any> = config.options) {
    this.area.set_tooltip_text(title);
    this.area.update_property([Gtk.AccessibleProperty.LABEL], [title]);
    this.status.set_visible(false);
    this.widget.append(this.area); this.widget.append(this.status);
    this.area.connect("map", () => {
      if (!this.signal) this.signal = this.style.connect("notify::dark", () => this.queueTheme());
      this.area.queue_draw();
    });
    this.area.connect("unmap", () => this.release());
    this.area.set_draw_func((_area: unknown, cr: any, width: number, height: number) => {
      try {
        if (this.failed || width < 1 || height < 1) return;
        this.ensure(width, height);
        const factor = this.chart.currentDevicePixelRatio || 1;
        cr.save(); cr.scale(1 / factor, 1 / factor); cr.setSourceSurface(this.canvas!.context.surface, 0, 0); cr.paint(); cr.restore();
      } catch (error) { this.error(error); }
      finally { cr.$dispose(); }
    });
    const motion = new Gtk.EventControllerMotion();
    motion.connect("motion", (_motion: unknown, x: number, y: number) => this.event("mousemove", x, y));
    motion.connect("leave", () => this.event("mouseout", -1, -1)); this.area.add_controller(motion);
    const click = new Gtk.GestureClick();
    click.connect("released", (_gesture: unknown, _count: number, x: number, y: number) => this.event("click", x, y)); this.area.add_controller(click);
  }
  private ensure(width: number, height: number): void {
    if (!this.chart) {
      this.canvas = new CairoCanvas(width, height);
      const config = JSON.parse(JSON.stringify(this.config));
      config.platform = BasicPlatform;
      config.options = { ...config.options, animation: false, responsive: false,
        maintainAspectRatio: false, devicePixelRatio: Math.max(1, Math.min(2, this.area.get_scale_factor())) };
      try { this.chart = new Chart(this.canvas, config); }
      catch (error) { Chart.getChart(this.canvas)?.destroy(); this.canvas.dispose(); this.canvas = undefined; throw error; }
      this.hiddenSeries.forEach((hidden, index) => this.chart.setDatasetVisibility(index, !hidden));
      this.hiddenPoints.forEach((hidden, index) => { if (hidden) this.chart.toggleDataVisibility(index); });
      this.theme();
    } else if (this.chart.width !== width || this.chart.height !== height) this.chart.resize(width, height);
  }
  private theme(): void {
    const chart = this.chart;
    if (!chart) return;
    const rgba = this.area.get_color();
    const colour = rgba.to_string(), grid = `rgba(${Math.round(rgba.red * 255)},${Math.round(rgba.green * 255)},${Math.round(rgba.blue * 255)},0.15)`;
    const authored = this.authored;
    if (authored.color === undefined) chart.options.color = colour;
    if (authored.borderColor === undefined) chart.options.borderColor = grid;
    if (authored.plugins === undefined) {
      chart.options.plugins.legend.labels.color = colour;
      chart.options.plugins.title.color = colour;
    }
    if (authored.scales === undefined) for (const scale of Object.values(chart.scales) as any[]) {
      scale.options.ticks.color = colour; scale.options.grid.color = grid; scale.options.grid.tickColor = grid;
      if (scale.options.title) scale.options.title.color = colour;
      if (scale.options.pointLabels) scale.options.pointLabels.color = colour;
      if (scale.options.angleLines) scale.options.angleLines.color = grid;
      if (scale.type === "radialLinear") scale.options.ticks.backdropColor = this.style.get_dark()
        ? "rgba(20,20,20,0.8)" : "rgba(255,255,255,0.8)";
    }
    chart.update("none");
  }
  private queueTheme(): void {
    if (this.themeIdle) GLib.Source.remove(this.themeIdle);
    this.themeIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this.themeIdle = 0;
      if (this.area.get_mapped()) this.repaint();
      return GLib.SOURCE_REMOVE;
    });
  }
  private repaint(): void { try { this.theme(); this.area.queue_draw(); } catch (error) { this.error(error); } }
  private event(type: string, x: number, y: number): void {
    if (!this.chart || this.failed) return;
    try { this.chart._eventHandler({ type, x, y, native: { type } }); this.area.queue_draw(); }
    catch (error) { this.error(error); }
  }
  private release(): void {
    if (this.themeIdle) GLib.Source.remove(this.themeIdle);
    this.themeIdle = 0;
    if (this.signal) this.style.disconnect(this.signal);
    this.signal = 0;
    if (this.chart) {
      this.hiddenSeries = this.config.data.datasets.map((_, index) => !this.chart.isDatasetVisible(index));
      const count = this.config.data.datasets.reduce((count, item) => Math.max(count, item.data.length), 0);
      this.hiddenPoints = Array.from({ length: count }, (_, index) => !this.chart.getDataVisibility(index));
      this.chart.destroy(); this.chart = undefined;
    }
    this.canvas?.dispose(); this.canvas = undefined;
  }
  private error(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      this.release(); this.status.set_label("Не удалось построить график: " + errorText(error));
      this.status.set_visible(true); this.area.set_visible(false); return GLib.SOURCE_REMOVE;
    });
  }
}
