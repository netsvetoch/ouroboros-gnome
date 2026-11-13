import { GLib } from "./gi.js";

/** One native UI process, distinct from message IDs and authentication credentials. */
export const nativeSenderSessionId = GLib.uuid_string_random();

/** Capture only facts supported by the gateway's client_surface normalizer. */
export function nativeClientSurface(widget: any): Record<string, unknown> {
  const surface: Record<string, unknown> = {
    ua: "Ouroboros GNOME (GTK4; GJS)",
    captured_at: new Date().toISOString(),
  };
  const timezone = String(GLib.TimeZone.new_local().get_identifier());
  if (timezone.length <= 64 && /^[A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+){0,2}$/u.test(timezone) && timezone !== "localtime") surface.timezone = timezone;
  const w = widget.get_width(), h = widget.get_height();
  if (Number.isSafeInteger(w) && Number.isSafeInteger(h) && w > 0 && h > 0) surface.viewport = { w: Math.min(w, 100000), h: Math.min(h, 100000) };
  const scale = widget.get_scale_factor();
  if (Number.isFinite(scale) && scale > 0) surface.device_pixel_ratio = Math.max(.25, Math.min(scale, 16));
  return surface;
}
