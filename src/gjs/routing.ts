import { bindChrome, chromeText, watchNativeI18n } from "./native-i18n.js";
import { type Gateway, type GatewayFrame, HttpError, query } from "./gateway.js";
import { Gio, GLib, Gtk } from "./gi.js";
import { button, clear, column, errorText, label, sheet } from "./ui.js";
import { exactWorkTarget } from "./work-actions.js";
import { RoutingJournal, type RoutingRequest as Request } from "./routing-journal.js";

interface RoutingOption { action?: string; task_id?: string; project_id?: string; label?: string; title?: string; project_name?: string }
export interface RoutingAnnotation {
  action?: string;
  status?: string;
  routing_token?: string;
  cause?: string;
  detail?: string;
  target?: string;
  target_label?: string;
  target_task_ids?: string[];
  target_titles?: string[];
  project_id?: string;
  project_chat_id?: number;
  project_name?: string;
  options?: RoutingOption[];
  reasoning_effort?: string;
  attachment_manifest?: { status?: string; label?: string; ordinal?: number }[];
}

export interface RoutingRow {
  role?: string;
  client_message_id?: string;
  row_address?: string;
  history_id?: string;
  chat_annotation?: RoutingAnnotation;
}

interface Entry {
  annotation?: RoutingAnnotation;
  at: number;
  confirmed: boolean;
}
interface Target { id: string; address?: string }
interface Receipt {
  ok?: boolean;
  decision_id?: string;
  state?: string;
  answered_index?: number;
  dispatched?: string;
  task_id?: string;
  reasoning_effort?: string;
  latest_status?: string;
  cause?: string;
  reason?: string;
}
interface Attempt { request?: Request; optionKey?: string; busy?: boolean; receipt?: Receipt; receiptAt?: number; error?: string; errorSource?: string }
interface ExactHistory {
  anchor?: { state?: string; chat_id?: number; row_address?: string; history_id?: string };
  messages?: RoutingRow[];
}

const landed = new Set(["scheduled", "delivered", "read"]);
const states: Record<string, string> = {
  pending: "Шлюз выбирает назначение", dispatch_pending: "Шлюз подтверждает отправку по выбранному маршруту",
  needs_manual_target: "Сообщению требуется назначение", project_unavailable: "Проект недоступен",
  accepted: "Запрос маршрутизации принят", scheduled: "Задача поставлена в очередь", delivered: "Сообщение передано задаче",
  read: "Задача прочитала сообщение", rejected: "Шлюз отклонил маршрутизацию", unconfirmed: "Маршрут не подтверждён",
};

const stateSources: Record<string, string> = {
  pending: "The gateway is choosing a destination", dispatch_pending: "The gateway is confirming the selected route",
  needs_manual_target: "This message needs a destination", project_unavailable: "Project unavailable",
  accepted: "Routing request accepted", scheduled: "Task queued", delivered: "Message delivered to task",
  read: "The task has read the message", rejected: "The gateway refused routing", unconfirmed: "Route unconfirmed",
};
const localSources: Record<string, string> = {
  "Шлюз не подтвердил точную запись маршрута.": "The gateway did not confirm the exact routing record.",
  "Маршрут изменился. Проверьте варианты перед отправкой.": "The route changed. Check the options before sending.",
  "Шлюз не подтвердил отправку. Можно повторить прежний запрос.": "The gateway did not confirm dispatch. You can retry the previous request.",
  "Не удалось удалить завершённый запрос из журнала маршрутов клиента.": "Could not remove the completed request from the client routing journal.",
  "Не удалось прочитать журнал маршрутов клиента. Новые отправки не сохраняются поверх него.": "Could not read the client routing journal. New requests will not overwrite it.",
  "Не удалось сохранить точный запрос маршрутизации.": "Could not save the exact routing request.",
  "Для этого маршрута уже сохранён другой запрос. Переоткройте окно и проверьте прежнюю отправку.": "Another request is already saved for this route. Reopen the dialog and check the previous dispatch.",
};
const localSource = (value: string) => Object.hasOwn(localSources, value) ? localSources[value] : undefined;
const localText = (value: string) => localSource(value) ? chromeText(localSources[value], undefined, value) : value;
const stateText = (value: string) => Object.hasOwn(stateSources, value) ? chromeText(stateSources[value], undefined, states[value]) : value;
const joined = (status: string, target?: string) => target
  ? chromeText("{status} · {target}", { status, target }, `${status} · ${target}`) : status;
