import { Gtk, Pango } from "./gi.js";
import { chrome } from "./native-i18n.js";
import { type OwnerQuestions } from "./owner-questions.js";
import { exactWorkTarget, type WorkControl, workActionNames } from "./work-actions.js";
import { activityWord, type Work, type WorkReason, type WorkResume, type WorkState } from "./work-state.js";
import { button, clear, column, confirm, label } from "./ui.js";

function actorName(actor?: string): string {
  const words: Record<string, string> = { owner: "Владелец", ouroboros: "Ouroboros", host: "Шлюз" };
  return Object.hasOwn(words, actor ?? "") ? words[actor!]! : actor ?? "";
}

function reasonText(reason: WorkReason): string {
  const clauses = (reason.wake ?? []).map((wake) => {
    const instant = wake.at ? new Date(wake.at) : undefined;
    return [wake.name || wake.kind, wake.count, instant && !Number.isNaN(instant.valueOf()) ? instant.toLocaleString() : wake.at]
      .filter((value) => value !== undefined && value !== "").join(" · ");
  }).filter(Boolean);
  const author = actorName(reason.by?.actor);
  return [reason.text || reason.code, typeof reason.count === "number" ? String(reason.count) : "",
    author, reason.by?.text, clauses.join(" или ")].filter(Boolean).join(" · ");
}

function resumeText(resume?: WorkResume): string {
  if (!resume) return "";
  const date = typeof resume.at === "number" || typeof resume.at === "string"
    ? new Date(typeof resume.at === "number" && resume.at < 10_000_000_000 ? resume.at * 1000 : resume.at) : undefined;
  return ["Возобновление было отклонено", date && !Number.isNaN(date.valueOf()) ? date.toLocaleString() : "", actorName(resume.by?.actor),
    resume.text || resume.error].filter(Boolean).join(" · ");
}

export class WorkPanel {
  readonly widget: any;
  private readonly content = column(5);
  private readonly notice = label("", "dim-label");
  private readonly rows = column(6);
  private readonly heading = new Gtk.Expander({ label: "Активная работа" });
  private readonly expanded = new Set<string>();
  private readonly pending = new Set<string>();
  private readonly off: () => void;
  private signature = "";
  private chatId?: number;
  private projectId?: string;
  private scope = 0;
  private closed = false;

  constructor(private readonly parent: any, private readonly state: WorkState, private readonly openTask?: (id: string) => void,
    private readonly compact = false, private readonly questions?: OwnerQuestions,
    private readonly openWait?: (taskId: string, waitId: string) => boolean) {
    this.content.append(this.notice);
    this.content.append(this.rows);
    if (compact) this.heading.set_child(this.content);
    this.widget = compact ? this.heading : this.content;
    this.off = state.subscribe(() => this.render());
    this.render();
  }

  setRoom(chatId: number, projectId?: string): void {
    if (this.chatId === chatId && this.projectId === projectId) return;
    this.invalidateQuestions();
    this.chatId = chatId;
    this.projectId = projectId;
    this.expanded.clear();
    this.notice.set_label("");
    this.render();
  }

  invalidateQuestions(): void { this.scope++; this.questions?.forms.withdraw(); }
  close(): void { this.closed = true; this.invalidateQuestions(); this.off(); }

