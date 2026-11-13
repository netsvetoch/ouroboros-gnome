import { Gio, GLib, Soup } from "./gi.js";

export type Query = Record<string, string | number | boolean | null | undefined>;
export type GatewayFrame = Record<string, unknown> & { type: string };
export interface DownloadIdentity { size: number; sha256: string }
export interface UploadProgress { phase: "preparing" | "sending" | "confirming"; bytes: number; total?: number }
interface UploadOptions<T> {
  cancel?: any;
  progress?: (progress: UploadProgress) => void;
  verifyReceipt?: (receipt: T, identity: DownloadIdentity) => void;
}

export function multipartFilename(name: string): string {
  return name.replace(/["\\\x00-\x1f\x7f]/gu, "_");
}

function multipartForm(name: string, bytes: any, fields: Record<string, string>): any {
  const form = new Soup.Multipart("multipart/form-data");
  for (const [key, value] of Object.entries(fields)) form.append_form_string(key, value);
  const [contentType] = Gio.content_type_guess(name, null);
  const headers = new Soup.MessageHeaders(Soup.MessageHeadersType.MULTIPART);
  // Starlette recognizes an uploaded file by the multipart filename parameter.
  const filename = multipartFilename(name);
  headers.append("Content-Disposition", `form-data; name="file"; filename="${filename}"`);
  headers.append("Content-Type", Gio.content_type_get_mime_type(contentType));
  form.append_part(headers, bytes);
  return form;
}

function multipartEnvelope(name: string, fields: Record<string, string>): { type: string; prefix: any; suffix: any } {
  const marker = new TextEncoder().encode(GLib.uuid_string_random());
  const headers = new Soup.MessageHeaders(Soup.MessageHeadersType.REQUEST);
  const bytes = multipartForm(name, GLib.Bytes.new(marker), fields).to_message(headers);
  const envelope: Uint8Array = bytes.get_data();
  const offset = envelope.findIndex((byte, index) => byte === marker[0] && marker.every((part, at) => envelope[index + at] === part));
  const type = headers.get_one("Content-Type");
  if (offset < 0 || !type) throw new Error("Не удалось собрать запрос для загрузки файла.");
  const end = offset + marker.length;
  return { type, prefix: GLib.Bytes.new_from_bytes(bytes, 0, offset),
    suffix: GLib.Bytes.new_from_bytes(bytes, end, envelope.length - end) };
}

function fileInfo(file: any, cancel: any): Promise<any> {
  return new Promise((resolve, reject) => {
    file.query_info_async("standard::type,standard::size,time::modified,time::modified-usec", Gio.FileQueryInfoFlags.NONE,
      GLib.PRIORITY_DEFAULT, cancel, (_file: unknown, result: unknown) => {
        try { resolve(file.query_info_finish(result)); } catch (error) { reject(error); }
      });
  });
}

function openFile(file: any, cancel: any): Promise<any> {
  return new Promise((resolve, reject) => {
    file.read_async(GLib.PRIORITY_DEFAULT, cancel, (_file: unknown, result: unknown) => {
      try { resolve(file.read_finish(result)); } catch (error) { reject(error); }
    });
  });
}

async function writeAll(stream: any, bytes: any, cancel: any): Promise<void> {
  const size = bytes.get_size();
  let offset = 0;
  while (offset < size) {
    const chunk = offset ? GLib.Bytes.new_from_bytes(bytes, offset, size - offset) : bytes;
    const count = await new Promise<number>((resolve, reject) => {
      stream.write_bytes_async(chunk, GLib.PRIORITY_DEFAULT, cancel, (_stream: unknown, result: unknown) => {
        try { resolve(stream.write_bytes_finish(result)); } catch (error) { reject(error); }
      });
    });
    if (count <= 0) throw new Error("Не удалось подготовить файл целиком.");
    offset += count;
  }
}

export function uploadProgressText(progress: UploadProgress): string {
  if (progress.phase === "confirming") return "Файл передан. Жду подтверждения шлюза…";
  const phase = progress.phase === "preparing" ? "Подготовка" : "Загрузка";
  return `${phase} · ${GLib.format_size(progress.bytes)}${progress.total === undefined ? "" : ` из ${GLib.format_size(progress.total)}`}`;
}

export function query(values: Query): string {
  const parts = Object.entries(values)
    .filter(([, value]) => value != null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

export function gatewayUrl(input: string): string {
  const base = input.trim().replace(/\/+$/, "");
  const uri = GLib.Uri.parse(base, GLib.UriFlags.NONE);
  if (!["http", "https"].includes(uri.get_scheme()) || !uri.get_host()
    || uri.get_userinfo() != null || uri.get_query() != null || uri.get_fragment() != null) {
    throw new Error("Укажите адрес шлюза HTTP или HTTPS без имени пользователя, параметров и фрагмента.");
  }
  return base;
}

export class HttpError extends Error {
  readonly reason?: string;

  constructor(readonly status: number, readonly body: unknown) {
    const problem = body && typeof body === "object"
      ? body as { error?: string | { message?: string }; reason_code?: string; code?: string }
      : {};
    const message = typeof problem.error === "string" ? problem.error : problem.error?.message;
    const reason = problem.reason_code ?? problem.code;
    super([`HTTP ${status}`, message || (typeof body === "string" ? body.slice(0, 300) : ""), reason]
      .filter(Boolean).join(" · "));
    this.reason = reason;
  }
}

export class UploadInterrupted extends Error {
  constructor(readonly mayBeStored: boolean, readonly canceled: boolean, cause: unknown) {
    super(mayBeStored ? ["Шлюз мог сохранить файл. Подтверждение загрузки не получено.",
      cause instanceof HttpError || cause instanceof UploadReceiptError ? cause.message : ""].filter(Boolean).join(" ")
      : canceled ? "Загрузка отменена." : cause instanceof Error ? cause.message : String(cause));
  }
}

export class UploadReceiptError extends Error {}

export class Gateway {
  readonly base: string;
  private readonly session = new Soup.Session({ timeout: 45 });
  private longSession?: any;
  private widgetSession?: any;
  private readonly moduleSessions = new Set<any>();
  private authCookies?: any;
  private moduleCookieTask?: Promise<any[]>;
  private moduleCookieExpires = Infinity;
  private moduleCookieHelper?: Gateway;
  private readonly accessRevoked = new Set<() => void>();
  private readonly cancellable = new Gio.Cancellable();

  constructor(base: string, private readonly password: string) {
    this.base = gatewayUrl(base);
  }

  close(): void {
    this.revokeModuleAccess();
    this.authCookies = undefined;
    this.cancellable.cancel();
    this.session.abort();
    this.longSession?.abort();
    this.widgetSession?.abort();
    for (const session of this.moduleSessions) session.abort();
    this.moduleSessions.clear();
  }

  private url(path: string): string {
    if (!path.startsWith("/") || path.startsWith("//") || /[\\\s\x00-\x1f\x7f]/.test(path)) {
      throw new Error("Требуется путь внутри шлюза.");
    }
    return this.base + path;
  }

  private authorize(message: any, authenticated = true): any {
    if (!message) throw new Error("Неверный адрес шлюза.");
    message.add_flags(Soup.MessageFlags.NO_REDIRECT);
    if (authenticated) {
      if (this.password) message.request_headers.replace("Authorization", `Bearer ${this.password}`);
      if (this.authCookies) {
        const address: string = message.get_uri().to_string();
        const uri = GLib.Uri.parse(address.replace(/^wss:/, "https:").replace(/^ws:/, "http:"), GLib.UriFlags.NONE);
        const cookie = this.authCookies.get_cookies(uri, true);
        if (cookie) message.request_headers.replace("Cookie", cookie);
      }
    }
    return message;
  }

  onAccessRevoked(callback: () => void): () => void {
    this.accessRevoked.add(callback);
    return () => { this.accessRevoked.delete(callback); };
  }

  cancelModulePreparation(): void {
    this.moduleCookieTask = undefined; this.moduleCookieExpires = Infinity;
    this.moduleCookieHelper?.close(); this.moduleCookieHelper = undefined;
  }

  private revokeModuleAccess(): void {
    this.cancelModulePreparation();
    for (const callback of [...this.accessRevoked]) callback();
  }

  /** HttpOnly owner cookie for an ephemeral same-origin module; never serialized into JS. */
  moduleCookies(): Promise<any[]> {
    if (this.cancellable.is_cancelled()) return Promise.reject(new Error("Подключение закрыто."));
    if (this.authCookies) {
      const cookies = this.authCookies.all_cookies() ?? [];
      if (cookies.some((cookie: any) => cookie.get_name() !== "ouroboros_auth" || !cookie.get_http_only())) return Promise.reject(new Error("Шлюз не выдал защищённый cookie модуля."));
      return Promise.resolve(cookies);
    }
    if (!this.password) return Promise.resolve([]);
    if (this.moduleCookieTask && this.moduleCookieExpires > GLib.get_real_time() / 1000000 + 60) return this.moduleCookieTask;
    this.moduleCookieExpires = Infinity;
    const helper = this.moduleCookieHelper = new Gateway(this.base, "");
    let task!: Promise<any[]>;
    task = (async () => {
      try {
        try { await helper.publicJson("/api/state"); return []; }
        catch (error) { if (!(error instanceof HttpError) || error.status !== 401) throw error; }
        await helper.login(this.password);
        if (this.moduleCookieTask !== task || this.cancellable.is_cancelled()) throw new Error("Подготовка сеанса модуля отменена.");
        const cookies = helper.authCookies.all_cookies() ?? [];
        if (cookies.some((cookie: any) => cookie.get_name() !== "ouroboros_auth" || !cookie.get_http_only())) throw new Error("Шлюз не выдал защищённый cookie модуля.");
        this.moduleCookieExpires = Math.min(...cookies.map((cookie: any) => cookie.get_expires()?.to_unix() ?? Infinity));
        return cookies;
      } catch (error) { if (this.moduleCookieTask === task) this.moduleCookieTask = undefined; throw error; }
      finally { helper.close(); if (this.moduleCookieHelper === helper) this.moduleCookieHelper = undefined; }
    })();
    this.moduleCookieTask = task; return task;
  }

  get hasSession(): boolean { return Boolean(this.authCookies); }

  copySession(): Gateway {
    if (!this.authCookies || this.cancellable.is_cancelled()) throw new Error("Сетевой сеанс закрыт.");
    const connection = new Gateway(this.base, "");
    connection.authCookies = this.authCookies;
    return connection;
  }

  async login(password: string): Promise<void> {
    const message = this.jsonMessage("POST", "/auth/login", { password }, "application/json", false);
    const bytes = await this.response(message).catch((error) => {
      if (error instanceof HttpError && error.status === 404) throw new Error("Шлюз не выдаёт сетевые сеансы по этому адресу.");
      throw error;
    });
    const reply = this.decode<{ ok?: boolean }>(bytes);
    if (reply?.ok !== true) throw new Error("Шлюз не подтвердил вход.");
    const jar = new Soup.CookieJar();
    const uri = message.get_uri();
    for (const cookie of Soup.cookies_from_response(message) ?? []) {
      if (cookie.get_name() === "ouroboros_auth") jar.add_cookie_full(cookie, uri, uri);
    }
    const protectedUri = GLib.Uri.parse(this.url("/api/state"), GLib.UriFlags.NONE);
    if (!jar.get_cookies(protectedUri, true)) throw new Error("Шлюз не выдал действующий cookie сеанса.");
    this.revokeModuleAccess();
    this.authCookies = jar;
  }

  async logout(): Promise<void> {
    if (!this.authCookies) return;
    this.revokeModuleAccess();
    const message = this.jsonMessage("POST", "/auth/logout", { next: "/" }, "application/json");
    this.authCookies = undefined;
    const session = new Soup.Session({ timeout: 6 });
    try {
      await this.response(message, session, this.cancellable, 303);
      const deleted = (Soup.cookies_from_response(message) ?? []).some((cookie: any) => cookie.get_name() === "ouroboros_auth"
        && cookie.get_expires()?.to_unix() <= GLib.get_real_time() / 1_000_000);
      if (message.get_status() !== 303 || !deleted) throw new Error("Шлюз не подтвердил выход.");
    } finally { session.abort(); }
  }

  private async response(message: any, session = this.session, cancel = this.cancellable, acceptedStatus?: number): Promise<any> {
    const bytes = await new Promise<any>((resolve, reject) => {
      session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancel, (_session: unknown, result: unknown) => {
        try {
          resolve(session.send_and_read_finish(result));
        } catch (error) {
          reject(error);
        }
      });
    });
    const status = message.get_status();
    if (status !== acceptedStatus && (status < 200 || status >= 300)) {
      const text = new TextDecoder().decode(bytes.get_data());
      let problem: unknown = text;
      try { problem = JSON.parse(text); } catch { /* plain text is valid on errors */ }
      throw new HttpError(status, problem);
    }
    return bytes;
  }

  private jsonMessage(method: string, path: string, body: unknown, accept: string, authenticated = true): any {
    const message = this.authorize(Soup.Message.new(method, this.url(path)), authenticated);
    message.request_headers.replace("Accept", accept);
    if (body !== undefined) {
      const bytes = new TextEncoder().encode(JSON.stringify(body));
      message.set_request_body_from_bytes("application/json", GLib.Bytes.new(bytes));
    }
    return message;
  }

  async json<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>, long = false,
    cancel = this.cancellable): Promise<T> {
    const message = this.jsonMessage(method, path, body, "application/json");
    for (const [name, value] of Object.entries(headers ?? {})) message.request_headers.replace(name, value);
    const session = long ? (this.longSession ??= new Soup.Session({ timeout: 0 })) : this.session;
    return this.decode<T>(await this.response(message, session, cancel));
  }

  async publicJson<T>(path: string, cancel = this.cancellable): Promise<T> {
    const message = this.authorize(Soup.Message.new("GET", this.url(path)), false);
    message.request_headers.replace("Accept", "application/json");
    return this.decode<T>(await this.response(message, this.session, cancel));
  }

  /** For operations whose HTTP success is the acknowledgement and JSON is optional metadata. */
  async optionalJson(method: string, path: string, body?: unknown, cancel = this.cancellable): Promise<unknown> {
    if (this.cancellable.is_cancelled()) throw new Error("Подключение закрыто.");
    if (cancel?.is_cancelled()) throw new Error("Запрос отменён.");
    const message = this.jsonMessage(method, path, body, "application/json, text/plain, */*");
    // A caller may share its cancellable with another connection. Cancel only
    // this transport when either its caller or its owning Gateway closes.
    const transport = new Gio.Cancellable();
    const sources = [...new Set([this.cancellable, cancel].filter(Boolean))];
    const links = sources.map(source => [source, source.connect(() => transport.cancel())] as const);
    let status = 0;
    const headers = message.connect("got-headers", () => {
      const received = message.get_status();
      if (received >= 200) status = received;
    });
    try {
      let bytes: any;
      try { bytes = await this.response(message, this.session, transport); }
      catch (error) {
        // A received final status remains authoritative when optional metadata
        // cannot be read. Caller/connection cancellation is never an acknowledgement.
        if (cancel?.is_cancelled() || this.cancellable.is_cancelled() || error instanceof HttpError || !status) throw error;
        if (status < 300) return null;
        throw new HttpError(status, { error: "Не удалось прочитать тело ответа." });
      }
      if (cancel?.is_cancelled() || this.cancellable.is_cancelled()) throw new Error("Запрос отменён.");
      // Parse like Response.json(), regardless of Content-Type.
      try { return this.decode<unknown>(bytes); } catch { return null; }
    } finally {
      message.disconnect(headers);
      for (const [source, id] of links) if (id) source.disconnect(id);
    }
  }

  async audio<T>(path: string, type: string, audio: Uint8Array, cancel: any): Promise<T> {
    const message = this.jsonMessage("POST", path, undefined, "application/json");
    message.set_request_body_from_bytes(type, GLib.Bytes.new(audio));
    return this.decode<T>(await this.response(message, this.session, cancel));
  }

  async extensionResult(method: string, path: string, body: unknown, cancel: any): Promise<unknown> {
    const message = this.jsonMessage(method, path, body, "application/json, text/plain, */*");
    const bytes = await this.response(message, this.session, cancel);
    const type: string = message.response_headers.get_one("Content-Type") ?? "";
    if (!type.toLowerCase().includes("application/json")) return { text: new TextDecoder().decode(bytes.get_data()) };
    try { return this.decode<unknown>(bytes); }
    catch { throw new HttpError(message.get_status(), { error: "Шлюз вернул некорректный JSON виджета." }); }
  }

  private stream(message: any, cancel: any, session = this.session): Promise<any> {
    return new Promise((resolve, reject) => {
      session.send_async(message, GLib.PRIORITY_DEFAULT, cancel, (_session: unknown, result: unknown) => {
        try { resolve(session.send_finish(result)); } catch (error) { reject(error); }
      });
    });
  }

  private readChunk(stream: any, size: number, cancel: any): Promise<any> {
    return new Promise((resolve, reject) => {
      stream.read_bytes_async(size, GLib.PRIORITY_DEFAULT, cancel, (_stream: unknown, result: unknown) => {
        try { resolve(stream.read_bytes_finish(result)); } catch (error) { reject(error); }
      });
    });
  }

  private async streamError(status: number, stream: any, cancel: any): Promise<HttpError> {
    const bytes = await this.readChunk(stream, 8192, cancel);
    const text = new TextDecoder().decode(bytes.get_data());
    let problem: unknown = text;
    try { problem = JSON.parse(text); } catch { /* gateway or proxy plain text */ }
    return new HttpError(status, problem);
  }

  async widgetFetch(method: string, path: string, headers: [string, string][], body: Uint8Array | undefined,
    authenticated: boolean, cancel: any): Promise<{ stream: any; status: number; statusText: string; headers: [string, string][] }> {
    const message = this.authorize(Soup.Message.new(method, this.url(path)), authenticated);
    if (body) {
      const type = headers.find(([key]) => key.toLowerCase() === "content-type")?.[1] ?? "application/octet-stream";
      message.set_request_body_from_bytes(type, GLib.Bytes.new(body));
    }
    for (const [key, value] of headers) {
      if (!body || key.toLowerCase() !== "content-type") message.request_headers.append(key, value);
    }
    // Unconsumed Fetch responses keep their streams open. They must not
    // exhaust the normal connection pool used by chat and settings.
    const session = this.widgetSession ??= new Soup.Session({ timeout: 0, max_conns: 128, max_conns_per_host: 96 });
    const stream = await this.stream(message, cancel, session);
    const status = message.get_status();
    if (status >= 300 && status < 400 && status !== 304 && message.response_headers.get_one("Location")) {
      stream.close(null);
      throw new Error("Переадресация запроса виджета отклонена.");
    }
    const received: [string, string][] = [];
    message.response_headers.foreach((key: string, value: string) => {
      if (!/^set-cookie2?$/i.test(key)) received.push([key, value]);
    });
    return { stream, status, statusText: message.get_reason_phrase() ?? "", headers: received };
  }

  /** Trusted, reviewed page-module HTTP; credentials remain in the native process. */
  moduleTransport(): { close: () => void; request: (method: string, path: string, headers: [string, string][], body: any, authenticated: boolean, cancel: any) => Promise<{ stream: any; status: number; headers: [string, string][] }> } {
    if (this.cancellable.is_cancelled()) throw new Error("Подключение закрыто.");
    const session = new Soup.Session({ timeout: 0, max_conns: 128, max_conns_per_host: 96 });
    this.moduleSessions.add(session);
    return {
      close: () => { session.abort(); this.moduleSessions.delete(session); },
      request: async (method, path, headers, body, authenticated, cancel) => {
        const message = this.authorize(Soup.Message.new(method, this.url(path)), authenticated);
        if (!authenticated) message.add_flags(Soup.MessageFlags.DO_NOT_USE_AUTH_CACHE);
        for (const [key, value] of headers) message.request_headers.replace(key, value);
        if (body) message.set_request_body(message.request_headers.get_one("Content-Type"), body, -1);
        const stream = await this.stream(message, cancel, session);
        const received: [string, string][] = [];
        message.response_headers.foreach((key: string, value: string) => { if (!/^set-cookie2?$/i.test(key)) received.push([key, value]); });
        return { stream, status: message.get_status(), headers: received };
      },
    };
  }

  events<T>(path: string, body: unknown, cancel: any, onEvent: (event: T) => void): Promise<void> {
    return this.readEvents(this.jsonMessage("POST", path, body, "text/event-stream"), cancel,
      (data) => onEvent(JSON.parse(data) as T));
  }

  listenEvents(path: string, cancel: any, onEvent: (data: string) => void): Promise<void> {
    return this.readEvents(this.jsonMessage("GET", path, undefined, "text/event-stream"), cancel, onEvent);
  }

  private async readEvents(message: any, cancel: any, onEvent: (data: string) => void): Promise<void> {
    const stream = await this.stream(message, cancel);
    const lines = new Gio.DataInputStream({
      base_stream: stream, newline_type: Gio.DataStreamNewlineType.ANY,
    });
    const status = message.get_status();
    const successful = status >= 200 && status < 300;
    const type = message.response_headers.get_one("Content-Type") ?? "";
    let data: string[] = [];
    try {
      while (true) {
        const line = await new Promise<string | null>((resolve, reject) => {
          lines.read_line_async(GLib.PRIORITY_DEFAULT, cancel, (_lines: unknown, result: unknown) => {
            try { resolve(lines.read_line_finish_utf8(result)[0]); } catch (error) { reject(error); }
          });
        });
        if (line === null) {
          if (data.length && successful) throw new Error("Поток оборвался посреди события.");
          break;
        }
        if (line === "") {
          if (data.length) {
            const value = data.join("\n");
            if (!successful) {
              let body: unknown = value;
              try { body = JSON.parse(value); } catch { /* Keep the server's text. */ }
              throw new HttpError(status, body);
            }
            onEvent(value);
            data = [];
          }
        } else if (!type.includes("text/event-stream")) {
          if (!successful) {
            let body: unknown = line;
            try { body = JSON.parse(line); } catch { /* Keep the server's text. */ }
            throw new HttpError(status, body);
          }
          throw new Error("Шлюз вернул ответ вместо потока событий.");
        } else if (line === "data" || line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (!successful) throw new HttpError(status, null);
    } finally {
      lines.close(null);
    }
  }

  async upload<T>(path: string, file: any, fields: Record<string, string> = {}, limit?: number,
    options: UploadOptions<T> = {}): Promise<T> {
    const cancel = new Gio.Cancellable();
    const stop = () => cancel.cancel();
    const gatewayCancel = this.cancellable.connect(stop);
    const callerCancel = options.cancel?.connect(stop);
    let temporary: any;
    let staging: any;
    let source: any;
    let body: any;
    let sent = 0;
    let contentLength = 0;
    let sentBody = false;
    let restarted = false;
    let lastUpdate = 0;
    const publish = (phase: UploadProgress["phase"], bytes: number, total?: number, immediate = false) => {
      const now = GLib.get_monotonic_time();
      if (!immediate && now - lastUpdate < 100_000) return;
      lastUpdate = now;
      options.progress?.({ phase, bytes, total });
    };
    const checkSize = (size: number) => {
      if (limit !== undefined && size > limit) throw new Error(`Размер файла превышает ${GLib.format_size(limit)}.`);
    };
    try {
      const info = await fileInfo(file, cancel);
      if ([Gio.FileType.DIRECTORY, Gio.FileType.SPECIAL].includes(info.get_file_type())) throw new Error("Выберите обычный файл.");
      const expected = info.has_attribute("standard::size") ? info.get_size() : undefined;
      if (expected !== undefined) checkSize(expected);
      const envelope = multipartEnvelope(file.get_basename() || "file", fields);
      [temporary, staging] = Gio.File.new_tmp("ouroboros-upload-XXXXXX");
      publish("preparing", 0, expected, true);
      source = await openFile(file, cancel);
      const output = staging.get_output_stream();
      await writeAll(output, envelope.prefix, cancel);
      const checksum = options.verifyReceipt && new GLib.Checksum(GLib.ChecksumType.SHA256);
      let size = 0;
      while (true) {
        const request = limit === undefined ? 256 * 1024 : Math.min(256 * 1024, limit - size + 1);
        const bytes = await this.readChunk(source, request, cancel);
        const chunkSize = bytes.get_size();
        if (!chunkSize) break;
        size += chunkSize;
        checkSize(size);
        checksum?.update(bytes.get_data());
        await writeAll(output, bytes, cancel);
        publish("preparing", size, expected);
      }
      const current = await fileInfo(file, cancel);
      if (expected !== undefined && expected !== size || current.has_attribute("standard::size") && current.get_size() !== size
        || info.get_attribute_uint64("time::modified") !== current.get_attribute_uint64("time::modified")
        || info.get_attribute_uint32("time::modified-usec") !== current.get_attribute_uint32("time::modified-usec")) {
        throw new Error("Файл изменился во время подготовки. Выберите его снова.");
      }
      await writeAll(output, envelope.suffix, cancel);
      source.close(null);
      staging.close(null);
      body = await openFile(temporary, cancel);
      const prefixSize = envelope.prefix.get_size();
      contentLength = prefixSize + size + envelope.suffix.get_size();
      const message = this.authorize(Soup.Message.new("POST", this.url(path)));
      message.set_request_body(envelope.type, body, contentLength);
      message.connect("restarted", () => { restarted = true; stop(); });
      message.connect("wrote-body-data", (_message: unknown, count: number) => {
        sent += count;
        publish("sending", Math.min(size, Math.max(0, sent - prefixSize)), size);
      });
      message.connect("wrote-body", () => { sentBody = true; publish("confirming", size, size, true); });
      publish("sending", 0, size, true);
      const session = this.longSession ??= new Soup.Session({ timeout: 0 });
      const receipt = this.decode<T>(await this.response(message, session, cancel));
      if (checksum) options.verifyReceipt?.(receipt, { size, sha256: checksum.get_string() });
      return receipt;
    } catch (error) {
      if (error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 408) throw error;
      const canceled = cancel.is_cancelled() && !restarted;
      if (canceled || restarted || sent > 0 || sentBody) {
        const cause = restarted ? new Error("Шлюз попытался начать загрузку заново. Подтвердите повтор вручную.") : error;
        throw new UploadInterrupted(sentBody || contentLength > 0 && sent >= contentLength, canceled, cause);
      }
      throw error;
    } finally {
      if (gatewayCancel) this.cancellable.disconnect(gatewayCancel);
      if (callerCancel) options.cancel.disconnect(callerCancel);
      for (const stream of [body, source, staging]) {
        try { if (stream && !stream.is_closed()) stream.close(null); } catch { /* Release the rest of the transfer. */ }
      }
      try { temporary?.delete(null); } catch { /* The temporary copy may already have been removed. */ }
    }
  }

  async uploadBytes<T>(path: string, name: string, bytes: any, fields: Record<string, string> = {}): Promise<T> {
    const multipart = multipartForm(name, bytes, fields);
    const message = this.authorize(Soup.Message.new_from_multipart(this.url(path), multipart));
    return this.decode<T>(await this.response(message));
  }

  async bytes(path: string, cancel = this.cancellable): Promise<any> {
    return this.response(this.authorize(Soup.Message.new("GET", this.url(path))), this.session, cancel);
  }

  async previewBytes(path: string, limit: number, cancel: any): Promise<Uint8Array> {
    const message = this.authorize(Soup.Message.new("GET", this.url(path)));
    const stream = await this.stream(message, cancel);
    const tooLarge = () => new Error(`Для просмотра файл должен быть не больше ${GLib.format_size(limit)}.`);
    try {
      const status = message.get_status();
      if (status !== 200) throw await this.streamError(status, stream, cancel);
      const length = message.response_headers.get_one("Content-Length");
      const encoding = message.response_headers.get_one("Content-Encoding");
      const expected = length != null && (!encoding || encoding === "identity") ? Number(length) : undefined;
      if (expected !== undefined && expected > limit) throw tooLarge();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const bytes = await this.readChunk(stream, Math.min(64 * 1024, limit - size + 1), cancel);
        const chunk: Uint8Array = bytes.get_data();
        if (!chunk.length) break;
        size += chunk.length;
        if (size > limit) throw tooLarge();
        chunks.push(chunk);
      }
      if (expected !== undefined && expected !== size) throw new Error("Шлюз передал неполный файл.");
      const result = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
      return result;
    } finally { stream.close(null); }
  }

  async cardApp(path: string, size: number, digest: string, cancel: any): Promise<string> {
    if (!Number.isSafeInteger(size) || size < 0 || size > 512 * 1024 || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error("Шлюз не вернул проверяемое описание HTML-приложения.");
    }
    const message = this.authorize(Soup.Message.new("GET", this.url(path)));
    const stream = await this.stream(message, cancel);
    try {
      const status = message.get_status();
      if (status !== 200) throw new HttpError(status, null);
      const type = message.response_headers.get_one("Content-Type") ?? "";
      if (!/^text\/plain(?:\s*;|$)/i.test(type)) throw new Error("Шлюз вернул HTML-приложение в неожиданном формате.");
      const html = new Uint8Array(size);
      let offset = 0;
      while (offset <= size) {
        const bytes = await this.readChunk(stream, Math.min(16 * 1024, size - offset + 1), cancel);
        const chunk: Uint8Array = bytes.get_data();
        if (!chunk.length) break;
        if (offset + chunk.length > size) throw new Error("Размер HTML-приложения отличается от описания карточки.");
        html.set(chunk, offset);
        offset += chunk.length;
      }
      if (offset !== size || GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, GLib.Bytes.new(html)) !== digest) {
        throw new Error("Контрольная сумма HTML-приложения не совпала с описанием карточки.");
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(html);
    } finally {
      stream.close(null);
    }
  }

  async status(path: string, cancel = this.cancellable): Promise<number> {
    const message = this.authorize(Soup.Message.new("GET", this.url(path)));
    await this.response(message, this.session, cancel);
    return message.get_status();
  }

  async reviewExport(path: string, original?: string, cancel = this.cancellable): Promise<any> {
    const message = this.authorize(Soup.Message.new("GET", this.url(path)));
    const bytes = await this.response(message, this.session, cancel);
    const source = message.response_headers.get_one("X-Review-Source-SHA256");
    const delivered = message.response_headers.get_one("X-Review-Export-SHA256");
    const digest = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
    if ((original && source !== original) || delivered !== digest) {
      throw new Error("Контрольная сумма выгрузки ревью не совпадает с ответом шлюза.");
    }
    return bytes;
  }

  async download(path: string, destination: any, authenticated = true, cancel = this.cancellable,
    identity?: DownloadIdentity): Promise<void> {
    if (identity && (!Number.isSafeInteger(identity.size) || identity.size < 0 || !/^[a-f0-9]{64}$/.test(identity.sha256))) {
      throw new Error("Шлюз не вернул проверяемое описание источника.");
    }
    const message = this.authorize(Soup.Message.new("GET", this.url(path)), authenticated);
    const input = await this.stream(message, cancel);
    try {
      const status = message.get_status();
      if (status !== 200) throw await this.streamError(status, input, cancel);

      // A failed network read must never touch the destination selected by the user.
      const [temporary, staging] = Gio.File.new_tmp("ouroboros-download-XXXXXX");
      let replacement: any;
      try {
        const output = staging.get_output_stream();
        const count = identity ? await this.copyVerified(input, output, identity, cancel) : await new Promise<number>((resolve, reject) => {
          output.splice_async(input, Gio.OutputStreamSpliceFlags.NONE, GLib.PRIORITY_DEFAULT, cancel,
            (_output: unknown, result: unknown) => {
              try { resolve(output.splice_finish(result)); } catch (error) { reject(error); }
            });
        });
        const expected = message.response_headers.get_one("Content-Length");
        const encoding = message.response_headers.get_one("Content-Encoding");
        if (expected != null && (!encoding || encoding === "identity") && count !== Number(expected)) {
          throw new Error("Шлюз передал неполный файл.");
        }
        staging.close(null);
        const parent = destination.get_parent();
        if (!parent) throw new Error("Не удалось определить папку для сохранения файла.");
        replacement = parent.get_child(`.ouroboros-download-${GLib.uuid_string_random()}`);
        await new Promise<void>((resolve, reject) => {
          temporary.copy_async(replacement, Gio.FileCopyFlags.NONE, GLib.PRIORITY_DEFAULT, cancel,
            null, (_file: unknown, result: unknown) => {
              try { temporary.copy_finish(result); resolve(); } catch (error) { reject(error); }
            });
        });
        await new Promise<void>((resolve, reject) => {
          const flags = Gio.FileCopyFlags.OVERWRITE | (destination.get_path() ? Gio.FileCopyFlags.NO_FALLBACK_FOR_MOVE : 0);
          replacement.move_async(destination, flags, GLib.PRIORITY_DEFAULT, cancel, null,
            (_file: unknown, result: unknown) => {
              try { replacement.move_finish(result); resolve(); } catch (error) { reject(error); }
            });
        });
      } finally {
        try { replacement?.delete(null); } catch { /* A completed move has consumed the sibling. */ }
        try {
          if (!staging.is_closed()) staging.close(null);
        } finally {
          temporary.delete(null);
        }
      }
    } finally {
      input.close(null);
    }
  }

  private async copyVerified(input: any, output: any, identity: DownloadIdentity, cancel: any): Promise<number> {
    const checksum = new GLib.Checksum(GLib.ChecksumType.SHA256);
    let count = 0;
    while (true) {
      const chunk = await this.readChunk(input, Math.min(256 * 1024, identity.size - count + 1), cancel);
      const size = chunk.get_size();
      if (!size) break;
      count += size;
      if (count > identity.size) throw new Error("Размер сохранённого материала изменился.");
      checksum.update(chunk.get_data());
      await writeAll(output, chunk, cancel);
    }
    if (count !== identity.size || checksum.get_string() !== identity.sha256) {
      throw new Error("Размер или контрольная сумма сохранённого материала не совпали.");
    }
    return count;
  }

  private decode<T>(bytes: any): T {
    const text = new TextDecoder().decode(bytes.get_data());
    return (text ? JSON.parse(text) : null) as T;
  }

  connect(path: string, cancellable: any): Promise<any> {
    const url = this.url(path).replace(/^http/, "ws");
    const message = this.authorize(Soup.Message.new("GET", url));
    return new Promise((resolve, reject) => {
      this.session.websocket_connect_async(message, null, null, GLib.PRIORITY_DEFAULT, cancellable, (_session: unknown, result: unknown) => {
        try {
          resolve(this.session.websocket_connect_finish(result));
        } catch (error) {
          reject(error);
        }
      });
    });
  }
}

export class ChatSocket {
  private readonly cancellable = new Gio.Cancellable();
  private connection: any = null;
  private timer = 0;
  private attempts = 0;
  private lastFrame = 0;
  private heartbeat = 0;
  private panicConnection?: object;
  private settlePanic?: (accepted: boolean) => void;

  constructor(
    private readonly gateway: Gateway,
    private readonly frame: (frame: GatewayFrame) => void,
    private readonly status: (online: boolean) => void,
    private readonly path = "/ws",
  ) {
    void this.open();
  }

  close(): void {
    this.cancellable.cancel();
    if (this.timer) GLib.Source.remove(this.timer);
    this.clearHeartbeat();
    this.settlePanic?.(false);
    if (this.online) this.connection.close(1000, null);
    this.connection = null;
  }

  get online(): boolean {
    return this.connection?.get_state() === Soup.WebsocketState.OPEN;
  }

  send(frame: GatewayFrame): boolean {
    if (!this.online) return false;
    this.connection.send_text(JSON.stringify(frame));
    return true;
  }

  requestPanic(): Promise<boolean> | undefined {
    if (!this.online || this.connection === this.panicConnection) return undefined;
    const connection = this.connection;
    this.panicConnection = connection;
    return new Promise(resolve => {
      let timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
        timer = 0;
        this.settlePanic?.(false);
        return GLib.SOURCE_REMOVE;
      });
      this.settlePanic = (accepted) => {
        if (timer) GLib.Source.remove(timer);
        this.settlePanic = undefined;
        resolve(accepted);
      };
      try {
        connection.send_text(JSON.stringify({ type: "command", cmd: "/panic", client_surface: { channel: "gnome" } }));
      } catch {
        this.settlePanic(false);
      }
    });
  }

  private async open(): Promise<void> {
    try {
      const connection = await this.gateway.connect(this.path, this.cancellable);
      if (this.cancellable.is_cancelled()) {
        connection.close(1000, null);
        return;
      }
      // The gateway may inline a 50 MiB attachment as base64 in one chat message.
      const incomingLimit = 72 * 1024 * 1024;
      connection.set_max_incoming_payload_size(incomingLimit);
      connection.set_max_total_message_size?.(incomingLimit);
      this.connection = connection;
      this.attempts = 0;
      this.lastFrame = GLib.get_monotonic_time();
      connection.connect("message", (_connection: unknown, type: number, bytes: any) => {
        this.lastFrame = GLib.get_monotonic_time();
        if (type !== Soup.WebsocketDataType.TEXT) return;
        let frame: GatewayFrame;
        try { frame = JSON.parse(new TextDecoder().decode(bytes.get_data())); } catch { return; }
        if (frame?.type === "panic_accepted") {
          if (connection === this.panicConnection) this.settlePanic?.(true);
          return;
        }
        if (typeof frame?.type === "string") this.frame(frame);
      });
      connection.connect("closed", () => {
        if (connection === this.panicConnection) {
          this.settlePanic?.(false);
          this.panicConnection = undefined;
        }
        this.clearHeartbeat();
        this.connection = null;
        this.reconnect();
      });
      this.heartbeat = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
        if (GLib.get_monotonic_time() - this.lastFrame < 45_000_000) return GLib.SOURCE_CONTINUE;
        this.heartbeat = 0;
        if (this.online) connection.close(1001, "heartbeat timeout");
        return GLib.SOURCE_REMOVE;
      });
      this.status(true);
    } catch {
      this.reconnect();
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) GLib.Source.remove(this.heartbeat);
    this.heartbeat = 0;
  }

  private reconnect(): void {
    if (this.cancellable.is_cancelled()) return;
    this.status(false);
    const seconds = Math.min(30, 2 ** this.attempts++);
    this.timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
      this.timer = 0;
      void this.open();
      return GLib.SOURCE_REMOVE;
    });
  }
}
