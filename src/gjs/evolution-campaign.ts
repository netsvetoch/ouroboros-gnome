import { type RuntimeCommands } from "./commands.js";
import { usd } from "./cost-view.js";
import { Adw, GLib, Gtk } from "./gi.js";
import { button, clear, column, label, row } from "./ui.js";

interface Campaign {
  id?: string;
  objective?: string;
  progress_notes?: string;
  cycles_done?: number;
  absorbed_cycles_done?: number;
  active_transaction?: { commit_sha?: string };
}

export interface CampaignState {
  runtime_mode?: string;
  supervisor_ready?: boolean;
  evolution_enabled?: boolean | null;
  evolution_state?: {
    enabled?: boolean | null;
    status?: string;
    detail?: string;
    objective?: string;
    campaign?: Campaign;
    cycle?: number;
    owner_chat_bound?: boolean;
    last_task_at?: string;
    consecutive_failures?: number;
    budget_remaining_usd?: number | null;
    cost_accounting_status?: string;
    queued_task_id?: string;
    running_task_id?: string;
  };
}

const statusNames: Record<string, string> = {
  disabled: "Кампания выключена",
  state_unknown: "Состояние кампании неизвестно",
  waiting_for_restart_verify: "Ожидается проверка после перезапуска",
  running: "Выполняется цикл",
  queued: "Цикл в очереди",
  accounting_unavailable: "Учёт расходов недоступен",
  waiting_for_owner_chat: "Ожидается привязка чата владельца",
  budget_blocked: "Достигнут общий лимит расходов",
  waiting_for_idle: "Ожидается завершение активных задач",
  idle_ready: "Готово к следующему циклу",
};
const startWindowSeconds = 10;

export class EvolutionCampaign {
  readonly widget = column();
  private readonly summary = column(4);
  private readonly receipt = label("", "dim-label");
  private readonly start = button("Запустить кампанию…", () => this.ask());
  private readonly stop = button("Остановить кампанию", () => void this.send("/evolve off"));
  private snapshot?: CampaignState;
  private objectiveDialog?: any;
  private startUntil = 0;
  private startTimer = 0;
  private fresh = false;
  private busy = false;
  private disposed = false;

  constructor(private readonly parent: any, private readonly commands: RuntimeCommands,
    private readonly refresh: () => Promise<void>, private readonly openTask: (id: string) => void) {
    const controls = row();
    controls.append(this.start);
    controls.append(this.stop);
    this.widget.append(this.summary);
    this.widget.append(controls);
    this.widget.append(this.receipt);
    this.render();
  }

  observe(snapshot: CampaignState, readAt: number): void {
    if (this.disposed) return;
    if (!snapshot || typeof snapshot !== "object" || typeof snapshot.runtime_mode !== "string"
      || typeof snapshot.supervisor_ready !== "boolean"
      || snapshot.evolution_state !== undefined && (snapshot.evolution_state === null
        || typeof snapshot.evolution_state !== "object" || Array.isArray(snapshot.evolution_state))) {
      this.unavailable();
      return;
    }
    this.snapshot = snapshot;
    this.fresh = true;
    if (this.enabled() === true || this.startUntil && readAt >= this.startUntil) this.clearStart();
    this.render();
  }

  unavailable(): void {
    if (this.disposed) return;
    this.fresh = false;
    this.render();
  }

  close(): void {
    this.disposed = true;
    this.clearStart();
    if (this.objectiveDialog?.get_mapped()) this.objectiveDialog.force_close();
    this.objectiveDialog = undefined;
    this.render();
  }

  private enabled(): boolean | null | undefined {
    const current = this.snapshot?.evolution_state?.enabled;
    return current === undefined ? this.snapshot?.evolution_enabled : current;
  }

  private canStart(): boolean {
    return !this.disposed && this.fresh && !this.busy && !this.startUntil && typeof this.enabled() === "boolean"
      && this.snapshot?.supervisor_ready === true && ["advanced", "pro", "cyber_pro"].includes(this.snapshot.runtime_mode ?? "");
  }

