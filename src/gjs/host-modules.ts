import { type Gateway } from "./gateway.js";
import { HostModule } from "./host-module.js";
import { type HostContribution, type UiContributions } from "./ui-contributions.js";
import { button, clear, column, errorText, label } from "./ui.js";

const instances = new WeakMap<Gateway, Set<HostModules>>();
const halted = new WeakSet<Gateway>();

/** Panic is local and immediate even when the gateway cannot acknowledge it. */
export function stopHostModules(gateway: Gateway): Promise<void> {
  halted.add(gateway);
  gateway.cancelModulePreparation();
  return Promise.all([...(instances.get(gateway) ?? [])].map(manager => manager.stop())).then(() => {});
}

/** Revision-bound providers owned by one native chat page. */
export class HostModules {
  readonly widget = column(2);
  private readonly views = column(0);
  private readonly holds = column(2);
  private readonly entries = new Map<string, { signature: string; module?: HostModule; error?: string; announced?: boolean }>();
  private readonly availability = new WeakSet<HostModule>();
  private readonly drains = new Set<Promise<void>>();
  private closed = false;
  private stopped = false;
  private closing?: Promise<void>;

  constructor(private readonly gateway: Gateway, private readonly catalog: UiContributions,
    private readonly callbacks: { changed: () => void; notice: (text: string) => void; insert: (text: string) => boolean }) {
    this.widget.append(this.holds); this.widget.append(this.views);
    this.stopped = halted.has(gateway);
    const owners = instances.get(gateway) ?? new Set<HostModules>();
    owners.add(this); instances.set(gateway, owners);
  }

  get(item: HostContribution): HostModule | undefined {
    const entry = this.entries.get(item.key);
    return entry?.signature === this.signature(item) ? entry.module : undefined;
  }

  reason(item: HostContribution): string {
    if (this.stopped) return "Модули остановлены аварийной остановкой. Переподключитесь к шлюзу для нового запуска.";
    const module = this.get(item);
    if (!module) return this.entries.get(item.key)?.error || "Модуль движка ещё не загружен.";
    if (module.status === "held") return "Запуск модуля приостановлен после незавершённого запуска. Нажмите «Запустить модуль».";
    if (module.status === "error") return module.error;
    if (module.status !== "ready") return "Модуль движка загружается.";
    return module.provider?.availability.ok ? "" : module.provider?.availability.reason || module.provider?.availability.code || "Модуль не зарегистрировал доступный движок.";
  }

  private signature(item: HostContribution): string { return JSON.stringify([item.skill, item.id, item.revision, item.provides, item.runtime, item.render, item.label, item.destination]); }

  reconcile(): void {
    if (this.closed || this.stopped || this.catalog.error) return;
    const items = this.catalog.hostEntries();
    const live = new Map(items.map(item => [item.key, item]));
    for (const [key, entry] of this.entries) {
      if (live.has(key) && entry.signature === this.signature(live.get(key)!)) continue;
      this.entries.delete(key);
      if (entry.module) this.retire(entry.module);
    }
    for (const item of items) {
      if (this.entries.has(item.key)) {
        const module = this.entries.get(item.key)?.module;
        if (module?.status === "ready" && item.runtime === "client" && ["stt", "tts"].includes(item.provides ?? "") && !this.availability.has(module)) {
          this.availability.add(module);
          void module.call("available").catch(() => {}).finally(() => this.availability.delete(module));
        }
        continue;
      }
      const entry: { signature: string; module?: HostModule; error?: string; announced?: boolean } = { signature: this.signature(item) };
      this.entries.set(item.key, entry);
      try {
        const module = new HostModule(this.gateway, item, {
          changed: () => { if (!this.closed && this.entries.get(item.key) === entry) {
            if (entry.module?.status === "error" && !entry.announced) {
              entry.announced = true;
              this.callbacks.notice(`${item.skill_label || item.skill}: ${entry.module.error}`);
            }
            this.render(); this.callbacks.changed();
          } },
          notice: text => { if (!this.closed && this.entries.get(item.key) === entry) this.callbacks.notice(text); },
          insert: text => !this.closed && this.entries.get(item.key) === entry && this.callbacks.insert(text),
        });
        entry.module = module; this.views.append(module.widget);
        void module.start().catch(() => {});
      } catch (error) { entry.error = errorText(error); }
    }
    this.render();
  }

  private render(): void {
    clear(this.holds);
    for (const entry of this.entries.values()) {
      const module = entry.module;
      if (module) this.holds.append(module.media.widget);
      if (entry.error || module?.status === "error") {
        this.holds.append(label((module?.item.label || "Модуль") + ": " + (entry.error || module?.error), "dim-label"));
      }
      if (module?.status !== "held") continue;
      this.holds.append(label(module.item.label + ": " + this.reason(module.item), "dim-label"));
      const release = button("Запустить модуль", () => {
        if (this.closed || this.entries.get(module.item.key) !== entry || module.status !== "held") return;
        release.set_sensitive(false); void module.release().catch(() => {});
      });
      this.holds.append(release);
    }
  }

  private retire(module: HostModule): void {
    const drain = module.close().finally(() => {
      if (module.widget.get_parent() === this.views) this.views.remove(module.widget);
      this.drains.delete(drain);
    });
    this.drains.add(drain);
  }

  stop(): Promise<void> {
    this.stopped = true;
    const closing = this.close();
    this.callbacks.changed();
    return closing;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const entry of this.entries.values()) if (entry.module) this.retire(entry.module);
    this.entries.clear(); clear(this.holds);
    instances.get(this.gateway)?.delete(this);
    return this.closing = Promise.all(this.drains).then(() => {});
  }
}
