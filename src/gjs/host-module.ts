import { Adw, Gio, GLib, Gtk, Soup } from "./gi.js";
import { createFrameBrowser, compileFrameFilter, frameSecret } from "./frame-browser.js";
import { frameLedger } from "./frame-ledger.js";
import { type Gateway } from "./gateway.js";
import { HostHttp } from "./host-http.js";
import { HostSpeech } from "./host-speech.js";
import { HostMedia } from "./host-media.js";
import { HostRecognition, type RecognitionCapability } from "./host-recognition.js";
import { prepareRecordingCodecs } from "./media-codecs.js";
import { hostModuleDocument } from "./host-module-document.js";
import { errorText } from "./ui.js";
import { type HostContribution } from "./ui-contributions.js";

export interface HostProviderState {
  availability: { ok: boolean; code?: string; reason?: string };
  label: string;
  destination: string;
  nativeRecognition?: RecognitionCapability;
}
interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: number; cancel?: any; signal?: number; generation: number }

/** One revision-bound host module in its own WebKit context, with no owner credentials in JS. */
export class HostModule {
  readonly widget: any;
  status: "idle" | "held" | "loading" | "ready" | "error" | "closed" = "idle";
  provider?: HostProviderState;
  error = "";
  private readonly kit: any;
  private readonly view: any;
  private readonly manager: any;
  private readonly capability = frameSecret();
  private readonly root: string;
  private readonly entry: string;
  private readonly ledger: ReturnType<typeof frameLedger>;
  private readonly key: string;
  private readonly http: HostHttp;
  private readonly speech: HostSpeech;
  private readonly recognition: HostRecognition;
  readonly media: HostMedia;
  private readonly pending = new Map<number, Pending>();
  private readonly style = Adw.StyleManager.get_default();
  private readonly settings = Gtk.Settings.get_default();
  private readonly signals: [any, number][] = [];
  private handler = 0;
  private boot = 0;
  private settle = 0;
  private started = false;
  private generation = 0;
  private documentLoaded = false;
  private loadingDocument = false;
  private cookieRefresh = 0;
  private readonly cookieCancel = new Gio.Cancellable();
  private unsubscribeAccess?: () => void;
  private sequence = 0;
  private mounted?: Promise<void>;
  private mounting?: { resolve: () => void; reject: (error: Error) => void };
  private stopping = false;
  private closing?: Promise<void>;
  private disposed?: () => void;

  constructor(private readonly gateway: Gateway, readonly item: HostContribution,
    private readonly callbacks: { changed: () => void; notice: (text: string) => void; insert: (text: string) => boolean }) {
    const render = item.render;
    this.root = `/api/extensions/${encodeURIComponent(item.skill)}/ui/${item.revision}/`;
    if (!/^[a-f0-9]{64}$/.test(item.revision ?? "")
      || render?.kind !== "host" || !render.url?.startsWith(this.root)) throw new Error("Шлюз не сообщил проверяемый модуль навыка.");
    this.entry = this.assetPath(render.url.slice(this.root.length));
    this.key = "module:" + item.key;
    this.ledger = frameLedger(gateway);
    prepareRecordingCodecs();
    const { kit, view, manager } = createFrameBrowser({ isolated: true, permission: request => this.media.request(request) });
    this.kit = kit; this.view = this.widget = view; this.manager = manager;
    this.http = new HostHttp(gateway, kit, id => this.send("network-done", { id }));
    this.speech = new HostSpeech(args => this.send("speech-event", args));
    this.media = new HostMedia(view, kit, item, gateway.base, () => this.callbacks.changed(), () => this.send("media-stop", {}), () => this.recognition?.abort());
    this.recognition = new HostRecognition(view, this.media, item, gateway.base, args => this.send("recognition-event", args), message => this.callbacks.notice(message));
    view.set_size_request(1, 1);
    view.set_can_focus(false);
    const context = view.get_context(), security = context.get_security_manager();
    security.register_uri_scheme_as_secure("ouro-host");
    security.register_uri_scheme_as_cors_enabled("ouro-host");
    context.register_uri_scheme("ouro-host", (request: any) => { void this.resource(request); });
    this.handler = manager.connect("script-message-received::ouroHost", (_manager: unknown, value: any) => this.receive(value));
    if (!manager.register_script_message_handler("ouroHost", null)) throw new Error("Не удалось открыть канал модуля.");
    view.connect("web-process-terminated", () => this.fail("Процесс модуля завершился."));
    view.connect("decide-policy", (_view: unknown, decision: any, kind: number) => {
      if (kind === kit.PolicyDecisionType.NAVIGATION_ACTION) {
        const uri = decision.get_navigation_action().get_request().get_uri();
        if ([this.gateway.base + "/", this.gateway.base + "/_module"].includes(uri) && !this.documentLoaded) { this.documentLoaded = true; return false; }
        if (uri === "about:blank" && this.status === "idle") return false;
        decision.ignore(); this.fail("Модуль открыл другой документ."); return true;
      }
      if (kind === kit.PolicyDecisionType.NEW_WINDOW_ACTION) { decision.ignore(); return true; }
      return false;
    });
    view.connect("load-changed", (_view: unknown, event: number) => {
      if (this.loadingDocument && event === kit.LoadEvent.COMMITTED) this.documentLoaded = true;
    });
    this.unsubscribeAccess = gateway.onAccessRevoked(() => { void this.close(); });
    this.signals.push([this.style, this.style.connect("notify::dark", () => this.theme())]);
    this.signals.push([this.settings, this.settings.connect("notify::gtk-enable-animations", () => this.theme())]);
  }

