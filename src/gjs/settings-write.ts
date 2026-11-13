import { HttpError } from "./gateway.js";
import { errorText } from "./ui.js";

export type SettingsDocument = Record<string, unknown>;

export const ownerHeaders = { "X-Ouroboros-Surface": "app", "X-Ouroboros-Actor": "owner" };

export function object(value: unknown): SettingsDocument {
  return value && typeof value === "object" && !Array.isArray(value) ? value as SettingsDocument : {};
}

export function unsaved(error: unknown): boolean {
  return error instanceof HttpError && object(error.body).saved === false;
}

export function settingsFailure(error: unknown): string {
  const saved = error instanceof HttpError ? object(error.body).saved : undefined;
  const detail = errorText(error);
  return saved === false ? `Параметры не записаны. ${detail}`
    : saved === true ? `Параметры записаны. Последующий шаг завершился ошибкой. ${detail}`
      : `Результат записи неизвестен. ${detail}`;
}
