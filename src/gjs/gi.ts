declare const imports: any;

imports.gi.versions.Gtk = "4.0";
imports.gi.versions.Adw = "1";
imports.gi.versions.Soup = "3.0";

export const { Adw, Gdk, Gio, GLib, GObject, Gtk, Pango, Soup } = imports.gi;

export function svgRenderer(): any {
  imports.gi.versions.Rsvg = "2.0";
  return imports.gi.Rsvg;
}

export function webKit(): any {
  imports.gi.versions.WebKit = "6.0";
  return imports.gi.WebKit;
}

export function gstreamer(): any {
  imports.gi.versions.Gst = "1.0";
  imports.gi.versions.GstApp = "1.0";
  const { Gst } = imports.gi;
  if (!Gst.is_initialized()) Gst.init(null);
  const { GstApp } = imports.gi;
  // Register the appsrc and appsink subclasses before parsing pipelines.
  void GstApp.AppSink;
  void GstApp.AppSrc;
  return Gst;
}

export function mediaPortal(): { Xdp: any; XdpGtk4: any } {
  imports.gi.versions.Xdp = "1.0";
  imports.gi.versions.XdpGtk4 = "1.0";
  return { Xdp: imports.gi.Xdp, XdpGtk4: imports.gi.XdpGtk4 };
}

export function sourceView(): any {
  imports.gi.versions.GtkSource = "5";
  return imports.gi.GtkSource;
}

export function canvasGraphics(): { Cairo: any; PangoCairo: any } {
  return { Cairo: imports.cairo, PangoCairo: imports.gi.PangoCairo };
}

export function mapRenderer(): any {
  imports.gi.versions.Shumate = "1.0";
  return imports.gi.Shumate;
}

let nativeStreams: any;
/** WebKit reads URI streams on worker threads, where GJS vfuncs cannot run. */
export function boundedStream(): any {
  if (!nativeStreams) {
    const directory = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_child("native").get_path();
    const repository = imports.gi.GIRepository.Repository;
    const current = typeof repository.dup_default === "function" ? repository.dup_default() : repository;
    current.prepend_search_path(directory); current.prepend_library_path(directory);
    nativeStreams = imports.gi.OuroborosStream;
  }
  return nativeStreams.BoundedStream.new();
}
