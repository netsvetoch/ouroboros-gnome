import { type Gateway, query } from "./gateway.js";
import { type SettingsDocument, object } from "./settings-write.js";

export interface WidgetTab {
  key?: string;
  skill: string;
  tab_id: string;
  title: string;
  revision: string;
  generation?: string;
  ws_prefix?: string;
  span?: number;
  grid_span?: number;
  pinned_card?: boolean;
  render: SettingsDocument;
}

export function widgetKey(tab: WidgetTab): string {
  return tab.key || `${tab.skill}:${tab.tab_id}`;
}

export async function readWidgets(gateway: Gateway, cancel?: any, requireComplete = false): Promise<WidgetTab[]> {
  const reply = await gateway.json<{ ui_tabs?: unknown }>("GET", "/api/widgets", undefined, undefined, false, cancel);
  if (!Array.isArray(reply?.ui_tabs)) throw new Error("Шлюз не вернул список виджетов.");
  if (requireComplete && reply.ui_tabs.some(tab => !tab || typeof tab.tab_id !== "string" || tab.render !== object(tab.render)
    || (typeof tab.skill !== "string" && tab.pinned_card !== true)
    || typeof tab.title !== "string" || typeof tab.revision !== "string" || typeof tab.render.kind !== "string"
    || (tab.ws_prefix !== undefined && typeof tab.ws_prefix !== "string")
    || (tab.generation !== undefined && typeof tab.generation !== "string")
    || (tab.pinned_card !== undefined && typeof tab.pinned_card !== "boolean"))) {
    throw new Error("Шлюз вернул неполный список виджетов. Показан последний прочитанный список.");
  }
  if (requireComplete && new Set(reply.ui_tabs.map(tab => widgetKey({ ...tab, skill: tab.skill ?? "_cards" } as WidgetTab))).size !== reply.ui_tabs.length) {
    throw new Error("Шлюз вернул повторяющиеся виджеты. Показан последний прочитанный список.");
  }
  return reply.ui_tabs.flatMap((tab) => {
    if (!tab || typeof tab.tab_id !== "string" || tab.render !== object(tab.render)) return [];
    if (typeof tab.skill === "string") return [tab as WidgetTab];
    return tab.pinned_card === true ? [{ ...tab, skill: "_cards" } as WidgetTab] : [];
  });
}

export function widgetRoute(skill: string, route: unknown, values: SettingsDocument = {}): string {
  const parts = typeof route === "string" ? route.trim().split("/").filter(Boolean) : [];
  if (!safeSkill(skill) || !parts.length || parts.some((part) => part === "." || part === ".." || /[\\%?#\x00-\x1f\x7f]/.test(part))) {
    throw new Error("Маршрут виджета недоступен.");
  }
  return `/api/extensions/${encodeURIComponent(skill)}/${parts.map(encodeURIComponent).join("/")}`
    + query(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value ?? "")])));
}

function safeSkill(skill: string): boolean {
  return Boolean(skill && skill !== "." && skill !== ".." && !/[\\/%?#\s\x00-\x1f\x7f]/.test(skill));
}

export function widgetMediaPath(skill: string, source: string): string {
  if (!safeSkill(skill)) return "";
  const prefix = `/api/extensions/${encodeURIComponent(skill)}/`;
  if (!source.startsWith(prefix) || /[\\\s#\x00-\x1f\x7f]/.test(source)) return "";
  try {
    const path = source.slice(prefix.length).split("?", 1)[0];
    const parts = path.split("/").map(decodeURIComponent);
    return parts.length && parts.every((part) => part && part !== "." && part !== ".." && !/[\\/%\x00-\x1f\x7f]/.test(part)) ? source : "";
  } catch {
    return "";
  }
}

export function widgetPath(data: unknown, selector: unknown): unknown {
  if (typeof selector !== "string" || !selector) return data;
  return selector.split(".").reduce((value: unknown, key) =>
    value && typeof value === "object" && Object.hasOwn(value, key) ? (value as SettingsDocument)[key] : undefined, data);
}

export function widgetText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : fallback;
}

export function widgetRows(value: unknown): SettingsDocument[] {
  return Array.isArray(value) ? value.map(object) : [];
}
