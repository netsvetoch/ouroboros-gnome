import { type Gateway, type GatewayFrame } from "./gateway.js";
import { Adw, GLib, Gtk } from "./gi.js";
import { compileFrameFilter, createFrameBrowser, frameSecret } from "./frame-browser.js";
import { type SettingsDocument, object } from "./settings-write.js";
import { errorText } from "./ui.js";
import { type WidgetTab, widgetRoute } from "./widget-contract.js";
import { WidgetLease, redactWidgetLeases } from "./widget-lease.js";
import { type WidgetRequestId, WidgetRelay } from "./widget-relay.js";
import { moduleDocument, parentDocument } from "./widget-sandbox-document.js";

interface SandboxCallbacks {
  beforeLoad: () => void;
  loaded: () => void;
  height: (height: number) => void;
  fault: (message: string) => void;
  stopped: (message?: string) => void;
}
const instances = new WeakMap<Gateway, Set<WidgetSandbox>>();
const safeExternal = /^(https?:\/\/|mailto:)/i;

function filterRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function originOf(url: string): string {
  const origin = GLib.Uri.parse(url, GLib.UriFlags.SCHEME_NORMALIZE);
  const authority = origin.get_host().includes(":") ? `[${origin.get_host()}]` : origin.get_host();
  const port = origin.get_port();
  const scheme = origin.get_scheme();
  const defaultPort = scheme === "https" ? 443 : 80;
  return `${scheme}://${authority.toLowerCase()}${port > 0 && port !== defaultPort ? ":" + port : ""}`;
}

function filterFor(kit: any, gateway: Gateway, route: boolean, prefix: string): Promise<any> {
  const gatewayOrigin = originOf(gateway.base);
  const blocked = route ? [`^${filterRegex(gatewayOrigin)}[/]`, `^wss?://${filterRegex(gatewayOrigin.split("://")[1])}[/]`]
    : ["^https?://", "^wss?://"];
  const allow = (pattern: string) => ({ trigger: { "url-filter": pattern }, action: { type: "ignore-previous-rules" } });
  const escaped = filterRegex(GLib.Uri.parse(gateway.base, GLib.UriFlags.SCHEME_NORMALIZE).to_string().replace(/\/$/, ""));
  const rules = blocked.map((pattern) => ({ trigger: { "url-filter": pattern }, action: { type: "block" } }));
  rules.push(allow(`^${escaped}/api/widget-resources/[A-Za-z0-9_-]+/`));
  if (!route) rules.push(allow(`^${escaped}/api/widget-assets/[A-Za-z0-9_-]+/`));
  if (route) rules.push(allow(`^${escaped}/api/widget-bridge\\.js$`));
  else rules.push(allow(`^${filterRegex(GLib.Uri.parse(prefix, GLib.UriFlags.SCHEME_NORMALIZE).to_string())}module/`));
  return compileFrameFilter(kit, rules);
}

function sourcePath(value: unknown, module: boolean): string {
  if (typeof value !== "string" || !value || (!module && value.includes("/"))
    || !value.split("/").every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== "..")) {
    throw new Error("Шлюз объявил недопустимый путь модуля виджета.");
  }
  return value;
}

function faultText(value: unknown, limit: number): string {
  const text = typeof value === "string" ? redactWidgetLeases(value).slice(0, limit) : "";
  return new TextDecoder().decode(new TextEncoder().encode(text));
}

export function stopWidgetSandboxes(gateway: Gateway): Promise<unknown> | undefined {
  const current = instances.get(gateway);
  if (current?.size) return Promise.all([...current].map((sandbox) => sandbox.stop()));
}

export class WidgetSandbox {
  private readonly kit: any;
  private readonly view: any;
  private readonly manager: any;
  private readonly style = Adw.StyleManager.get_default();
  private readonly capability = frameSecret();
  private readonly route: boolean;
  private readonly fileLease: boolean;
  private readonly lease: WidgetLease;
  private readonly done: Promise<void>;
  private complete!: () => void;
  private relay?: WidgetRelay;
  private document = 0;
  private timer = 0;
  private styleSignal = 0;
  private handler = 0;
  private subscribed = false;
  private themed = false;
  private stopping = false;
  private stopReason?: string;
  private stopped = false;
  private loaded = false;
  private readonly faults = new Set<string>();
  private readonly ownerPath: string;
  private allowedRoute = "";

