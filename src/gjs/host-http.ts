import { type Gateway } from "./gateway.js";
import { boundedStream, Gio, GLib, Soup } from "./gi.js";

interface Transfer { cancel: any; stream?: any; output?: any; pumping?: boolean }
const hop = /^(cookie2?|host|connection|keep-alive|proxy-.*|te|trailer|transfer-encoding|upgrade|content-length|origin|referer|sec-.*|x-ouro-host-.*)$/i;
const read = (stream: any, cancel: any): Promise<any> => new Promise((resolve, reject) => {
  stream.read_bytes_async(65536, GLib.PRIORITY_DEFAULT, cancel, (_: unknown, result: any) => { try { resolve(stream.read_bytes_finish(result)); } catch (error) { reject(error); } });
});
const close = (stream: any): Promise<void> => new Promise(resolve => {
  stream.close_async(GLib.PRIORITY_DEFAULT, null, (_: unknown, result: any) => { try { stream.close_finish(result); } catch { /* Already retired. */ } resolve(); });
});

/** Full gateway authority follows the reviewed page_module grant, unlike widget leases. */
export class HostHttp {
  private readonly transport: ReturnType<Gateway["moduleTransport"]>;
  private readonly active = new Map<string, Transfer>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly cancelled = new Set<string>();
  private sequence = 0;
  private closed = false;
  private closing?: Promise<void>;

  constructor(private readonly gateway: Gateway, private readonly kit: any, private readonly done: (id: string) => void) {
    this.transport = gateway.moduleTransport();
  }

  cancel(id: string): void {
    const transfer = this.active.get(id);
    if (!transfer) { if (this.cancelled.size < 1024) this.cancelled.add(id); return; }
    transfer.cancel.cancel(); transfer.output?.fail("Request cancelled");
  }

  request(request: any, path: string): Promise<void> {
    const task = this.proxy(request, path).finally(() => this.tasks.delete(task));
    this.tasks.add(task); return task;
  }

  private async proxy(request: any, path: string): Promise<void> {
    if (this.closed) throw new Error("Модуль закрыт.");
    const supplied = request.get_http_headers();
    const id = supplied?.get_one("X-Ouro-Host-Request") || "native:" + ++this.sequence;
    if (this.active.has(id) || id.length > 128) throw new Error("Повторный запрос модуля.");
    const transfer: Transfer = { cancel: new Gio.Cancellable() };
    this.active.set(id, transfer);
    try {
      if (this.cancelled.delete(id)) throw new Error("Запрос отменён.");
      const headers: [string, string][] = [];
      supplied?.foreach((key: string, value: string) => { if (!hop.test(key)) headers.push([key, value]); });
      const result = await this.transport.request(request.get_http_method(), path, headers, request.get_http_body(), supplied?.get_one("X-Ouro-Host-Credentials") !== "omit", transfer.cancel);
      transfer.stream = result.stream;
      if (this.closed || transfer.cancel.is_cancelled()) { await close(result.stream); return; }
      const output = transfer.output = boundedStream();
      const response = this.kit.URISchemeResponse.new(output, -1);
      const translatedRedirect = Boolean(supplied?.get_one("X-Ouro-Host-Request")) && [301, 302, 303, 307, 308].includes(result.status)
        && result.headers.some(([key]) => key.toLowerCase() === "location");
      response.set_status(translatedRedirect ? 200 : result.status, null);
      const received = Soup.MessageHeaders.new(Soup.MessageHeadersType.RESPONSE);
      for (const [key, value] of result.headers) {
        if (/^(content-length|content-encoding|transfer-encoding|connection|access-control-allow-origin|x-ouro-host-.*)$/i.test(key)) continue;
        received.append(key, key.toLowerCase() === "location" ? this.location(value, path) : value);
      }
      if (translatedRedirect) received.replace("X-Ouro-Host-Redirect-Status", String(result.status));
      received.replace("Access-Control-Allow-Origin", "*");
      received.replace("Access-Control-Expose-Headers", "*");
      response.set_http_headers(received);
      const type = received.get_one("Content-Type"); if (type) response.set_content_type(type);
      request.finish_with_response(response);
      transfer.pumping = true;
      const pump = this.pump(transfer).finally(() => { this.active.delete(id); this.done(id); this.tasks.delete(pump); });
      this.tasks.add(pump);
    } catch (error) { if (transfer.stream && !transfer.pumping) await close(transfer.stream); throw error; }
    finally { if (!transfer.pumping) { this.active.delete(id); this.done(id); } }
  }

  private async pump(transfer: Transfer): Promise<void> {
    try {
      while (!transfer.cancel.is_cancelled()) {
        const bytes = await read(transfer.stream, transfer.cancel);
        if (!bytes.get_size()) { transfer.output.end(); return; }
        await new Promise<void>((resolve, reject) => transfer.output.write_async(bytes, transfer.cancel, (_: unknown, result: any) => {
          try { transfer.output.write_finish(result); resolve(); } catch (error) { reject(error); }
        }));
      }
      transfer.output.fail("Request cancelled");
    } catch (error) { transfer.output.fail(error instanceof Error ? error.message : String(error)); }
    finally { await close(transfer.stream); }
  }

  private location(value: string, path: string): string {
    const flags = GLib.UriFlags.ENCODED | GLib.UriFlags.SCHEME_NORMALIZE;
    const absolute = GLib.Uri.resolve_relative(this.gateway.base + path, value, flags);
    const owner = GLib.Uri.parse(this.gateway.base, flags), uri = GLib.Uri.parse(absolute, flags);
    if (uri.get_scheme() !== owner.get_scheme() || uri.get_host() !== owner.get_host() || uri.get_port() !== owner.get_port()) return absolute;
    const root = owner.get_path().replace(/\/$/, "");
    if (!uri.get_path().startsWith(root + "/")) return absolute;
    return "ouro-host://module" + uri.get_path().slice(root.length) + (uri.get_query() === null ? "" : "?" + uri.get_query());
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const [id] of this.active) this.cancel(id);
    this.cancelled.clear(); this.transport.close();
    return this.closing = Promise.allSettled(this.tasks).then(() => {});
  }
}