  private assetPath(value: string): string {
    const parts = value.split("/").map(part => decodeURIComponent(part));
    if (!parts.length || parts.some(part => !part || part.startsWith(".") || /[\\/\x00-\x1f\x7f]/u.test(part))) throw new Error("Путь ресурса модуля недоступен.");
    return parts.map(encodeURIComponent).join("/");
  }

  private reply(request: any, bytes: Uint8Array, type: string, status = 200): void {
    const stream = Gio.MemoryInputStream.new_from_bytes(GLib.Bytes.new(bytes));
    const response = this.kit.URISchemeResponse.new(stream, bytes.length);
    response.set_status(status, null);
    response.set_content_type(type);
    const headers = Soup.MessageHeaders.new(Soup.MessageHeadersType.RESPONSE);
    headers.append("Access-Control-Allow-Origin", "*");
    headers.append("Cache-Control", "no-store");
    response.set_http_headers(headers);
    request.finish_with_response(response);
  }

  private async resource(request: any): Promise<void> {
    const json = (value: unknown, status = 200) => this.reply(request, new TextEncoder().encode(JSON.stringify(value)), "application/json", status);
    try {
      if (this.status === "closed") { json(false, 410); return; }
      const uri = GLib.Uri.parse(request.get_uri(), GLib.UriFlags.ENCODED);
      if (uri.get_host() !== "module") { json(false, 403); return; }
      const path = uri.get_path();
      if (path === "/_rpc") {
        if (this.stopping) { json(false, 410); return; }
        const raw = uri.get_query() ?? "";
        if (raw.length > 4 * 1024 * 1024) { json(false, 413); return; }
        const value = JSON.parse(decodeURIComponent(raw));
        if (typeof value.text !== "string") { json(false, 400); return; }
        if (["media-acquire", "media-opened", "media-release"].includes(value.op)) { json(this.media.control(value.op, value.text)); return; }
        if (value.op === "insert") json(this.callbacks.insert(value.text) === true);
        else if (value.op === "notice") { this.callbacks.notice(value.text.slice(0, 300)); json(true); }
        else json(false, 403);
        return;
      }
      if (!path.startsWith("/assets/")) { await this.http.request(request, path + (uri.get_query() === null ? "" : "?" + uri.get_query())); return; }
      const file = this.assetPath(path.slice(8));
      await this.http.request(request, this.root + file + (uri.get_query() === null ? "" : "?" + uri.get_query()));
    } catch (error) { json({ error: errorText(error) }, 400); }
  }