const effortText = (effort: string) => chromeText("Effort · {effort}", { effort }, `Усилие · ${effort}`);

const object = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const strings = (value: Record<string, any>, keys: string[]) => keys.every(key => value[key] === undefined || typeof value[key] === "string");

function readAnnotation(value: unknown): RoutingAnnotation | undefined {
  if (!object(value) || typeof value.status !== "string" || !value.status
    || !strings(value, ["action", "routing_token", "cause", "detail", "target", "target_label", "project_id", "project_name", "reasoning_effort"])
    || (value.project_chat_id !== undefined && !Number.isSafeInteger(value.project_chat_id))
    || ["target_task_ids", "target_titles"].some(key => value[key] !== undefined
      && (!Array.isArray(value[key]) || value[key].some((item: unknown) => typeof item !== "string")))
    || (value.options !== undefined && (!Array.isArray(value.options) || value.options.some((item: unknown) =>
      !object(item) || !strings(item, ["action", "task_id", "project_id", "label", "title", "project_name"]))))
    || (value.attachment_manifest !== undefined && (!Array.isArray(value.attachment_manifest)
      || value.attachment_manifest.some((item: unknown) => !object(item) || !strings(item, ["status", "label"])
        || (item.ordinal !== undefined && (!Number.isSafeInteger(item.ordinal) || item.ordinal < 0)))))) return undefined;
  return value as RoutingAnnotation;
}

function readReceipt(value: unknown): Receipt | undefined {
  if (!object(value) || (value.ok !== undefined && typeof value.ok !== "boolean")
    || !strings(value, ["decision_id", "state", "dispatched", "task_id", "reasoning_effort", "latest_status", "cause", "reason"])
    || (value.answered_index !== undefined && (!Number.isSafeInteger(value.answered_index) || value.answered_index < 0))
    || (value.task_id !== undefined && !exactWorkTarget(value.task_id))) return undefined;
  return value as Receipt;
}

function confirms(receipt: Receipt | undefined, request: Request, option: RoutingOption, effort?: string): receipt is Receipt {
  return Boolean(receipt?.ok === true && receipt.decision_id === request.decision_id && receipt.state === "answered"
    && (receipt.answered_index === undefined || receipt.answered_index === request.option_index)
    && (option.action === "steer_task" ? ["delivered", "read"].includes(receipt.dispatched ?? "")
      && receipt.task_id === undefined && receipt.reasoning_effort === undefined
      : receipt.dispatched === "scheduled" && (effort === undefined || receipt.reasoning_effort === undefined || receipt.reasoning_effort === effort)));
}

function messageId(value: unknown): value is string { return typeof value === "string" && Boolean(value.trim()) && value.trim() === value; }

function tokenOf(annotation?: RoutingAnnotation): string | undefined {
  const token = annotation?.routing_token;
  return messageId(token) && !token.includes(":") ? token : undefined;
}

function optionName(option: RoutingOption, localized = true): string {
  if (option.label) return option.label;
  if (option.action === "new_task_in_project") {
    const project = option.project_name || option.project_id || "Проект";
    const fallback = `Новая задача в проекте «${project}»`;
    return localized ? chromeText("New task in project “{project}”", {
      project: option.project_name || option.project_id || chromeText("Project", undefined, "Проект"),
    }, fallback) : fallback;
  }
  return option.title || option.project_name || option.task_id || (localized ? chromeText("Task", undefined, "Задача") : "Задача");
}

function optionKey(option: RoutingOption, effort?: string): string {
  return JSON.stringify([option.action, option.task_id, option.project_id, optionName(option, false), effort]);
}

function allowedOption(option?: RoutingOption): option is RoutingOption {
  return Boolean(option && (option.action === "steer_task" && exactWorkTarget(option.task_id)
    || option.action === "new_task_in_project" && messageId(option.project_id)));
}

