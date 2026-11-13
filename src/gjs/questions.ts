import { mergeQuestionWait, questionWaitStatus, questionWaitLines, type QuestionWaitFacts } from "./question-wait.js";
import { QuestionMaterials } from "./question-materials.js";
import { questionLifecycleFacts, questionLifecycleLines, type QuestionLifecycleFacts } from "./question-lifecycle.js";
import { Adw, GLib, Gtk, Pango } from "./gi.js";
import { contactSource } from "./contact-source.js";
import { type Gateway, HttpError } from "./gateway.js";
import { SecretQuestion, type SecretRequest, type SecretOutcome } from "./secrets.js";
import { button, clear, column, errorText, label, row, sheet } from "./ui.js";

import { chrome, chromeText, watchNativeI18n } from "./native-i18n.js";

interface Option {
  label: string;
  detail?: string;
  recommended?: boolean;
}

interface Delivery {
  state?: string;
  kind?: string;
  reason_code?: string;
  dismissed?: boolean;
}

interface QuizStatus extends QuestionLifecycleFacts, QuestionWaitFacts {
  state?: string;
  answered_index?: number;
  comment?: string;
  question_delivery?: Delivery;
  secret_outcome?: SecretOutcome;
}

export interface Quiz extends QuizStatus {
  presence_contact?: unknown;
  materials?: unknown;
  quiz_id: string;
  question?: string;
  options?: (Option | string)[];
  option_details?: string[];
  recommended_index?: number;
  assumption?: string;
  stake?: string;
  host_facts?: string;
  wait_for_answer?: boolean;
  secret_request?: SecretRequest;
}

interface Answer {
  decision_id: string;
  request_id: string;
  option_index?: number;
  comment?: string;
  action?: "close" | "dismiss";
  reason?: string;
}

interface Entry {
  quiz: Quiz;
  pending?: Answer;
  sending?: boolean;
  dialog?: QuestionDialog;
  allowed?: () => boolean;
}

interface Receipt extends QuizStatus {
  ok?: boolean;
  error?: string;
}

function receiptFacts(response: Record<string, unknown>): QuizStatus {
  const result: QuizStatus = questionLifecycleFacts(response);
  if (typeof response.state === "string") result.state = response.state;
  if (typeof response.answered_index === "number") result.answered_index = response.answered_index;
  if (typeof response.comment === "string") result.comment = response.comment;
  if (response.question_delivery && typeof response.question_delivery === "object") result.question_delivery = response.question_delivery;
  if (response.secret_outcome && typeof response.secret_outcome === "object") result.secret_outcome = response.secret_outcome;
  return result;
}

const states: Record<string, [string, string]> = {
  open: ["Waiting for an answer", "Ожидает ответа"],
  expired_terminal: ["The task has ended. You can still answer.", "Задача закончилась, ответ ещё можно дать"],
  answered: ["Answer recorded", "Ответ записан"],
  closed: ["Question closed", "Вопрос закрыт"],
  superseded: ["Question replaced", "Вопрос заменён"],
};
function stateText(state?: string): string {
  const words = Object.hasOwn(states, state ?? "") ? states[state!] : undefined;
  return words ? chromeText(words[0], undefined, words[1]) : chromeText("Question state unknown", undefined, "Состояние вопроса неизвестно");
}
function counter(widget: any, length: number): void {
  widget.set_label(`${length} / 2000 символов`);
  chrome(widget, "label", "{n} / 2000 characters", { n: length });
}

function open(quiz: Quiz): boolean {
  return quiz.state === "open" || quiz.state === "expired_terminal";
}

function mergeFacts(quiz: Quiz, response: Record<string, unknown>): void {
  const facts = receiptFacts(response);
  if (facts.state && !open(quiz) && open({ ...quiz, state: facts.state })) return;
  if (quiz.state === "expired_terminal" && facts.state === "open") delete facts.state;
  const previous = quiz.question_delivery;
  // Publishing the question and delivering its answer are separate duties.
  // A stale WS frame or HTTP response cannot regress a receipt for the same duty.
  if (previous?.kind && previous.kind === facts.question_delivery?.kind
    && (previous.dismissed || previous.state === "delivered" && facts.question_delivery?.state === "owed")) {
    delete facts.question_delivery;
    delete facts.forwarded;
    delete facts.reason_code;
  }
  for (const key of ["answered_after_terminal", "delivery_after_terminal", "forwarded"] as const)
    if (quiz[key] === true && facts[key] === false) delete facts[key];
  mergeQuestionWait(quiz, response);
  Object.assign(quiz, facts);
}

