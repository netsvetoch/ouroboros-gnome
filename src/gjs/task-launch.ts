import type { Room } from "./chat.js";
import { directoryPicker } from "./directory-picker.js";
import { type Gateway, HttpError, type UploadProgress, uploadProgressText } from "./gateway.js";
import { gatewayStatePath, readGatewayState, writeGatewayState } from "./gateway-state.js";
import { Gio, GLib, Gtk } from "./gi.js";
import { object } from "./settings-write.js";
import { type LaunchAttachment, type LaunchBody, submissionKey, TaskLaunchFields } from "./task-launch-fields.js";
import { TaskReviews } from "./task-reviews.js";
import { button, chooseFile, clear, column, errorText, label, row, sheet } from "./ui.js";
import { exactWorkTarget } from "./work-actions.js";

import { chrome } from "./native-i18n.js";

interface PendingLaunch { body: LaunchBody; room: string }
const newId = (): string => GLib.uuid_string_random().replace(/-/g, "");
const text = (value: unknown): string => typeof value === "string" ? value : "";

export function renderAttachmentManifest(parent: any, target: any, task: string, result: unknown, sources: TaskReviews): void {
  const payload = object(result);
  const rows = Array.isArray(payload.attachment_manifest) ? payload.attachment_manifest : [];
  const ref = object(payload.attachment_manifest_ref);
  if (!rows.length && !Object.keys(ref).length) return;
  const section = column(4);
  const rejected = rows.filter((value) => object(value).status === "rejected").length;
  const title = rejected ? `Приём вложений · отклонено в списке ${rejected}` : "Приём вложений";
  target.append(chrome(new Gtk.Expander({ label: title, child: section }), "label", rejected ? "Attachment intake · {n} rejected" : "Attachment intake", { n: rejected }));
  for (const [index, value] of rows.entries()) {
    const item = object(value);
    const ordinal = typeof item.ordinal === "number" && Number.isSafeInteger(item.ordinal) && item.ordinal >= 0 ? item.ordinal + 1 : index + 1;
    const status = item.status === "staged" ? "Подготовлено" : item.status === "rejected" ? "Отклонено" : "Состояние неизвестно";
    const detail = label([ordinal, text(item.label), status, text(item.reason), text(item.relpath)].filter(Boolean).join(" · "));
    const prefix = [ordinal, text(item.label)].filter(Boolean).join(" · ");
    const suffix = [text(item.reason), text(item.relpath)].filter(Boolean).join(" · ");
    chrome(detail, "label", item.status === "staged" ? "{item} · Staged{detail}" : item.status === "rejected" ? "{item} · Rejected{detail}" : "{item} · State unknown{detail}", { item: prefix, detail: suffix ? " · " + suffix : "" });
    detail.set_selectable(true);
    section.append(detail);
  }
  if (Object.keys(ref).length) {
    if (typeof ref.count === "number" && Number.isSafeInteger(ref.count) && ref.count > rows.length) {
      section.append(chrome(label(`Показано ${rows.length} из ${ref.count}`, "dim-label"), "label", "Showing {n} of {total}", { n: rows.length, total: ref.count }));
    }
    if (!sources.publishedSource(parent, section, task, "Запросить полный отчёт о вложениях", ref, "Request full attachment report")) {
      section.append(chrome(label("Полный отчёт о вложениях недоступен.", "dim-label"), "label", "Full attachment report unavailable."));
    }
  }
}

function pendingFrom(raw: unknown): PendingLaunch | undefined {
  const record = object(raw);
  const body = object(record.body);
  if (!exactWorkTarget(body.task_id) || !text(body.description) || !/^[a-f0-9]{32}$/u.test(text(object(body.metadata)[submissionKey]))
    || (body.attachments !== undefined && (!Array.isArray(body.attachments) || body.attachments.some((item) =>
      !text(object(item).path) || (object(item).label !== undefined && typeof object(item).label !== "string"))))) return undefined;
  return { body: body as LaunchBody, room: text(record.room) };
}

export class TaskLaunch {
  private readonly location: string;
  private openDialog?: LaunchDialog;
  private disposed = false;
  private parentSignal = 0;

  constructor(private readonly parent: any, private readonly gateway: Gateway,
    private readonly showTask: (id: string) => void, private readonly changed: () => void) {
    if (parent instanceof Gtk.Window) this.parentSignal = parent.connect("close-request", () => { this.close(); return false; });
    this.location = gatewayStatePath(gateway.base, "task-launch");
  }