  private render(): void {
    if (this.closed) return;
    const works = this.state.list(this.compact ? this.chatId : undefined);
    const room = this.compact && this.chatId !== undefined ? this.state.room(this.chatId) : undefined;
    if (this.compact) {
      this.heading.set_visible((this.state.loaded || this.state.readUnavailable) && (works.length > 0 || Boolean(room?.amber)
        || !this.state.complete || this.state.gaps.length > 0 || this.state.gapsUnavailable));
      this.heading.set_label([room ? activityWord(room) : "", room?.amber ? "Нужно ваше участие" : "",
        works.length > 1 ? `Работ · ${works.length}` : ""].filter(Boolean).join(" · ") || "Активная работа");
    }
    const signature = JSON.stringify([this.state.loaded, this.state.complete, this.state.readUnavailable, this.state.gaps, this.state.gapsUnavailable, works.map((work) =>
      [work, this.pending.has(work.work_id), this.state.controls(work).map((control) => [control, this.state.actions.busy(control.target)])])]);
    if (signature === this.signature) return;
    this.signature = signature;
    clear(this.rows);
    if (this.state.readUnavailable) this.rows.append(chrome(label("Сведения об активной работе недоступны. Прежние записи не подтверждены; действия отключены.", "warning"),
      "label", "Active work details are unavailable. Previous records are unconfirmed; actions are disabled."));
    if (this.state.gapsUnavailable) this.rows.append(chrome(label("Причины пробелов сводки недоступны. Прежние сведения могут быть устаревшими.", "warning"),
      "label", "Work summary gap details are unavailable. Previous details may be stale."));
    if (this.state.gaps.length) {
      this.rows.append(chrome(label("Пробелы сводки шлюза", "warning"), "label", "Gateway work summary gaps"));
      const captions: Record<string, [string, string]> = {
        work_projection_unavailable: ["Work summary could not be read.", "Не удалось прочитать сводку активной работы."],
        answer_upkeep_unavailable: ["Pending answer delivery could not be read.", "Не удалось прочитать ожидающую доставку ответов."],
        delegated_custody_unavailable: ["Delegated work custody could not be read.", "Не удалось прочитать сведения об ответственности за делегированную работу."],
        resume_attempt_unavailable: ["The last resume attempt could not be read.", "Не удалось прочитать последнюю попытку возобновления."],
        episode_record_unavailable: ["A linked task record could not be read.", "Не удалось прочитать запись связанной задачи."],
        episode_chain_cycle: ["The linked task chain contains a cycle.", "В цепочке связанных задач обнаружен цикл."],
      };
      for (const gap of this.state.gaps) {
        const caption = Object.hasOwn(captions, gap.reason) ? captions[gap.reason] : undefined;
        if (caption) this.rows.append(chrome(label(caption[1], "dim-label"), "label", caption[0]));
        const detail = label([gap.reason, gap.task_id].filter(Boolean).join(" · "), "dim-label");
        detail.set_wrap_mode(Pango.WrapMode.WORD_CHAR);detail.set_max_width_chars(64);detail.set_selectable(true);this.rows.append(detail);
      }
    }
    if (!works.length) {
      const words = this.state.complete ? "Нет активной работы." : "Шлюз пока не подтвердил список активных работ.";
      this.rows.append(label(words, "dim-label"));
      return;
    }
    if (!this.state.complete) this.rows.append(label("Список активных работ подтверждён частично.", "dim-label"));
    for (const work of works) this.rows.append(this.work(work));
  }