function settled(quiz: Quiz): boolean {
  const delivery = quiz.question_delivery;
  return Boolean(delivery?.dismissed || delivery?.state === "delivered" && delivery.kind !== "publication" && !open(quiz));
}

function unknownDelivery(quiz: Quiz): boolean {
  const delivery = quiz.question_delivery;
  return quiz.state === "answered" && delivery?.state === "owed"
    && delivery.reason_code === "late_answer_delivery_unknown" && !delivery.dismissed;
}

function normalizeOptions(quiz: Quiz): Option[] {
  return (quiz.options ?? []).map((option, index) => ({
    label: typeof option === "string" ? option : option.label,
    detail: (typeof option === "string" ? undefined : option.detail) ?? quiz.option_details?.[index] ?? "",
    recommended: (typeof option === "string" ? undefined : option.recommended) ?? (index === quiz.recommended_index),
  }));
}

function quizDetails(quiz: Quiz): string {
  const lines = [quiz.state === "open" ? questionWaitStatus(quiz) : stateText(quiz.state), ...questionWaitLines(quiz)];
  if (quiz.answered_index !== undefined) {
    const option = normalizeOptions(quiz)[quiz.answered_index];
    lines.push(option?.label || chromeText("Option {n}", { n: quiz.answered_index + 1 }, `Вариант ${quiz.answered_index + 1}`));
  }
  if (quiz.comment) lines.push(quiz.comment);
  lines.push(...questionLifecycleLines(quiz));
  const delivery = quiz.question_delivery;
  if (delivery?.kind !== "publication") {
    if (delivery?.dismissed) lines.push(chromeText("Hidden from current questions. Delivery remains unknown.", undefined, "Скрыто из текущих вопросов. Доставка остаётся неизвестной."));
    else if (unknownDelivery(quiz)) lines.push(chromeText("Delivery outcome unknown.", undefined, "Результат доставки неизвестен."));
    else if (delivery?.reason_code === "awaiting_recipient_read") lines.push(chromeText("Queued for the task to read.", undefined, "Записано в очередь чтения задачи."));
    else if (delivery?.state === "owed") lines.push(chromeText("Delivery not yet confirmed.", undefined, "Доставка ещё не подтверждена."));
    else if (delivery?.state === "delivered") lines.push(chromeText("Delivery confirmed by the gateway.", undefined, "Доставка подтверждена шлюзом."));
  }
  return lines.join("\n");
}

export class Questions {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;

  constructor(private readonly parent: any, private readonly gateway: Gateway, private readonly changed: () => void) {}

