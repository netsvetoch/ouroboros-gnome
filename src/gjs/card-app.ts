import { appHostDocument, type CardTheme, cardStateLimit } from "./card-app-document.js";
import { compileFrameFilter, createFrameBrowser, frameSecret, type FrameRule } from "./frame-browser.js";
import { frameLedger } from "./frame-ledger.js";
import { type Gateway, HttpError } from "./gateway.js";
import { Adw, Gio, GLib } from "./gi.js";
import { type SettingsDocument, object } from "./settings-write.js";
import { button, column, errorText, label, row } from "./ui.js";

export interface CardAppRef { sha256: string; size: number; url: string }

interface AppRun {
  readonly cancel: any;
  readonly capability: string;
  readonly nonce: string;
  view?: any;
  manager?: any;
  handler?: number;
  boot: number;
  settle: number;
  ledgerEntry: boolean;
  ready: boolean;
}

const blockNetwork: FrameRule[] = ["^https?://", "^wss?://", "^file:", "^ftp://"].map((pattern) => ({
  trigger: { "url-filter": pattern }, action: { type: "block" },
}));

function compact(value: string): string { return value.replace(/\s+/g, " ").trim(); }

export function appDraftLine(title: string, value: unknown, summary: string): string {
  const words = compact(summary).slice(0, 300);
  const json = value == null ? "" : JSON.stringify(value) ?? "";
  const repeats = typeof value === "string" && compact(value) === words;
  const content = [words, json.length <= 300 && !repeats ? json : ""].filter(Boolean).join(" ");
  return `From «${compact(title || "card")}»: ${content || "(no summary)"}`;
}

export class CardApp {
  readonly widget = column(5);
  private readonly mount = column(0);
  private readonly status = label("", "dim-label");
  private readonly toggle = button("Открыть приложение", () => this.toggleOpen());
  private readonly expand = button("Развернуть", () => { this.expanded = !this.expanded; this.fit(); });
  private readonly style = Adw.StyleManager.get_default();
  private readonly themeSignals: number[] = [];
  private readonly ledger: ReturnType<typeof frameLedger>;
  private readonly key: string;
  private readonly stopKey: string;
  private readonly stateKey: string;
  private readonly appPath: string;
  private readonly faults = new Set<string>();
  private run?: AppRun;
  private closed = false;
  private expanded = false;
  private height = 320;

  constructor(private readonly gateway: Gateway, id: string, private readonly title: string, private readonly ref: CardAppRef,
    private readonly states: Map<string, string>, private readonly submit: (line: string) => boolean) {
    this.ledger = frameLedger(gateway);
    this.key = "app:" + id;
    this.stopKey = "card:" + id;
    this.stateKey = this.key + ":" + ref.sha256;
    this.appPath = "/api/cards/" + encodeURIComponent(id) + "/app";
    const controls = row();
    controls.append(this.toggle);
    controls.append(this.expand);
    this.widget.append(controls);
    this.widget.append(this.status);
    this.widget.append(this.mount);
    this.status.set_selectable(true);
    this.themeSignals.push(this.style.connect("notify::dark", () => this.updateTheme()));
    if (this.style.get_accent_color_rgba) this.themeSignals.push(this.style.connect("notify::accent-color", () => this.updateTheme()));
    this.sync();
  }

  open(): void {
    if (this.closed || this.run) return;
    if (this.ledger.held(this.key, this.ref.sha256)) {
      this.status.set_label("Предыдущий запуск приложения прервался. При открытии оно начнёт с чистого состояния.");
    } else if (!this.ledger.isStopped(this.stopKey)) void this.start();
  }

