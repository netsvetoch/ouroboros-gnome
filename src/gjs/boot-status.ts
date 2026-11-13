import { Gtk, Pango } from "./gi.js";
import { bindChrome, chromeText, watchNativeI18n } from "./native-i18n.js";
import { clear, column, label } from "./ui.js";

interface Step { name: string; state: string; started_at?: string | null; ended_at?: string | null; error?: string | null }
interface Job { state?: string | null; done?: number | null; total?: number | null }
interface Boot {
  phase?: string; since?: string; error?: string | null; dialogue_ready?: boolean; tasks_ready?: boolean;
  steps?: Step[]; jobs?: Record<string, Job>;
  supervisor_load?: { ts?: string; max_event_lag_sec?: number | null } | null;
}
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
const strings = (v: Record<string, any>, keys: string[]) => keys.every(k => v[k] == null || typeof v[k] === "string");
function read(raw: unknown): Boot | undefined {
  if (raw === undefined) return undefined;
  if (!object(raw) || !strings(raw, ["phase", "since", "error"])
    || ["dialogue_ready", "tasks_ready"].some(k => raw[k] !== undefined && typeof raw[k] !== "boolean")) throw new Error();
  if (raw.steps !== undefined) {
    const names = new Set<string>();
    if (!Array.isArray(raw.steps) || raw.steps.some((s: unknown) => {
      if (!object(s) || typeof s.name !== "string" || !s.name.trim() || names.has(s.name)
        || typeof s.state !== "string" || !s.state.trim() || !strings(s, ["started_at", "ended_at", "error"])) return true;
      names.add(s.name);return false;
    })) throw new Error();
  }
  if (raw.jobs !== undefined && (!object(raw.jobs) || Object.entries(raw.jobs).some(([name, job]) => !name.trim() || !object(job)
    || !strings(job, ["state"]) || ["done", "total"].some(k => job[k] != null && (!Number.isSafeInteger(job[k]) || job[k] < 0))))) throw new Error();
  if (raw.supervisor_load != null && (!object(raw.supervisor_load) || !strings(raw.supervisor_load, ["ts"])
    || raw.supervisor_load.max_event_lag_sec != null && (typeof raw.supervisor_load.max_event_lag_sec !== "number"
      || !Number.isFinite(raw.supervisor_load.max_event_lag_sec) || raw.supervisor_load.max_event_lag_sec < 0))) throw new Error();
  return raw as Boot;
}
function stateWord(value?: string | null): string {
  const names: Record<string, [string, string]> = { starting:["Starting","Запускается"], serving:["Serving during startup","Обслуживает запросы во время запуска"],
    ready:["Ready","Готов"], running:["Running","Выполняется"], pending:["Pending","Ожидает"], done:["Done","Завершено"], failed:["Failed","Ошибка"] };
  return value && Object.hasOwn(names,value) ? chromeText(names[value][0],undefined,names[value][1])
    : value || chromeText("Unknown",undefined,"Неизвестно");
}