  private work(work: Work): any {
    const content = column(4);
    const task = work.episode?.task_id;
    for (const reason of [...(work.because ?? []), ...(work.tails ?? [])]) {
      const text = reasonText(reason);
      if (text) content.append(label(text, "dim-label"));
    }
    if (work.focus?.text) content.append(label(work.focus.text));
    const last = resumeText(work.last_resume);
    if (last) content.append(label(last, "dim-label"));
    for (const [id, member] of Object.entries(work.members?.states ?? {})) {
      const resume = resumeText(member.last_resume);
      if (id !== task && resume) content.append(label(`${id} · ${resume}`, "dim-label"));
    }
    for (const turn of work.turn ?? []) {
      if (!turn.task_id) continue;
      const id = turn.task_id;
      const caption = turn.kind === "question" ? "Ожидается ответ владельца" : "Ожидается действие владельца";
      const waitId = turn.wait_id;
      if (this.openWait && turn.kind === "action" && turn.code === "model_access" && exactWorkTarget(waitId)) {
        content.append(button("Восстановить доступ к модели…", () => {
          if (!this.openWait?.(id, waitId)) this.openTask?.(id);
        }));
        continue;
      }
      const chatId = typeof work.room === "number" ? work.room : Number(work.room ?? NaN);
      const quizId = turn.quiz_id;
      if (this.questions && work.confirmed !== false && turn.kind === "question" && exactWorkTarget(id) && exactWorkTarget(quizId)
        && Number.isSafeInteger(chatId) && chatId >= 0) {
        content.append(button("Открыть ожидающий вопрос…", () => {
          const scope = this.scope;
          const inScope = () => !this.closed && this.scope === scope;
          const current = () => this.state.list().some((item) => item.work_id === work.work_id && item.room === work.room
            && item.confirmed !== false && item.turn?.some((value) => value.kind === "question" && value.task_id === id && value.quiz_id === quizId));
          this.notice.set_label("");
          void this.questions?.open({ task_id: id, quiz_id: quizId }, { chatId, projectId: this.projectId }, inScope, current)
            .then((message) => { if (inScope()) this.notice.set_label(message); });
        }));
      } else content.append(this.openTask ? button(caption, () => this.openTask?.(id)) : label(caption));
    }
    if (task && this.openTask) {
      const details = button("Открыть задачу", () => this.openTask?.(task));
      details.set_halign(Gtk.Align.START);
      content.append(details);
    }
    const controls = this.state.controls(work).filter((control) => !(this.compact && control.scope === "single"));
    const flow = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, column_spacing: 5, row_spacing: 5, halign: Gtk.Align.START });
    const add = (caption: string, items: WorkControl[], destructive = false) => {
      if (!items.length) return;
      const control = button(caption, () => void this.execute(work, items));
      if (destructive) control.add_css_class("destructive-action");
      control.set_sensitive(!this.pending.has(work.work_id) && !items.some(({ target }) => this.state.actions.busy(target)));
      control.set_tooltip_text(items.map(({ target }) => target).join("\n"));
      flow.append(control);
    };
    const earlier = controls.filter(({ action }) => action === "stop_earlier");
    const stop = controls.filter(({ action }) => action === "stop");
    for (const control of controls) {
      if (control.action === "stop" || control.action === "stop_earlier") continue;
      const suffix = control.scope === "single" ? ` · ${control.target}` : "";
      add(workActionNames[control.action] + suffix, [control]);
    }
    add("Остановить прежнюю попытку", earlier, true);
    add("Остановить работу", stop, true);
    if (flow.get_first_child()) content.append(flow);
    const box = new Gtk.Expander({ label: [work.name || task || work.work_id, activityWord(work),
      work.turn?.length ? "Нужно ваше участие" : ""].filter(Boolean).join(" · "), child: content });
    box.set_expanded(this.expanded.has(work.work_id));
    box.connect("notify::expanded", () => {
      if (box.get_expanded()) this.expanded.add(work.work_id);
      else this.expanded.delete(work.work_id);
    });
    return box;
  }

  private async execute(work: Work, controls: WorkControl[]): Promise<void> {
    if (this.closed || this.pending.has(work.work_id)) return;
    const room = this.chatId;
    const items = [...new Map(controls.map((control) => [control.target, { control, attempt: this.state.attempt(control) }])).values()];
    this.pending.add(work.work_id);
    this.render();
    const usable = () => !this.closed && this.chatId === room;
    try {
      const action = items[0]?.control.action;
      if (action === "stop" || action === "stop_earlier" || action === "wrap_up") {
        const accepted = await confirm(this.parent, `${workActionNames[action]}?`,
          [work.name || work.work_id, ...items.map(({ control }) => control.target)].join("\n"), workActionNames[action]);
        if (!accepted || !usable()) return;
      }
      if (!await this.state.refresh() || !usable()) {
        if (usable()) this.notice.set_label("Шлюз не подтвердил актуальные действия.");
        return;
      }
      const results: string[] = [];
      for (const { control, attempt } of items) {
        if (!usable()) break;
        const pending = this.state.actions.run(this.parent, control, attempt,
          () => usable() && this.state.allows(work.work_id, control, attempt));
        this.state.changed();
        const result = await pending;
        results.push(items.length === 1 ? result.text : `${control.target} · ${result.text}`);
      }
      if (usable()) this.notice.set_label(results.join("\n"));
      void this.state.refresh();
    } finally {
      this.pending.delete(work.work_id);
      this.state.changed();
    }
  }
}
