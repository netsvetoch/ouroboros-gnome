import { Gio, GLib } from "./gi.js";
import { createFrameBrowser, compileFrameFilter, scriptJson } from "./frame-browser.js";
import { mermaidDocument, mermaidProgram } from "./mermaid-document.js";
import { errorText } from "./ui.js";
import { diagramImageLoader, type DiagramImageLoader } from "./diagram-images.js";

export interface MermaidSvg { svg: string; width: number; height: number; links: { href: string; label: string }[]; diagramType: string }
interface Job { id: number; source: string; dark: boolean; width: number; cancel: any; signal: number; image: DiagramImageLoader; assets: Map<string, Promise<string>>; assetCancel: any; assetSize: number; resolve(value: MermaidSvg): void; reject(error: Error): void }

/** One isolated, unparented WebKit worker computes SVG; it owns no gateway state. */
export class MermaidRenderer {
  private view: any;
  private manager: any;
  private readonly queue: Job[] = [];
  private current?: Job;
  private sequence = 0;
  private generation = 0;
  private ready = false;
  private starting = false;
  private timeout = 0;
  private idle = 0;
  private signals: number[] = [];
  private messageSignal = 0;

  render(source: string, dark: boolean, width: number, cancel = new Gio.Cancellable(), image = diagramImageLoader()): Promise<MermaidSvg> {
    if (source.length > 50000) return Promise.reject(new Error("Исходник диаграммы превышает предел Mermaid в 50000 символов."));
    if (cancel.is_cancelled()) return Promise.reject(new Error("Построение диаграммы отменено."));
    if (this.idle) GLib.Source.remove(this.idle); this.idle = 0;
    return new Promise((resolve, reject) => {
      const job: Job = { id: ++this.sequence, source, dark, width: Math.max(320, Math.min(8192, Math.round(width || 800))), cancel, signal: 0, image, assets: new Map(), assetCancel: new Gio.Cancellable(), assetSize: 0, resolve, reject };
      job.signal = cancel.connect(() => {
        // GIO forbids disconnecting a cancellation signal inside its callback.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { this.cancel(job); return GLib.SOURCE_REMOVE; });
      });
      this.queue.push(job); this.pump();
    });
  }

