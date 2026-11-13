import { type Gateway } from "./gateway.js";
import { gatewayStatePath, readGatewayState, writeGatewayState } from "./gateway-state.js";
import { object } from "./settings-write.js";

interface Hold { key: string; rev: string }
const ledgers = new WeakMap<Gateway, FrameLedger>();

class FrameLedger {
  private readonly path: string;
  private readonly holding = new Map<string, string>();
  private readonly starting = new Map<string, { rev: string; count: number }>();
  private readonly stopped = new Set<string>();
  private readonly pending = new Map<string, string>();
  private reporting = false;

  constructor(private readonly gateway: Gateway) {
    this.path = gatewayStatePath(gateway.base, "widget-launches");
    let saved = {};
    try { saved = object(readGatewayState(this.path)); } catch { /* The first run has no ledger. */ }
    const state = object(saved);
    for (const [key, rev] of Object.entries({ ...object(state.holding), ...object(state.starting) })) {
      if (typeof rev === "string") this.holding.set(key, rev);
    }
    for (const [key, rev] of Object.entries({ ...object(state.pending), ...object(state.starting) })) {
      if (typeof rev === "string") this.pending.set(key, rev);
    }
    if (Array.isArray(state.stopped)) for (const key of state.stopped) if (typeof key === "string") this.stopped.add(key);
    if (Object.keys(object(state.starting)).length) {
      try { this.write(); } catch { /* The original start remains on disk. */ }
    }
    this.report();
  }

  held(key: string, revision: string): boolean { return this.holding.get(key) === revision; }
  isStopped(key: string): boolean { return this.stopped.has(key); }

  begin(key: string, rev: string): void {
    const existing = this.starting.get(key);
    this.starting.set(key, { rev, count: existing?.rev === rev ? existing.count + 1 : 1 });
    try { this.write(); }
    catch (error) {
      if (existing) this.starting.set(key, existing);
      else this.starting.delete(key);
      throw error;
    }
  }

  settled(key: string, rev: string): void {
    const current = this.starting.get(key);
    if (current?.rev !== rev) return;
    if (--current.count <= 0) this.starting.delete(key);
    this.write();
  }

  allow(key: string, stopKey: string): void {
    this.holding.delete(key);
    this.stopped.delete(stopKey);
    this.write();
  }

  resume(key: string): void {
    if (this.stopped.delete(key)) this.write();
  }

  hold(key: string, rev: string): void {
    this.holding.set(key, rev);
    this.pending.set(key, rev);
    this.settled(key, rev);
    this.report();
  }

  stop(key: string): void {
    this.stopped.add(key);
    this.write();
  }

  report(): void {
    if (!this.pending.size || this.reporting) return;
    this.reporting = true;
    let confirmed = false;
    const holds: Hold[] = [...this.pending].slice(0, 50).map(([key, rev]) => ({ key, rev }));
    void this.gateway.json<{ ok?: boolean; named?: number }>("POST", "/api/ui/holds", { holds, surface: { pywebview: false, telegram: false } })
      .then((reply) => {
        if (reply?.ok === true && Number.isSafeInteger(reply.named) && reply.named! >= 0 && reply.named! <= holds.length) {
          confirmed = true;
          for (const { key, rev } of holds) if (this.pending.get(key) === rev) this.pending.delete(key);
          this.write();
        }
      }).catch(() => {}).finally(() => {
        this.reporting = false;
        if (confirmed && this.pending.size) this.report();
      });
  }

  private write(): void {
    writeGatewayState(this.path, {
      starting: Object.fromEntries([...this.starting].map(([key, value]) => [key, value.rev])),
      holding: Object.fromEntries(this.holding), stopped: [...this.stopped], pending: Object.fromEntries(this.pending),
    });
  }
}

export function frameLedger(gateway: Gateway): FrameLedger {
  const existing = ledgers.get(gateway);
  if (existing) return existing;
  const ledger = new FrameLedger(gateway);
  ledgers.set(gateway, ledger);
  return ledger;
}
