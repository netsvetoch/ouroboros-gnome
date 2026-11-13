import { Adw, Gio, Gtk, Pango } from "./gi.js";
import { ChatMedia, mediaCaption, type MediaRow } from "./chat-media.js";
import { markdownView } from "./markdown-view.js";
import { type Gateway, HttpError, query } from "./gateway.js";
import type { Present } from "./mcp-server.js";
import { button, clear, column, errorText, label, row, sheet } from "./ui.js";

export interface Room {
  room_chat_id: number;
  address: string;
  label: string | null;
  conversation_id: string;
  thread_id: string;
  last_at: string;
  unanswered_count: number | null;
}

interface Rooms {
  place_id: string;
  rooms: Room[];
  coverage: { discovery: string; importing: boolean; gaps: boolean };
}

interface Account {
  id: string;
  label: string;
  kind: "user" | "bot";
}

interface Row extends MediaRow {
  markdown?: boolean;
  history_id?: string;
  is_progress?: boolean;
  sender_label?: string;
  sender_session_id?: string;
  place_history?: {
    kind?: string;
    delivery_state?: string;
    attention?: { decision?: string; reason?: string; recipient?: string };
    historical_import?: { authorship?: string; received_at?: string };
    owner_confirmed?: boolean;
    sent_at?: string;
    facts?: string[];
    identity?: { sends_as?: Account; reads_as?: Account[] };
    sends_as?: Account;
    sends_as_owner?: boolean;
    held?: boolean;
    checked?: boolean;
    held_text?: string;
    reaction?: { summary?: string };
  };
}

interface Page {
  messages: Row[];
  page_cursor?: string;
  next_cursor?: string | null;
  has_more?: boolean;
  window?: { complete?: boolean; truncated_by?: string[] };
  coverage?: { spans?: Record<string, { gaps?: string[] }> };
}

function lifetime(dialog: any, parent: any, closed: () => void = () => {}): { alive: () => boolean; cancel: any } {
  let open = true, signal = 0;
  const cancel = new Gio.Cancellable();
  const dispose = () => {
    if (!open) return;
    open = false;
    cancel.cancel();
    closed();
    if (signal) { parent.disconnect(signal); signal = 0; }
  };
  dialog.connect("closed", dispose);
  if (parent instanceof Adw.Dialog) signal = parent.connect("closed", dispose);
  return { alive: () => open, cancel };
}

function validPage(page: Page): boolean {
  const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
  const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === "string");
  const fields = (value: Record<string, any>, names: string[], type: string) => names.every(name => value[name] === undefined || typeof value[name] === type);
  const nested = (value: Record<string, any>, name: string, valid: (value: Record<string, any>) => boolean) =>
    value[name] === undefined || record(value[name]) && valid(value[name]);
  // Read-only captured accounts can predate today's identity declaration; validate the fields shown here.
  const account = (value: unknown) => record(value) && typeof value.label === "string" && fields(value, ["kind"], "string");
  return Boolean(record(page) && Array.isArray(page.messages) && page.messages.every(row => record(row) && typeof row.text === "string"
    && fields(row, ["role", "sender_label", "sender_session_id", "ts", "row_address", "history_id", "task_id"], "string")
    && fields(row, ["markdown", "is_progress"], "boolean")
    && nested(row, "place_history", info => fields(info, ["kind", "delivery_state", "sent_at", "held_text"], "string")
      && fields(info, ["owner_confirmed", "sends_as_owner", "held", "checked"], "boolean")
      && (info.facts === undefined || strings(info.facts))
      && nested(info, "attention", attention => fields(attention, ["decision", "reason", "recipient"], "string"))
      && nested(info, "historical_import", imported => fields(imported, ["authorship", "received_at"], "string"))
      && nested(info, "reaction", reaction => fields(reaction, ["summary"], "string"))
      && (info.sends_as === undefined || account(info.sends_as))
      && nested(info, "identity", identity => (identity.sends_as === undefined || account(identity.sends_as))
        && (identity.reads_as === undefined || Array.isArray(identity.reads_as) && identity.reads_as.every(account)))))
    && (page.page_cursor === undefined || typeof page.page_cursor === "string")
    && (page.next_cursor == null || typeof page.next_cursor === "string")
    && (page.has_more === undefined || typeof page.has_more === "boolean")
    && (page.window === undefined || record(page.window)
      && fields(page.window, ["complete"], "boolean")
      && (page.window.truncated_by === undefined || strings(page.window.truncated_by)))
    && (page.coverage === undefined || record(page.coverage)
      && (page.coverage.spans === undefined || record(page.coverage.spans)
        && Object.values(page.coverage.spans).every(span => record(span) && (span.gaps === undefined || strings(span.gaps))))));
}

