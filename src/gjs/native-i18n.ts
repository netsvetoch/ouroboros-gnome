import type { Gateway, GatewayFrame } from "./gateway.js";
import { Gio, GLib, Gtk } from "./gi.js";

import { readI18nSnapshot, type I18nSnapshot as Memory } from "./i18n-contract.js";

interface Binding {
  object: WeakRef<any>; property: string; source: string; params?: Record<string, string | number>;
  signal: number; painting: boolean;
}
const path = "/api/ui/i18n";
const normalized = (value: string) => value.replace(/[ \t\n\r\f\v]+/gu, " ").trim();
const record = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value));
let active: NativeI18n | undefined;

export function useNativeI18n(value?: NativeI18n): void { active = value; }
export function refreshNativeI18n(): void { active?.refresh(); }
/** Resolve a known static chrome source, never an owner value or descriptor. */
export function chromeText(english: string, params?: Record<string, string | number>, fallback = english): string {
  return active?.translate(english, params) ?? fallback;
}
export function watchNativeI18n(changed: () => void): () => void {
  return active?.watch(changed) ?? (() => {});
}

/** Opt-in chrome only: never call this with a model string, filename, or owner input. */
export function chrome<T>(object: T, property: string, english: string, params?: Record<string, string | number>): T {
  active?.bind(object, property, english, params);
  return object;
}
/** A chrome binding owned by a short-lived dialog. Call the release on close. */
export function bindChrome(object: any, property: string, english: string, params?: Record<string, string | number>): () => void {
  return active?.bind(object, property, english, params) ?? (() => {});
}

export class NativeI18n {
  private readonly cancel = new Gio.Cancellable();
  private readonly bindings = new Set<Binding>();
  private readonly indexed = new WeakMap<object, Map<string, Binding>>();
  private readonly revisions = new Map<string, number>();
  private readonly missing = new Map<string, { key: string; context: Record<string, unknown> }>();
  private readonly reported = new Set<string>();
  private readonly watchers = new Set<() => void>();
  private memory?: Memory;
  private expected?: string;
  private timer = 0;
  private flushTimer = 0;
  private reading = false;
  private readAgain = false;
  private posting = false;
  private closed = false;
  private readonly poll: number;