  show(room: Room): void {
    if (this.disposed) return;
    if (this.openDialog) {
      this.openDialog.present();
      return;
    }
    let pending: PendingLaunch | undefined;
    let issue = "";
    if (GLib.file_test(this.location, GLib.FileTest.EXISTS)) {
      try {
        const saved = readGatewayState(this.location);
        pending = pendingFrom(saved);
        if (saved !== null && !pending) throw new Error("invalid saved launch");
      } catch { issue = "Не удалось прочитать ранее сохранённый запрос запуска."; }
    }
    const dialog = new LaunchDialog(this.parent, this.gateway, room, pending, issue,
      (state) => writeGatewayState(this.location, state ?? null), this.showTask, this.changed, () => { if (this.openDialog === dialog) this.openDialog = undefined; });
    this.openDialog = dialog;
    dialog.present();
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.parentSignal) { this.parent.disconnect(this.parentSignal); this.parentSignal = 0; }
    this.openDialog?.close();
  }
}

class LaunchDialog {
  private readonly content = column(8);
  private readonly dialog = chrome(sheet("Новая задача", this.content), "title", "New task");
  private readonly editor: TaskLaunchFields;
  private readonly sources: TaskReviews;
  private readonly status = label("", "dim-label");
  private readonly receipt = column(4);
  private readonly attachmentList = column(4);
  private readonly serverPath = new Gtk.Entry({ placeholder_text: "Путь файла на шлюзе", hexpand: true });
  private readonly serverLabel = new Gtk.Entry({ placeholder_text: "Название вложения (необязательно)", hexpand: true });
  private readonly attach = chrome(button("Загрузить файл…", () => void this.upload()), "label", "Upload file…");
  private readonly cancelUpload = chrome(button("Отменить загрузку", () => this.uploadCancel?.cancel()), "label", "Cancel upload");
  private readonly submit = chrome(button("Запустить", () => void this.send()), "label", "Launch");
  private readonly check = chrome(button("Проверить квитанцию на шлюзе", () => void this.verify()), "label", "Check gateway receipt");
  private readonly discard = chrome(button("Оставить без повтора", () => this.forget()), "label", "Leave without retrying");
  private readonly openTask = chrome(button("Открыть задачу", () => {
    if (this.disposed) return;
    const id = this.confirmed || this.observed;
    if (id && this.dialog.close()) this.showTask(id);
  }), "label", "Open task");
  private readonly attachments: LaunchAttachment[];
  private attachmentVersion = 0;
  private readonly cancel = new Gio.Cancellable();
  private uploadCancel?: any;
  private picker?: any;
  private pending?: PendingLaunch;
  private confirmed?: string;
  private observed?: string;
  private retry = false;
  private busy = false;
  private disposed = false;

