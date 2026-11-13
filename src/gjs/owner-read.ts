import type { SettingsDocument } from "./settings-write.js";

export interface OwnerCognition {
  context_mode?: string;
  subagents_mode?: string;
  effort_range?: { min: string; recommended: string; max: string };
}
export interface OwnerProject { id: string; name?: string; lifecycle?: string; cognition?: OwnerCognition }
export interface OwnerDesktopState { state: string; reason?: string }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function requireShape(ok: unknown, source: string): asserts ok {
  if (!ok) throw new Error(`Неполный или неверный ответ ${source}. Перечитайте состояние перед записью.`);
}

export function readOwnerSettings(value: unknown): SettingsDocument {
  requireShape(record(value), "/api/settings");
  for (const key of ["OUROBOROS_RUNTIME_MODE", "OUROBOROS_CONTEXT_MODE", "OUROBOROS_SUBAGENTS_MODE",
    "OUROBOROS_EFFORT_MIN", "OUROBOROS_EFFORT_TASK", "OUROBOROS_EFFORT_MAX", "OUROBOROS_SAFETY_MODE",
    "OUROBOROS_CONSCIOUSNESS_SAFETY_MODE", "OUROBOROS_MODEL_SAFETY", "OUROBOROS_SAFETY_OWNER_RULES"]) {
    requireShape(typeof value[key] === "string", "/api/settings");
  }
  requireShape(typeof value.OUROBOROS_AUTO_GRANT_REVIEWED_SKILLS === "string" || typeof value.OUROBOROS_AUTO_GRANT_REVIEWED_SKILLS === "boolean", "/api/settings");
  if (value._meta !== undefined) {
    requireShape(record(value._meta), "/api/settings metadata");
    const policy = value._meta.policy_state;
    if (policy !== undefined) {
      requireShape(record(policy), "/api/settings policy");
      if (policy.access !== undefined) {
        requireShape(record(policy.access), "/api/settings access");
        for (const key of ["configured", "effective"]) requireShape(policy.access[key] === undefined || typeof policy.access[key] === "string", "/api/settings access");
      }
    }
  }
  return value;
}

export function readOwnerProjects(value: unknown): OwnerProject[] {
  requireShape(record(value) && Array.isArray(value.projects), "/api/projects");
  const ids = new Set<string>();
  for (const item of value.projects) {
    requireShape(record(item) && typeof item.id === "string" && item.id.trim() && !ids.has(item.id), "/api/projects");
    ids.add(item.id);
    for (const key of ["name", "lifecycle"]) requireShape(item[key] === undefined || typeof item[key] === "string", "/api/projects");
    if (item.cognition !== undefined) {
      const cognition = item.cognition;
      requireShape(record(cognition), "/api/projects cognition");
      for (const key of ["context_mode", "subagents_mode"]) requireShape(cognition[key] === undefined || typeof cognition[key] === "string", "/api/projects cognition");
      if (cognition.effort_range !== undefined) {
        requireShape(record(cognition.effort_range), "/api/projects effort");
        for (const key of ["min", "recommended", "max"]) requireShape(typeof cognition.effort_range[key] === "string", "/api/projects effort");
      }
    }
  }
  return (value.projects as OwnerProject[]).filter(project => project.lifecycle !== "deleting");
}

export function readOwnerDesktop(value: unknown): OwnerDesktopState {
  requireShape(record(value) && typeof value.state === "string" && value.state.length &&
    (value.reason === undefined || typeof value.reason === "string"), "/api/desktop");
  return value as unknown as OwnerDesktopState;
}