  reportHolds(): void { this.ledger.report(); }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const signal of this.themeSignals) this.style.disconnect(signal);
    if (this.run) this.finish(this.run);
  }

  private toggleOpen(): void {
    if (this.closed) return;
    try {
      if (this.run) {
        this.ledger.stop(this.stopKey);
        this.finish(this.run);
      } else {
        if (this.ledger.held(this.key, this.ref.sha256)) this.states.delete(this.stateKey);
        this.ledger.allow(this.key, this.stopKey);
        void this.start();
      }
    } catch (error) { this.status.set_label(errorText(error)); }
  }

  private async start(): Promise<void> {
    if (this.closed || this.run) return;
    this.status.set_label("Загружаю приложение…");
    this.height = 320;
    this.faults.clear();
    let run: AppRun | undefined;
    try {
      if (this.ref.url !== this.appPath) throw new Error("Адрес приложения не совпадает с адресом карточки.");
      const attempt: AppRun = { cancel: new Gio.Cancellable(), capability: frameSecret(), nonce: frameSecret(),
        boot: 0, settle: 0, ledgerEntry: false, ready: false };
      run = this.run = attempt;
      this.sync();
      const html = await this.gateway.cardApp(this.appPath, this.ref.size, this.ref.sha256, attempt.cancel);
      if (this.run !== attempt) return;
      const { kit, manager, view } = createFrameBrowser();
      attempt.view = view;
      attempt.manager = manager;
      const filter = await compileFrameFilter(kit, blockNetwork);
      if (this.run !== attempt) return;
      manager.add_filter(filter);
      const kinds = kit.PolicyDecisionType;
      view.connect("decide-policy", (_view: unknown, decision: any, type: number) => {
        if (type === kinds.NAVIGATION_ACTION) {
          const uri = decision.get_navigation_action().get_request().get_uri();
          if (uri === "about:blank" || uri === "about:srcdoc") return false;
          decision.ignore();
          this.finish(attempt, "Приложение попыталось открыть другой документ.");
          return true;
        }
        if (type === kinds.NEW_WINDOW_ACTION || type === kinds.RESPONSE && !decision.is_mime_type_supported()) {
          decision.ignore();
          return true;
        }
        return false;
      });
      view.connect("web-process-terminated", () => this.finish(attempt, "Процесс приложения завершился.", !attempt.ready));
      view.connect("load-failed", (_view: unknown, _event: unknown, _uri: unknown, error: unknown) => {
        this.finish(attempt, errorText(error), !attempt.ready);
        return true;
      });
      attempt.handler = manager.connect("script-message-received::ouroCard", (_manager: unknown, value: any) => this.receive(attempt, value));
      if (!manager.register_script_message_handler("ouroCard", null)) throw new Error("Не удалось открыть канал приложения.");
      this.mount.append(view);
      this.fit();
      this.ledger.begin(this.key, this.ref.sha256);
      attempt.ledgerEntry = true;
      attempt.boot = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
        attempt.boot = 0;
        this.finish(attempt, "Приложение не завершило запуск.", true);
        return GLib.SOURCE_REMOVE;
      });
      view.load_html(appHostDocument(html, attempt.capability, attempt.nonce, this.theme(), this.states.get(this.stateKey) ?? null), "about:blank");
    } catch (error) {
      if (run && this.run !== run) return;
      const message = error instanceof HttpError && error.status === 404
        ? "HTML-приложение карточки больше недоступно." : errorText(error);
      if (run) this.finish(run, message);
      else this.status.set_label(message);
    }
  }

  private receive(run: AppRun, value: any): void {
    if (this.run !== run || !value.is_string()) return;
    let message: SettingsDocument;
    try {
      const text = value.to_string();
      if (text.length > 256 * 1024) return;
      message = object(JSON.parse(text));
    } catch { return; }
    if (message.capability !== run.capability) return;
    switch (message.type) {
      case "card-loaded":
        if (run.ready) return;
        run.ready = true;
        if (run.boot) { GLib.Source.remove(run.boot); run.boot = 0; }
        run.settle = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
          run.settle = 0;
          this.settle(run);
          return GLib.SOURCE_REMOVE;
        });
        if (this.status.get_label() === "Загружаю приложение…") this.status.set_label("");
        this.updateTheme();
        this.sync();
        break;
      case "card-navigated":
        this.finish(run, "Приложение открыло другой документ.");
        break;
      case "ouro-card-resize":
        if (typeof message.height === "number" && Number.isFinite(message.height) && message.height > 0) {
          this.height = Math.ceil(message.height);
          this.fit();
        }
        break;
      case "ouro-card-state":
        this.saveState(message.state);
        break;
      case "ouro-card-submit":
        if (typeof message.summary !== "string") return;
        if (!this.submit(appDraftLine(this.title, message.value, message.summary))) {
          this.status.set_label("Черновик сейчас занят отправкой. Результат можно перенести после её завершения.");
        }
        break;
      case "ouro-card-error":
        this.showFault(message);
        break;
    }
  }

  private saveState(value: unknown): void {
    if (typeof value !== "string" || new TextEncoder().encode(value).length > cardStateLimit) return;
    try { JSON.parse(value); } catch { return; }
    this.states.delete(this.stateKey);
    this.states.set(this.stateKey, value);
    if (this.states.size > 100) {
      const oldest = this.states.keys().next().value;
      if (oldest !== undefined) this.states.delete(oldest);
    }
  }

  private showFault(message: SettingsDocument): void {
    if (!["error", "csp", "rejection"].includes(String(message.kind)) || typeof message.message !== "string") return;
    const description = new TextDecoder().decode(new TextEncoder().encode(message.message.slice(0, 300)));
    const key = `${message.kind}:${description}`;
    if (this.faults.has(key) || this.faults.size >= 10) return;
    this.faults.add(key);
    this.status.set_label(`${message.kind === "csp" ? "Политика приложения заблокировала действие" : "Ошибка приложения"} · ${description || "без описания"}`);
  }

  private theme(): CardTheme {
    const dark = this.style.get_dark();
    const name = dark ? "dark" : "light";
    const [text, meta, surface, tray, border, ok, warn, error] = dark
      ? ["#ffffff", "#b7b7bc", "#303030", "#242424", "#555559", "#8ff0a4", "#f8e45c", "#ff7b7b"]
      : ["#242424", "#626267", "#ffffff", "#f6f5f4", "#deddda", "#206c35", "#8d5e00", "#b52a2a"];
    const accent = this.style.get_accent_color_rgba?.()?.to_string() || (dark ? "#78aeed" : "#1c71d8");
    return { name, css: `:root { color-scheme: ${name}; --ouro-text: ${text}; --ouro-text-meta: ${meta}; --ouro-accent: ${accent}; --ouro-surface: ${surface}; --ouro-tray: ${tray}; --ouro-border: ${border}; --ouro-ok: ${ok}; --ouro-warn: ${warn}; --ouro-error: ${error}; --ouro-font: system-ui, sans-serif; --ouro-radius: 12px; } html { background: transparent; color: var(--ouro-text); font-family: var(--ouro-font); }` };
  }

  private updateTheme(): void {
    const run = this.run;
    if (!run?.ready) return;
    const script = `window.ouroCardTheme(${JSON.stringify(run.capability)},${JSON.stringify(this.theme())});`;
    run.view.evaluate_javascript(script, -1, null, null, run.cancel, (_view: unknown, result: unknown) => {
      try { run.view.evaluate_javascript_finish(result); } catch { /* A closing frame no longer needs the theme. */ }
    });
  }

  private settle(run: AppRun, interrupted = false): void {
    if (!run.ledgerEntry) return;
    run.ledgerEntry = false;
    try {
      if (interrupted) this.ledger.hold(this.key, this.ref.sha256);
      else this.ledger.settled(this.key, this.ref.sha256);
    } catch (error) { this.status.set_label(errorText(error)); }
  }

  private finish(run: AppRun, message = "", interrupted = false): void {
    if (this.run !== run) return;
    this.run = undefined;
    run.cancel.cancel();
    if (run.boot) GLib.Source.remove(run.boot);
    if (run.settle) GLib.Source.remove(run.settle);
    this.status.set_label(message);
    this.settle(run, interrupted);
    if (run.handler) {
      run.manager.disconnect(run.handler);
      run.manager.unregister_script_message_handler("ouroCard", null);
    }
    if (run.view) {
      run.view.stop_loading();
      if (run.view.get_parent() === this.mount) this.mount.remove(run.view);
    }
    this.sync();
  }

  private fit(): void {
    const upper = this.expanded ? 8192 : Math.max(120, Math.floor((this.widget.get_root()?.get_height() || 640) * 0.7));
    this.run?.view?.set_size_request(-1, Math.max(120, Math.min(upper, this.height)));
    this.expand.set_label(this.expanded ? "Свернуть" : "Развернуть");
  }

  private sync(): void {
    this.toggle.set_label(this.run ? "Закрыть приложение" : "Открыть приложение");
    this.expand.set_visible(this.run?.ready === true);
    this.fit();
  }
}