/** Published boot observations do not grant command or task admission authority. */
export class BootStatusView {
  private readonly body = column(6);
  readonly widget = new Gtk.Expander({ child: this.body, visible: false });
  private snapshot?: Boot;
  private stale = false;
  private closed = false;
  private headingRelease = () => {};
  private readonly unwatch: () => void;
  constructor() { this.unwatch = watchNativeI18n(() => this.render()); }
  update(raw: unknown): void {
    if (this.closed) return;
    try { this.snapshot = read(raw);this.stale = false; } catch { this.stale = true; }
    this.render();
  }
  unavailable(): void { if (!this.closed) { this.stale = true;this.render(); } }
  close(): void { if (this.closed) return;this.closed = true;this.unwatch();this.headingRelease(); }
  private render(): void {
    if (this.closed) return;
    const value = this.snapshot;clear(this.body);this.headingRelease();this.widget.set_visible(this.stale || Boolean(value));
    const failures = value?.steps?.filter(step => step.state === "failed").length ?? 0;
    const title = this.stale ? "Startup details are unavailable" : failures
      ? "Gateway startup · {phase} · step failures: {count}" : "Gateway startup · {phase}";
    const params = { phase:stateWord(value?.phase), count:failures };
    this.widget.remove_css_class("warning");
    if (this.stale || failures || value?.phase === "failed") this.widget.add_css_class("warning");
    this.widget.set_label(chromeText(title,params,this.stale?"Сведения о запуске недоступны":`Запуск шлюза · ${params.phase}${failures ? ` · ошибок этапов: ${failures}` : ""}`));
    this.headingRelease=bindChrome(this.widget,"label",title,params);
    const append=(text:string,style?:string)=>{const field=label(text,style);field.set_selectable(true);field.set_wrap_mode(Pango.WrapMode.WORD_CHAR);field.set_max_width_chars(64);this.body.append(field)};
    if (this.stale) append(value ? chromeText("Showing the last observed startup snapshot; a new reading is unconfirmed.",undefined,"Показан последний снимок запуска; новое чтение не подтверждено.")
      : chromeText("No startup details could be read.",undefined,"Прочитать сведения о запуске не удалось."),"warning");
    if (!value) return;
    const fact=(source:string,caption:string,field:string|number|boolean|null|undefined)=>{
      if(field==null||field==="")return;append(chromeText(source,{value:String(field)},`${caption} · ${field}`));
    };
    fact("Generation started · {value}","Начало поколения",value.since);
    if(value.error)fact("Startup error · {value}","Ошибка запуска",value.error);
    for(const[key,source,caption]of[["dialogue_ready","Chat admission · {value}","Приём сообщений"],["tasks_ready","Task admission · {value}","Допуск задач"]]as const){
      const state=value[key]===true?chromeText("Ready",undefined,"Готов"):value[key]===false?chromeText("Not ready",undefined,"Не готов"):chromeText("Unknown",undefined,"Неизвестно");fact(source,caption,state);
    }
    append(chromeText("Named startup steps",undefined,"Именованные этапы запуска"),"heading");
    if(!value.steps?.length)append(chromeText("No named startup steps were published in this snapshot.",undefined,"В этом снимке именованные этапы не опубликованы."),"dim-label");
    for(const step of value.steps??[]){
      append(`${step.name} · ${stateWord(step.state)}`,step.state==="failed"?"warning":undefined);
      fact("Started · {value}","Начало",step.started_at);fact("Ended · {value}","Окончание",step.ended_at);if(step.error)append(step.error,"warning");
    }
    append(chromeText("Published background jobs",undefined,"Опубликованные фоновые задания"),"heading");
    if(!Object.keys(value.jobs??{}).length)append(chromeText("No job rows were published in this snapshot; this does not confirm that no jobs exist.",undefined,"В этом снимке строки заданий не опубликованы; отсутствие заданий не подтверждено."),"dim-label");
    for(const[name,job]of Object.entries(value.jobs??{})){
      append(`${name} · ${stateWord(job.state)}`);fact("Done · {value}","Выполнено",job.done);fact("Total · {value}","Всего",job.total);
      if(job.done==null||job.total==null)append(chromeText("Job progress is only partially known.",undefined,"Сведения о ходе задания неполны."),"dim-label");
    }
    append(chromeText("Supervisor event lag",undefined,"Задержка событий супервизора"),"heading");
    if(value.supervisor_load?.max_event_lag_sec==null)append(chromeText("No event-lag measurement was published.",undefined,"Измерение задержки событий не опубликовано."),"dim-label");
    fact("Measured · {value}","Измерено",value.supervisor_load?.ts);fact("Maximum event lag, seconds · {value}","Максимальная задержка, секунд",value.supervisor_load?.max_event_lag_sec);
  }
}