export function detail(target: any, ...values: unknown[]): void {
  const text = values.filter((value) => value != null && value !== false && value !== "").map(String).join(" · ");
  if (!text) return;
  const field = label(text);
  field.set_wrap_mode(Pango.WrapMode.WORD_CHAR);field.set_max_width_chars(64);
  field.set_selectable(true);
  target.append(field);
}

function pageNote(page: Page): { text: string; retry: boolean } {
  const reasons = page.window?.truncated_by;
  const gaps = Object.values(page.coverage?.spans ?? {}).flatMap((span) => span.gaps ?? []);
  const importing = reasons?.some((reason) => reason.endsWith("_importing")) || gaps.includes("importing");
  const unavailable = reasons?.some((reason) => /^(chat|progress)_/.test(reason) && !reason.endsWith("_importing"))
    || gaps.some((gap) => gap !== "importing");
  const bounded = reasons?.some((reason) => !["page", "quota"].includes(reason) && !/^(chat|progress)_/.test(reason));
  const unknown = !reasons || (!page.window?.complete && !reasons.length);
  const retry = Boolean(importing || unavailable || bounded || unknown);
  return { retry, text: [importing && "Продолжается импорт более ранних записей.", unavailable && "Часть записей в этом диапазоне недоступна.",
    bounded && "Выдача этого диапазона ограничена.", unknown && "Шлюз не сообщил полноту этого диапазона.",
    !retry && (page.has_more ? "Есть более ранние сохранённые записи." : "Начало истории, сохранённой к моменту чтения.")].filter(Boolean).join(" ") };
}

const delivery: Record<string, string> = {
  authored: "Доставка не подтверждена", accepted: "Принято сервисом, доставка не подтверждена",
  delivered: "Доставлено", failed: "Доставка не удалась", uncertain: "Итог доставки неизвестен",
};
const heard: Record<string, string> = {
  paused: "Получено во время паузы", off: "Получено при выключенном сознании", no_wake_match: "Получено без запуска фокуса",
  reaction_context_only: "Получено как контекст", current_author: "Передано текущему автору",
  conversation_work: "Передано работе в этой комнате", disconnected: "Получено после отключения", own_account: "Получено от аккаунта отправителя",
};

export class PlaceHistory {
  private readonly indexes = new Map<string, Rooms>();

  constructor(private readonly gateway: Gateway, private readonly present: Present, private readonly task?: (id: string) => void) {}

  async capture(place: string, cancel?: any): Promise<Rooms> {
    const result = await this.gateway.json<Rooms>("GET", `/api/places/${encodeURIComponent(place)}/rooms`,
      undefined, undefined, false, cancel);
    if (result.place_id !== place || !Array.isArray(result.rooms) || result.coverage?.discovery !== "arrivals"
      || typeof result.coverage.importing !== "boolean" || typeof result.coverage.gaps !== "boolean"
      || result.rooms.some((room) => !room || !Number.isSafeInteger(room.room_chat_id) || room.room_chat_id <= 0
        || typeof room.address !== "string" || !(room.label === null || typeof room.label === "string")
        || typeof room.conversation_id !== "string" || typeof room.thread_id !== "string" || typeof room.last_at !== "string"
        || !(room.unanswered_count === null || (Number.isSafeInteger(room.unanswered_count) && room.unanswered_count >= 0)))) {
      throw new Error("Шлюз не подтвердил индекс комнат этого места.");
    }
    if (cancel?.is_cancelled()) throw new Error("Чтение индекса комнат отменено.");
    this.indexes.set(place, result);
    return result;
  }