  close(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) entry.dialog?.close();
    this.entries.clear();
  }

  withdraw(): void {
    for (const entry of this.entries.values()) if (entry.allowed && !entry.allowed()) entry.dialog?.close();
  }

  observe(taskId: string, quiz: Quiz): void {
    const entry = this.entries.get(`quiz:${taskId}:${quiz.quiz_id}`);
    if (!entry) return;
    const { question, options, option_details, recommended_index } = quiz;
    if (Object.hasOwn(quiz, "materials")) entry.quiz.materials = quiz.materials;
    if (Object.hasOwn(quiz, "presence_contact")) entry.quiz.presence_contact = quiz.presence_contact;
    mergeFacts(entry.quiz, { ...quiz });
    if (question) entry.quiz.question = question;
    if (options) Object.assign(entry.quiz, { options, option_details, recommended_index });
    if (!entry.sending && settled(entry.quiz)) entry.pending = undefined;
    entry.dialog?.sync();
  }

  update(taskId: string, quizId: string, frame: Record<string, unknown>): void {
    const entry = this.entries.get(`quiz:${taskId}:${quizId}`);
    if (entry) {
      // announce_wait_ended's live frame carries no timestamp: this exact typed pair ends the wait.
      if (frame.state === "open" && frame.wait_for_answer === false) {
        entry.quiz._native_wait_ended_live = true;
        frame = { ...frame, owner_wait_state: "resumed" };
      }
      mergeFacts(entry.quiz, frame);
      if (!entry.sending && settled(entry.quiz)) entry.pending = undefined;
      entry.dialog?.sync();
    }
  }

  show(taskId: string, quiz: Quiz, allowed?: () => boolean): void {
    if (this.disposed || allowed && !allowed()) return;
    const id = `quiz:${taskId}:${quiz.quiz_id}`;
    let entry = this.entries.get(id);
    if (entry) {
      if (allowed) {
        const { secret_request, assumption, stake, host_facts, materials } = quiz;
        if (JSON.stringify(entry.quiz.secret_request) !== JSON.stringify(secret_request)) {
          entry.dialog?.close();
          entry.dialog = undefined;
        }
        Object.assign(entry.quiz, { secret_request, assumption, stake, host_facts, materials });
      }
      this.observe(taskId, quiz);
    } else {
      entry = { quiz: { ...quiz } };
      mergeQuestionWait(entry.quiz, quiz);
      this.entries.set(id, entry);
    }
    if (entry.dialog) {
      if (allowed) entry.allowed = allowed;
      entry.dialog.present();
      return;
    }
    const selected = entry;
    selected.allowed = allowed;
    const dialog = new QuestionDialog(this.parent, this.gateway, id, selected,
      (answer) => {
        if (selected.dialog === dialog && (!selected.allowed || selected.allowed())) void this.send(id, selected, answer);
      },
      () => { if (selected.dialog === dialog) selected.dialog = undefined; },
      () => this.changed());
    selected.dialog = dialog;
    dialog.present();
  }

  private async send(id: string, entry: Entry, input: Omit<Answer, "decision_id" | "request_id">): Promise<void> {
    if (this.disposed || entry.sending) return;
    entry.pending ??= { decision_id: id, request_id: GLib.uuid_string_random(), ...input };
    const answer = entry.pending;
    entry.sending = true;
    entry.dialog?.sync();
    let message = "";
    try {
      const receipt = await this.gateway.json<Receipt>("POST", "/api/decisions", answer);
      if (this.disposed) return;
      mergeFacts(entry.quiz, { ...receipt });
      if (entry.quiz.question_delivery?.state !== "owed" || unknownDelivery(entry.quiz)
        || entry.quiz.question_delivery?.dismissed || answer.action === "dismiss") entry.pending = undefined;
      if (receipt.ok === false) message = receipt.error ?? "Шлюз отклонил действие.";
    } catch (error) {
      if (this.disposed) return;
      message = errorText(error);
      if (error instanceof HttpError) {
        if (error.body && typeof error.body === "object") mergeFacts(entry.quiz, { ...error.body });
        if (error.status < 500 && error.status !== 408 && error.status !== 429) entry.pending = undefined;
      }
    } finally {
      entry.sending = false;
      if (!this.disposed) {
        if (settled(entry.quiz)) entry.pending = undefined;
        entry.dialog?.sync(message);
        this.changed();
      }
    }
  }
}

