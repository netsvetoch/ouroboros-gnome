import { GLib, Gtk, mapRenderer } from "./gi.js";
import { FieldURL } from "./vendor/field-url.js";
import { fitMapPoints, mapPoints, mapTileTemplate } from "./component-map-model.js";
import { componentTable } from "./component-table.js";
import { button, column, errorText, label } from "./ui.js";

export class ComponentMap {
  readonly widget = column(6);
  private readonly view = column();
  private readonly status = label("", "dim-label");
  private readonly selected = label("");
  private readonly points;
  private map: any;
  private layer: any;
  private source: any;
  private reference: any;
  private active = true;
  private closed = false;
  private first = true;
  private idle = 0;
  private baseLayer: any;
  private tileSignals: number[] = [];
  private note = "";
  private settleTick = 0;
  private settleFrames = 0;
  private pose = "";
  constructor(markers: unknown, tiles: unknown, title = "Карта") {
    const records = Array.isArray(markers) ? markers.map(value => value && typeof value === "object" ? value as Record<string, unknown> : {}) : [];
    this.points = mapPoints(markers);
    const controls = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, row_spacing: 4, column_spacing: 6 });
    controls.append(button("Все точки", () => this.fit()));
    if (this.points.length) {
      const select = Gtk.DropDown.new_from_strings(this.points.map(point => point.label));
      select.update_property([Gtk.AccessibleProperty.LABEL], ["Точка на карте"]);
      controls.append(select);
      controls.append(button("Показать точку", () => {
        const point = this.points[select.get_selected()];
        if (!point || !this.map || this.closed) return;
        this.map.get_map().center_on(point.plotLat, point.plotLon);
        this.map.get_viewport().set_zoom_level(Math.max(12, this.map.get_viewport().get_zoom_level()));
        this.selected.set_label([point.label, point.popup, `${point.lat}, ${point.lon}`].filter(Boolean).join(" · "));
      }));
    }
    this.selected.set_selectable(true);
    this.widget.append(controls); this.widget.append(this.status); this.widget.append(this.view); this.widget.append(this.selected);
    try {
      const template = mapTileTemplate(tiles);
      const Shumate = mapRenderer();
      Shumate.set_user_agent("OuroborosGNOME/0.6.0 (io.github.ouroboros.Client)");
      this.map = new Shumate.SimpleMap({ height_request: 360, hexpand: true, show_zoom_buttons: true });
      this.map.update_property([Gtk.AccessibleProperty.LABEL], [title]);
      let host = "";
      if (template) host = new FieldURL(template).hostname;
      const osm = host === "tile.openstreetmap.org" || host.endsWith(".tile.openstreetmap.org");
      this.reference = Shumate.RasterRenderer.new_full_from_url("ouroboros-map-" + GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, template ?? "coordinates", -1),
        host || "Координаты", osm ? "© OpenStreetMap contributors" : host ? "Источник тайлов: " + host : "", osm ? "https://www.openstreetmap.org/copyright" : template ? new FieldURL(template).origin : "", 0, 19, 256, Shumate.MapProjection.MERCATOR, template ?? "about:blank");
      this.source = template ? this.reference : undefined;
      if (this.source) this.map.get_license().append_map_source(this.source);
      this.map.get_viewport().set_reference_map_source(this.reference);
      this.map.get_viewport().connect("notify", () => {
        if (!this.map || !this.active || this.closed) return;
        const viewport = this.map.get_viewport();
        const pose = [viewport.get_latitude(), viewport.get_longitude(), viewport.get_zoom_level(), viewport.get_rotation()].join(",");
        if (pose !== this.pose) { this.pose = pose; this.settle(); }
      });
      this.layer = Shumate.MarkerLayer.new(this.map.get_viewport());
      for (const point of this.points) {
        const marker = new Shumate.Marker(); marker.set_location(point.plotLat, point.plotLon);
        const detail = column(4); detail.append(label(point.label, "heading"));
        if (point.popup) { const text = label(point.popup); text.set_selectable(true); detail.append(text); }
        detail.append(label(`${point.lat}, ${point.lon}`, "dim-label"));
        const trigger = new Gtk.MenuButton({ icon_name: "mark-location-symbolic", tooltip_text: point.label });
        trigger.update_property([Gtk.AccessibleProperty.LABEL], [point.label]);
        trigger.set_popover(new Gtk.Popover({ child: detail }));
        marker.set_child(trigger); this.layer.add_marker(marker);
      }
      this.map.add_overlay_layer(this.layer); this.view.append(this.map);
      this.widget.connect("map", () => this.resume());
      this.widget.connect("unmap", () => this.pause());
      const invalid = records.length - this.points.length;
      this.note = invalid ? `Не нанесено точек с неподходящими координатами: ${invalid}.` : "";
      this.status.set_label([template ? "" : "Фоновая карта не задана.", this.note].filter(Boolean).join(" "));
    } catch (error) {
      this.status.set_label("Карта недоступна: " + errorText(error));
    }
    const data = new Gtk.Expander({ label: "Список точек" });
    data.connect("notify::expanded", () => {
      if (data.expanded && !data.get_child()) data.set_child(componentTable([{ label: "Место", path: "label" }, { label: "Описание", path: "popup" }, { label: "Широта", path: "lat" }, { label: "Долгота", path: "lon" }], records));
    });
    this.widget.append(data);
  }
  private fit(): void {
    if (!this.map || this.closed) return;
    const place = fitMapPoints(this.points, this.map.get_width() || 640, this.map.get_height() || 360);
    this.map.get_map().center_on(place.lat, place.lon); this.map.get_viewport().set_zoom_level(place.zoom);
  }
  private resume(): void {
    if (!this.active || this.closed || !this.map || !this.widget.get_mapped()) return;
    if (this.first) this.fit();
    if (this.source && !this.baseLayer) {
      const Shumate = mapRenderer();
      const layer = Shumate.MapLayer.new(this.source, this.map.get_viewport());
      this.baseLayer = layer;
      this.status.set_label([this.note, "Загрузка карты…"].filter(Boolean).join(" "));
      this.tileSignals = [layer.connect("tile-error", () => this.status.set_label([this.note, "Не удалось загрузить часть тайлов. Маркеры и список точек доступны."].filter(Boolean).join(" "))),
        layer.connect("map-loaded", (_layer: unknown, errors: boolean) => this.status.set_label([this.note, errors
          ? "Не удалось загрузить часть тайлов. Маркеры и список точек доступны." : "Тайлы загружены."].filter(Boolean).join(" ")))];
      this.map.get_map().insert_layer_behind(layer, this.layer);
      this.settle();
    }
    if (this.first) {
      this.idle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { this.idle = 0; if (this.active && !this.closed) { this.fit(); this.first = false; } return GLib.SOURCE_REMOVE; });
    }
  }
  private settle(): void {
    if (!this.source || !this.map || !this.baseLayer || !this.active || this.closed || !this.widget.get_mapped()) return;
    this.settleFrames = 0;
    if (this.settleTick) return;
    // Unpatched libshumate 1.7 may stop its deferred tile tick in the same frame.
    // Re-notify the unchanged viewport on two frames; this does not retry HTTP.
    this.settleTick = this.map.add_tick_callback(() => {
      if (!this.map || !this.active || this.closed) { this.settleTick = 0; return GLib.SOURCE_REMOVE; }
      this.map.get_viewport().notify("zoom-level");
      if (++this.settleFrames >= 2) { this.settleTick = 0; return GLib.SOURCE_REMOVE; }
      return GLib.SOURCE_CONTINUE;
    });
  }
  private pause(): void {
    if (this.settleTick && this.map) this.map.remove_tick_callback(this.settleTick);
    this.settleTick = 0;
    if (this.idle) GLib.Source.remove(this.idle);
    this.idle = 0;
    for (const signal of this.tileSignals) this.baseLayer.disconnect(signal);
    this.tileSignals = [];
    if (this.baseLayer) {
      this.map.get_map().remove_layer(this.baseLayer);
      this.baseLayer.map_source = null;
      this.baseLayer = undefined;
    }
    if (!this.map) return;
    const viewport = this.map.get_viewport(), lat = viewport.get_latitude(), lon = viewport.get_longitude(), zoom = viewport.get_zoom_level();
    this.map.get_map().stop_go_to();
    viewport.set_reference_map_source(this.reference);
    viewport.set_location(lat, lon); viewport.set_zoom_level(zoom);
  }
  setActive(active: boolean): void { if (this.active === active) return; this.active = active; if (active) this.resume(); else this.pause(); }
  release(): void {
    if (this.closed) return;
    this.closed = true; this.pause();
    if (this.map?.get_parent() === this.view) this.view.remove(this.map);
    this.map = this.layer = this.source = this.reference = undefined;
  }
}