  private document(): string {
    const owner = GLib.Uri.parse(this.gateway.base, GLib.UriFlags.SCHEME_NORMALIZE);
    const host = owner.get_host().toLowerCase(), loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) || host.endsWith(".localhost");
    return hostModuleDocument({ capability: this.capability, entry: "ouro-host://module/assets/" + this.entry,
      gateway: this.gateway.base, skill: this.item.skill, key: this.item.key,
      kind: this.item.runtime === "client" ? this.item.provides ?? null : null,
      label: this.item.label, destination: this.item.destination ?? "",
      speech: this.speech.configuration(),
      recognition: this.recognition.configuration(),
      dark: this.style.get_dark(), reducedMotion: !this.settings.gtk_enable_animations,
      origin: { secure: owner.get_scheme() === "https" || loopback, loopback } });
  }

  private async cookies(): Promise<void> {
    const cookies = await this.gateway.moduleCookies();
    if (this.stopping) return;
    const manager = this.view.get_network_session().get_cookie_manager();
    for (const cookie of cookies) await new Promise<void>((resolve, reject) => manager.add_cookie(cookie, this.cookieCancel, (_: unknown, result: any) => {
      try { manager.add_cookie_finish(result); resolve(); } catch (error) { reject(error); }
    }));
    const expires = Math.min(...cookies.map((cookie: any) => cookie.get_expires()?.to_unix() ?? Infinity));
    if (!this.stopping && Number.isFinite(expires) && expires > GLib.get_real_time() / 1000000) this.cookieRefresh = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
      Math.min(0x7fffffff, Math.max(1, Math.floor(expires - GLib.get_real_time() / 1000000 - (this.gateway.hasSession ? 0 : 30)))), () => {
        this.cookieRefresh = 0;
        void this.cookies().catch(error => this.fail(errorText(error)));
        return GLib.SOURCE_REMOVE;
      });
  }

  async start(): Promise<void> {
    if (this.status === "error") throw new Error(this.error);
    if (this.stopping || this.status === "closed") throw new Error("Модуль закрыт.");
    if (this.status === "loading") return this.mounted;
    if (this.status !== "idle") return;
    if (this.ledger.held(this.key, this.item.revision!)) { this.status = "held"; this.callbacks.changed(); return; }
    this.status = "loading";
    const mounted = new Promise<void>((resolve, reject) => { this.mounting = { resolve, reject }; });
    this.mounted = mounted;
    void mounted.catch(() => {});
    try {
      const prepared = await Promise.race([Promise.all([compileFrameFilter(this.kit, ["^file:"].map(pattern => ({ trigger: { "url-filter": pattern }, action: { type: "block" } }))), this.cookies(), this.speech.prepare()]), mounted]);
      if (this.stopping || this.status !== "loading") { await mounted; return; }
      this.manager.add_filter(prepared![0]);
      this.ledger.begin(this.key, this.item.revision!); this.started = true;
      this.boot = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 25000, () => { this.boot = 0; this.fail("Модуль не завершил запуск."); return GLib.SOURCE_REMOVE; });
      this.loadingDocument = true;
      this.view.load_alternate_html(this.document(), this.gateway.base + "/_module", this.gateway.base + "/");
      await mounted;
    } catch (error) { this.fail(errorText(error)); throw error; }
  }

  async release(): Promise<void> {
    if (this.status !== "held") return;
    this.ledger.allow(this.key, this.key); this.status = "idle";
    await this.start();
  }

  private receive(value: any): void {
    if (this.status === "closed" || !value.is_string()) return;
    let message: any;
    try { const raw = value.to_string(); if (raw.length > 4 * 1024 * 1024) return; message = JSON.parse(raw); } catch { return; }
    if (message?.capability !== this.capability) return;
    if (message.type === "disposed") { this.disposed?.(); return; }
    if (this.stopping) return;
    if (message.type === "speech") { this.speech.receive(message); return; }
    if (message.type === "recognition") { this.recognition.receive(message); return; }
    if (message.type === "network-cancel" && typeof message.id === "string") { this.http.cancel(message.id); return; }
    if (message.type === "provider") {
      if (this.item.runtime !== "client" || !this.item.provides) { this.fail("Модуль зарегистрировал необъявленный провайдер."); return; }
      if (!Number.isSafeInteger(message.generation) || message.generation < this.generation) return;
      this.generation = message.generation;
      for (const [id, call] of this.pending) if (call.generation !== this.generation) this.finish(id, undefined, new Error("Провайдер изменился."));
      const p = message.provider;
      this.provider = p && typeof p.availability?.ok === "boolean" && typeof p.label === "string" && typeof p.destination === "string"
        && ["code", "reason"].every(key => p.availability[key] === undefined || typeof p.availability[key] === "string")
        ? { label: p.label, destination: p.destination, availability: { ...p.availability },
          nativeRecognition: this.item.provides === "stt" ? this.recognition.configuration() ?? undefined : undefined } : undefined;
      this.callbacks.changed(); return;
    }
    if (message.type === "fault") { this.fail(typeof message.message === "string" ? message.message : "Ошибка модуля."); return; }
    if (message.type === "mounted" && this.status === "loading") {
      if (this.boot) GLib.Source.remove(this.boot); this.boot = 0;
      this.status = "ready"; this.mounting?.resolve(); this.mounting = undefined;
      this.settle = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => { this.settle = 0; this.settled(); return GLib.SOURCE_REMOVE; });
      this.callbacks.changed(); return;
    }
    if (message.type === "reply" && message.generation === this.generation && Number.isSafeInteger(message.id)) {
      this.finish(message.id, message.value, typeof message.error === "string" ? new Error(message.error) : undefined);
    }
  }

  private send(op: string, args: object, id = 0): void {
    if (this.status === "closed") return;
    const source = `window.__ouroHostCommand?.(${JSON.stringify(this.capability)},${JSON.stringify({ id, op, args })});void 0;`;
    this.view.evaluate_javascript(source, -1, null, null, null, (_view: unknown, result: unknown) => { try { this.view.evaluate_javascript_finish(result); } catch { /* Retired document. */ } });
  }

  call(op: "available" | "voices" | "speak" | "stop" | "start" | "finish", args: object = {}, cancel?: any, timeoutMs = 0): Promise<unknown> {
    if (this.item.runtime !== "client" || !["stt", "tts"].includes(this.item.provides ?? "") || this.stopping || this.status !== "ready" || !["stop", "available"].includes(op) && !this.provider?.availability.ok || cancel?.is_cancelled()) return Promise.reject(new Error("Провайдер модуля недоступен."));
    if (!["stop", "available"].includes(op) && !(this.item.provides === "stt" ? ["start", "finish"] : ["voices", "speak"]).includes(op)) return Promise.reject(new Error("Метод не объявлен провайдером."));
    if (op === "stop") this.recognition.abort();
    if (op === "finish") this.recognition.finish();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => { this.send("cancel", { id }); this.finish(id, undefined, new Error("Истекло время ожидания модуля.")); return GLib.SOURCE_REMOVE; }) : 0;
      const call: Pending = { resolve, reject, timer, cancel, generation: this.generation };
      this.pending.set(id, call);
      if (cancel) call.signal = cancel.connect(() => { if (["start", "finish"].includes(op)) this.recognition.abort(); this.send("cancel", { id }); this.finish(id, undefined, new Error("Вызов модуля отменён."), true); });
      this.send(op, args, id);
    });
  }

  private finish(id: number, value?: unknown, error?: Error, deferDisconnect = false): void {
    const call = this.pending.get(id); if (!call) return;
    this.pending.delete(id); if (call.timer) GLib.Source.remove(call.timer);
    if (call.signal) {
      if (deferDisconnect) GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { call.cancel.disconnect(call.signal); return GLib.SOURCE_REMOVE; });
      else call.cancel.disconnect(call.signal);
    }
    if (error) call.reject(error); else call.resolve(value);
  }

  private theme(): void { this.send("theme", { dark: this.style.get_dark(), reducedMotion: !this.settings.gtk_enable_animations }); }
  private settled(): void { if (this.started) { this.started = false; this.ledger.settled(this.key, this.item.revision!); } }
  private fail(message: string): void {
    if (this.stopping || this.status === "closed" || this.status === "error") return;
    this.error = message; this.status = "error"; this.provider = undefined;
    if (this.boot) GLib.Source.remove(this.boot); this.boot = 0;
    if (this.settle) GLib.Source.remove(this.settle); this.settle = 0;
    this.settled(); this.mounting?.reject(new Error(message)); this.mounting = undefined;
    for (const id of this.pending.keys()) this.finish(id, undefined, new Error(message));
    this.callbacks.changed();
    void this.closeResources();
  }

  private closeResources(): Promise<void> {
    this.stopping = true;
    this.recognition.close();
    this.media.close();
    this.speech.close();
    this.unsubscribeAccess?.(); this.unsubscribeAccess = undefined;
    this.cookieCancel.cancel();
    if (this.cookieRefresh) GLib.Source.remove(this.cookieRefresh); this.cookieRefresh = 0;
    this.closing ??= (async () => {
      await new Promise<void>(resolve => {
        const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => { this.disposed = undefined; resolve(); return GLib.SOURCE_REMOVE; });
        this.disposed = () => { GLib.Source.remove(timer); this.disposed = undefined; resolve(); };
        this.send("dispose", {});
      });
      await this.http.close();
      const manager = this.view.get_network_session().get_cookie_manager();
      await new Promise<void>(resolve => manager.get_all_cookies(null, (_: unknown, result: any) => {
        let cookies: any[];
        try { cookies = manager.get_all_cookies_finish(result) ?? []; } catch { resolve(); return; }
        void Promise.all(cookies.map(cookie => new Promise<void>(done => manager.delete_cookie(cookie, null, (_: unknown, value: any) => {
          try { manager.delete_cookie_finish(value); } catch { /* The context may already be gone. */ } done();
        })))).then(() => resolve());
      }));
      for (const [owner, signal] of this.signals) owner.disconnect(signal); this.signals.length = 0;
      this.manager.disconnect(this.handler); this.manager.unregister_script_message_handler("ouroHost", null);
      this.view.stop_loading();
      this.view.terminate_web_process();
      this.media.dispose();
    })();
    return this.closing;
  }

  async close(): Promise<void> {
    if (this.status === "closed") return this.closing;
    if (this.boot) GLib.Source.remove(this.boot); this.boot = 0;
    if (this.settle) GLib.Source.remove(this.settle); this.settle = 0;
    this.settled(); this.mounting?.reject(new Error("Модуль закрыт.")); this.mounting = undefined;
    for (const id of this.pending.keys()) this.finish(id, undefined, new Error("Модуль закрыт."));
    await this.closeResources();
    this.status = "closed"; this.provider = undefined;
  }
}
