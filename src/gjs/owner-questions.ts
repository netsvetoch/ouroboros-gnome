import { projectQuestionWait, questionWaitStatus, type QuestionWaitFacts } from "./question-wait.js";
import { watchNativeI18n } from "./native-i18n.js";
import { type Gateway } from "./gateway.js";
import { Gio, GLib, Gtk } from "./gi.js";
import { Questions, type Quiz } from "./questions.js";
import { exactWorkTarget } from "./work-actions.js";
import { button, clear, column, errorText, label } from "./ui.js";

interface QuestionTarget { task_id: string; quiz_id: string }
interface QuestionRoom { chatId: number; projectId?: string }
interface ProjectRoom { id?: string; chat_id?: number }
interface CurrentQuestion extends QuestionTarget, QuestionWaitFacts {
  chat_id?: number;
  native?: boolean;
  project_id?: string;
  project_chat_id?: number;
  project_name?: string;
  question?: string;
  quiz_state?: string;
  ts?: string;
  confirmed: boolean;
}
interface Snapshot {
  current_questions?: CurrentQuestion[];
  current_questions_complete?: boolean;
  current_questions_gaps?: Partial<QuestionTarget>[];
  projects?: ProjectRoom[];
}
interface RoomProof { state?: string; chat_id?: number; project_id?: string; also_project_ids?: string[] }
interface StoredQuiz extends Quiz {
  delivery?: NonNullable<Quiz["question_delivery"]> & { dismissed_at?: string };
  publication_chat_id?: number;
  publication_evidence?: string;
}
interface TaskDetail {
  owner_wait?: unknown;
  task_id?: string;
  id?: string;
  owner_quiz?: Record<string, StoredQuiz>;
  question_rooms?: Record<string, RoomProof>;
}

const key = ({ task_id, quiz_id }: QuestionTarget): string => `${task_id}:${quiz_id}`;
const lifecycle = new Set(["open", "expired_terminal", "answered", "closed", "superseded"]);

function inRoom(quiz: StoredQuiz, proof: RoomProof | undefined, room: QuestionRoom): boolean {
  if (proof?.state !== "known" || !Number.isSafeInteger(proof.chat_id) || typeof proof.project_id !== "string") return false;
  if (room.chatId === 0) return proof.chat_id === 1 && proof.project_id === "" && quiz.publication_chat_id === 1
    && (quiz.publication_evidence === "pre_exposure" || quiz.publication_evidence === "history");
  if (room.chatId === 1) return proof.chat_id === 1 && proof.project_id === "";
  if (proof.chat_id === room.chatId) return Boolean(proof.project_id && (!room.projectId || proof.project_id === room.projectId));
  return Boolean(room.projectId && proof.chat_id === 1 && proof.project_id === "" && Array.isArray(proof.also_project_ids)
    && proof.also_project_ids.includes(room.projectId));
}

export class OwnerQuestions {
  readonly forms: Questions;
  private readonly listeners = new Set<() => void>();
  private questions: CurrentQuestion[] = [];
  private projects = new Map<number, string>();
  private connected = false;
  private epoch = 0;
  private readAt = 0;
  private opening?: { id: string; cancel: any };
  private closed = false;
  loaded = false;
  complete = false;

