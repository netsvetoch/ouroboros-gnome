import { type Gateway, HttpError } from "./gateway.js";
import { Gio, GLib } from "./gi.js";
import { object } from "./settings-write.js";
import { errorText } from "./ui.js";
import { type WidgetTab } from "./widget-contract.js";

const endpoint = "/api/widgets/asset-leases";

export class WidgetLease {
  private token?: string;
  private timeout = 0;
  private failures = 0;
  private closed = false;
  private renewal?: any;
  private readonly files: boolean;
  private readonly request: { skill: string; tab_id: string; generation: string; scope: "files" | "routes" };

  constructor(private readonly gateway: Gateway, tab: WidgetTab, private readonly lost: (message: string) => void) {
    this.files = tab.render.kind === "module" && tab.render.entry_type === "module";
    this.request = { skill: tab.skill, tab_id: tab.tab_id, generation: tab.generation ?? "", scope: this.files ? "files" : "routes" };
  }

  async open(): Promise<{ token: string; basePath: string }> {
    const lease = this.parse(await this.gateway.json("POST", endpoint, this.request));
    if (this.closed) {
      void this.revoke(lease.token);
      throw new Error("Виджет уже закрыт.");
    }
    this.token = lease.token;
    this.schedule(lease.seconds);
    return { token: lease.token, basePath: lease.basePath };
  }

  private parse(value: unknown): { token: string; basePath: string; seconds: number } {
    const { token, base_url, renew_after } = object(value);
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Шлюз не выдал аренду ресурсов виджета.");
    const basePath = `/api/widget-${this.files ? "assets" : "resources"}/${token}/`;
    if (base_url !== basePath || this.token && this.token !== token) throw new Error("Шлюз вернул другой адрес аренды ресурсов.");
    return { token, basePath, seconds: typeof renew_after === "number" && Number.isInteger(renew_after)
      ? Math.max(1, Math.min(120, renew_after)) : 40 };
  }

  private schedule(seconds: number): void {
    if (this.closed) return;
    this.timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
      this.timeout = 0;
      void this.renew();
      return GLib.SOURCE_REMOVE;
    });
  }

  private async renew(): Promise<void> {
    const token = this.token;
    if (!token || this.closed) return;
    const cancel = new Gio.Cancellable();
    this.renewal = cancel;
    const request = async (path: string, data: object) => {
      let expired = false;
      const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 25, () => {
        expired = true;
        cancel.cancel();
        return GLib.SOURCE_REMOVE;
      });
      try { return await this.gateway.extensionResult("POST", path, data, cancel); }
      finally { if (!expired) GLib.Source.remove(timer); }
    };
    try {
      let reply: unknown;
      try {
        reply = await request(endpoint + "/renew", { token });
      } catch (error) {
        if (this.closed) return;
        if (this.files || !(error instanceof HttpError) || error.status !== 409) throw error;
        reply = await request(endpoint, { ...this.request, token });
      }
      if (this.closed) { void this.revoke(token); return; }
      const lease = this.parse(reply);
      this.failures = 0;
      this.schedule(lease.seconds);
    } catch (error) {
      if (this.closed) return;
      if (this.files || error instanceof HttpError && [400, 401, 403, 410].includes(error.status)) {
        this.lost(redactWidgetLeases(errorText(error)));
      } else this.schedule(Math.min(40, 2 ** Math.min(6, ++this.failures)));
    } finally {
      this.renewal = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timeout) GLib.Source.remove(this.timeout);
    this.renewal?.cancel();
    if (this.token) await this.revoke(this.token);
  }

  private async revoke(token: string): Promise<void> {
    const cancel = new Gio.Cancellable();
    let expired = false;
    const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
      expired = true;
      cancel.cancel();
      return GLib.SOURCE_REMOVE;
    });
    try { await this.gateway.extensionResult("POST", endpoint + "/revoke", { token }, cancel); }
    catch { /* An unconfirmed revocation still has a finite lease. */ }
    finally { if (!expired) GLib.Source.remove(timer); }
  }
}

export function redactWidgetLeases(text: string): string {
  return text.replace(/(\/api\/widget-(?:assets|resources)\/)[A-Za-z0-9_-]{43}/g, "$1[скрыто]");
}
