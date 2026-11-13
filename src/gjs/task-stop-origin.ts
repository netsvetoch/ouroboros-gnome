import { Gtk, Pango } from "./gi.js";
import { bindChrome, chromeText } from "./native-i18n.js";
import { clear, column, label } from "./ui.js";

const keys = ["source", "requested_by", "scope", "reason", "requested_at", "request_id", "stop_policy"] as const;
type Origin = Partial<Record<typeof keys[number], string>> & { actor?: Record<string, string>; incomplete: boolean };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
function read(raw: unknown): Origin | undefined {
  if (raw == null) return;
  const result: Origin = { incomplete: !object(raw) };
  if (!object(raw)) return result;
  for (const key of keys) if (raw[key] != null) {
    if (typeof raw[key] === "string") result[key] = raw[key]; else result.incomplete = true;
  }
  if (raw.request_origin != null) {
    if (!object(raw.request_origin)) result.incomplete = true;
    else {
      result.actor = {};
      for (const key of ["kind", "task_id", "source"]) if (raw.request_origin[key] != null) {
        if (typeof raw.request_origin[key] === "string") result.actor[key] = raw.request_origin[key];
        else result.incomplete = true;
      }
      if (!result.actor.kind || result.actor.kind === "agent_task" && !result.actor.task_id) result.incomplete = true;
    }
  }
  if (!keys.some(key => result[key]) && !result.actor) result.incomplete = true;
  return result;
}
const sources: Record<string, [string, string]> = {
  server_shutdown: ["Server shutdown", "Остановка сервера"],
  cascade_descendant: ["Stopped with its task tree", "Остановлена вместе со своим деревом задач"],
  owner_restart: ["Stopped by the Restart command", "Остановлена командой Restart"],
  snapshot_restore: ["The server stopped while this task was still running", "Сервер остановился, пока задача ещё выполнялась"],
  agent_tool: ["Stopped by Ouroboros", "Остановлена Ouroboros"],
  silence_resolved: ["Silence check withdrawn because the observed work moved on", "Проверка тишины отозвана: наблюдаемая работа изменилась"],
};

/** Stored provenance only: HTTP transport and requested_by never identify an owner or actor. */
export class TaskStopOriginView {
  private readonly body = column(5);
  readonly widget = new Gtk.Expander({ child: this.body });
  private readonly headingRelease: () => void;
  private readonly releases: (() => void)[] = [];
  private closed = false;
  constructor() {
    this.widget.set_label(chromeText("Recorded stop origin", undefined, "Записанные сведения об остановке"));
    this.headingRelease = bindChrome(this.widget, "label", "Recorded stop origin");
    this.widget.set_visible(false);
  }
  update(raw: unknown): void {
    if (this.closed) return;
    this.release();clear(this.body);
    const origin = read(raw);
    this.widget.set_visible(Boolean(origin));
    if (!origin) return;
    const append = (english: string, russian: string, params?: Record<string, string>, css?: string) => {
      const field = label(chromeText(english, params, russian), css);
      field.set_selectable(true);field.set_wrap_mode(Pango.WrapMode.WORD_CHAR);field.set_max_width_chars(64);
      this.body.append(field);this.releases.push(bindChrome(field, "label", english, params));
    };
    if (origin.incomplete) append("Some recorded stop-origin details could not be read.", "Часть записанных сведений об остановке прочитать не удалось.", undefined, "warning");
    for (const [key, english, russian] of [
      ["source", "Stop source · {value}", "Источник остановки"], ["scope", "Stop scope · {value}", "Область остановки"],
      ["requested_by", "Task associated with the stop request · {value}", "Задача, связанная с запросом остановки"],
      ["requested_at", "Stop requested at · {value}", "Время запроса остановки"], ["request_id", "Stop request · {value}", "Запрос остановки"],
      ["reason", "Recorded stop reason · {value}", "Записанная причина остановки"],
    ] as const) if (origin[key]) append(english, `${russian} · ${origin[key]}`, { value: origin[key]! });
    if (origin.source && Object.hasOwn(sources, origin.source)) {
      const [english, russian] = sources[origin.source];append(english, russian);
    }
    if (origin.stop_policy === "immediate") append("Recorded stop policy · Stop now", "Записанная команда остановки · Stop now");
    else if (origin.stop_policy === "finalize_then_cancel") append("Recorded stop policy · Wrap up", "Записанная команда остановки · Wrap up");
    else if (origin.stop_policy) append("Recorded stop policy · {value}", `Записанная политика остановки · ${origin.stop_policy}`, { value: origin.stop_policy });
    const actor = origin.actor;
    if (actor?.kind === "http_client") append("Request origin · HTTP client; actor not identified", "Происхождение запроса · HTTP-клиент; автор не указан");
    else if (actor?.kind === "agent_task") append("Request origin · Agent task", "Происхождение запроса · Задача агента");
    else if (actor?.kind) append("Request origin kind · {value}", `Происхождение запроса · ${actor.kind}`, { value: actor.kind });
    if (actor?.task_id) append("Request-origin task · {value}", `Задача-источник запроса · ${actor.task_id}`, { value: actor.task_id });
    if (actor?.source) append("Request-origin source · {value}", `Источник запроса · ${actor.source}`, { value: actor.source });
  }
  private release(): void { for (const release of this.releases.splice(0)) release(); }
  close(): void { if (this.closed) return;this.closed = true;this.release();this.headingRelease(); }
}
