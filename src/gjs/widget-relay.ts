import { type Gateway } from "./gateway.js";
import { Gio, GLib } from "./gi.js";
import { type SettingsDocument, object } from "./settings-write.js";
import { chooseFile, errorText } from "./ui.js";
import { widgetMediaPath } from "./widget-contract.js";
import { redactWidgetLeases } from "./widget-lease.js";

interface Request { cancel: any; stream?: any; timer: number; pulling: boolean }
export type WidgetRequestId = number | string;
const forbiddenHeader = /^(authorization|cookie2?|connection|content-length|host|origin|referer|transfer-encoding|upgrade|proxy-|sec-|x-ouroboros-)/i;
const urlFlags = GLib.UriFlags.ENCODED | GLib.UriFlags.SCHEME_NORMALIZE;

function readBytes(stream: any, size: number, cancel: any): Promise<any> {
  return new Promise((resolve, reject) => {
    stream.read_bytes_async(size, GLib.PRIORITY_DEFAULT, cancel, (_stream: unknown, result: unknown) => {
      try { resolve(stream.read_bytes_finish(result)); } catch (error) { reject(error); }
    });
  });
}

function bodyBytes(value: unknown): Uint8Array | undefined {
  if (value == null) return;
  if (typeof value === "string") return new TextEncoder().encode(value);
  const base64 = object(value).base64;
  if (typeof base64 !== "string" || base64.length > 45 * 1024 * 1024 || !/^[A-Za-z0-9+/=]*$/.test(base64)) {
    throw new Error("Тело запроса виджета недоступно.");
  }
  return GLib.base64_decode(base64);
}

export class WidgetRelay {
  private readonly requests = new Map<WidgetRequestId, Request>();
  private readonly downloads = new Set<any>();
  private readonly owner: any;
  private closed = false;

  constructor(private readonly gateway: Gateway, private readonly skill: string, private readonly basePath: string,
    private readonly fileLease: boolean, private readonly parent: any, private readonly send: (message: SettingsDocument) => void) {
    this.owner = GLib.Uri.parse(gateway.base, urlFlags);
  }

  close(): void {
    this.closed = true;
    for (const [id, request] of this.requests) this.finish(id, request);
    for (const request of this.downloads) request.cancel();
    this.downloads.clear();
  }