function annotationText(annotation: RoutingAnnotation): string {
  if (annotation.cause) return annotation.cause;
  const status = annotation.status ?? "";
  const action = annotation.action ?? "";
  const text = status === "delivered" && action === "mailbox_delivery" ? chromeText("Message saved for task", undefined, "Сообщение сохранено для задачи")
    : stateText(status);
  const name = annotation.target_label || annotation.project_name;
  return joined(text, name);
}

function receiptText(receipt?: Receipt, options?: RoutingOption[]): string {
  if (receipt?.state === "answered") {
    const index = receipt.answered_index;
    const option = Number.isInteger(index) ? options?.[index!] : undefined;
    const dispatch = receipt.dispatched;
    return joined(dispatch ? stateText(dispatch) : chromeText("The gateway has already accepted a decision", undefined, "Решение уже принято шлюзом"), option && optionName(option));
  }
  if (receipt?.state === "superseded") {
    const status = receipt.latest_status;
    return joined(chromeText("Routing card replaced", undefined, "Карточка маршрута заменена"), status && stateText(status));
  }
  if (receipt?.state === "pending") return chromeText("The gateway is still confirming one of the requests.", undefined, "Шлюз ещё подтверждает один из запросов.");
  return "";
}

export class Routing {
  private readonly journal: RoutingJournal;
  private readonly stopLanguage: () => void;
  private journalIssue = "";
  private readonly cancel = new Gio.Cancellable();
  private readonly readTimes = new WeakMap<RoutingRow, number>();
  private readonly entries = new Map<string, Entry>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly views = new Map<any, Target>();
  private readonly renderings = new WeakMap<object, object>();
  private chatId = 1;
  private epoch = 0;
  private connected = false;
  private closed = false;
  private dialog?: { widget: any; sync: () => void; cancel: any };

  constructor(private readonly parent: any, private readonly gateway: Gateway,
    private readonly refresh: () => void, private readonly openProject: (id: string, chatId?: number) => void,
    private readonly openTask?: (id: string) => void) {
    this.journal = new RoutingJournal(gateway.base);
    this.restore();
    this.stopLanguage = watchNativeI18n(() => this.paint());
  }

  private attemptKey(decision: string, chat = this.chatId): string { return JSON.stringify([chat, decision]); }

  private restore(): void {
    try {
      for (const item of this.journal.pending(this.chatId)) {
        const key = this.attemptKey(item.request.decision_id);
        const previous = this.attempts.get(key);
        if (!previous?.request && !previous?.busy && !["answered", "superseded"].includes(previous?.receipt?.state ?? "")) {
          this.attempts.set(key, { ...previous, request: item.request, optionKey: item.optionKey });
        }
      }
      this.journalIssue = "";
    } catch (error) { this.journalIssue = errorText(error); }
  }

  private forget(chat: number, attempt: Attempt): void {
    const request = attempt.request;
    attempt.request = undefined;
    if (!request) return;
    try { this.journal.forget(chat, request); }
    catch { this.journalIssue = "Не удалось удалить завершённый запрос из журнала маршрутов клиента."; }
  }

  remember(rows: RoutingRow[] | undefined, readAt: number): void {
    if (Array.isArray(rows)) for (const row of rows) if (row && typeof row === "object") this.readTimes.set(row, readAt);
  }

  setConnected(connected: boolean): void {
    if (this.closed || connected === this.connected) return;
    this.connected = connected;
    this.epoch = GLib.get_monotonic_time();
    for (const entry of this.entries.values()) {
      entry.confirmed = false;
      if (entry.annotation?.status === "pending") entry.annotation = undefined;
    }
    this.leave();
    this.paint();
  }

  setRoom(chatId: number): void {
    this.leave();
    this.chatId = chatId;
    this.entries.clear();
    this.views.clear();
    this.restore();
  }

  leave(): void {
    const dialog = this.dialog;
    this.dialog = undefined;
    dialog?.cancel.cancel();
    dialog?.widget.force_close();
  }
  close(): void { if (this.closed) return; this.closed = true; this.stopLanguage(); this.cancel.cancel(); this.leave(); this.entries.clear(); this.views.clear(); this.attempts.clear(); }