  private render(): void {
    const snapshot = this.snapshot;
    const evolution = snapshot?.evolution_state;
    const campaign = evolution?.campaign;
    const enabled = this.enabled();
    const starting = Boolean(this.startUntil && enabled !== true);
    clear(this.summary);
    const status = evolution?.status;
    const state = status ? statusNames[status] ?? status
      : enabled === true ? "Кампания включена" : enabled === false ? "Кампания выключена" : "Состояние кампании неизвестно";
    this.summary.append(label(starting ? "Ожидается подтверждение запуска кампании" : state, "heading"));
    if (!this.fresh && snapshot) this.summary.append(label("Показано последнее состояние кампании.", "dim-label"));
    if (snapshot?.runtime_mode === "light") this.summary.append(label("Для запуска кампании нужен режим Advanced или Pro.", "dim-label"));
    const facts: [string, string | number | undefined][] = [
      ["Сведения шлюза", evolution?.detail], ["Цель", campaign?.objective ?? evolution?.objective],
      ["Ход кампании", campaign?.progress_notes], ["ID кампании", campaign?.id],
      ["Цикл", evolution?.cycle], ["Попыток", campaign?.cycles_done], ["Применено циклов", campaign?.absorbed_cycles_done],
      ["Сбоев подряд", evolution?.consecutive_failures], ["Последний цикл", evolution?.last_task_at],
      ["Чат владельца", evolution?.owner_chat_bound === true ? "привязан" : evolution?.owner_chat_bound === false ? "ожидается привязка" : undefined],
      ["Остаток общего бюджета", typeof evolution?.budget_remaining_usd === "number"
        ? (evolution.budget_remaining_usd < 0 ? "−" : "") + usd(Math.abs(evolution.budget_remaining_usd))
        : evolution?.cost_accounting_status === "unavailable" ? "учёт недоступен" : undefined],
      ["Коммит цикла", campaign?.active_transaction?.commit_sha],
    ];
    for (const [name, value] of facts) {
      if (value == null || value === "") continue;
      const fact = label(`${name} · ${value}`);
      fact.set_selectable(true);
      this.summary.append(fact);
    }
    for (const [name, id] of [["Задача в очереди", evolution?.queued_task_id], ["Текущая задача", evolution?.running_task_id]] as const) {
      if (id) this.summary.append(button(`${name} · ${id}`, () => { if (!this.disposed) this.openTask(id); }));
    }
    this.start.set_label(enabled === true ? "Изменить цель…" : "Запустить кампанию…");
    this.start.set_sensitive(this.canStart());
    this.stop.set_sensitive(Boolean(!this.disposed && snapshot && !this.busy && (enabled !== false || starting)));
  }

  private ask(): void {
    if (!this.canStart() || this.objectiveDialog) return;
    const running = this.enabled() === true;
    const campaignId = this.snapshot?.evolution_state?.campaign?.id;
    const dialog = this.objectiveDialog = new Adw.AlertDialog({
      heading: running ? "Изменить цель кампании?" : "Запустить кампанию саморазвития?",
      body: running ? "Кампания продолжится с новой целью." : "С пустым полем Ouroboros самостоятельно выберет цель кампании.",
    });
    const objective = new Gtk.Entry({ placeholder_text: "Цель кампании", hexpand: true });
    dialog.set_extra_child(objective);
    dialog.add_response("cancel", "Отмена");
    dialog.add_response("apply", running ? "Изменить цель" : "Запустить");
    dialog.set_close_response("cancel");
    dialog.set_response_appearance("apply", Adw.ResponseAppearance.SUGGESTED);
    if (running) {
      dialog.set_response_enabled("apply", false);
      objective.connect("changed", () => dialog.set_response_enabled("apply", Boolean(objective.get_text().trim())));
    }
    let closed = false, answered = false;
    dialog.connect("closed", () => {
      closed = true;
      if (this.objectiveDialog === dialog) this.objectiveDialog = undefined;
    });
    dialog.connect("response", (_dialog: unknown, response: string) => {
      if (closed || answered || this.disposed) return;
      answered = true;
      if (response !== "apply") return;
      const text = objective.get_text().trim();
      if (running && !text) return;
      if (!this.canStart() || running !== (this.enabled() === true)
        || running && campaignId !== this.snapshot?.evolution_state?.campaign?.id) {
        this.receipt.set_label("Состояние изменилось. Проверьте кампанию и повторите действие.");
        return;
      }
      void this.send(text ? `/evolve on ${text}` : "/evolve on");
    });
    dialog.present(this.parent);
  }

  private async send(command: string): Promise<void> {
    if (this.busy || this.disposed) return;
    const starting = command.startsWith("/evolve on") && this.enabled() !== true;
    this.busy = true;
    this.receipt.set_label("Передача команды…");
    this.render();
    const result = await this.commands.send(command);
    if (this.disposed) return;
    this.busy = false;
    this.receipt.set_label(result.message);
    if (starting && (result.accepted || result.uncertain) && this.enabled() !== true) {
      this.clearStart();
      this.startUntil = GLib.get_monotonic_time() + startWindowSeconds * 1_000_000;
      this.startTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, startWindowSeconds + 1, () => {
        this.startTimer = 0;
        void this.refresh();
        return GLib.SOURCE_REMOVE;
      });
    } else if (command === "/evolve off" && result.accepted) {
      this.clearStart();
    }
    this.render();
    void this.refresh();
  }

  private clearStart(): void {
    this.startUntil = 0;
    if (this.startTimer) GLib.Source.remove(this.startTimer);
    this.startTimer = 0;
  }
}
