import type { WorkAction } from "./work-actions.js";

const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);

function shape(value: Record<string, any>): boolean {
  if (!["task_id", "state", "status", "error", "cancel_state", "stop_policy", "late_phase", "request_id"]
    .every(key => !Object.hasOwn(value, key) || typeof value[key] === "string")
    || !["ok", "latch_pending", "held", "tree_only", "duplicate", "unconfirmed", "replay", "cascade"]
      .every(key => !Object.hasOwn(value, key) || typeof value[key] === "boolean")) return false;
  if (Object.hasOwn(value, "blockers") && (!Array.isArray(value.blockers) || !value.blockers.every(record))) return false;
  if (Object.hasOwn(value, "membership_gaps")) {
    const gaps = value.membership_gaps;
    if (!record(gaps) || (Object.hasOwn(gaps, "count") && (!Number.isSafeInteger(gaps.count) || gaps.count < 0))
      || (Object.hasOwn(gaps, "rows") && (!Array.isArray(gaps.rows) || !gaps.rows.every((row: unknown) =>
        record(row) && (!Object.hasOwn(row, "task_id") || typeof row.task_id === "string"))))) return false;
  }
  return true;
}

/** Response fields are optional in the ABI. Check named facts without inventing
 * mandatory echoes: Pause has no request_id echo; Stop's request_id is custody. */
export function workAccepted(value: unknown, action: WorkAction, target: string, request?: string, cascade?: boolean): boolean {
  if (!record(value) || !shape(value) || value.ok !== true || value.unconfirmed === true
    || (value.error !== undefined && value.error !== "") || (value.task_id !== undefined && value.task_id !== target)) return false;
  if (action === "pause") {
    return (value.state === undefined || ["requested", "paused", "released"].includes(value.state))
      && !(value.state === "released" && value.latch_pending === true);
  }
  if (action === "hurry") {
    return (value.request_id === undefined || value.request_id === request)
      && (!Object.hasOwn(value, "attempt_key") || (Number.isSafeInteger(value.attempt_key) && value.attempt_key > 0));
  }
  if (["stop", "stop_earlier", "wrap_up"].includes(action)) {
    return (value.cancel_state === undefined || value.cancel_state === "pending")
      && (value.stop_policy === undefined || ["immediate", "finalize_then_cancel"].includes(value.stop_policy))
      && !(action !== "wrap_up" && value.stop_policy === "finalize_then_cancel")
      && !(cascade === true && value.cascade === false);
  }
  return true;
}

/** An alien or malformed HTTP error is not proof that this request was refused. */
export function workRefused(value: unknown, target: string): boolean {
  return record(value) && shape(value) && (value.ok === undefined || value.ok === false)
    && (value.task_id === undefined || value.task_id === target) && typeof value.error === "string" && Boolean(value.error.trim())
    && value.unconfirmed !== true && value.duplicate !== true && value.replay !== true && value.held !== true && value.tree_only !== true;
}