  frame(frame: GatewayFrame): void {
    if (this.closed || !this.connected || frame.type !== "message_annotation" || frame.annotation_type !== "routing_ack"
      || !messageId(frame.client_message_id)
      || (frame.chat_id !== undefined && !Number.isSafeInteger(frame.chat_id))
      || (frame.also_rooms !== undefined && (!Array.isArray(frame.also_rooms) || !frame.also_rooms.every(Number.isSafeInteger)))
      || frame.chat_id !== this.chatId && !(Array.isArray(frame.also_rooms) && frame.also_rooms.includes(this.chatId))) return;
    const annotation = readAnnotation(frame);
    if (!annotation) return;
    this.entries.set(frame.client_message_id, { annotation, at: GLib.get_monotonic_time(), confirmed: true });
    this.paint(frame.client_message_id);
  }

  resetRows(): void { this.views.clear(); }

  adopt(messages: Iterable<RoutingRow>): void {
    let changed = false;
    for (const message of messages) if (message.role === "user" && messageId(message.client_message_id)) {
      const readAt = this.readTimes.get(message);
      if (readAt !== undefined) changed = this.observe(message, readAt) || changed;
    }
    if (changed) this.paint();
  }

  mount(message: RoutingRow): any | undefined {
    const id = message.client_message_id;
    if (message.role !== "user" || !messageId(id)) return undefined;
    const widget = column(4);
    const target = { id, address: message.row_address };
    this.views.set(widget, target);
    this.paintRow(widget, target);
    return widget;
  }

  private observe(message: RoutingRow, readAt: number): boolean {
    const id = message.client_message_id!;
    const previous = this.entries.get(id);
    if (readAt <= (previous?.at ?? 0)) return false;
    const annotation = readAnnotation(message.chat_annotation);
    const confirmed = this.connected && readAt >= this.epoch;
    if (annotation && typeof annotation.status === "string") {
      this.entries.set(id, { annotation, at: readAt, confirmed });
      const token = tokenOf(annotation);
      const attempt = token && this.attempts.get(this.attemptKey(`routing:${id}:${token}`));
      if (confirmed && token) {
        for (const [key, pending] of this.attempts) {
          const decision = pending.request?.decision_id;
          if (!decision || key !== this.attemptKey(decision)) continue;
          const last = decision.lastIndexOf(":");
          if (decision.slice(8, last) === id && (decision.slice(last + 1) !== token || landed.has(annotation.status!))) this.forget(this.chatId, pending);
        }
      }
      if (confirmed && annotation.status === "needs_manual_target" && attempt && attempt.receipt?.state === "pending"
        && readAt >= (attempt.receiptAt ?? 0)) {
        attempt.receipt = undefined;
        this.forget(this.chatId, attempt);
        attempt.error = undefined;
        attempt.errorSource = undefined;
        return true;
      }
      return confirmed !== previous?.confirmed || JSON.stringify(annotation) !== JSON.stringify(previous?.annotation);
    } else if (previous) {
      this.entries.set(id, { ...previous, at: readAt, confirmed: false });
      return previous.confirmed;
    }
    return false;
  }

  private paint(id?: string): void {
    if (this.closed) return;
    for (const [widget, target] of this.views) if (!id || target.id === id) this.paintRow(widget, target);
    this.dialog?.sync();
  }