  rooms(parent: any, place: string, name: string, labels: Record<string, string>): void {
    const content = column();
    const dialog = sheet(`Комнаты · ${name}`, content);
    const status = label("", "dim-label");
    const list = column();
    const life = lifetime(dialog, parent);
    let revision = 0;
    let reading = false;
    const render = (result: Rooms) => {
      const current = ++revision;
      clear(list);
      for (const room of result.rooms) {
        list.append(button(room.label || room.address, () => { if (life.alive() && revision === current) this.history(dialog, room, labels); }));
        detail(list, room.address, room.thread_id && `ветка ${room.thread_id}`, room.last_at,
          room.unanswered_count === null ? "число открытых фокусов неизвестно" : `открытых фокусов ${room.unanswered_count}`);
      }
      if (!result.rooms.length) detail(list, "В индексе сохранённых входящих событий комнат пока нет.");
    };
    const load = async () => {
      if (reading || !life.alive()) return;
      reading = true;
      status.set_label("Читаю индекс комнат…");
      try {
        const result = await this.capture(place, life.cancel);
        if (!life.alive()) return;
        render(result);
        status.set_label([result.coverage.importing && "Список может пополниться после импорта.",
          result.coverage.gaps && "Некоторые сохранённые записи недоступны."].filter(Boolean).join("\n"));
      } catch (error) {
        if (life.alive()) {
          const saved = this.indexes.get(place);
          if (saved) render(saved);
          status.set_label([saved ? "Показан последний прочитанный индекс." : "", errorText(error)].filter(Boolean).join("\n"));
        }
      } finally { reading = false; }
    };
    content.append(label("Индекс строится по сохранённым входящим событиям. Старые комнаты и комнаты только с исходящими сообщениями могут отсутствовать.", "dim-label"));
    content.append(button("Перечитать комнаты", () => void load()));
    content.append(status);
    content.append(list);
    this.present(dialog, parent);
    void load();
  }

  history(parent: any, room: Room, labels: Record<string, string>): void {
    const content = column();
    const dialog = sheet(room.label || room.address, content);
    dialog.set_content_width(760);
    dialog.set_content_height(690);
    const status = label("", "dim-label");
    const coverage = column(4);
    const messages = column();
    const pages: { cursor?: string; page: Page }[] = [];
    const media = new ChatMedia(this.gateway, this.present);
    const life = lifetime(dialog, parent, () => media.close());
    let revision = 0;
    let busy = false;
    let retry: (() => void) | undefined;
    const render = () => {
      const current = ++revision;
      clear(coverage);
      clear(messages);
      const seen = new Set<string>();
      for (const [index, { cursor, page }] of pages.entries()) {
        const note = pageNote(page);
        if (index === 0 || note.retry) detail(coverage, note.text);
        if (note.retry) coverage.append(button("Повторить чтение диапазона", () => { if (life.alive() && revision === current) void load(cursor, index); }));
        for (const message of page.messages) {
          if (!message.place_history || message.is_progress || !["assistant", "system", "user"].includes(message.role ?? "")) continue;
          const id = message.row_address ?? message.history_id;
          if (id && seen.has(id)) continue;
          if (id) seen.add(id);
          this.message(dialog, messages, message, labels, media);
        }
      }
      if (!messages.get_first_child()) detail(messages, "В прочитанных диапазонах нет сохранённых сообщений.");
      older.set_visible(pages[0]?.page.has_more === true);
    };
    const load = async (cursor: string | undefined, replace: number | "all" | null) => {
      if (busy || !life.alive()) return;
      busy = true;
      retry = undefined;
      retryButton.set_visible(false);
      controls.set_sensitive(false);
      status.set_label("Читаю сохранённую историю…");
      const read = () => this.gateway.json<Page>("GET", `/api/chat/history${query({ chat_id: room.room_chat_id, cursor })}`, undefined, undefined, false, life.cancel);
      let moved = false;
      try {
        let page: Page;
        try { page = await read(); } catch (error) {
          if (!life.alive() || cursor == null || !(error instanceof HttpError) || error.reason !== "history_view_changed") throw error;
          cursor = undefined;
          replace = "all";
          moved = true;
          page = await read();
        }
        if (!life.alive()) return;
        if (!validPage(page) || (page.has_more === true && (typeof page.next_cursor !== "string" || !page.next_cursor
          || page.next_cursor === cursor || replace === null && pages.some(item => item.cursor === page.next_cursor)))) {
          throw new Error("Шлюз вернул неполную страницу истории.");
        }
        const saved = { cursor: page.page_cursor || cursor, page };
        if (replace === "all") pages.splice(0, pages.length, saved);
        else if (replace === null) pages.unshift(saved);
        else {
          const previous = pages[replace]?.page.next_cursor;
          pages[replace] = saved;
          if (replace > 0 && previous !== page.next_cursor) pages.splice(0, replace);
        }
        render();
        status.set_label(moved ? "Сохранённая история изменилась. Шлюз вернул её заново с последней страницы." : "");
      } catch (error) {
        if (!life.alive()) return;
        status.set_label((pages.length ? "Показаны последние прочитанные страницы. Новое чтение не подтверждено. " : "") + errorText(error));
        retry = () => void load(cursor, replace);
        retryButton.set_visible(true);
      } finally {
        busy = false;
        if (life.alive()) controls.set_sensitive(true);
      }
    };
    const controls = row();
    const older = button("Ранее", () => {
      const next = pages[0]?.page.next_cursor;
      if (next) void load(next, null);
    });
    older.set_visible(false);
    const retryButton = button("Повторить запрос", () => retry?.());
    retryButton.set_visible(false);
    for (const widget of [older, button("Перечитать историю", () => void load(undefined, "all")), retryButton]) controls.append(widget);
    for (const widget of [label("Показаны события, сохранённые Ouroboros. История самого сервиса может быть шире.", "dim-label"),
      controls, status, coverage, messages]) content.append(widget);
    this.present(dialog, parent);
    void load(undefined, "all");
  }

