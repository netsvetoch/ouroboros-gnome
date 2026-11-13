import { type Gateway, HttpError } from "./gateway.js";
import { object } from "./settings-write.js";
import { Gio } from "./gi.js";
import { errorText } from "./ui.js";

export interface GatewayHealth {
  status?: string;
  version?: string;
  runtime_version?: string;
  app_version?: string;
  abi_version?: string;
  inline_executors?: unknown;
  boot?: { phase?: string; since?: string; error?: string | null; dialogue_ready?: boolean; tasks_ready?: boolean; steps?: unknown; jobs?: unknown; supervisor_load?: unknown };
}

export function readGatewayHealth(raw: unknown): GatewayHealth {
  const health = object(raw);
  if (health.status !== "ok") throw new Error("Сервер не подтвердил состояние шлюза.");
  if ([health.version, health.runtime_version, health.app_version, health.abi_version]
    .some(value => value !== undefined && typeof value !== "string")) throw new Error("Сервер вернул неполные сведения о версии шлюза.");
  if (health.boot !== undefined) {
    const boot = object(health.boot);
    if (boot !== health.boot || [boot.phase, boot.since, boot.error].some(value => value != null && typeof value !== "string")
      || [boot.dialogue_ready, boot.tasks_ready].some(value => value !== undefined && typeof value !== "boolean")) {
      throw new Error("Сервер вернул неполные сведения о запуске шлюза.");
    }
  }
  return health as GatewayHealth;
}

export async function probeConnection(gateway: Gateway, cancel = new Gio.Cancellable()): Promise<string> {
  if (cancel.is_cancelled()) return "";
  const [health, state] = await Promise.allSettled([
    gateway.publicJson("/api/health", cancel).then(readGatewayHealth),
    gateway.json("GET", "/api/state", undefined, undefined, false, cancel).then((raw) => {
      const state = object(raw);
      if (typeof state.supervisor_ready !== "boolean" || state.error) throw new Error("Сервер не вернул состояние супервизора.");
      return state;
    }),
  ]);
  if (cancel.is_cancelled()) return "";
  const messages: string[] = [];
  if (health.status === "fulfilled") {
    const { runtime_version, version, abi_version, boot } = health.value;
    const runtime = runtime_version ?? version;
    messages.push(["Сервер шлюза отвечает", runtime, abi_version && `ABI ${abi_version}`].filter(Boolean).join(" · "));
    if (boot?.phase) messages.push(`Этап запуска · ${boot.phase}`);
    if (boot?.error) messages.push(`Ошибка запуска · ${boot.error}`);
  } else messages.push(`Проверка доступности · ${errorText(health.reason)}`);
  if (state.status === "fulfilled") {
    messages.push("Доступ к защищённому состоянию подтверждён.");
    messages.push(state.value.supervisor_ready ? "Супервизор готов." : "Супервизор ещё не готов.");
  } else if (state.reason instanceof HttpError && [401, 403].includes(state.reason.status)) {
    messages.push(`Шлюз отклонил доступ к защищённому состоянию · HTTP ${state.reason.status}`);
  } else messages.push(`Защищённое состояние · ${errorText(state.reason)}`);
  return messages.join("\n");
}
