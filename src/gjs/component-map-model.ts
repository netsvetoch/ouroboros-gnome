import { FieldURL } from "./vendor/field-url.js";
export const mercatorLatitude = 85.0511287798066;
export interface MapPoint { index: number; lat: number; lon: number; plotLat: number; plotLon: number; label: string; popup: string }
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const numeric = (value: unknown): number => typeof value === "number" || typeof value === "string" && value.trim() ? Number(value) : NaN;
export const wrapLongitude = (lon: number): number => lon >= -180 && lon < 180 ? lon : ((lon + 180) % 360 + 360) % 360 - 180;
export function mapPoints(markers: unknown): MapPoint[] {
  return (Array.isArray(markers) ? markers : []).flatMap((value, index) => {
    const marker = object(value), lat = numeric(marker.lat), lon = numeric(marker.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) return [];
    return [{ index, lat, lon, plotLat: Math.max(-mercatorLatitude, Math.min(mercatorLatitude, lat)), plotLon: wrapLongitude(lon),
      label: String(marker.label || `${lat}, ${lon}`), popup: marker.popup ? String(marker.popup) : "" }];
  });
}
export function mapTileTemplate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  let template = value.trim().replace(/%7b(x|y|z|tmsy|-y|s|r)%7d/giu, (_, name: string) => `{${name.toLowerCase()}}`);
  if ([...template.matchAll(/\{([^{}]+)\}/gu)].some(match => !["x", "y", "z", "s", "r", "-y", "tmsy"].includes(match[1]))) throw new Error("Неизвестная подстановка в tiles_url.");
  template = template.replace(/\{s\}/gu, "a").replace(/\{r\}/gu, "").replace(/\{-y\}/gu, "{tmsy}");
  const parsed = new FieldURL(template);
  const local = parsed.hostname === "localhost" || /^127(?:\.\d+){3}$/u.test(parsed.hostname) || parsed.hostname === "[::1]";
  if (!(parsed.protocol === "https:" || parsed.protocol === "http:" && local) || !parsed.hostname || parsed.username || parsed.password) throw new Error("tiles_url должен использовать HTTPS или локальный HTTP без учётных данных.");
  return parsed.href.replace(/%7b(x|y|z|tmsy)%7d/giu, "{$1}");
}
const mercatorY = (lat: number): number => .5 - Math.log((1 + Math.sin(lat * Math.PI / 180)) / (1 - Math.sin(lat * Math.PI / 180))) / (4 * Math.PI);
export function fitMapPoints(points: MapPoint[], width: number, height: number): { lat: number; lon: number; zoom: number } {
  if (!points.length) return { lat: 0, lon: 0, zoom: 1 };
  if (points.length === 1) return { lat: points[0].plotLat, lon: points[0].plotLon, zoom: 12 };
  const xs = points.map(point => ((point.plotLon + 360) % 360)).sort((a, b) => a - b);
  let gap = -1, after = 0;
  for (let i = 0; i < xs.length; i++) { const next = i + 1 < xs.length ? xs[i + 1] : xs[0] + 360; if (next - xs[i] > gap) { gap = next - xs[i]; after = (i + 1) % xs.length; } }
  const west = xs[after], span = 360 - gap;
  const ys = points.map(point => mercatorY(point.plotLat));
  const north = ys.reduce((a, b) => Math.min(a, b)), south = ys.reduce((a, b) => Math.max(a, b));
  const y = (north + south) / 2;
  const dx = span / 360, dy = south - north;
  const zoom = Math.floor(Math.log2(Math.min(Math.max(1, width - 80) / (256 * Math.max(dx, 1e-12)), Math.max(1, height - 80) / (256 * Math.max(dy, 1e-12)))));
  return { lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI, lon: wrapLongitude(west + span / 2), zoom: Math.max(0, Math.min(19, zoom)) };
}
