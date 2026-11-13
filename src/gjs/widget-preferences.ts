export interface WidgetPreferences {
  ok?: boolean;
  widget_order: string[];
  widget_size: Record<string, { w: number; h: number }>;
  widget_start_mode: Record<string, string>;
}
const record = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value));

export function readWidgetPreferences(value: unknown, written = false): WidgetPreferences {
  if (!record(value) || written && value.ok !== true || value.ok !== undefined && value.ok !== true
    || !Array.isArray(value.widget_order) || value.widget_order.some((key: unknown) => typeof key !== "string" || !key)
    || new Set(value.widget_order).size !== value.widget_order.length
    || !record(value.widget_size) || !record(value.widget_start_mode)
    || Object.values(value.widget_size).some(size => !record(size) || !Number.isInteger(size.w) || size.w < 1 || size.w > 12 || size.h !== 0)
    || Object.values(value.widget_start_mode).some(mode => !["auto", "manual", "retain"].includes(mode))) {
    throw new Error("Шлюз не вернул полные настройки виджетов. Сохранена последняя прочитанная версия.");
  }
  return value as WidgetPreferences;
}