  constructor(private readonly gateway: Gateway, private readonly tab: WidgetTab, private readonly mount: any,
    private readonly where: "board" | "message", private readonly callbacks: SandboxCallbacks) {
    const { kit, manager, view } = createFrameBrowser();
    this.kit = kit;
    this.route = tab.render.kind === "iframe";
    this.fileLease = !this.route && tab.render.entry_type === "module";
    this.lease = new WidgetLease(gateway, tab, (message) => this.stop(message));
    this.done = new Promise<void>((resolve) => { this.complete = resolve; });
    this.ownerPath = widgetRoute(tab.skill, "_").slice(0, -1);
    this.manager = manager;
    this.view = view;
    this.view.connect("decide-policy", (_view: unknown, decision: any, type: number) => this.policy(decision, type));
    this.view.connect("web-process-terminated", () => this.finish("Процесс виджета завершился."));
    this.view.connect("load-failed", (_view: unknown, _event: unknown, _uri: unknown, error: unknown) => {
      if (!this.stopping) this.finish(redactWidgetLeases(errorText(error)));
      return true;
    });
    this.handler = this.manager.connect("script-message-received::ouroNative", (_manager: unknown, value: any) => this.receive(value));
    if (!this.manager.register_script_message_handler("ouroNative", null)) throw new Error("Не удалось открыть канал виджета.");
    this.styleSignal = this.style.connect("notify::dark", () => { if (this.themed) this.sendTheme(); });
    const current = instances.get(gateway) ?? new Set<WidgetSandbox>();
    current.add(this);
    instances.set(gateway, current);
  }

  private policy(decision: any, type: number): boolean {
    const kinds = this.kit.PolicyDecisionType;
    if (type === kinds.NAVIGATION_ACTION) {
      const action = decision.get_navigation_action();
      const uri: string = action.get_request().get_uri();
      if (uri === "about:blank" || !this.route && uri === "about:srcdoc" || this.route && this.allowedRoute && uri.startsWith(this.allowedRoute)) return false;
      if (this.route && this.allowedRoute && action.is_redirect() && /^https?:\/\//i.test(uri)) {
        try { if (originOf(uri) !== originOf(this.gateway.base)) return false; } catch { /* Invalid redirect. */ }
      }
      if (!this.route && !this.stopping) this.finish("Виджет попытался открыть другой документ.");
      decision.ignore();
      return true;
    }
    if (type === kinds.NEW_WINDOW_ACTION || type === kinds.RESPONSE && !decision.is_mime_type_supported()) {
      decision.ignore();
      return true;
    }
    return false;
  }

  async start(initialHeight: number): Promise<void> {
    const { tab, gateway } = this;
    try {
      const origin = gateway.base;
      const routeBase = origin + this.ownerPath;
      const entry = this.route ? "" : sourcePath(tab.render.entry, this.fileLease);
      const [lease, filter, bridge, classic] = await Promise.all([
        this.lease.open(),
        filterFor(this.kit, gateway, this.route, routeBase),
        this.route ? undefined : gateway.bytes("/api/widget-bridge.js"),
        this.route || this.fileLease ? undefined : gateway.bytes(this.ownerPath + "module/" + entry),
      ]);
      if (this.stopped || this.stopping) return;
      this.manager.add_filter(filter);
      const base = origin + lease.basePath;
      const nonce = frameSecret();
      const sandbox = this.route ? {
        kind: "route" as const, capability: this.capability, proof: lease.token, routeBase,
        src: base + widgetRoute(tab.skill, tab.render.route).slice(this.ownerPath.length),
      } : {
        kind: "module" as const, capability: this.capability, proof: nonce, routeBase,
        document: moduleDocument({
          nonce, routeBase, initialTheme: this.theme, bridge: new TextDecoder().decode(bridge.get_data()), entry,
          classicSource: classic && new TextDecoder().decode(classic.get_data()),
          assetBase: this.fileLease ? base : "", resourceBase: this.fileLease ? "" : base, resize: !tab.render.height,
        }),
      };
      this.allowedRoute = this.route ? base : "";
      this.basePath = lease.basePath;
      this.view.set_size_request(-1, initialHeight);
      this.mount.append(this.view);
      this.callbacks.beforeLoad();
      this.view.load_html(parentDocument(sandbox), "about:blank");
    } catch (error) {
      if (!this.stopped) this.finish(redactWidgetLeases(errorText(error)));
    }
  }

  private basePath = "";

  resize(height: number): void {
    if (!this.stopped) this.view.set_size_request(-1, height);
  }

  private receive(value: any): void {
    if (this.stopped || !value.is_string()) return;
    let msg: SettingsDocument;
    try {
      const text = value.to_string();
      if (text.length > 46 * 1024 * 1024) return;
      msg = object(JSON.parse(text));
    } catch { return; }
    if (msg.capability !== this.capability) return;
    if (msg.type === "host-loaded") {
      if (!this.loaded) {
        this.loaded = true;
        this.callbacks.loaded();
      }
      return;
    }
    if (msg.type === "host-document") {
      if (typeof msg.document !== "number" || !Number.isSafeInteger(msg.document) || msg.document < 0 || !this.basePath) return;
      this.changeDocument(msg.document);
      return;
    }
    if (msg.type === "host-navigated") { this.finish("Виджет открыл другой документ."); return; }
    if (msg.document !== this.document || !this.relay) return;
    const id = typeof msg.id === "string" && msg.id.length <= 100
      || typeof msg.id === "number" && Number.isSafeInteger(msg.id) && msg.id > 0 ? msg.id : undefined;
    switch (msg.type) {
      case "ouro-widget-fetch": if (id) void this.relay.fetch(id, msg); break;
      case "ouro-widget-fetch-pull": if (id) void this.relay.pull(id); break;
      case "ouro-widget-fetch-abort": if (id) this.relay.abort(id); break;
      case "ouro-widget-download": if (id) void this.relay.download(id, msg); break;
      case "ouro-widget-open-external": if (id) void this.external(id, msg); break;
      case "ouro-widget-events": this.subscribed = msg.op === "subscribe"; break;
      case "ouro-widget-theme": this.themed = msg.op === "subscribe"; if (this.themed) this.sendTheme(); break;
      case "ouro-widget-resize":
        if (!this.route && typeof msg.height === "number" && Number.isFinite(msg.height) && msg.height > 0) this.callbacks.height(msg.height);
        break;
      case "ouro-widget-error": this.report(msg); break;
      case "ouro-widget-disposed": if (this.stopping) this.finish(); break;
    }
  }

