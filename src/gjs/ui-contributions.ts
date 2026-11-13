import { type Gateway, type GatewayFrame } from "./gateway.js";
import { Gio } from "./gi.js";
import { errorText } from "./ui.js";

export interface VoicePreferences { stt?: string; tts?: string; tts_voice?: string }

interface ContributionIdentity {
  key: string;
  skill: string;
  id: string;
  label: string;
  title?: string;
  skill_label?: string;
  revision?: string;
}

export interface HostContribution extends ContributionIdentity {
  provides?: string;
  runtime?: string;
  render?: { kind?: string; url?: string };
  destination?: string;
}

export interface SpeechProvider extends HostContribution {
  provides: "stt" | "tts";
  runtime: "server" | "client";
  render?: { kind?: string; url?: string };
  destination?: string;
  route_url?: string;
  languages?: string[];
  formats?: string[];
  max_bytes?: number;
  max_seconds?: number;
}

export type Placement = "composer.plus" | "composer.chips" | "message.action";

export interface PlacedContribution extends HostContribution {
  placement: Placement;
  icon?: string;
  icon_spec?: { kind?: string; name?: string; svg?: string };
  order?: number;
  route_url?: string;
  render?: { kind?: string; url?: string };
  source?: { url: string; refresh_s: number };
  action: { verb: string; text?: string; url?: string; with?: string; then?: string };
}

type Contribution = PlacedContribution | SpeechProvider | HostContribution;
export interface ContributionArrangement { hidden?: string[]; order?: string[] }

export interface SpeechOffer {
  skill: string;
  id: string;
  label: string;
  title?: string;
  destination?: string;
  install_size?: string;
  installed?: boolean;
}

interface Projection {
  contributions?: Contribution[];
  offers?: { stt?: SpeechOffer[] };
  preferences?: { voice?: VoicePreferences; contributions?: ContributionArrangement };
}

const record = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(key => typeof key === "string");
function arrangement(value: unknown): value is ContributionArrangement {
  return record(value) && strings(value.hidden) && strings(value.order);
}
function voice(value: unknown): value is VoicePreferences {
  return record(value) && ["stt", "tts", "tts_voice"].every(key => typeof value[key] === "string");
}
function readProjection(value: unknown): Projection {
  const optionalText = (row: Record<string, any>, keys: string[]) => keys.every(key => row[key] === undefined || typeof row[key] === "string");
  if (!record(value) || !Array.isArray(value.contributions) || !record(value.preferences)
    || !voice(value.preferences.voice) || !arrangement(value.preferences.contributions)
    || !record(value.offers) || !Array.isArray(value.offers.stt)
    || value.offers.stt.some((row: unknown) => !record(row) || !["skill", "id", "label"].every(key => typeof row[key] === "string")
      || !optionalText(row, ["title", "destination", "install_size"]) || row.installed !== undefined && typeof row.installed !== "boolean")
    || value.contributions.some((row: unknown) => !record(row)
      || !["key", "skill", "id", "label"].every(key => typeof row[key] === "string" && Boolean(row[key]))
      || !optionalText(row, ["title", "skill_label", "revision", "route_url", "icon", "placement", "provides", "runtime", "destination"])
      || row.order !== undefined && (typeof row.order !== "number" || !Number.isFinite(row.order))
      || row.placement !== undefined && (!record(row.action) || typeof row.action.verb !== "string" || !optionalText(row.action, ["text", "url", "with", "then"]))
      || row.source !== undefined && (!record(row.source) || typeof row.source.url !== "string" || typeof row.source.refresh_s !== "number" || !Number.isFinite(row.source.refresh_s))
      || row.render !== undefined && (!record(row.render) || !optionalText(row.render, ["kind", "url"]))
      || row.icon_spec !== undefined && (!record(row.icon_spec) || !optionalText(row.icon_spec, ["kind", "name", "svg"]))
      || ["languages", "formats"].some(key => row[key] !== undefined && !strings(row[key]))
      || ["max_bytes", "max_seconds"].some(key => row[key] !== undefined && (typeof row[key] !== "number" || !Number.isFinite(row[key]) || row[key] < 0)))
    || new Set(value.contributions.map((row: ContributionIdentity) => row.key)).size !== value.contributions.length) {
    throw new Error("Шлюз вернул неполный каталог элементов навыков. Сохранён последний прочитанный каталог.");
  }
  return value as Projection;
}

const lifecycleEnds = new Set(["completed", "failed", "cancelled"]);
const preferencesPath = "/api/ui/preferences";