  private message(dialog: any, target: any, message: Row, labels: Record<string, string>, media: ChatMedia): void {
    const info = message.place_history!;
    const group = column(4);
    const attention = info.attention;
    const name = message.role === "assistant" ? "Ouroboros" : message.role === "system" ? "Система"
      : message.sender_label || message.sender_session_id || "Участник";
    detail(group, name, info.owner_confirmed === true && "вы", info.sent_at || message.ts,
      info.sent_at && `сохранено ${info.historical_import?.received_at || message.ts || "в неизвестное время"}`);
    detail(group, attention?.decision === "focus_started" ? "Фокус запущен" : attention?.decision === "heard"
      ? Object.hasOwn(heard, attention.reason ?? "") ? heard[attention.reason!] : "Получено" : "", attention?.recipient,
      info.delivery_state && (Object.hasOwn(delivery, info.delivery_state) ? delivery[info.delivery_state] : info.delivery_state),
      info.historical_import?.authorship && `импорт · ${info.historical_import.authorship}`, info.historical_import?.received_at);
    if (attention?.decision === "heard") detail(group, ...(info.facts ?? []).filter((item) => item !== "any_message").map((item) => Object.hasOwn(labels, item) ? labels[item] : item));
    if (info.sends_as) detail(group, "Отправлено от", info.sends_as.label, info.sends_as.kind, info.sends_as_owner === true && "вы");
    if (info.identity?.sends_as) detail(group, "Аккаунт отправителя при получении", info.identity.sends_as.label, info.identity.sends_as.kind);
    if (info.identity?.reads_as?.length) detail(group, "Получающие аккаунты", info.identity.reads_as.map((item) => item.label).join(", "));
    media.append(dialog, group, message);
    const caption = mediaCaption(message);
    if (caption) {
      if (message.markdown === true) group.append(markdownView(caption, this.gateway.base, { controls: false }));
      else detail(group, caption);
    }
    if (info.reaction?.summary) detail(group, "Реакция", info.reaction.summary);
    if (info.held === true && info.checked === false && typeof info.held_text === "string") {
      detail(group, "Удержано до проверки", info.held_text);
    }
    if (attention?.decision === "focus_started" && message.task_id && this.task) {
      group.append(button("Открыть задачу фокуса", () => this.task?.(message.task_id!)));
    }
    group.append(new Gtk.Separator());
    target.append(group);
  }
}
