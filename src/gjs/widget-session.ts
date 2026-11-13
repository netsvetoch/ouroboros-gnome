import { type Gateway, type GatewayFrame, HttpError } from "./gateway.js";
import { classifyWidgetJobStatus, readWidgetJobStatus } from "./widget-job-status.js";
import { Gio, GLib } from "./gi.js";
import { type SettingsDocument, object } from "./settings-write.js";
import { errorText } from "./ui.js";
import { type WidgetTab, widgetPath, widgetRoute, widgetText } from "./widget-contract.js";

export type WidgetStatus = "idle" | "loading" | "refreshing" | "success" | "error";
export interface WidgetValue {
  data: unknown;
  status: WidgetStatus;
  message: string;
}
const empty: WidgetValue = { data: undefined, status: "idle", message: "" };
type Listener = (value: WidgetValue) => void;
type MountActivity = (active: boolean) => void;

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const n = value == null ? NaN : Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}

export class WidgetSession {
  private readonly values = new Map<string, WidgetValue>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly activities = new Set<MountActivity>();
  private readonly eventHandlers = new Map<string, Set<(data: unknown) => void>>();
  private readonly timers = new Set<number>();
  private readonly resume = new Set<() => void>();
  private readonly requests = new Set<any>();
  private readonly busy = new Set<string>();
  private readonly jobs = new Map<string, { id: string; ticks: number }>();
  private readonly progress = new Map<string, { job: string; value: number }>();
  private readonly progressKeys = new Set(["progress_pct", "progress"]);
  private active = false;
  private disposed = false;

  constructor(private readonly gateway: Gateway, private readonly tab: WidgetTab) {}

  observe(target: string, listener: Listener): void {
    const listeners = this.listeners.get(target) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(target, listeners);
    listener(this.values.get(target) ?? empty);
  }

