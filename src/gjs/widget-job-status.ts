export type WidgetJobStatus = "pending" | "success" | "failure" | "invalid";
const success = new Set(["done", "succeeded", "success", "complete", "completed"]);
const failure = new Set(["error", "failed", "failure", "cancelled", "canceled", "timeout", "expired"]);

export function readWidgetJobStatus(data: unknown): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  return Object.hasOwn(data, "status") ? (data as Record<string, unknown>).status : (data as Record<string, unknown>).state;
}

export function classifyWidgetJobStatus(value: unknown): WidgetJobStatus {
  if (typeof value !== "string" || !value.trim()) return "invalid";
  const status = value.trim().toLowerCase();
  return success.has(status) ? "success" : failure.has(status) ? "failure" : "pending";
}