class QuestionDialog {
  private readonly content = column();
  private readonly question = label("", "title-3");
  private readonly source = column(2);
  private readonly state = label("", "dim-label");
  private readonly error = label("", "error");
  private readonly form = column();
  private readonly comment = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR, top_margin: 6, bottom_margin: 6,
    left_margin: 6, right_margin: 6 });
  private readonly commentSize = label("", "dim-label");
  private readonly choices = column();
  private readonly dialog: any;
  private readonly actions = row();
  private readonly answer: any;
  private readonly closeQuestion: any;
  private readonly retry: any;
  private readonly dismiss: any;
  private readonly secret?: SecretQuestion;
  private readonly materials: QuestionMaterials;
  private selected?: number;
  private options = "";
  private closing?: any;
  private confirmation?: any;
  private disposed = false;
  private unwatch = () => {};

  constructor(
    private readonly parent: any,
    gateway: Gateway,
    id: string,
    private readonly entry: Entry,
    send: (answer: Omit<Answer, "decision_id" | "request_id">) => void,
    closed: () => void,
    changed: () => void,
  ) {
    this.dialog = chrome(sheet("Вопрос Ouroboros", this.content), "title", "Ouroboros question");
    this.content.append(this.question);
    this.content.append(this.source);
    for (const fact of [entry.quiz.host_facts, entry.quiz.stake, entry.quiz.assumption]) {
      if (fact) this.content.append(label(fact, "dim-label"));
    }
    this.materials = new QuestionMaterials(this.dialog, gateway);
    this.content.append(this.materials.widget);
    this.content.append(this.state);
    this.content.append(this.error);
    this.dialog.connect("closed", () => {
      this.disposed = true; this.unwatch();
      this.closing?.force_close(); this.confirmation?.force_close(); this.secret?.close(); this.materials.close(); closed();
    });

    this.answer = chrome(button("Отправить ответ", () => send({
      option_index: this.selected,
      comment: this.commentText() || undefined,
    })), "label", "Send answer");
    this.answer.add_css_class("suggested-action");
    this.closeQuestion = chrome(button("Закрыть вопрос…", () => this.closeWithReason(send)), "label", "Close question…");
    this.retry = chrome(button("Повторить прежнее действие", () => send({})), "label", "Retry previous action");
    this.dismiss = chrome(button("Скрыть из текущих вопросов…", () => this.confirmDismiss(send)), "label", "Hide from current questions…");
    if (entry.quiz.secret_request) {
      this.secret = new SecretQuestion(parent, gateway, id, entry.quiz.secret_request, changed);
      this.content.append(this.secret.widget);
    } else {
      this.form.append(this.choices);
      this.form.append(chrome(label("Комментарий или собственный ответ"), "label", "Comment or your own answer"));
      this.comment.update_property([Gtk.AccessibleProperty.LABEL], ["Комментарий или собственный ответ"]);
      this.form.append(new Gtk.ScrolledWindow({ child: this.comment, min_content_height: 85, max_content_height: 180,
        propagate_natural_height: true, hscrollbar_policy: Gtk.PolicyType.NEVER }));
      this.form.append(this.commentSize);
      this.form.append(this.actions);
      this.actions.append(this.answer);
      this.actions.append(this.closeQuestion);
      this.content.append(this.form);
      this.content.append(this.retry);
      this.content.append(this.dismiss);
      this.comment.get_buffer().connect("changed", () => this.sync());
    }
    this.unwatch = watchNativeI18n(() => this.sync());
    this.sync();
  }

  close(): void { this.materials.close(); this.closing?.force_close(); this.confirmation?.force_close(); this.dialog.force_close(); }
  present(): void { if (!this.disposed) this.dialog.present(this.parent); }

  private commentText(): string {
    const buffer = this.comment.get_buffer();
    return buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false);
  }

  sync(message?: string): void {
    if (this.disposed) return;
    const { quiz, pending, sending } = this.entry;
    if (!open(quiz) || pending) this.closing?.force_close();
    if (!unknownDelivery(quiz) || pending) this.confirmation?.force_close();
    this.question.set_label(quiz.question || chromeText("Ouroboros question", undefined, "Вопрос Ouroboros"));
    clear(this.source);
    const source = contactSource(quiz.presence_contact);
    if (source) this.source.append(source);
    this.materials.update(quiz.materials);
    this.state.set_label(quizDetails(quiz));
    this.state.set_selectable(true);this.state.set_wrap_mode(Pango.WrapMode.WORD_CHAR);this.state.set_max_width_chars(64);
    if (message !== undefined) this.error.set_label(message);
    this.secret?.observe(quiz);
    if (this.secret) return;
    this.comment.update_property([Gtk.AccessibleProperty.LABEL], [chromeText("Comment or your own answer", undefined, "Комментарий или собственный ответ")]);
    this.form.set_visible(open(quiz) && !pending);
    this.retry.set_visible(Boolean(pending));
    this.retry.set_sensitive(!sending);
    this.dismiss.set_visible(unknownDelivery(quiz) && !pending);
    this.dismiss.set_sensitive(!sending);
    const options = normalizeOptions(quiz);
    if (JSON.stringify(options) !== this.options) {
      this.options = JSON.stringify(options);
      this.selected = undefined;
      clear(this.choices);
      let group: any;
      if (options.length) {
        group = chrome(new Gtk.CheckButton({ label: "Свой ответ", active: true }), "label", "Your own answer");
        group.connect("toggled", () => {
          if (group.get_active()) { this.selected = undefined; this.sync(); }
        });
        this.choices.append(group);
      }
      options.forEach((option, index) => {
        const item = new Gtk.CheckButton({
          label: option.recommended ? `${option.label} · рекомендовано` : option.label,
        });
        if (option.recommended) chrome(item, "label", "{option} · recommended", { option: option.label });
        item.set_group(group);
        item.connect("toggled", () => {
          if (item.get_active()) { this.selected = index; this.sync(); }
        });
        this.choices.append(item);
        if (option.detail) this.choices.append(label(option.detail, "dim-label"));
      });
    }
    const length = this.comment.get_buffer().get_char_count();
    counter(this.commentSize, length);
    this.commentSize[length > 2000 ? "add_css_class" : "remove_css_class"]("error");
    this.answer.set_sensitive(!sending && length <= 2000 && (this.selected !== undefined || this.commentText().trim() !== ""));
    this.closeQuestion.set_sensitive(!sending);
  }

  private closeWithReason(send: (answer: Omit<Answer, "decision_id" | "request_id">) => void): void {
    if (this.disposed || !open(this.entry.quiz) || this.entry.pending) return;
    if (this.closing) { this.closing.present(this.parent); return; }
    const content = column();
    const reason = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR, top_margin: 6, bottom_margin: 6,
      left_margin: 6, right_margin: 6 });
    const read = () => reason.buffer.get_text(reason.buffer.get_start_iter(), reason.buffer.get_end_iter(), false);
    const size = label("0 / 2000 символов", "dim-label");
    const dialog = chrome(sheet("Закрыть вопрос без ответа", content), "title", "Close question without answering");
    this.closing = dialog;
    dialog.connect("closed", () => { if (this.closing === dialog) this.closing = undefined; });
    content.append(chrome(label("Причина (необязательно)"), "label", "Reason (optional)"));
    reason.update_property([Gtk.AccessibleProperty.LABEL], ["Причина закрытия вопроса"]);
    content.append(new Gtk.ScrolledWindow({ child: reason, min_content_height: 85, max_content_height: 180,
      propagate_natural_height: true, hscrollbar_policy: Gtk.PolicyType.NEVER }));
    content.append(size);
    let active = true;
    const repaint = () => {
      counter(size, reason.buffer.get_char_count());
      reason.update_property([Gtk.AccessibleProperty.LABEL], [chromeText("Reason for closing the question", undefined, "Причина закрытия вопроса")]);
    };
    const stop = watchNativeI18n(repaint); repaint();
    dialog.connect("closed", () => { active = false; stop(); });
    const close = chrome(button("Закрыть вопрос", () => {
      if (!active || this.disposed || reason.buffer.get_char_count() > 2000) return;
      const text = read();
      dialog.close();
      if (open(this.entry.quiz) && !this.entry.pending) send({ action: "close", reason: text.trim() ? text : undefined });
    }), "label", "Close question");
    reason.buffer.connect("changed", () => {
      const length = reason.buffer.get_char_count();
      counter(size, length);
      size[length > 2000 ? "add_css_class" : "remove_css_class"]("error");
      close.set_sensitive(length <= 2000);
    });
    content.append(close);
    dialog.present(this.parent);
  }

  private confirmDismiss(send: (answer: Omit<Answer, "decision_id" | "request_id">) => void): void {
    if (this.disposed || !unknownDelivery(this.entry.quiz) || this.entry.pending) return;
    if (this.confirmation) { this.confirmation.present(this.parent); return; }
    const dialog = new Adw.AlertDialog({ heading: "Скрыть вопрос?",
      body: "Записанный ответ и состояние доставки останутся в истории." });
    chrome(dialog, "heading", "Hide question?");
    chrome(dialog, "body", "The recorded answer and delivery state will remain in history.");
    this.confirmation = dialog;
    dialog.add_response("cancel", "Отмена");
    dialog.add_response("ok", "Скрыть");
    let active = true;
    const repaint = () => {
      if (!active) return;
      dialog.set_response_label("cancel", chromeText("Cancel", undefined, "Отмена"));
      dialog.set_response_label("ok", chromeText("Hide", undefined, "Скрыть"));
    };
    const stop = watchNativeI18n(repaint); repaint();
    const release = () => { active = false; stop(); };
    dialog.connect("closed", release);
    dialog.set_close_response("cancel");
    dialog.set_default_response("cancel");
    dialog.set_response_appearance("ok", Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.connect("response", (_dialog: any, response: string) => {
      if (this.disposed || this.confirmation !== dialog) return;
      release();
      this.confirmation = undefined;
      if (response === "ok" && unknownDelivery(this.entry.quiz) && !this.entry.pending) send({ action: "dismiss" });
    });
    dialog.present(this.parent);
  }
}
