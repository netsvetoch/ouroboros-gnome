import { object } from "./settings-write.js";
import { exactWorkTarget } from "./work-actions.js";

/** Root-attempt predicate for fallback controls, mirroring resolve_task_lineage.
 * A supplied empty canonical field overrides metadata; null uses metadata.
 * Unreadable relevant fields cannot grant a whole-root operation.
 */
export function rootTaskAttempt(raw: unknown, id: string): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !exactWorkTarget(id)) return false;
  const task = object(raw), metadata = object(task.metadata);
  const field = (key: string): string | undefined => {
    const value = task[key] ?? metadata[key];
    return value == null ? "" : typeof value === "string" ? value.trim() : undefined;
  };
  const root = field("root_task_id"), parent = field("parent_task_id"), role = field("delegation_role");
  if (root === undefined || parent === undefined || role === undefined || parent) return false;
  if ((root || id) === id) return role.toLowerCase() !== "subagent";
  const original = field("original_task_id"), retry = field("timeout_retry_from");
  return role.toLowerCase() === "root" && Boolean(original) && original !== id && original === retry;
}
