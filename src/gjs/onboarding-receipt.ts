import { commandAccepted, commandRefused } from "./command-receipt.js";
import { type Gateway, HttpError } from "./gateway.js";
import { GLib } from "./gi.js";
import { object } from "./settings-write.js";
import { errorText } from "./ui.js";
import { readGatewayHealth } from "./connection-probe.js";

export const setupPath = "/api/onboarding";

export interface SetupReceipt {
  runtimeMode: string;
  restartRequired: boolean;
  preset: string;
  harnesses: string[];
}

export function setupReceipt(value: unknown): SetupReceipt | undefined {
  const reply = object(value);
  const preset = object(reply.preset);
  if (reply.ok !== true || reply.status !== "saved" || typeof reply.runtime_mode !== "string"
    || !reply.runtime_mode || typeof reply.restart_required !== "boolean" || typeof preset.applied !== "boolean"
    || typeof preset.reason !== "string" || !Array.isArray(preset.harnesses)
    || preset.harnesses.some((item) => typeof item !== "string") || !preset.receipt
    || typeof preset.receipt !== "object" || Array.isArray(preset.receipt)) return;
  return { runtimeMode: reply.runtime_mode, restartRequired: reply.restart_required,
    preset: preset.reason, harnesses: preset.harnesses };
}

export async function readSetupBoot(gateway: Gateway, cancel?: any): Promise<Record<string, unknown>> {
  return object(readGatewayHealth(await gateway.publicJson("/api/health", cancel)).boot);
}

function wait(): Promise<void> {
  return new Promise((resolve) => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => { resolve(); return GLib.SOURCE_REMOVE; });
  });
}

export async function startSetupConsciousness(
  gateway: Gateway, since: string, current: () => boolean, status: (message: string) => void, cancel?: any,
): Promise<void> {
  const active = () => current() && !cancel?.is_cancelled();
  if (!active()) return;
  if (!since) {
    status("Фоновая активность не запущена. Идентификатор запуска шлюза недоступен.");
    return;
  }
  status("Ожидаю готовности шлюза для запуска фоновой активности…");
  const readyBy = GLib.get_monotonic_time() + 120_000_000;
  try {
    while (active()) {
      const boot = await readSetupBoot(gateway, cancel);
      if (!active()) return;
      if (boot.since !== since || boot.phase === "failed" || GLib.get_monotonic_time() >= readyBy) {
        status("Фоновая активность не запущена. Запуск шлюза изменился или не достиг готовности.");
        return;
      }
      if (boot.dialogue_ready === true) break;
      await wait();
    }
  } catch (error) {
    if (active()) status(`Фоновая активность не запущена. ${errorText(error)}`);
    return;
  }
  if (!active()) return;
  try {
    const reply = await gateway.json<unknown>("POST", "/api/command", {
      cmd: "/bg start", if_boot: since, client_surface: { channel: "gnome" },
    }, undefined, false, cancel);
    if (!active()) return;
    if (!commandAccepted(reply)) {
      status("Шлюз не подтвердил приём команды фоновой активности.");
      return;
    }
  } catch (error) {
    if (active()) status(error instanceof HttpError && commandRefused(error.status, error.body)
      ? `Запуск фоновой активности отклонён. ${errorText(error)}`
      : `Итог запуска фоновой активности неизвестен. ${errorText(error)}`);
    return;
  }
  const confirmBy = GLib.get_monotonic_time() + 30_000_000;
  while (active() && GLib.get_monotonic_time() < confirmBy) {
    try {
      const state = await gateway.json<{ bg_consciousness_enabled?: boolean }>("GET", "/api/state", undefined, undefined, false, cancel);
      if (!active()) return;
      if (state?.bg_consciousness_enabled === true) {
        status("Фоновая активность включена.");
        return;
      }
    } catch {
      // The command was accepted. Keep reading state within the confirmation window.
    }
    if (active()) await wait();
  }
  if (active()) status("Команда принята. Включение фоновой активности пока не подтверждено.");
}
