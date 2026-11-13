const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function commandShape(value: Record<string, unknown>): boolean {
  return ["status", "task_id", "reason_code"].every(key => !(key in value) || typeof value[key] === "string")
    && ["ok", "deduped", "accepted"].every(key => !(key in value) || typeof value[key] === "boolean");
}

/** Admission only. A visible_task_id is a submission key, not a minted task ID. */
export function commandAccepted(value: unknown, visibleId?: string): boolean {
  if (!record(value) || !commandShape(value) || value.ok === false || value.accepted === false
    || (value.status !== undefined && value.status !== "ok")
    || (value.error !== undefined && value.error !== null && value.error !== "")) return false;
  if (visibleId && value.task_id !== undefined && value.task_id !== visibleId) return false;
  if (value.deduped === true) return Boolean(visibleId && value.ok === true && value.task_id === visibleId);
  return value.status === "ok";
}

/** Only the documented pre-admission refusal proves that no command was queued. */
export function commandRefused(status: number, value: unknown): boolean {
  return (status === 400 || status === 409) && record(value) && commandShape(value)
    && typeof value.error === "string" && Boolean(value.error.trim()) && value.accepted === false
    && value.ok !== true && value.deduped !== true && value.status !== "ok";
}