  private changeDocument(number: number): void {
    this.relay?.close();
    this.relay = undefined;
    this.document = number;
    this.subscribed = this.themed = false;
    if (this.document) {
      this.relay = new WidgetRelay(this.gateway, this.tab.skill, this.basePath, this.fileLease, this.mount, (message) => this.send(number, message));
    } else if (this.stopping) this.finish();
  }

  private send(document: number, message: SettingsDocument): void {
    if (this.stopped || !document || document !== this.document) return;
    const script = `window.ouroNativeReceive(${JSON.stringify(this.capability)},${document},${JSON.stringify(message)});`;
    this.view.evaluate_javascript(script, -1, null, null, null, (_view: unknown, result: unknown) => {
      try { this.view.evaluate_javascript_finish(result); } catch { /* The old document can disappear first. */ }
    });
  }

  private get theme(): string { return this.style.get_dark() ? "dark" : "light"; }

  private sendTheme(): void { this.send(this.document, { type: "ouro-widget-theme", theme: this.theme }); }

  frame(frame: GatewayFrame): void {
    const prefix = this.tab.ws_prefix;
    if (this.subscribed && prefix && frame.type.startsWith(prefix)) {
      this.send(this.document, { type: "ouro-widget-event", event: frame.type.slice(prefix.length), data: frame.data ?? {} });
    }
  }

  private async external(id: WidgetRequestId, msg: SettingsDocument): Promise<void> {
    const document = this.document;
    let result: SettingsDocument;
    try {
      const url = typeof msg.url === "string" ? msg.url : "";
      if (msg.activated !== true || !safeExternal.test(url) || /[\s\x00-\x1f\x7f]/.test(url) || url.length > 8192) {
        throw new Error("Открытие ссылки требует действия пользователя.");
      }
      if (/\/api\/widget-(assets|resources)\//.test(url)) throw new Error("Адрес аренды ресурсов нельзя передать наружу.");
      const launcher = new Gtk.UriLauncher({ uri: url });
      await new Promise<void>((resolve, reject) => launcher.launch(this.mount.get_root(), null, (_launcher: unknown, reply: unknown) => {
        try { launcher.launch_finish(reply); resolve(); } catch (error) { reject(error); }
      }));
      result = { ok: true };
    } catch (error) { result = { ok: false, error: redactWidgetLeases(errorText(error)) }; }
    this.send(document, { type: "ouro-widget-open-external-result", id, result });
  }

  private report(msg: SettingsDocument): void {
    const kind = msg.kind;
    if (kind !== "error" && kind !== "rejection" && kind !== "csp") return;
    const message = faultText(msg.message, 500);
    const source = faultText(msg.source, 200);
    const key = kind + ":" + message;
    if (this.faults.has(key) || this.faults.size >= 10) return;
    this.faults.add(key);
    this.callbacks.fault([message, source].filter(Boolean).join(" · ") || "Ошибка виджета.");
    const line = typeof msg.line === "number" && Number.isSafeInteger(msg.line) && msg.line >= 0 ? msg.line : 0;
    void this.gateway.json("POST", "/api/widgets/fault", {
      skill: this.tab.skill, tab_id: this.tab.tab_id, revision: this.tab.revision, where: this.where, kind, message, source, line,
    }).catch(() => {});
  }

  stop(reason?: string): Promise<void> {
    if (this.stopped || this.stopping) return this.done;
    this.stopping = true;
    this.stopReason = reason;
    if (!this.document) this.finish(reason);
    else {
      this.send(this.document, { type: "ouro-widget-dispose" });
      this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
        this.timer = 0;
        this.finish(reason);
        return GLib.SOURCE_REMOVE;
      });
    }
    return this.done;
  }

  private finish(reason?: string): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) GLib.Source.remove(this.timer);
    this.relay?.close();
    this.style.disconnect(this.styleSignal);
    this.manager.disconnect(this.handler);
    this.manager.unregister_script_message_handler("ouroNative", null);
    this.view.stop_loading();
    if (this.view.get_parent() === this.mount) this.mount.remove(this.view);
    void this.lease.close().finally(() => {
      instances.get(this.gateway)?.delete(this);
      this.complete();
    });
    this.callbacks.stopped(reason ?? this.stopReason);
  }
}
