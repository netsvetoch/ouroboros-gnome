import { RetainedOutputReaders } from "./retained-output-reader.js";
import type { Gateway } from "./gateway.js";
import { Gtk, Pango } from "./gi.js";
import { bindChrome, chromeText } from "./native-i18n.js";
import { clear, column, label } from "./ui.js";

export interface ReconciliationFields { delegated_runs_unreconciled?: unknown; delegate_terminal_reconciliation?: unknown }
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
function ids(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every(id => typeof id === "string" && id.length > 0) ? [...new Set(v)] : undefined;
}
export function currentCustodyDebt(task: ReconciliationFields): string[] | undefined { return ids(task.delegated_runs_unreconciled); }
const groups = [
  ["open_run_ids", "Open delegated execution", "Открытые делегированные запуски"],
  ["pending_invocation_ids", "Pending delegated invocations", "Ожидающие делегированные запросы"],
  ["undisposed_patch_run_ids", "Pending patch decisions", "Ожидающие решения по патчам"],
  ["deferred_project_retirements", "Deferred project registration cleanup", "Отложенная очистка регистраций проекта"],
] as const;

/** Stored audit categories do not prove success or change task/control authority. */
export class TaskReconciliationView {
  private readonly body = column(5);
  readonly widget = new Gtk.Expander({ child: this.body });
  private readonly headingRelease: () => void;
  private readonly releases: (() => void)[] = [];
  private closed = false;
  private pending = false;
  private readonly readers?: RetainedOutputReaders;
  constructor(parent?: any, gateway?: Gateway) {
    if (parent && gateway) this.readers = new RetainedOutputReaders(parent, gateway);
    this.widget.set_label(chromeText("Delegated execution reconciliation", undefined, "Сверка делегированных запусков"));
    this.headingRelease = bindChrome(this.widget, "label", "Delegated execution reconciliation");
    this.widget.set_visible(false);
  }
  waiting(): boolean { return !this.closed && this.pending; }
  update(task: ReconciliationFields): void {
    if (this.closed) return;
    this.release();clear(this.body);this.pending = false;this.readers?.begin();
    const raw = task.delegate_terminal_reconciliation, flat = task.delegated_runs_unreconciled;
    this.widget.set_visible(raw != null || flat !== undefined);
    if (!this.widget.visible) { this.readers?.finish();return; }
    let bad = raw != null && !object(raw);
    const audit = object(raw) ? raw : undefined, debt = currentCustodyDebt(task);
    const append = (english: string, russian: string, params?: Record<string, string | number>, css?: string, target = this.body) => {
      const field = label(chromeText(english, params, russian), css);
      field.set_selectable(true);field.set_wrap_mode(Pango.WrapMode.WORD_CHAR);field.set_max_width_chars(64);
      target.append(field);this.releases.push(bindChrome(field, "label", english, params));
    };
    const showIds = (values: string[], target = this.body) => {
      for (const id of values) {
        const field = label(id);field.set_selectable(true);field.set_wrap_mode(Pango.WrapMode.WORD_CHAR);field.set_max_width_chars(64);target.append(field);
      }
    };
    if (flat !== undefined && !debt) bad = true;
    if (debt?.length) {
      this.pending = true;
      append("Unreconciled entries · {n}", `Записи, требующие сверки · ${debt.length}`, { n: debt.length }, "warning");showIds(debt);
    } else if (debt && (!audit || audit.audit_status === "ok")) {
      append("Published unreconciled entries · {n}", "Опубликовано несверенных записей · 0", { n: 0 });
    } else append("Current reconciliation debt is not confirmed.", "Текущее состояние несверенных записей не подтверждено.", undefined, "dim-label");
    if (audit) {
      if (typeof audit.audit_status === "string") {
        append("Audit status · {status}", `Состояние проверки · ${audit.audit_status}`, { status: audit.audit_status });
        if (audit.audit_status !== "ok") this.pending = true;
      } else bad = true;
      if (typeof audit.task_id === "string" && audit.task_id) append("Audit task · {value}", `Задача проверки · ${audit.task_id}`, { value: audit.task_id });
      else if (audit.task_id != null) bad = true;
      if (typeof audit.trigger === "string" && audit.trigger) append("Audit trigger · {value}", `Основание проверки · ${audit.trigger}`, { value: audit.trigger });
      else if (audit.trigger != null) bad = true;
      if (audit.unreconciled !== undefined) {
        const recorded = ids(audit.unreconciled);
        if (!recorded) bad = true;
        else {
          const matches = debt && recorded.length === debt.length && recorded.every(id => debt.includes(id));
          if (!matches) {
            append("Audit unreconciled entries · {n}", `Несверенные записи проверки · ${recorded.length}`, { n: recorded.length }, "heading");showIds(recorded);
            if (debt) bad = true;
          }
          if (recorded.length) this.pending = true;
        }
      }
      const terminals = new Set(Array.isArray(audit.terminal_runs) ? audit.terminal_runs.filter(object)
        .filter(row => typeof row.run_id === "string" && typeof row.state === "string" && row.state).map(row => row.run_id) : []);
      for (const [key, english, russian] of groups) if (audit[key] !== undefined) {
        const values = ids(audit[key]);
        if (!values) { bad = true;continue; }
        const shown = key === "open_run_ids" ? values.filter(id => !terminals.has(id)) : values;
        if (key === "open_run_ids") {
          const accounting = values.filter(id => terminals.has(id));
          if (accounting.length) { append("Terminal runs awaiting accounting reconciliation", "Завершённые запуски, ожидающие сверки учёта", undefined, "heading");showIds(accounting); }
        }
        append(english, russian, undefined, "heading");
        append("Published entries · {n}", `Опубликовано записей · ${shown.length}`, { n: shown.length }, "dim-label");showIds(shown);
        if (key !== "deferred_project_retirements" && values.length) this.pending = true;
      }
      if (audit.terminal_runs !== undefined) {
        if (!Array.isArray(audit.terminal_runs)) bad = true;
        else {
          append("Recorded delegated terminal receipts", "Записанные итоговые квитанции запусков", undefined, "heading");
          for (const row of audit.terminal_runs) {
            if (!object(row) || typeof row.run_id !== "string" || !row.run_id || typeof row.state !== "string" || !row.state) { bad = true;continue; }
            const block = column(3);this.body.append(block);showIds([row.run_id], block);
            for (const [key, english, russian] of [["state", "Recorded run state · {value}", "Записанное состояние запуска"],
              ["model", "Receipt model · {value}", "Модель в квитанции"], ["profile_id", "Receipt access profile · {value}", "Профиль доступа в квитанции"],
              ["selected_subagent_id", "Receipt subagent · {value}", "Субагент в квитанции"]] as const) {
              if (typeof row[key] === "string" && row[key]) append(english, `${russian} · ${row[key]}`, { value: row[key] }, undefined, block);
              else if (row[key] != null && typeof row[key] !== "string") bad = true;
            }
            for (const [key, observation] of [["staged_output", false], ["terminal_observation", true]] as const) if (row[key] != null) this.readers?.append(block, row[key], observation, append);
            for (const [key, observation] of [["other_staged_outputs", false], ["other_terminal_observations", true]] as const) if (row[key] != null) {
              if (!Array.isArray(row[key])) bad = true;
              else for (const ref of row[key]) this.readers?.append(block, ref, observation, append);
            }
          }
        }
      }
    }
    this.readers?.finish();
    if (bad) { this.pending = true;append("Some reconciliation details could not be read consistently.", "Часть сведений о сверке прочитать согласованно не удалось.", undefined, "warning"); }
    append("These are stored custody observations; they do not establish task success.", "Это сохранённые сведения об учёте запусков; они не подтверждают успех задачи.", undefined, "dim-label");
  }
  private release(): void { for (const release of this.releases.splice(0)) release(); }
  close(): void { if (this.closed) return;this.closed = true;this.release();this.headingRelease();this.readers?.close(); }
}