  constructor(private readonly gateway: Gateway, parent: any, changed: () => void) {
    this.forms = new Questions(parent, gateway, changed);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setConnected(connected: boolean): void {
    if (this.closed || connected === this.connected) return;
    this.connected = connected;
    this.epoch = GLib.get_monotonic_time();
    this.opening?.cancel.cancel();
    this.forms.withdraw();
    this.observe(undefined, this.epoch);
  }

  observe(value: unknown, readAt: number): void {
    if (this.closed || readAt < this.epoch || readAt < this.readAt || !this.connected && value !== undefined) return;
    this.readAt = readAt;
    const snapshot = value as Snapshot | undefined;
    this.projects = new Map((Array.isArray(snapshot?.projects) ? snapshot.projects : [])
      .filter((project) => Number.isSafeInteger(project?.chat_id) && typeof project.id === "string" && project.id)
      .map(({ chat_id, id }) => [chat_id!, id!]));
    const rows = snapshot?.current_questions;
    if (Array.isArray(rows)) this.loaded = true;
    this.complete = Array.isArray(rows) && snapshot?.current_questions_complete === true;
    const current = new Map<string, CurrentQuestion>();
    if (Array.isArray(rows)) for (const row of rows) {
      if (!exactWorkTarget(row?.task_id) || !exactWorkTarget(row.quiz_id)) continue;
      if (row.chat_id !== 1 || !(row.native === true || row.project_id && Number.isSafeInteger(row.project_chat_id) && row.project_chat_id! > 1)) continue;
      current.set(key(row), { ...row, confirmed: this.connected });
    }
    const gaps = snapshot?.current_questions_gaps;
    const scopedGaps = Array.isArray(rows) && Array.isArray(gaps) && gaps.length && gaps.every((gap) => gap?.task_id);
    for (const previous of this.questions) {
      if (this.complete || current.has(key(previous))) continue;
      if (scopedGaps && !gaps.some((gap) => gap.task_id === previous.task_id && (!gap.quiz_id || gap.quiz_id === previous.quiz_id))) continue;
      current.set(key(previous), { ...previous, confirmed: false });
    }
    this.questions = [...current.values()];
    for (const question of current.values()) if (question.confirmed) this.forms.observe(question.task_id, { ...question, state: lifecycle.has(question.quiz_state ?? "") ? question.quiz_state : undefined });
    for (const listener of this.listeners) listener();
  }

  list(room?: QuestionRoom): CurrentQuestion[] {
    if (!room || room.chatId === 1) return this.questions;
    return this.questions.filter((row) => row.project_chat_id === room.chatId && (!room.projectId || row.project_id === room.projectId));
  }

  async open(target: QuestionTarget, room: QuestionRoom, inScope: () => boolean, current: () => boolean): Promise<string> {
    if (!this.connected || this.closed || !current() || !inScope()) return "Вопрос больше не подтверждён шлюзом.";
    if (!exactWorkTarget(target.task_id) || !exactWorkTarget(target.quiz_id)) return "Шлюз не указал точный вопрос.";
    this.opening?.cancel.cancel();
    const opening = { id: key(target), cancel: new Gio.Cancellable() };
    this.opening = opening;
    const epoch = this.epoch;
    const allowed = () => !this.closed && this.connected && this.epoch === epoch && inScope();
    const usable = () => this.opening === opening && !opening.cancel.is_cancelled() && allowed();
    try {
      const detail = await this.gateway.json<TaskDetail>("GET", `/api/tasks/${encodeURIComponent(target.task_id)}`,
        undefined, undefined, false, opening.cancel);
      if (!usable()) return "";
      const quiz = detail?.owner_quiz?.[target.quiz_id];
      const proof = detail?.question_rooms?.[target.quiz_id];
      let projectId = room.projectId ?? this.projects.get(room.chatId);
      if (!projectId && room.chatId > 1 && proof?.chat_id === 1 && proof.also_project_ids?.length) {
        const result = await this.gateway.json<{ projects?: ProjectRoom[] }>("GET", "/api/projects?all=1",
          undefined, undefined, false, opening.cancel);
        if (!usable()) return "";
        projectId = result.projects?.find((project) => project?.chat_id === room.chatId)?.id;
      }
      if (!current() || (detail?.task_id ?? detail?.id) !== target.task_id || quiz?.quiz_id !== target.quiz_id
        || !lifecycle.has(quiz.state ?? "") || !inRoom(quiz, proof, { ...room, projectId })) {
        return "Шлюз не подтвердил этот вопрос в указанной комнате.";
      }
      const delivery = quiz.delivery;
      this.forms.show(target.task_id, { ...quiz, ...projectQuestionWait(target.quiz_id, detail.owner_wait, quiz), question_delivery: delivery
        ? { ...delivery, dismissed: Boolean(delivery.dismissed_at || delivery.dismissed) } : quiz.question_delivery }, allowed);
      return "";
    } catch (error) {
      return usable() ? errorText(error) : "";
    } finally {
      if (this.opening === opening) this.opening = undefined;
    }
  }

  update(taskId: string, quizId: string, frame: Record<string, unknown>): void {
    if (this.opening?.id === key({ task_id: taskId, quiz_id: quizId })) this.opening.cancel.cancel();
    this.forms.update(taskId, quizId, frame);
  }

  close(): void {
    this.closed = true;
    this.opening?.cancel.cancel();
    this.forms.close();
    this.listeners.clear();
  }
}

export class OwnerQuestionsPanel {
  readonly widget = new Gtk.Expander({ label: "Текущие вопросы" });
  private readonly rows = column(5);
  private readonly notice = label("", "dim-label");
  private readonly off: () => void;
  private readonly offLocale: () => void;
  private room?: QuestionRoom;
  private scope = 0;
  private signature = "";