  private pump(): void {
    if (this.current || this.starting) return;
    while (this.queue[0]?.cancel.is_cancelled()) this.finishJob(this.queue.shift()!, new Error("Построение диаграммы отменено."));
    if (!this.queue.length) { this.scheduleIdle(); return; }
    if (!this.ready) { void this.start(); return; }
    const job = this.current = this.queue.shift()!;
    this.timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 25, () => { this.timeout = 0; this.fail(new Error("Превышено время построения диаграммы.")); return GLib.SOURCE_REMOVE; });
    this.view.evaluate_javascript(`void ouroborosRenderDiagram(${scriptJson({ id: job.id, source: job.source, dark: job.dark, width: job.width })});`, -1, null, null, null,
      (view: any, result: unknown) => { try { view.evaluate_javascript_finish(result); } catch (error) { if (this.current === job) this.fail(new Error(errorText(error))); } });
  }

  private async start(): Promise<void> {
    this.starting = true;
    const generation = ++this.generation;
    try {
      const { kit, manager, view } = createFrameBrowser({ isolated: true });
      this.view = view; this.manager = manager;
      const filter = await compileFrameFilter(kit, [
        { trigger: { "url-filter": ".*" }, action: { type: "block" } },
        { trigger: { "url-filter": "^data:image/" }, action: { type: "ignore-previous-rules" } },
      ]);
      if (generation !== this.generation) return;
      manager.add_filter(filter);
      const file = Gio.File.new_for_uri(import.meta.url).get_parent().get_child("vendor").get_child("mermaid-browser.js");
      const [, bytes] = file.load_contents(null);
      manager.add_script(kit.UserScript.new(new TextDecoder().decode(bytes) + "\n" + mermaidProgram, kit.UserContentInjectedFrames.TOP_FRAME, kit.UserScriptInjectionTime.END, null, null));
      if (!manager.register_script_message_handler("ouroDiagram", null)) throw new Error("Не удалось открыть канал SVG-рендерера.");
      this.messageSignal = manager.connect("script-message-received::ouroDiagram", (_manager: unknown, value: any) => this.receive(value));
      this.signals = [
        view.connect("load-changed", (_view: unknown, event: number) => {
          if (generation !== this.generation || event !== kit.LoadEvent.FINISHED) return;
          if (this.timeout) GLib.Source.remove(this.timeout); this.timeout = 0;
          this.ready = true; this.starting = false; this.pump();
        }),
        view.connect("load-failed", (_view: unknown, _event: unknown, _uri: unknown, error: unknown) => { this.fail(new Error(errorText(error))); return true; }),
        view.connect("web-process-terminated", () => this.fail(new Error("Процесс построения диаграммы завершился."))),
        view.connect("decide-policy", (_view: unknown, decision: any, kind: number) => {
          if (kind === kit.PolicyDecisionType.NAVIGATION_ACTION && decision.get_navigation_action().get_request().get_uri() === "about:blank") return false;
          if (kind === kit.PolicyDecisionType.RESPONSE && decision.is_mime_type_supported()) return false;
          decision.ignore(); return true;
        }),
      ];
      this.timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 20, () => { this.timeout = 0; this.fail(new Error("Не удалось запустить построение диаграмм.")); return GLib.SOURCE_REMOVE; });
      view.load_html(mermaidDocument, "about:blank");
    } catch (error) { if (generation === this.generation) this.fail(new Error(errorText(error))); }
  }

  private receive(value: any): void {
    if (!this.current || !value.is_string()) return;
    try {
      const text = value.to_string(); if (text.length > 17 * 1024 * 1024) throw new Error("Ответ SVG-рендерера слишком велик.");
      const result = JSON.parse(text);
      if (result.id !== this.current.id) return;
      if (typeof result.resource === "string" && Number.isSafeInteger(result.request) && result.request > 0) { void this.image(this.current, result.request, result.resource); return; }
      const job = this.current; this.current = undefined;
      if (this.timeout) GLib.Source.remove(this.timeout); this.timeout = 0;
      this.finishJob(job, result.error ? new Error(String(result.error)) : undefined, result);
      if (result.fatal) this.reset();
      this.pump();
    } catch (error) { this.fail(new Error(errorText(error))); }
  }

  private async image(job: Job, request: number, source: string): Promise<void> {
    let value: { data?: string; error?: string };
    try {
      if (source.length > 128 * 1024) throw new Error("Адрес изображения слишком велик.");
      let pending = job.assets.get(source);
      if (!pending) {
        pending = job.image(source, job.assetCancel).then(data => {
          if (!/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/u.test(data)) throw new Error("Загрузчик не вернул встроенное изображение.");
          job.assetSize += data.length; if (job.assetSize > 16 * 1024 * 1024) throw new Error("Изображения диаграммы превышают размер SVG.");
          return data;
        });
        job.assets.set(source, pending);
      }
      value = { data: await pending };
    } catch (error) { value = { error: errorText(error) }; }
    if (this.current !== job || job.cancel.is_cancelled() || !this.view) return;
    this.view.evaluate_javascript(`void ouroborosDiagramAsset(${job.id},${request},${scriptJson(value)});`, -1, null, null, null,
      (view: any, result: unknown) => { try { view.evaluate_javascript_finish(result); } catch (error) { if (this.current === job) this.fail(new Error(errorText(error))); } });
  }

  private finishJob(job: Job, error?: Error, value?: MermaidSvg): void {
    if (job.signal) job.cancel.disconnect(job.signal); job.signal = 0;
    job.assetCancel.cancel(); job.assets.clear();
    if (error || job.cancel.is_cancelled()) job.reject(error ?? new Error("Построение диаграммы отменено."));
    else job.resolve(value!);
  }

  private cancel(job: Job): void {
    if (this.current === job) { this.current = undefined; this.finishJob(job, new Error("Построение диаграммы отменено.")); this.reset(); this.pump(); }
    else { const index = this.queue.indexOf(job); if (index >= 0) { this.queue.splice(index, 1); this.finishJob(job, new Error("Построение диаграммы отменено.")); } if (!this.current && !this.queue.length) this.reset(); }
  }
  private fail(error: Error): void {
    const job = this.current ?? this.queue.shift(); this.current = undefined;
    if (job) this.finishJob(job, error);
    this.reset(); this.pump();
  }
  private scheduleIdle(): void {
    if (this.idle || !this.view) return;
    this.idle = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => { this.idle = 0; this.reset(); return GLib.SOURCE_REMOVE; });
  }
  private reset(): void {
    ++this.generation;
    for (const name of ["timeout", "idle"] as const) { if (this[name]) GLib.Source.remove(this[name]); this[name] = 0; }
    if (this.manager && this.messageSignal) this.manager.disconnect(this.messageSignal);
    this.messageSignal = 0;
    for (const signal of this.signals) this.view.disconnect(signal); this.signals = [];
    if (this.manager) { this.manager.unregister_script_message_handler("ouroDiagram", null); this.manager.remove_all_scripts(); this.manager.remove_all_filters(); }
    if (this.view) { this.view.stop_loading(); this.view.terminate_web_process(); }
    this.view = this.manager = undefined; this.ready = this.starting = false;
  }
  close(): void {
    const jobs = [...this.queue]; this.queue.length = 0;
    if (this.current) jobs.push(this.current); this.current = undefined;
    for (const job of jobs) this.finishJob(job, new Error("Построение диаграмм завершено."));
    this.reset();
  }
}

export const mermaidRenderer = new MermaidRenderer();
