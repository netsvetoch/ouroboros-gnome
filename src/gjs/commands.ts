import { commandAccepted, commandRefused } from "./command-receipt.js";
import { Gio, GLib } from "./gi.js";
import { type Gateway, HttpError } from "./gateway.js";
import { confirm, errorText } from "./ui.js";

interface CommandResult {
  accepted: boolean;
  message: string;
  uncertain?: boolean;
}

export function runtimeCommand(input: string): string | undefined {
  const command = input.trim();
  const [name, ...words] = command.split(/\s+/);
  const prefix = name.toLowerCase();
  if (prefix === "/panic" || prefix === "/review" || prefix === "/status" || prefix === "/restart") {
    return words.length && prefix !== "/panic" ? undefined : prefix + command.slice(name.length);
  }
  if (prefix === "/evolve" && (!words.length || words[0] === "on" || words[0] === "off" && words.length === 1)) {
    return prefix + command.slice(name.length);
  }
  if (prefix === "/bg" && (!words.length || words.length === 1 && ["start", "stop", "status"].includes(words[0]))) {
    return prefix + command.slice(name.length);
  }
  return undefined;
}

// Local cancellation stops waiting for callbacks/WS acknowledgements; it cannot undo dispatch.
function commandWait<T>(work: Promise<T>, cancel: any): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false, signal = 0;
    const finish = (ok: boolean, value: any) => {
      if (settled) return;
      settled = true;
      // Gio.Cancellable.disconnect may deadlock inside the cancellation callback.
      if (signal) GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        cancel.disconnect(signal); return GLib.SOURCE_REMOVE;
      });
      if (ok) resolve(value); else reject(value);
    };
    signal = cancel.connect(() => finish(false, new Error("Ожидание команды отменено.")));
    work.then(value => finish(true, value), error => finish(false, error));
  });
}

export class RuntimeCommands {
  private boot?: string;
  private panicSent = false;
  private disposed = false;
  private readonly sending = new Set<string>();
  private readonly pending = new Set<any>();

  constructor(private readonly parent: any, private readonly gateway: Gateway,
    private readonly requestPanic: () => Promise<boolean> | undefined) {}

  observeBoot(since?: string): void {
    if (!since) return;
    this.boot = since;
  }

  panicSocketOpened(): void { this.panicSent = false; }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cancel of this.pending) cancel.cancel();
  }

  canPanic(): boolean {
    return !this.disposed && !this.panicSent && !this.sending.has("/panic");
  }

  async send(cmd: string, beforeSend?: () => Promise<boolean>, context?: { replyTo?: string; cancel?: any }): Promise<CommandResult> {
    if (context?.cancel?.is_cancelled()) return { accepted: false, message: "" };
    const name = cmd.split(/\s+/, 1)[0];
    const panic = name === "/panic";
    if (this.disposed || this.sending.has(name) || panic && this.panicSent) {
      return { accepted: false, message: panic ? "Запрос аварийной остановки уже отправлен." : "Дождитесь ответа на предыдущую команду." };
    }
    this.sending.add(name);
    const boot = this.boot;
    const cancel = new Gio.Cancellable();
    this.pending.add(cancel);
    const callerSignal = context?.cancel?.connect(() => cancel.cancel());
    let sent = false;
    try {
      if (name === "/restart" && !await confirm(this.parent, "Перезапустить Ouroboros?",
        "Связь со шлюзом прервётся, пока он перезапускается.", "Перезапустить", cancel)) {
        return { accepted: false, message: "" };
      }
      if (cancel.is_cancelled()) return { accepted: false, message: "" };
      if (beforeSend && !await commandWait(beforeSend(), cancel)) return { accepted: false, message: "" };
      if (this.disposed || cancel.is_cancelled()) return { accepted: false, message: "" };
      if (panic) {
        const receipt = this.requestPanic();
        if (!receipt) return { accepted: false, message: "Аварийная остановка требует активного соединения со шлюзом. Проверьте Ouroboros на хосте." };
        this.panicSent = true;
        sent = true;
        return await commandWait(receipt, cancel) ? { accepted: true, message: "Шлюз принял аварийную остановку. Завершение процесса ещё не подтверждено." }
          : { accepted: false, uncertain: true, message: "Подтверждение аварийной остановки не получено. Проверьте Ouroboros на хосте." };
      }
      sent = true;
      const receipt = await this.gateway.json<unknown>("POST", "/api/command", {
        cmd, if_boot: boot, client_surface: { channel: "gnome" }, reply_to: context?.replyTo,
      }, undefined, false, cancel);
      if (cancel.is_cancelled()) throw new Error("Ожидание команды отменено.");
      if (commandAccepted(receipt)) {
        return { accepted: true, message: "Шлюз принял команду. Результат выполнения появится отдельно." };
      }
      return { accepted: false, uncertain: true, message: "Шлюз не подтвердил приём команды." };
    } catch (error) {
      if (!sent && cancel.is_cancelled()) return { accepted: false, message: "" };
      const refused = error instanceof HttpError && commandRefused(error.status, error.body);
      if (refused && error instanceof HttpError && error.reason === "boot_changed" && this.boot === boot) this.boot = undefined;
      return { accepted: false, message: refused ? `Команда отклонена. ${errorText(error)}`
        : `Результат команды неизвестен. ${errorText(error)}`,
      uncertain: !refused };
    } finally {
      this.sending.delete(name);
      this.pending.delete(cancel);
      if (callerSignal) GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        context!.cancel.disconnect(callerSignal); return GLib.SOURCE_REMOVE;
      });
    }
  }
}