  onActivity(listener: MountActivity): void {
    this.activities.add(listener);
    if (this.active) listener(true);
  }

  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return;
    this.active = active;
    for (const listener of this.activities) listener(active);
    if (active) {
      const waiting = [...this.resume];
      this.resume.clear();
      for (const run of waiting) run();
    }
  }

  close(): void {
    this.setActive(false);
    this.disposed = true;
    for (const source of this.timers) GLib.Source.remove(source);
    for (const request of this.requests) request.cancel();
    this.timers.clear();
    this.resume.clear();
    this.requests.clear();
    this.listeners.clear();
    this.activities.clear();
    this.eventHandlers.clear();
    this.busy.clear();
    this.jobs.clear();
    this.progress.clear();
  }

  frame(frame: GatewayFrame): void {
    if (!this.disposed) for (const accept of this.eventHandlers.get(frame.type) ?? []) accept(frame.data ?? {});
  }

  subscribe(event: string, target: string, visible: () => boolean): void {
    if (!event || !this.tab.ws_prefix) return;
    const type = this.tab.ws_prefix + event;
    const listeners = this.eventHandlers.get(type) ?? new Set<(data: unknown) => void>();
    listeners.add((data) => { if (this.active && visible()) this.publish(target, "success", data); });
    this.eventHandlers.set(type, listeners);
  }

  addProgressKey(key: string): void {
    if (key) this.progressKeys.add(key);
  }

  private publish(target: string, status: WidgetStatus, data?: unknown, message = ""): void {
    if (this.disposed) return;
    const next = data === undefined ? this.values.get(target)?.data : this.monotonic(target, data);
    const value = { data: next, status, message };
    this.values.set(target, value);
    for (const listener of this.listeners.get(target) ?? []) listener(value);
  }

  private monotonic(target: string, data: unknown): unknown {
    const incoming = object(data);
    const job = widgetText(incoming.job_id);
    if (!job) return data;
    let next = incoming;
    for (const key of this.progressKeys) {
      const number = incoming[key];
      if (typeof number !== "number" || !Number.isFinite(number)) continue;
      const progressKey = target + ":" + key;
      const previous = this.progress.get(progressKey);
      const value = previous?.job === job ? Math.max(previous.value, number) : number;
      this.progress.set(progressKey, { job, value });
      if (number !== value) next = { ...next, [key]: value };
    }
    return next === incoming ? data : next;
  }

  private later(ms: number, run: () => void): void {
    if (this.disposed) return;
    const source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      this.timers.delete(source);
      if (!this.disposed) run();
      return GLib.SOURCE_REMOVE;
    });
    this.timers.add(source);
  }

  private async request(spec: SettingsDocument, values: SettingsDocument): Promise<unknown> {
    const method = widgetText(spec.method, "GET").toUpperCase();
    if (!/^[A-Z]+$/.test(method)) throw new Error("Метод запроса виджета недоступен.");
    const read = method === "GET" || method === "HEAD";
    const path = widgetRoute(this.tab.skill, spec.route || spec.api_route, read ? values : {});
    const cancel = new Gio.Cancellable();
    this.requests.add(cancel);
    let expired = false;
    const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 25, () => {
      expired = true;
      cancel.cancel();
      return GLib.SOURCE_REMOVE;
    });
    try {
      const result = await this.gateway.extensionResult(method, path, read ? undefined : values, cancel);
      if (expired) throw new Error("Истекло время ожидания ответа виджета.");
      const problem = object(result).error;
      if (problem || result === null) throw new HttpError(200, problem ? { error: widgetText(problem, "Шлюз вернул ошибку виджета.") } : null);
      return result;
    } finally {
      if (!expired) GLib.Source.remove(timer);
      this.requests.delete(cancel);
    }
  }

  async action(key: string, target: string, spec: SettingsDocument, values: SettingsDocument, feedback: Listener): Promise<void> {
    if (!this.active || this.busy.has(key) || this.jobs.has(key)) return;
    this.busy.add(key);
    const update = (status: WidgetStatus, message: string, data?: unknown) => {
      if (this.disposed) return;
      this.publish(target, status, data, message);
      feedback({ data, status, message });
    };
    update("loading", "Выполняется…");
    try {
      const data = await this.request(spec, values);
      if (this.disposed) return;
      const fields = object(data);
      if (spec.job === true || spec.mode === "job") {
        const id = widgetText(fields.job_id || fields.id);
        if (!id) throw new Error("Шлюз не вернул идентификатор операции виджета.");
        this.jobs.set(key, { id, ticks: 0 });
        update("loading", widgetText(fields.message, "Операция начата."), { job_id: id });
        this.pollJob(key, target, spec, update);
      } else update("success", widgetText(fields.message, "Готово."), data);
    } catch (error) {
      update("error", errorText(error), { error: errorText(error) });
    } finally {
      this.busy.delete(key);
    }
  }

  private pollJob(key: string, target: string, spec: SettingsDocument,
    update: (status: WidgetStatus, message: string, data?: unknown) => void): void {
    const job = this.jobs.get(key);
    if (!job) return;
    const maxTicks = integer(spec.max_ticks, 240, 1, 1000);
    const interval = integer(spec.interval_ms, 2000, 1000, 30000);
    const finish = (status: WidgetStatus, message: string, data?: unknown) => {
      this.jobs.delete(key);
      update(status, message, data);
    };
    const tick = async () => {
      if (this.disposed || this.jobs.get(key) !== job) return;
      if (!this.active) { this.resume.add(tick); return; }
      job.ticks++;
      try {
        const data = object(await this.request({ route: spec.status_route || spec.job_status_route || "status" }, { job_id: job.id }));
        if (this.disposed) return;
        const status = classifyWidgetJobStatus(readWidgetJobStatus(data));
        if (status === "invalid") { finish("error", "Шлюз вернул некорректное состояние операции."); return; }
        if (status === "success") { finish("success", widgetText(data.message, "Готово."), data.result && typeof data.result === "object" ? data.result : data); return; }
        if (status === "failure") { finish("error", widgetText(data.error, "Операция завершилась ошибкой."), data); return; }
        update("loading", widgetText(data.message, "Выполняется…"), { ...object(this.values.get(target)?.data), ...data, job_id: job.id });
      } catch (error) {
        if (this.disposed) return;
        const retryable = !(error instanceof HttpError) || error.status === 408 || error.status === 429 || error.status >= 500;
        if (!retryable || job.ticks >= maxTicks) { finish("error", errorText(error)); return; }
      }
      if (job.ticks >= maxTicks) finish("error", "Истекло время ожидания результата операции.");
      else this.later(interval, () => void tick());
    };
    void tick();
  }

  poll(key: string, target: string, spec: SettingsDocument, feedback: Listener): void {
    if (!this.active || this.busy.has(key)) return;
    this.busy.add(key);
    let count = 0;
    const max = integer(spec.max_ticks, 20, 1, 100);
    const interval = integer(spec.interval_ms, 2000, 1000, 30000);
    const tick = async () => {
      if (this.disposed) return;
      if (!this.active) { this.resume.add(tick); return; }
      const hasData = this.values.get(target)?.data !== undefined;
      this.publish(target, hasData ? "refreshing" : "loading");
      feedback({ data: undefined, status: "loading", message: "" });
      let complete = false;
      count++;
      try {
        const data = await this.request(spec, {});
        this.publish(target, "success", data);
        complete = String(widgetPath(data, spec.stop_path)) === String(spec.stop_value ?? "done");
      } catch (error) {
        const message = errorText(error);
        this.publish(target, "error", hasData ? undefined : { error: message }, message);
      }
      if (this.disposed) return;
      if (!complete && count < max) this.later(interval, () => void tick());
      else {
        this.busy.delete(key);
        feedback(this.values.get(target) ?? empty);
      }
    };
    void tick();
  }

  stream(target: string, spec: SettingsDocument, visible: () => boolean): () => void {
    let cancel: any;
    const connect = async () => {
      if (!this.active || !visible() || cancel) return;
      const request = new Gio.Cancellable();
      cancel = request;
      this.requests.add(request);
      this.publish(target, "loading");
      try {
        await this.gateway.listenEvents(widgetRoute(this.tab.skill, spec.route || spec.api_route), request, (raw) => {
          if (cancel !== request) return;
          let data: unknown;
          try { data = JSON.parse(raw); } catch { data = { text: raw }; }
          this.publish(target, "success", data);
        });
      } catch (error) {
        if (cancel === request) this.publish(target, "error", undefined, errorText(error));
      } finally {
        this.requests.delete(request);
        if (cancel === request) {
          cancel = undefined;
          this.later(2500, () => void connect());
        }
      }
    };
    const sync = () => {
      if (this.active && visible()) void connect();
      else {
        cancel?.cancel();
        cancel = undefined;
      }
    };
    this.onActivity(sync);
    return sync;
  }
}