  constructor(private readonly questions: OwnerQuestions, private readonly compact = false) {
    const content = column(5);
    content.append(compact ? new Gtk.ScrolledWindow({ child: this.rows, hscrollbar_policy: Gtk.PolicyType.NEVER,
      max_content_height: 170, propagate_natural_height: true }) : this.rows);
    content.append(this.notice);
    this.widget.set_child(content);
    this.widget.set_expanded(!compact);
    this.offLocale = watchNativeI18n(() => { this.signature = "";this.render(); });
    this.off = questions.subscribe(() => this.render());
    this.render();
  }

  setRoom(room: QuestionRoom): void {
    this.invalidate();
    this.room = room;
    this.render();
  }

  invalidate(): void { this.scope++; this.notice.set_label(""); this.questions.forms.withdraw(); }
  close(): void { this.invalidate(); this.off(); this.offLocale(); }

  private render(): void {
    const list = this.questions.list(this.room);
    this.widget.set_visible(this.questions.loaded && (!this.compact || list.length > 0 || this.room?.chatId === 1 && !this.questions.complete));
    this.widget.set_label(list.length ? `Текущие вопросы · ${list.length}` : "Текущие вопросы");
    const signature = JSON.stringify([list, this.questions.complete]);
    if (signature === this.signature) return;
    this.signature = signature;
    clear(this.rows);
    if (!this.questions.complete) this.rows.append(label("Список текущих вопросов подтверждён частично.", "dim-label"));
    else if (!list.length) this.rows.append(label("Нет текущих вопросов.", "dim-label"));
    for (const question of list) {
      const location = question.project_name || question.project_id || "Main";
      const title = question.question || `Вопрос задачи ${question.task_id}`;
      const date = question.ts ? new Date(question.ts) : undefined;
      const status = question.confirmed ? question.quiz_state === "expired_terminal" ? "Задача завершилась"
        : question.quiz_state === "answered" ? "Доставка ответа" : question.quiz_state === "open" ? questionWaitStatus(question) : "" : "Не подтверждён";
      this.rows.append(label([title, location, status, date && !Number.isNaN(date.valueOf()) && date.toLocaleString()]
        .filter(Boolean).join(" · ")));
      const open = button("Открыть вопрос…", () => {
        const scope = this.scope;
        const inScope = () => scope === this.scope;
        const current = () => this.questions.list(this.room).some((row) => row.confirmed && key(row) === key(question)
          && row.project_id === question.project_id && row.project_chat_id === question.project_chat_id);
        this.notice.set_label("");
        const room = question.native === true ? { chatId: 1 } : { chatId: question.project_chat_id!, projectId: question.project_id };
        void this.questions.open(question, room, inScope, current).then((message) => {
          if (inScope()) this.notice.set_label(message);
        });
      });
      open.set_halign(Gtk.Align.START);
      open.set_sensitive(question.confirmed);
      this.rows.append(open);
    }
  }
}
