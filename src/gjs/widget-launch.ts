import { type Gateway, type GatewayFrame } from "./gateway.js";
import { frameLedger } from "./frame-ledger.js";
import { GLib } from "./gi.js";
import { button, column, errorText, label, row } from "./ui.js";
import { type WidgetTab, widgetKey } from "./widget-contract.js";
import { WidgetSandbox } from "./widget-sandbox.js";

export type WidgetLaunchMode = "auto" | "manual" | "retain";
export interface WidgetLaunchOptions { where?: "board" | "message"; stopKey?: string; mode?: string }

function launchMode(value: unknown): WidgetLaunchMode | undefined {
  return value === "auto" || value === "manual" || value === "retain" ? value : undefined;
}

export class WidgetLaunch {
  readonly widget = column(4);
  private readonly mount = column(0);
  private readonly status = label("", "dim-label");
  private readonly toggle = button("Запустить виджет", () => this.toggleRun());
  private readonly expand = button("Развернуть", () => { this.expanded = !this.expanded; this.resize(); });
  private readonly where: "board" | "message";
  private readonly ledger: ReturnType<typeof frameLedger>;
  private readonly key: string;
  private readonly stopKey: string;
  private sandbox?: WidgetSandbox;
  private mode: WidgetLaunchMode;
  private active = false;
  private disposed = false;
  private closing = false;
  private restart = false;
  private opened = false;
  private awaiting = false;
  private expanded = false;
  private started = false;
  private settle = 0;
  private boot = 0;
  private measurement = 0;

  constructor(private readonly gateway: Gateway, private tab: WidgetTab, options: WidgetLaunchOptions) {
    this.where = options.where ?? "board";
    this.mode = this.where === "message" ? "auto" : launchMode(options.mode) ?? launchMode(tab.render.start) ?? "auto";
    this.key = "widget:" + widgetKey(tab);
    this.stopKey = options.stopKey ?? this.key;
    this.ledger = frameLedger(gateway);
    const controls = row();
    controls.append(this.toggle);
    controls.append(this.expand);
    this.widget.append(controls);
    this.widget.append(this.status);
    this.widget.append(this.mount);
    this.sync();
  }

  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return;
    this.active = active;
    if (active) {
      if (this.closing) this.restart = true;
      else this.autoStart();
    } else if (this.mode !== "retain" || this.where === "message") {
      this.restart = false;
      this.stop();
    }
    this.sync();
  }

  setMode(value: unknown): void {
    if (this.where === "message") return;
    const mode = launchMode(value) ?? launchMode(this.tab.render.start) ?? "auto";
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode !== "manual") {
      try { this.ledger.resume(this.stopKey); } catch (error) { this.status.set_label(errorText(error)); return; }
      this.autoStart();
    } else if (!this.active) this.stop();
    this.sync();
  }

  update(tab: WidgetTab): void { this.tab = tab; }

  frame(frame: GatewayFrame): void {
    if (frame.type === "extension_lifecycle") this.ledger.report();
    this.sandbox?.frame(frame);
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.restart = false;
    this.stop();
  }

  private toggleRun(): void {
    if (this.disposed || this.closing) return;
    try {
      if (this.sandbox) {
        this.ledger.stop(this.stopKey);
        this.stop();
      } else {
        this.ledger.allow(this.key, this.stopKey);
        this.start();
      }
    } catch (error) { this.status.set_label(errorText(error)); }
    this.sync();
  }

  private autoStart(): void {
    if (this.active && this.mode !== "manual" && !this.sandbox && !this.ledger.held(this.key, this.tab.revision)
      && !this.ledger.isStopped(this.stopKey)) this.start();
  }

  private start(): void {
    if (this.disposed || !this.active || this.sandbox) return;
    this.opened = true;
    this.awaiting = true;
    this.measurement = 0;
    this.status.set_label("Загружаю виджет…");
    const tab = this.tab;
    try {
      const sandbox = new WidgetSandbox(this.gateway, tab, this.mount, this.where, {
        beforeLoad: () => {
          this.ledger.begin(this.key, tab.revision);
          this.started = true;
          this.boot = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
            this.boot = 0;
            void this.sandbox?.stop("Виджет не завершил запуск.");
            return GLib.SOURCE_REMOVE;
          });
        },
        loaded: () => {
          if (this.boot) { GLib.Source.remove(this.boot); this.boot = 0; }
          this.awaiting = false;
          this.settle = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this.settle = 0;
            this.settled(tab.revision);
            return GLib.SOURCE_REMOVE;
          });
          if (this.status.get_label() === "Загружаю виджет…") this.status.set_label("");
          this.sync();
        },
        height: (height) => { this.measurement = Math.ceil(height) + 2; this.resize(); },
        fault: (message) => { this.status.set_label(message); },
        stopped: (message) => {
          if (this.boot) { GLib.Source.remove(this.boot); this.boot = 0; }
          if (this.settle) { GLib.Source.remove(this.settle); this.settle = 0; }
          this.settled(tab.revision, Boolean(message && this.awaiting));
          this.sandbox = undefined;
          this.awaiting = this.closing = false;
          this.status.set_label(message ?? "");
          this.sync();
          if (this.restart) { this.restart = false; this.autoStart(); }
        },
      });
      this.sandbox = sandbox;
      void sandbox.start(this.size());
    } catch (error) {
      this.awaiting = false;
      this.status.set_label(errorText(error));
    }
    this.sync();
  }

  private settled(revision: string, interrupted = false): void {
    if (!this.started) return;
    this.started = false;
    try {
      if (interrupted) this.ledger.hold(this.key, revision);
      else this.ledger.settled(this.key, revision);
    }
    catch (error) { this.status.set_label(errorText(error)); }
  }

  private stop(): void {
    if (!this.sandbox || this.closing) return;
    this.closing = true;
    void this.sandbox.stop();
    this.sync();
  }

  private size(): number {
    const render = this.tab.render;
    const floor = this.where === "message" ? 120 : 320;
    const configured = Number(render.height || 0);
    const upper = Math.max(floor, Math.min(8192, Number(render.max_height) || 8192));
    const windowHeight = this.widget.get_root()?.get_height() || 640;
    const cap = this.where === "message" && !this.expanded ? Math.min(upper, Math.max(floor, Math.floor(windowHeight * 0.7))) : upper;
    const requested = configured || this.measurement || 320;
    return Math.min(cap, Math.max(floor, requested));
  }

  private resize(): void {
    this.sandbox?.resize(this.size());
    this.expand.set_label(this.expanded ? "Свернуть" : "Развернуть");
  }

  private sync(): void {
    const held = this.ledger.held(this.key, this.tab.revision);
    if (held && !this.opened) this.status.set_label("Предыдущий запуск виджета не завершился. Его можно запустить вручную.");
    this.toggle.set_label(this.sandbox ? "Остановить виджет" : "Запустить виджет");
    this.toggle.set_sensitive(this.active && !this.closing);
    this.expand.set_visible(this.where === "message" && Boolean(this.sandbox) && !this.awaiting);
  }
}
