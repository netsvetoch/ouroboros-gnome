export interface Translation {
  text?: string; forms?: Record<string, string>; provenance?: string; source?: string;
  source_hash?: string; model?: string; at?: string; attempt_id?: string; pack?: string; pack_version?: string; context?: string;
}
export interface Language { language: string; label?: string; entries?: number; pending?: number; malformed?: boolean }
export interface I18nSnapshot {
  language: string;
  chosen: boolean;
  english: boolean;
  revision: number;
  profile?: { label?: string; instruction?: string; direction?: string; lexicon_chars?: number } | null;
  plural_select?: { period?: number | null; map?: Record<string, string> } | null;
  plural_categories?: string[] | null;
  entries: Record<string, Translation>;
  languages: Language[];
  stats: { entries?: number; generated?: number; owner?: number; imported?: number; stale?: number | null; pending?: number; refused?: number };
  generator: { state?: string; error?: string; updated_at?: string; applied?: number; language?: string; in_flight?: number };
  updated_at?: string;
  memory_error?: string;
}

const tag = /^(?=.{1,48}$)[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,8}$/u;
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const strings = (value: unknown) => record(value) && Object.values(value).every(item => typeof item === "string");

export function readI18nSnapshot(value: unknown): I18nSnapshot {
  const stats = record(value) ? value.stats : undefined;
  const generator = record(value) ? value.generator : undefined;
  const profile = record(value) ? value.profile : undefined;
  if (!record(value) || typeof value.language !== "string" || !count(value.revision)
    || typeof value.english !== "boolean" || typeof value.chosen !== "boolean"
    || !record(value.entries) || Object.values(value.entries).some(item => !record(item)
      || ["text", "provenance", "source", "source_hash", "model", "at", "attempt_id", "pack", "pack_version", "context"]
        .some(key => item[key] !== undefined && typeof item[key] !== "string")
      || item.forms !== undefined && !strings(item.forms))
    || !Array.isArray(value.languages) || value.languages.some(item => !record(item) || typeof item.language !== "string"
      || !tag.test(item.language) || (item.label !== undefined && typeof item.label !== "string")
      || ["entries", "pending"].some(key => item[key] !== undefined && !count(item[key]))
      || item.malformed !== undefined && typeof item.malformed !== "boolean")
    || !record(stats) || ["entries", "generated", "owner", "imported", "pending", "refused"]
      .some(key => stats[key] !== undefined && !count(stats[key]))
    || stats.stale != null && !count(stats.stale)
    || !record(generator) || ["state", "error", "updated_at", "language"].some(key => generator[key] !== undefined && typeof generator[key] !== "string")
    || ["applied", "in_flight"].some(key => generator[key] !== undefined && !count(generator[key]))
    || ["updated_at", "memory_error"].some(key => value[key] !== undefined && typeof value[key] !== "string")
    || (profile != null && (!record(profile)
      || ["label", "instruction", "direction"].some(key => profile[key] !== undefined && typeof profile[key] !== "string")
      || profile.lexicon_chars !== undefined && !count(profile.lexicon_chars)))
    || (value.plural_categories != null && (!Array.isArray(value.plural_categories) || value.plural_categories.some(item => typeof item !== "string")))
    || (value.plural_select != null && (!record(value.plural_select)
      || value.plural_select.map !== undefined && !strings(value.plural_select.map)
      || value.plural_select.period != null && (!count(value.plural_select.period) || value.plural_select.period === 0)))) {
    throw new Error("Шлюз вернул неизвестный формат словаря.");
  }
  return value as unknown as I18nSnapshot;
}
