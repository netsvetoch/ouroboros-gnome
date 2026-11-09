/**
 * Адрес gateway. Loopback по умолчанию — как у веба и CLI.
 * Не-loopback ходит только с OUROBOROS_NETWORK_PASSWORD (HMAC-кука сервера).
 */
export interface GatewayConfig {
  baseUrl: string; // http://127.0.0.1:8765
  wsUrl: string; // ws://127.0.0.1:8765/ws
  password?: string;
}

function trimSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

export function resolveConfig(): GatewayConfig {
  const base = trimSlash(
    process.env["OUROBOROS_URL"] ?? "http://127.0.0.1:8765",
  );
  const ws = base.replace(/^http/, "ws") + "/ws";
  const password = process.env["OUROBOROS_NETWORK_PASSWORD"] || undefined;
  return { baseUrl: base, wsUrl: ws, password };
}