  private resolve(value: unknown, method: string): { path: string; authenticated: boolean } {
    if (typeof value !== "string" || !value || value.length > 8192 || /[\\\x00-\x20\x7f]/.test(value)) {
      throw new Error("Адрес запроса виджета недоступен.");
    }
    const base = this.gateway.base + (this.fileLease ? this.basePath : "/");
    const uri = GLib.Uri.parse(GLib.Uri.resolve_relative(base, value, urlFlags), urlFlags);
    if (uri.get_scheme() !== this.owner.get_scheme() || uri.get_host()?.toLowerCase() !== this.owner.get_host()?.toLowerCase()
      || uri.get_port() !== this.owner.get_port() || uri.get_userinfo() !== null) throw new Error("Запрос за пределы маршрутов навыка отклонён.");
    const root = this.owner.get_path().replace(/\/$/, "");
    const pathname: string = uri.get_path();
    if (!pathname.startsWith(root + "/")) throw new Error("Запрос за пределы маршрутов навыка отклонён.");
    const path = pathname.slice(root.length);
    const query = uri.get_query();
    const suffix = query === null ? "" : "?" + query;
    if (path.startsWith(this.basePath)) {
      const asset = path.slice(this.basePath.length);
      if (this.fileLease) {
        if (!["GET", "HEAD"].includes(method) || !asset.split("/").every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== "..")) {
          throw new Error("Аренда файлов допускает чтение объявленных ресурсов.");
        }
        return { path: path + suffix, authenticated: false };
      }
      const mapped = `/api/extensions/${encodeURIComponent(this.skill)}/${asset}` + suffix;
      if (widgetMediaPath(this.skill, mapped)) return { path: mapped, authenticated: true };
    }
    if (widgetMediaPath(this.skill, path + suffix)) return { path: path + suffix, authenticated: true };
    throw new Error("Запрос за пределы маршрутов навыка отклонён.");
  }

  private finish(id: WidgetRequestId, request: Request): void {
    if (this.requests.get(id) !== request) return;
    this.requests.delete(id);
    if (request.timer) GLib.Source.remove(request.timer);
    request.cancel.cancel();
    if (request.stream && !request.pulling) this.closeStream(request.stream);
  }

  private closeStream(stream: any): void {
    stream.close_async(GLib.PRIORITY_DEFAULT, null, (_stream: unknown, result: unknown) => {
      try { stream.close_finish(result); } catch { /* A cancelled read can already own the stream. */ }
    });
  }

  private chunk(id: WidgetRequestId, phase: string, rest: SettingsDocument = {}): void {
    if (!this.closed) this.send({ type: "ouro-widget-fetch-chunk", id, phase, ...rest });
  }

  async fetch(id: WidgetRequestId, message: SettingsDocument): Promise<void> {
    if (this.closed || this.requests.has(id)) return;
    const request: Request = { cancel: new Gio.Cancellable(), timer: 0, pulling: false };
    this.requests.set(id, request);
    const current = () => this.requests.get(id) === request;
    try {
      if (this.requests.size > 64) throw new Error("Слишком много запросов виджета.");
      const init = object(message.init);
      const method = typeof init.method === "string" ? init.method.toUpperCase() : "GET";
      if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("Метод запроса виджета недоступен.");
      const address = this.resolve(message.url, method);
      const headers: [string, string][] = [];
      for (const header of Array.isArray(init.headers) ? init.headers.slice(0, 128) : []) {
        if (!Array.isArray(header) || typeof header[0] !== "string" || typeof header[1] !== "string") continue;
        const [key, value] = header;
        if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) && !forbiddenHeader.test(key) && !/[\x00\r\n]/.test(value)) headers.push([key, value]);
      }
      const timeout = Number(init.timeoutMs);
      if (Number.isFinite(timeout) && timeout > 0) request.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
        Math.min(0x7fff_ffff, Math.max(1, Math.ceil(timeout))), () => {
          request.timer = 0;
          this.chunk(id, "error", { error: "widget request timed out" });
          this.finish(id, request);
          return GLib.SOURCE_REMOVE;
        });
      const body = ["GET", "HEAD"].includes(method) ? undefined : bodyBytes(init.body);
      const { stream, ...response } = await this.gateway.widgetFetch(method, address.path, headers, body, address.authenticated, request.cancel);
      if (!current()) { this.closeStream(stream); return; }
      request.stream = stream;
      this.chunk(id, "headers", response);
      if (method === "HEAD" || [204, 205, 304].includes(response.status)) {
        this.chunk(id, "end");
        this.finish(id, request);
      }
    } catch (error) {
      if (current()) {
        this.chunk(id, "error", { error: redactWidgetLeases(errorText(error)) });
        this.finish(id, request);
      }
    }
  }

  async pull(id: WidgetRequestId): Promise<void> {
    const request = this.requests.get(id);
    if (!request?.stream || request.pulling) return;
    request.pulling = true;
    try {
      const bytes = await readBytes(request.stream, 64 * 1024, request.cancel);
      if (this.requests.get(id) !== request) return;
      if (bytes.get_size()) this.chunk(id, "data", { base64: GLib.base64_encode(bytes.get_data()) });
      else {
        this.chunk(id, "end");
        this.finish(id, request);
      }
    } catch (error) {
      if (this.requests.get(id) === request) {
        this.chunk(id, "error", { error: redactWidgetLeases(errorText(error)) });
        this.finish(id, request);
      }
    } finally {
      request.pulling = false;
      if (this.requests.get(id) !== request) this.closeStream(request.stream);
    }
  }

  abort(id: WidgetRequestId): void {
    const request = this.requests.get(id);
    if (request) this.finish(id, request);
  }

  async download(id: WidgetRequestId, message: SettingsDocument): Promise<void> {
    if (this.closed || this.downloads.size >= 3) return;
    const cancel = new Gio.Cancellable();
    this.downloads.add(cancel);
    const reply = (result: SettingsDocument) => {
      if (!this.closed) this.send({ type: "ouro-widget-download-result", id, result });
    };
    try {
      const source = message.source;
      let bytes: Uint8Array | undefined;
      let url: ReturnType<WidgetRelay["resolve"]> | undefined;
      if (typeof source === "string" && source.startsWith("data:")) {
        const match = /^data:[^,]*;base64,([A-Za-z0-9+/=]*)$/.exec(source);
        if (match) bytes = bodyBytes({ base64: match[1] });
        else {
          const separator = source.indexOf(",");
          if (separator < 0) throw new Error("Данные для скачивания недоступны.");
          bytes = new TextEncoder().encode(decodeURIComponent(source.slice(separator + 1)));
        }
      } else if (typeof source === "string") url = this.resolve(source, "GET");
      else bytes = bodyBytes(source);
      if (!bytes && !url) throw new Error("Файл виджета недоступен.");
      const name = String(message.name || "download").replace(/[/\\\x00-\x1f]/g, "_").slice(0, 180);
      const destination = await chooseFile(this.parent, name);
      if (!destination || this.closed) { reply({ ok: false, error: "Скачивание отменено." }); return; }
      if (url) await this.gateway.download(url.path, destination, url.authenticated, cancel);
      else destination.replace_contents(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, cancel);
      reply({ ok: true });
    } catch (error) {
      reply({ ok: false, error: redactWidgetLeases(errorText(error)) });
    } finally { this.downloads.delete(cancel); }
  }
}