  constructor(private readonly gateway: Gateway) {
    this.poll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
      this.refresh(); return GLib.SOURCE_CONTINUE;
    });
    this.refresh();
  }

  get language(): string | undefined { return this.memory?.language; }
  get revision(): number | undefined { return this.memory?.revision; }
  watch(changed: () => void): () => void {
    if (this.closed) return () => {};
    this.watchers.add(changed);
    return () => { this.watchers.delete(changed); };
  }

  bind(object: any, property: string, english: string, params?: Record<string, string | number>): () => void {
    if (this.closed || !normalized(english)) return () => {};
    const properties = this.indexed.get(object) ?? new Map<string, Binding>();
    const previous = properties.get(property);
    if (previous) this.remove(previous);
    const binding: Binding = { object: new WeakRef(object), property, source: english,
      params: params && { ...params }, signal: 0, painting: false };
    // An unmarked writer owns subsequent content (for example an owner-supplied title).
    // Stop translating it rather than overwriting it on the next language change.
    binding.signal = object.connect(`notify::${property}`, () => {
      if (!binding.painting) this.remove(binding);
    });
    properties.set(property, binding);
    this.indexed.set(object, properties);
    this.bindings.add(binding);
    this.paint(binding);
    return () => this.remove(binding);
  }

  frame(frame: GatewayFrame): void {
    if (this.closed || typeof frame.language !== "string") return;
    if (frame.type === "ui_language_changed") {
      this.expected = frame.language;
      this.refresh();
    } else if (frame.type === "ui_i18n_updated" && Number.isSafeInteger(frame.revision)) {
      const revision = Number(frame.revision);
      this.revisions.set(frame.language, Math.max(revision, this.revisions.get(frame.language) ?? 0));
      if (frame.language === this.memory?.language && revision > this.memory.revision) this.refresh();
    }
  }

  reconnect(): void { this.expected = undefined; this.refresh(); }

  refresh(): void {
    if (this.closed || this.timer) return;
    if (this.reading) { this.readAgain = true; return; }
    this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 90, () => {
      this.timer = 0; void this.read(); return GLib.SOURCE_REMOVE;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (active === this) active = undefined;
    this.cancel.cancel();
    GLib.Source.remove(this.poll);
    if (this.timer) GLib.Source.remove(this.timer);
    if (this.flushTimer) GLib.Source.remove(this.flushTimer);
    for (const binding of [...this.bindings]) this.remove(binding);
    this.missing.clear();
    this.watchers.clear();
  }

  private remove(binding: Binding): void {
    const object = binding.object.deref();
    if (object && binding.signal) {
      try { object.disconnect(binding.signal); } catch { /* a disposed GTK widget */ }
      if (this.indexed.get(object)?.get(binding.property) === binding) this.indexed.get(object)?.delete(binding.property);
    }
    binding.signal = 0;
    this.bindings.delete(binding);
  }

  private async read(): Promise<void> {
    this.reading = true;
    try {
      const raw = await this.gateway.json<unknown>("GET", path, undefined, undefined, false, this.cancel);
      if (this.closed) return;
      const value = readI18nSnapshot(raw);
      if (value.memory_error) return;
      if (this.expected !== undefined && value.language !== this.expected
        || value.revision < (this.revisions.get(value.language) ?? 0)) { this.readAgain = true; return; }
      const changed = this.memory?.language !== value.language || this.memory?.revision !== value.revision;
      this.memory = value;
      this.expected = undefined;
      this.revisions.set(value.language, value.revision);
      if (changed) { this.reported.clear(); this.missing.clear(); }
      for (const binding of [...this.bindings]) this.paint(binding);
      if (changed) for (const notify of [...this.watchers]) notify();
    } catch { /* Keep the last verified memory; retry on reconnect, frame or poll. */ }
    finally {
      this.reading = false;
      if (this.readAgain) { this.readAgain = false; this.refresh(); }
    }
  }

  private category(n: unknown): string {
    if (typeof n !== "number" || !Number.isFinite(n)) return "other";
    const value = Math.abs(n), rules = this.memory?.plural_select;
    if (Number.isInteger(value) && record(rules?.map)) {
      const exact = rules.map[String(value)];
      const periodic = rules.period && rules.period > 0 ? rules.map[String(value % rules.period)] : undefined;
      if (typeof exact === "string") return exact;
      if (typeof periodic === "string") return periodic;
    }
    try {
      const language = this.memory?.language;
      if (language && Intl.PluralRules.supportedLocalesOf([language]).length) return new Intl.PluralRules(language).select(value);
    } catch { /* Unknown languages use the memory's map or other. */ }
    return "other";
  }

  translate(source: string, params?: Record<string, string | number>): string {
    let text = source;
    const key = normalized(text), memory = this.memory;
    if (memory && !memory.english) {
      const entry = memory.entries[key];
      const forms = record(entry?.forms) ? entry.forms : undefined;
      const translated = typeof entry?.text === "string" ? entry.text : forms?.[this.category(params?.n)]
        ?? forms?.other ?? forms?.many ?? (forms && Object.values(forms)[0]);
      if (typeof translated === "string") text = translated;
      else if (!this.reported.has(key)) {
        this.missing.set(key, { key, context: { surface: "gnome", role: "chrome", params: Object.keys(params ?? {}) } });
        this.planFlush();
      }
    }
    return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (match, key: string) =>
      params && Object.hasOwn(params, key) ? String(params[key]) : match);
  }

  private paint(binding: Binding): void {
    if (!this.bindings.has(binding)) return;
    const object = binding.object.deref();
    if (!object) { this.remove(binding); return; }
    binding.painting = true;
    try {
      object.set_property(binding.property, this.translate(binding.source, binding.params));
      if (object instanceof Gtk.Widget) {
        // Call the base method: Gtk.MenuButton.set_direction is an arrow setter.
        Gtk.Widget.prototype.set_direction.call(object,
          this.memory?.profile?.direction === "rtl" ? Gtk.TextDirection.RTL : Gtk.TextDirection.LTR);
      }
    } catch { this.remove(binding); }
    finally { binding.painting = false; }
  }

  private planFlush(): void {
    if (this.closed || this.flushTimer || this.posting || !this.missing.size) return;
    this.flushTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
      this.flushTimer = 0; void this.flush(); return GLib.SOURCE_REMOVE;
    });
  }

  private async flush(): Promise<void> {
    const memory = this.memory;
    if (this.closed || !memory || memory.english || this.posting) return;
    const items = [...this.missing.values()].slice(0, 200);
    if (!items.length) return;
    this.posting = true;
    try {
      const saved = await this.gateway.json<{ accepted?: number }>("POST", `${path}/missing`,
        { language: memory.language, items }, undefined, false, this.cancel);
      if (!this.closed && this.memory === memory && Number.isSafeInteger(saved?.accepted)) {
        for (const { key } of items) { this.missing.delete(key); this.reported.add(key); }
      }
    } catch { /* No text or parameters from user content are ever queued here. */ }
    finally { this.posting = false; this.planFlush(); }
  }
}