  constructor(private readonly parent: any, private readonly gateway: Gateway, private readonly room: Room, pending: PendingLaunch | undefined,
    issue: string, private readonly save: (state?: PendingLaunch) => void, private readonly showTask: (id: string) => void,
    private readonly changed: () => void, onClose: () => void) {
    chrome(this.serverPath, "placeholder-text", "File path on gateway");
    chrome(this.serverLabel, "placeholder-text", "Attachment label (optional)");
    this.pending = pending;
    this.attachments = [...(pending?.body.attachments as LaunchAttachment[] ?? [])];
    this.sources = new TaskReviews(gateway);
    this.editor = new TaskLaunchFields(room, (initial, select) => this.browse(initial, select));
    if (pending) this.editor.restore(pending.body);
    const heading = label(pending ? `Сохранённый запрос · ${pending.room || pending.body.task_id}` : room.name, "heading");
    if (pending) chrome(heading, "label", "Saved request · {room}", { room: pending.room || pending.body.task_id });
    this.content.append(heading);
    const files = this.editor.attachments;
    const fields = row();
    fields.append(this.serverPath);
    fields.append(chrome(button("Добавить путь", () => {
      if (this.disposed || this.busy || this.pending || this.confirmed) return;
      const path = this.serverPath.get_text().trim();
      if (!path) return;
      this.attachments.push({ path, label: this.serverLabel.get_text().trim() || undefined });
      this.serverPath.set_text("");
      this.serverLabel.set_text("");
      this.renderAttachments();
    }), "label", "Add path"));
    for (const child of [fields, this.serverLabel, this.attach, this.cancelUpload, this.attachmentList]) files.append(child);
    this.renderAttachments();
    this.content.append(this.editor.widget);
    this.content.append(this.status);
    this.content.append(this.receipt);
    const actions = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, column_spacing: 6, row_spacing: 6 });
    for (const widget of [this.submit, this.check, this.discard, this.openTask]) actions.append(widget);
    this.submit.add_css_class("suggested-action");
    this.content.append(actions);
    this.status.set_label(pending ? `Результат запуска неизвестен · ${pending.body.task_id}` : issue);
    if (pending) chrome(this.status, "label", "Launch outcome unknown · {id}", { id: pending.body.task_id });
    this.dialog.connect("closed", () => {
      this.disposed = true;
      this.cancel.cancel();
      this.editor.close();
      this.sources.close();
      this.uploadCancel?.cancel();
      this.picker?.force_close();
      onClose();
    });
    this.sync();
  }

  present(): void { if (!this.disposed) this.dialog.present(this.parent); }
  close(): void { this.dialog.force_close(); }

  private setStatus(fallback: string, source: string, params?: Record<string, string | number>): void {
    this.status.set_label(fallback); chrome(this.status, "label", source, params);
  }

  private progress(progress: UploadProgress): void {
    if (this.disposed) return;
    const params = { bytes: GLib.format_size(progress.bytes), total: progress.total === undefined ? "" : GLib.format_size(progress.total) };
    const source = progress.phase === "confirming" ? "File sent. Waiting for gateway confirmation…"
      : progress.phase === "preparing" ? progress.total === undefined ? "Preparing · {bytes}" : "Preparing · {bytes} of {total}"
      : progress.total === undefined ? "Uploading · {bytes}" : "Uploading · {bytes} of {total}";
    this.setStatus(uploadProgressText(progress), source, params);
  }

  private browse(initial: string, select: (path: string) => void): void {
    if (this.disposed || this.picker) return;
    const picker = directoryPicker(this.gateway, initial, select, this.dialog);
    this.picker = picker;
    picker.connect("closed", () => { this.picker = undefined; });
    picker.present(this.dialog);
  }

  private async upload(): Promise<void> {
    if (this.uploadCancel || this.busy || this.pending || this.disposed) return;
    const cancel = new Gio.Cancellable();
    this.uploadCancel = cancel;
    this.sync();
    try {
      const file = await chooseFile(this.dialog, undefined, cancel);
      if (!file || cancel.is_cancelled()) return;
      const upload = object(await this.gateway.upload("/api/chat/upload", file, undefined, undefined, {
        cancel, progress: (progress) => this.progress(progress),
      }));
      if (this.disposed || cancel.is_cancelled()) return;
      if (upload.ok !== true || !text(upload.path) || !text(upload.display_name)) throw new Error("Шлюз не подтвердил адрес загруженного файла.");
      this.attachments.push({ path: text(upload.path), label: text(upload.display_name) });
      this.setStatus("Файл загружен. Подготовку вложения подтвердит квитанция запуска.", "File uploaded. The launch receipt will confirm attachment staging.");
      this.renderAttachments();
    } catch (error) {
      if (!this.disposed) {
        if (cancel.is_cancelled()) this.setStatus("Загрузка остановлена.", "Upload stopped.");
        else this.status.set_label(errorText(error));
      }
    } finally {
      this.uploadCancel = undefined;
      if (!this.disposed) this.sync();
    }
  }

  private renderAttachments(): void {
    if (this.disposed) return;
    const version = ++this.attachmentVersion;
    clear(this.attachmentList);
    this.attachments.forEach(({ path, label: name }, index) => {
      const item = row();
      const title = label([name, path].filter(Boolean).join(" · "));
      title.set_hexpand(true);
      item.append(title);
      item.append(chrome(button("Убрать", () => {
        if (this.disposed || this.busy || this.pending || this.confirmed || version !== this.attachmentVersion) return;
        this.attachments.splice(index, 1);
        this.renderAttachments();
      }), "label", "Remove"));
      this.attachmentList.append(item);
    });
  }

  private sync(): void {
    if (this.disposed) return;
    this.editor.widget.set_sensitive(!this.busy && !this.pending && !this.confirmed);
    this.attach.set_sensitive(!this.busy && !this.pending && !this.confirmed && !this.uploadCancel);
    this.cancelUpload.set_visible(Boolean(this.uploadCancel));
    this.submit.set_label(this.pending ? "Повторить с тем же ID" : "Запустить");
    chrome(this.submit, "label", this.pending ? "Retry with the same ID" : "Launch");
    this.submit.set_visible(!this.confirmed && (!this.pending || this.retry));
    this.submit.set_sensitive(!this.busy && !this.uploadCancel);
    this.check.set_visible(Boolean(this.pending));
    this.check.set_sensitive(!this.busy);
    this.discard.set_visible(Boolean(this.pending));
    this.discard.set_sensitive(!this.busy);
    this.openTask.set_visible(Boolean(this.confirmed || this.observed));
    this.openTask.set_sensitive(!this.busy);
  }

  private forget(): void {
    if (this.disposed || !this.pending || this.busy) return;
    try {
      this.save();
      const body = this.pending.body;
      this.pending = undefined;
      this.observed = undefined;
      this.retry = false;
      this.editor.restore({ ...body, task_id: "" });
      this.setStatus("Повтор отменён. Если шлюз принял исходный запрос, задача может появиться в списке.", "Retry abandoned. If the gateway accepted the original request, the task may appear in the list.");
    } catch (error) { this.status.set_label(errorText(error)); }
    this.sync();
  }

  private async send(): Promise<void> {
    if (this.disposed || this.busy || this.uploadCancel || this.confirmed || (this.pending && !this.retry)) return;
    let launch: PendingLaunch;
    try {
      launch = this.pending ?? { body: this.editor.request(newId(), newId(), this.attachments), room: this.room.name };
      if (!exactWorkTarget(launch.body.task_id)) throw new Error("Укажите допустимый идентификатор задачи.");
      if (!this.pending) this.save(launch);
      this.pending = launch;
    } catch (error) {
      this.status.set_label(errorText(error));
      return;
    }
    this.retry = false;
    this.busy = true;
    this.observed = undefined;
    clear(this.receipt);
    this.setStatus("Отправляю запрос запуска…", "Sending launch request…");
    this.sync();
    try {
      const result = object(await this.gateway.json("POST", "/api/tasks", launch.body, undefined, false, this.cancel));
      if (this.disposed) return;
      if (result.ok !== true || result.status !== "scheduled" || result.task_id !== launch.body.task_id) {
        throw new Error(text(result.error) || "Шлюз не подтвердил создание задачи с этим ID.");
      }
      this.accept(launch.body.task_id, result);
    } catch (error) {
      if (this.disposed) return;
      const refused = error instanceof HttpError && error.status >= 400 && error.status < 500 && ![408, 409].includes(error.status);
      if (refused) {
        const reply = object(error.body);
        if (reply.task_id === launch.body.task_id) renderAttachmentManifest(this.dialog, this.receipt, launch.body.task_id, reply, this.sources);
        try {
          this.save();
          this.pending = undefined;
          this.status.set_label(errorText(error));
        } catch (failure) { this.status.set_label(errorText(failure)); }
      } else this.setStatus(`Запуск не подтверждён · ${launch.body.task_id}\n${errorText(error)}`, "Launch unconfirmed · {id} · {detail}", { id: launch.body.task_id, detail: errorText(error) });
    } finally {
      this.busy = false;
      if (!this.disposed) this.sync();
    }
  }

  private async verify(): Promise<void> {
    const launch = this.pending;
    if (!launch || this.busy || this.disposed) return;
    this.busy = true;
    this.retry = false;
    this.observed = undefined;
    clear(this.receipt);
    this.setStatus("Читаю сохранённую запись задачи…", "Reading saved task record…");
    this.sync();
    const id = launch.body.task_id;
    try {
      const result = object(await this.gateway.json("GET", `/api/tasks/${encodeURIComponent(id)}`, undefined, undefined, false, this.cancel));
      if (this.disposed) return;
      const admission = object(result.api_admission);
      if ((result.task_id || result.id) !== id || object(result.metadata)[submissionKey] !== launch.body.metadata[submissionKey]) {
        this.setStatus(`Найденная запись не подтверждает этот запрос · ${id}`, "The saved record does not confirm this request · {id}", { id });
      } else if (admission.status === "accepted" && text(admission.token)) {
        this.accept(id, result);
      } else {
        this.observed = id;
        renderAttachmentManifest(this.dialog, this.receipt, id, result, this.sources);
        this.setStatus(`Запись задачи найдена · ${id}. Подтверждение запуска ещё не получено.`, "Task record found · {id}. Launch not yet confirmed.", { id });
      }
    } catch (error) {
      if (this.disposed) return;
      if (error instanceof HttpError && error.status === 404) {
        this.retry = true;
        this.setStatus(`Сохранённая запись пока отсутствует · ${id}. Можно повторить исходный запрос.`, "No saved record yet · {id}. You can retry the original request.", { id });
      } else this.setStatus(`Не удалось подтвердить запуск · ${id}\n${errorText(error)}`, "Could not confirm launch · {id} · {detail}", { id, detail: errorText(error) });
    } finally {
      this.busy = false;
      if (!this.disposed) this.sync();
    }
  }

  private accept(id: string, result: Record<string, unknown>): void {
    this.confirmed = id;
    this.pending = undefined;
    clear(this.receipt);
    renderAttachmentManifest(this.dialog, this.receipt, id, result, this.sources);
    const state = text(result.status);
    let message = [`Шлюз подтвердил запуск · ${id}`, state && `Состояние · ${state}`].filter(Boolean).join("\n");
    let detail = "";
    try { this.save(); } catch (error) { detail = "\n" + errorText(error); message += detail; }
    this.setStatus(message, "Gateway confirmed launch · {id}{state}{detail}", { id, state: state ? " · " + state : "", detail });
    this.changed();
  }
}