  private paintRow(widget: any, target: Target): void {
    clear(widget);
    const entry = this.entries.get(target.id);
    const annotation = entry?.annotation;
    const rendering = {};
    this.renderings.set(widget, rendering);
    // An identical history read replaces Entry without repainting. The view generation,
    // rather than that cache object's identity, owns these rendered actions.
    const current = () => !this.closed && this.views.get(widget) === target && this.renderings.get(widget) === rendering;
    if (annotation) {
      const token = tokenOf(annotation);
      const receipt = token ? this.attempts.get(this.attemptKey(`routing:${target.id}:${token}`))?.receipt : undefined;
      const localResult = !landed.has(annotation.status ?? "") && (receipt?.state === "answered" || receipt?.state === "superseded");
      const text = localResult ? receiptText(receipt, annotation.options) : annotationText(annotation);
      if (text) widget.append(label(text, "dim-label"));
      const effort = receipt?.reasoning_effort || annotation.reasoning_effort;
      if (effort) widget.append(label(effortText(effort), "dim-label"));
      const rejected = Array.isArray(annotation.attachment_manifest) ? annotation.attachment_manifest.filter((item) => item?.status === "rejected") : [];
      if (rejected.length) {
        const files = rejected.map(item => item.label || chromeText("File {n}", { n: (item.ordinal ?? 0) + 1 }, `Файл ${(item.ordinal ?? 0) + 1}`)).join(", ");
        widget.append(label(chromeText("Unattached to task · {files}", { files }, `Не прикреплено к задаче · ${files}`), "dim-label"));
      }
      if (token && (annotation.status === "dispatch_pending" || annotation.status === "needs_manual_target"
        && Array.isArray(annotation.options) && annotation.options.some(allowedOption))) {
        const choose = button(localResult ? chromeText("Routing result…", undefined, "Результат маршрутизации…") : chromeText("Message route…", undefined, "Маршрут сообщения…"), () => { if (current()) this.show(target, token); });
        choose.set_halign(Gtk.Align.START);
        choose.set_sensitive(this.connected && Boolean(entry.confirmed || target.address));
        widget.append(choose);
      }
      if (landed.has(annotation.status ?? "")) {
        if (messageId(annotation.project_id) && annotation.project_chat_id !== this.chatId) {
          const projectId = annotation.project_id;
          const projectName = annotation.project_name || projectId;
          const project = button(chromeText("Open project · {project}", { project: projectName }, `Открыть проект · ${projectName}`), () => { if (current()) this.openProject(projectId, annotation.project_chat_id); });
          project.set_halign(Gtk.Align.START);
          widget.append(project);
        }
      }
      const tasks = new Map<string, string>();
      if (landed.has(annotation.status ?? "")) {
        if (Array.isArray(annotation.target_task_ids)) annotation.target_task_ids.forEach((id, index) => {
          if (exactWorkTarget(id)) tasks.set(id, annotation.target_titles?.[index] || id);
        });
        if (!tasks.size && annotation.action === "steer_task" && exactWorkTarget(annotation.target)) {
          tasks.set(annotation.target, annotation.target_label || annotation.target);
        }
      }
      if (exactWorkTarget(receipt?.task_id) && !tasks.has(receipt.task_id)) tasks.set(receipt.task_id, receipt.task_id);
      if (this.openTask) for (const [id, name] of tasks) {
        const task = button(chromeText("Open task · {task}", { task: name }, `Открыть задачу · ${name}`), () => { if (current()) this.openTask?.(id); });
        task.set_halign(Gtk.Align.START);
        widget.append(task);
      }
    }
    widget.set_visible(Boolean(widget.get_first_child()));
  }

  private decision(id: string, token: string): Attempt {
    const key = this.attemptKey(`routing:${id}:${token}`);
    let value = this.attempts.get(key);
    if (!value) { value = {}; this.attempts.set(key, value); }
    return value;
  }

  private async revalidate(target: Target, usable: () => boolean, cancel: any): Promise<boolean> {
    if (!usable()) return false;
    if (!target.address) return this.entries.get(target.id)?.confirmed === true;
    const readAt = GLib.get_monotonic_time();
    const chatId = this.chatId;
    const history = await this.gateway.json<ExactHistory>("GET", "/api/chat/history" + query({
      chat_id: chatId, around: target.address, n_human: 1, n_progress: 0,
    }), undefined, undefined, false, cancel);
    if (!usable()) return false;
    const anchor = history.anchor;
    const match = anchor?.state === "found" && anchor.row_address === target.address && anchor.chat_id === chatId
      && Array.isArray(history.messages) && history.messages.find((row) => row.role === "user" && row.client_message_id === target.id
        && (row.row_address === target.address || Boolean(anchor.history_id && row.history_id === anchor.history_id)));
    if (!match || !readAnnotation(match.chat_annotation)) {
      const entry = this.entries.get(target.id);
      if (entry) entry.confirmed = false;
      return false;
    }
    this.observe(match, readAt);
    return this.entries.get(target.id)?.confirmed === true;
  }

