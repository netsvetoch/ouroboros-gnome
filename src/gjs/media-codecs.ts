import { GLib, gstreamer } from "./gi.js";

let prepared = false;

/** WebKit's default MP4 recorder needs an autopluggable AAC encoder. */
export function prepareRecordingCodecs(): void {
  if (prepared) return;
  prepared = true;
  // An explicit application launch configuration takes precedence.
  if (GLib.getenv("GST_PLUGIN_FEATURE_RANK") !== null) return;
  try {
    const gst = gstreamer(), aac = gst.ElementFactory.find("avenc_aac");
    if (!aac || aac.get_rank() !== gst.Rank.NONE) return;
    if (["fdkaacenc", "voaacenc", "faac"].some(name => (gst.ElementFactory.find(name)?.get_rank() ?? 0) > gst.Rank.NONE)) return;
    // GNOME 51 ships libav's AAC encoder at NONE. Native capture can select it
    // explicitly; WebKit's separate process needs the same available encoder
    // in automatic selection. Do not replace another working preferred encoder.
    aac.set_rank(gst.Rank.PRIMARY);
    GLib.setenv("GST_PLUGIN_FEATURE_RANK", "avenc_aac:256", true);
  } catch { /* Other module capabilities remain usable without GStreamer. */ }
}
