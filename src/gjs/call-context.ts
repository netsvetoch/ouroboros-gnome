import { type CallSession, type CallView } from "./call-session.js";
import { Adw, Gtk } from "./gi.js";
import { button, column, label, sheet } from "./ui.js";

/** Supplemental observations stay bound to the call that was shown on opening. */
export class CallContext {
  private view?: { dialog: any; update: (view: CallView) => void };
  private closed = false;
  private parentSignal = 0;

  constructor(private readonly parent: any, private readonly session: CallSession) {
    if (parent instanceof Adw.Dialog || parent instanceof Gtk.Window) this.parentSignal = parent.connect(
      parent instanceof Gtk.Window ? "close-request" : "closed", () => { this.close(); return false; });
  }

  show(): void {
    if (this.closed) return;
    if (this.view) { this.view.dialog.present(this.parent); return; }
    const initial = this.session.current;
    const callId = initial.callId;
    if (!callId || !initial.active || initial.phase !== "live") return;
    const content = column();
    const dialog = sheet("Контекст вызова", content);
    const availability = label("", "dim-label");
    const context = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR });
    const contextStatus = label("", "dim-label");
    const participant = new Gtk.Entry({ placeholder_text: "Имя участника" });
    const speaking = new Gtk.CheckButton({ label: "Сейчас говорит" });
    const participantStatus = label("", "dim-label");
    const controls = column();
    let contextSent: string | undefined;
    let participantSent: string | undefined;
    let open = true;
    const text = () => {
      const buffer = context.get_buffer();
      return buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false) as string;
    };
    const participantKey = () => JSON.stringify([participant.get_text().trim(), speaking.get_active()]);
    const sendContext = button("Передать факт", () => {
      if (!open || this.closed || !sendContext.get_sensitive()) return;
      const draft = text();
      const result = this.session.sendContext(callId, draft);
      contextStatus.set_label(result.message);
      if (result.sent || result.uncertain) contextSent = draft.trim();
      update(this.session.current);
    });
    const sendParticipant = button("Сообщить состояние участника", () => {
      if (!open || this.closed || !sendParticipant.get_sensitive()) return;
      const result = this.session.sendParticipant(callId, participant.get_text(), speaking.get_active());
      participantStatus.set_label(result.message);
      if (result.sent || result.uncertain) participantSent = participantKey();
      update(this.session.current);
    });
    const update = (view: CallView) => {
      if (!open || this.closed) return;
      const same = view.active && view.callId === callId;
      const live = same && view.phase === "live";
      availability.set_label(!same ? "Вызов завершён или заменён. Текст сохранён в этом окне для копирования."
        : view.phase === "closing" ? "Вызов завершается." : live ? "" : "Ожидаю восстановления текущего вызова.");
      sendContext.set_sensitive(live && Boolean(text().trim()) && text().trim() !== contextSent);
      sendParticipant.set_sensitive(live && Boolean(participant.get_text().trim()) && participantKey() !== participantSent);
    };
    for (const status of [contextStatus, participantStatus, availability]) status.set_selectable(true);
    content.append(label(initial.room?.name ?? "Текущий вызов", "title-3"));
    content.append(availability);
    controls.append(label("Дополнительный факт для беседы", "title-3"));
    controls.append(label("Ouroboros получит текст как сведения, введённые владельцем в GNOME-клиенте. Отдельную команду можно отправить в чате."));
    controls.append(new Gtk.ScrolledWindow({ child: context, min_content_height: 120, hscrollbar_policy: Gtk.PolicyType.NEVER }));
    controls.append(sendContext);
    controls.append(contextStatus);
    const participants = column();
    participants.append(label("Сведения об участнике задаются вручную. Отметьте, говорит ли указанный участник сейчас."));
    for (const widget of [participant, speaking, sendParticipant, participantStatus]) participants.append(widget);
    controls.append(new Gtk.Expander({ label: "Участник разговора", child: participants }));
    content.append(controls);
    context.get_buffer().connect("changed", () => update(this.session.current));
    participant.connect("changed", () => update(this.session.current));
    speaking.connect("toggled", () => update(this.session.current));
    this.view = { dialog, update };
    dialog.connect("closed", () => {
      open = false;
      if (this.view?.dialog === dialog) this.view = undefined;
    });
    update(initial);
    dialog.present(this.parent);
  }

  update(view: CallView): void { this.view?.update(view); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.parentSignal) { this.parent.disconnect(this.parentSignal); this.parentSignal = 0; }
    this.view?.dialog.force_close();
  }
}