  private show(target: Target, token: string): void {
    if (!this.connected || this.closed || tokenOf(this.entries.get(target.id)?.annotation) !== token) return;
    this.leave();
    this.restore();
    const attempt = this.decision(target.id, token);
    const chat = this.chatId;
    const content = column();
    const widget = sheet("Маршрут сообщения", content);
    const releaseTitle = bindChrome(widget, "title", "Message route");
    const choices = column();
    const facts = label("", "dim-label");
    const status = label("");
    const comment = new Gtk.Entry({ placeholder_text: "Комментарий к маршруту (необязательно)", max_length: 2000 });
    const cancel = new Gio.Cancellable();
    const epoch = this.epoch;
    const usable = () => !this.closed && this.connected && this.epoch === epoch && this.dialog?.widget === widget;
    let checking = false;
    let validationError = "";
    let selected: number | undefined;
    let signature: string | undefined;
    let shownOptions: RoutingOption[] = [];
    const optionControls = new Map<number, any>();

    const state = () => {
      const entry = this.entries.get(target.id);
      const annotation = entry?.annotation;
      const same = tokenOf(annotation) === token;
      const receipt = attempt.receipt;
      const terminal = receipt?.state === "answered" || receipt?.state === "superseded";
      const open = same && entry?.confirmed && annotation?.status === "needs_manual_target" && !terminal && receipt?.state !== "pending";
      const owned = same && entry?.confirmed && annotation?.status === "dispatch_pending" && attempt.request
        && annotation.detail === `request:${attempt.request.request_id}` && !terminal;
      return { annotation, same, open, owned, receipt, terminal };
    };

    const reload = async () => {
      if (checking || attempt.busy || !usable()) return;
      checking = true;
      validationError = "";
      sync();
      try {
        if (!await this.revalidate(target, usable, cancel) && usable()) validationError = "Шлюз не подтвердил точную запись маршрута.";
      } catch (error) { if (usable()) validationError = errorText(error); }
      finally { checking = false; if (usable()) this.paint(target.id); }
    };

    const send = async (replay: boolean) => {
      if (checking || attempt.busy || !usable()) return;
      const before = state();
      const index = replay ? attempt.request?.option_index : selected;
      if (index === undefined || !(before.open || replay && before.owned)) return;
      const expected = replay ? attempt.optionKey : allowedOption(shownOptions[index]) ? optionKey(shownOptions[index], before.annotation?.reasoning_effort) : undefined;
      if (!expected) return;
      const draft = comment.get_text();
      attempt.busy = true;
      attempt.error = undefined;
      attempt.errorSource = undefined;
      validationError = "";
      this.paint(target.id);
      try {
        if (!await this.revalidate(target, usable, cancel) || !usable()) {
          if (usable()) { attempt.error = "Шлюз не подтвердил точную запись маршрута."; attempt.errorSource = localSource(attempt.error); }
          return;
        }
        const current = state();
        const option = current.annotation?.options?.[index];
        if (!(current.open || replay && current.owned) || !allowedOption(option)
          || optionKey(option, current.annotation?.reasoning_effort) !== expected) {
          attempt.error = "Маршрут изменился. Проверьте варианты перед отправкой.";
          attempt.errorSource = localSource(attempt.error);
          return;
        }
        const request = replay ? attempt.request! : { decision_id: `routing:${target.id}:${token}`,
          request_id: GLib.uuid_string_random(), option_index: index, ...(draft ? { comment: draft } : {}) };
        this.journal.put(chat, request, expected);
        this.journalIssue = "";
        attempt.request = request;
        attempt.optionKey = expected;
        const receipt = readReceipt(await this.gateway.json<unknown>("POST", "/api/decisions", request, undefined, true, this.cancel));
        if (confirms(receipt, request, option, current.annotation?.reasoning_effort)) {
          attempt.receipt = receipt;
          attempt.receiptAt = GLib.get_monotonic_time();
          this.forget(chat, attempt);
        } else { attempt.error = "Шлюз не подтвердил отправку. Можно повторить прежний запрос."; attempt.errorSource = localSource(attempt.error); }
      } catch (error) {
        const parsed = error instanceof HttpError ? readReceipt(error.body) : undefined;
        const receipt = parsed?.decision_id === `routing:${target.id}:${token}` ? parsed : undefined;
        if (receipt?.decision_id === `routing:${target.id}:${token}` && ["open", "answered", "superseded", "pending"].includes(receipt.state ?? "")) {
          attempt.receipt = receipt;
          attempt.receiptAt = GLib.get_monotonic_time();
        }
        if (error instanceof HttpError && error.status < 500 && error.status !== 408 && error.status !== 429 && receipt?.state !== "pending") {
          this.forget(chat, attempt);
        }
        attempt.error = receipt?.cause || errorText(error);
        attempt.errorSource = error instanceof HttpError ? undefined : localSource(attempt.error);
      } finally {
        attempt.busy = false;
        this.paint(target.id);
        if (!this.closed) this.refresh();
        if (target.address && usable() && ["answered", "superseded", "pending"].includes(attempt.receipt?.state ?? "")) void reload();
      }
    };

    const submit = button("Отправить по выбранному маршруту", () => void send(false));
    const repeat = button("Повторить прежний запрос", () => void send(true));
    const refresh = button("Проверить маршрут", () => void reload());
    const task = button("Открыть созданную задачу", () => {
      if (usable() && exactWorkTarget(attempt.receipt?.task_id)) this.openTask?.(attempt.receipt.task_id);
    });
    submit.add_css_class("suggested-action");
    for (const child of [facts, status, choices, comment, submit, repeat, refresh, task]) content.append(child);

    const sync = () => {
      comment.set_placeholder_text(chromeText("Routing comment (optional)", undefined, "Комментарий к маршруту (необязательно)"));
      submit.set_label(chromeText("Send via selected route", undefined, "Отправить по выбранному маршруту"));
      repeat.set_label(chromeText("Retry previous request", undefined, "Повторить прежний запрос"));
      refresh.set_label(chromeText("Check route", undefined, "Проверить маршрут"));
      task.set_label(chromeText("Open created task", undefined, "Открыть созданную задачу"));
      const { annotation, same, open, owned, receipt, terminal } = state();
      const options = same && Array.isArray(annotation?.options) ? annotation.options : shownOptions;
      const nextSignature = JSON.stringify(options);
      if (signature !== nextSignature) {
        signature = nextSignature;
        shownOptions = options;
        selected = undefined;
        clear(choices);
        optionControls.clear();
        let group: any;
        options.forEach((option, index) => {
          if (!allowedOption(option)) return;
          const toggle = new Gtk.CheckButton({ label: optionName(option) });
          if (group) toggle.set_group(group);
          else group = toggle;
          toggle.connect("toggled", () => { if (toggle.get_active()) { selected = index; sync(); } });
          choices.append(toggle);
          optionControls.set(index, toggle);
        });
      }
      for (const [index, control] of optionControls) control.set_label(optionName(shownOptions[index]));
      const effort = receipt?.reasoning_effort || (same ? annotation?.reasoning_effort : undefined);
      facts.set_label([same && annotation && annotationText(annotation), effort && effortText(effort)].filter(Boolean).join("\n"));
      const result = receiptText(receipt, shownOptions) || (!same ? chromeText("This routing card has been replaced.", undefined, "Эта карточка маршрута заменена.") : "");
      status.set_label([result, attempt.errorSource ? chromeText(attempt.errorSource, undefined, attempt.error) : attempt.error,
        localText(validationError), localText(this.journalIssue),
        checking ? chromeText("Checking the saved route…", undefined, "Проверяю сохранённый маршрут…")
          : attempt.busy ? chromeText("The gateway is processing the request…", undefined, "Шлюз обрабатывает запрос…") : ""]
        .filter(Boolean).join("\n"));
      const idle = !checking && !attempt.busy && usable();
      const pickable = Boolean(idle && open && !attempt.request);
      choices.set_visible(!terminal && same && Boolean(options.length));
      choices.set_sensitive(pickable);
      comment.set_sensitive(pickable);
      comment.set_visible(!terminal && same && Boolean(options.length));
      submit.set_visible(!terminal && same && Boolean(options.length));
      submit.set_sensitive(pickable && selected !== undefined);
      repeat.set_visible(Boolean(attempt.request && (open || owned)));
      repeat.set_sensitive(idle);
      refresh.set_sensitive(idle);
      task.set_visible(Boolean(this.openTask && exactWorkTarget(receipt?.task_id)));
    };
    this.dialog = { widget, sync, cancel };
    widget.connect("closed", () => { releaseTitle(); cancel.cancel(); if (this.dialog?.widget === widget) this.dialog = undefined; });
    sync();
    widget.present(this.parent);
    if (target.address) void reload();
  }
}