/** Projection routes are relative to the declaring skill and have no query or fragment. */
export function contributionRoute(skill: string, path: string | undefined): string | undefined {
  if (!skill || skill.startsWith(".") || /[/%\\?#:\s\x00-\x1f\x7f]/u.test(skill)) return undefined;
  const prefix = `/api/extensions/${encodeURIComponent(skill)}/`;
  if (!path?.startsWith(prefix)) return undefined;
  try {
    const segments = path.slice(prefix.length).split("/").map(decodeURIComponent);
    return segments.every((part) => part && !part.startsWith(".") && !/[/%\\?#:\s\x00-\x1f\x7f]/u.test(part)) ? path : undefined;
  } catch { return undefined; }
}

export class UiContributions {
  current: Projection = {};
  error = "";
  private reading?: Promise<void>;
  private again = false;
  private closed = false;
  private readCancel?: any;
  private readonly writes = new Set<any>();
  private preferenceWriting = false;
  private version = 0;

  constructor(private readonly gateway: Gateway, private readonly changed: () => void) {}

  hostEntries(): HostContribution[] {
    return (this.current.contributions ?? []).filter(item => item.render?.kind === "host");
  }

  speech(kind: "stt" | "tts"): SpeechProvider[] {
    return (this.current.contributions ?? []).filter((item): item is SpeechProvider =>
      "provides" in item && item.provides === kind);
  }

  placed(placement: Placement, includeHidden = false,
    arrangement = this.current.preferences?.contributions): PlacedContribution[] {
    const order = new Map((arrangement?.order ?? []).map((key, index) => [key, index]));
    const hidden = new Set(arrangement?.hidden ?? []);
    return (this.current.contributions ?? []).filter((item): item is PlacedContribution =>
      "placement" in item && item.placement === placement && (includeHidden || !hidden.has(item.key)))
      .sort((a, b) => (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity)
        || (a.order ?? 0) - (b.order ?? 0) || (a.key < b.key ? -1 : a.key === b.key ? 0 : 1));
  }

  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.reading) {
      this.again = true;
      return this.reading;
    }
    this.reading = (async () => {
      do {
        this.again = false;
        const version = this.version;
        try {
          const cancel = new Gio.Cancellable();
          this.readCancel = cancel;
          const projection = readProjection(await this.gateway.json("GET", "/api/ui/contributions", undefined, undefined, false, cancel));
          if (this.closed) return;
          if (version !== this.version) continue;
          this.current = projection;
          this.error = "";
        } catch (error) {
          if (this.closed) return;
          if (version !== this.version) continue;
          this.error = errorText(error);
        }
        this.changed();
      } while (this.again && !this.closed);
    })().finally(() => { this.reading = undefined; this.readCancel = undefined; });
    return this.reading;
  }

  frame(frame: GatewayFrame): void {
    if (frame.type === "extension_lifecycle") void this.refresh();
    if (frame.type === "chat" && frame.system_type === "skill_lifecycle") {
      const lifecycle = frame.lifecycle ?? (frame.progress_meta as { lifecycle?: unknown } | undefined)?.lifecycle;
      if (lifecycleEnds.has(String((lifecycle as { phase?: unknown } | undefined)?.phase))) void this.refresh();
    }
  }

  async saveVoice(value: VoicePreferences, callerCancel?: any): Promise<void> {
    await this.savePreferences(() => ({ voice: value }), callerCancel);
  }

  async saveArrangement(patch: (current: ContributionArrangement) => ContributionArrangement | undefined, callerCancel?: any): Promise<void> {
    await this.savePreferences(latest => {
      const change = patch(latest.contributions);
      return change ? { contributions: change } : undefined;
    }, callerCancel);
  }

  private async savePreferences(patch: (latest: { voice: VoicePreferences; contributions: ContributionArrangement }) => { voice?: VoicePreferences; contributions?: ContributionArrangement } | undefined, callerCancel?: any): Promise<void> {
    if (this.closed || callerCancel?.is_cancelled()) return;
    if (this.preferenceWriting) throw new Error("Другая запись настроек элементов навыков ещё не завершена.");
    const cancel = new Gio.Cancellable();
    const caller = callerCancel?.connect(() => cancel.cancel());
    this.writes.add(cancel);
    this.preferenceWriting = true;
    this.version++;
    this.readCancel?.cancel();
    let attempted = false;
    const read = (value: unknown, written = false): { voice: VoicePreferences; contributions: ContributionArrangement } => {
      if (!record(value) || written && value.ok !== true || value.ok !== undefined && value.ok !== true || !voice(value.voice) || !arrangement(value.contributions)) {
        throw new Error("Шлюз не вернул полные настройки элементов навыков.");
      }
      return value as { voice: VoicePreferences; contributions: ContributionArrangement };
    };
    try {
      const latest = read(await this.gateway.json("GET", preferencesPath, undefined, undefined, false, cancel));
      if (this.closed || cancel.is_cancelled()) return;
      const changes = patch(latest);
      attempted = Boolean(changes);
      const result = changes ? read(await this.gateway.json("POST", preferencesPath, changes, undefined, false, cancel), true) : latest;
      if (this.closed || cancel.is_cancelled()) return;
      if (changes?.voice && Object.entries(changes.voice).some(([key, value]) => value !== undefined && result.voice[key as keyof VoicePreferences] !== value)
        || changes?.contributions && Object.entries(changes.contributions).some(([key, values]) => JSON.stringify(result.contributions[key as keyof ContributionArrangement]) !== JSON.stringify([...new Set(values)]))) {
        throw new Error("Ответ не подтверждает выбранные настройки элементов навыков.");
      }
      this.current = { ...this.current, preferences: { ...this.current.preferences, voice: result.voice, contributions: result.contributions } };
      this.changed();
      await this.refresh();
    } catch (error) {
      if (!this.closed) throw new Error(attempted ? `Результат записи настроек неизвестен. ${errorText(error)}` : errorText(error));
    } finally {
      if (caller) callerCancel.disconnect(caller);
      this.writes.delete(cancel);
      this.preferenceWriting = false;
    }
  }

  close(): void {
    this.closed = true;
    this.readCancel?.cancel();
    for (const cancel of this.writes) cancel.cancel();
    this.writes.clear();
  }
}
