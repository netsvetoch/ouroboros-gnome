import { FieldURL } from "./vendor/field-url.js";

type Field = Record<string, unknown>;
export type ComponentFieldValue = string | number | boolean | null;

const types = new Set(["text", "number", "url", "email", "password", "textarea", "select", "checkbox"]);
const numeric = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

export function componentFieldType(value: unknown): string {
  const type = String(value || "text").toLowerCase();
  return types.has(type) ? type : "text";
}

export function componentFieldValue(type: unknown, value: string): string {
  return ["email", "url"].includes(componentFieldType(type))
    ? value.replace(/[\r\n]/gu, "").replace(/^[\t\f ]+|[\t\f ]+$/gu, "") : value;
}

function email(value: string): boolean {
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  const local = value.slice(0, at), domain = value.slice(at + 1);
  return /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+$/u.test(local)
    && domain.split(".").every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label));
}

interface Decimal { coefficient: bigint; exponent: number }

function decimal(value: unknown): Decimal | undefined {
  if (value == null) return undefined;
  const raw = String(value);
  const parsed = Number(raw);
  if (!numeric.test(raw) || !Number.isFinite(parsed)) return undefined;
  if (parsed === 0) return { coefficient: 0n, exponent: 0 };
  const [mantissa, power = "0"] = raw.toLowerCase().split("e");
  const unsigned = mantissa.replace(/^-/, "");
  const point = unsigned.indexOf(".");
  let exponent = Number(power) - (point < 0 ? 0 : unsigned.length - point - 1);
  let digits = unsigned.replace(".", "").replace(/^0+/u, "");
  const trailing = /0+$/u.exec(digits)?.[0].length ?? 0;
  if (trailing) { digits = digits.slice(0, -trailing); exponent += trailing; }
  return { coefficient: BigInt((raw.startsWith("-") ? "-" : "") + digits), exponent };
}

function aligned(values: Decimal[]): bigint[] {
  const exponent = Math.min(...values.map(value => value.exponent));
  return values.map(value => value.coefficient * 10n ** BigInt(value.exponent - exponent));
}

function compare(a: Decimal, b: Decimal): number {
  const [left, right] = aligned([a, b]);
  return left < right ? -1 : left > right ? 1 : 0;
}

function matchesStep(value: Decimal, base: Decimal, step: Decimal): boolean {
  const [current, origin, increment] = aligned([value, base, step]);
  const difference = current >= origin ? current - origin : origin - current;
  // The browser cannot distinguish a grid finer than its numeric precision.
  if (difference > increment * (1n << 53n)) return true;
  const remainder = difference % increment;
  const distance = remainder < increment - remainder ? remainder : increment - remainder;
  // Match WebKit's step tolerance, using decimal arithmetic before the comparison.
  return distance * (1n << 24n) <= increment;
}

export function componentFieldProblem(field: Field, value: ComponentFieldValue, maxLength: number): string | undefined {
  const title = String(field.label || field.name || "");
  if (field.disabled) return undefined;
  const type = componentFieldType(field.type);
  if (typeof value === "string") value = componentFieldValue(type, value);
  if (field.required && (value === "" || value === false || value === null)) return `Заполните поле «${title}».`;
  if (maxLength && typeof value === "string" && [...value].length > maxLength) return `В поле «${title}» больше ${maxLength} символов.`;
  if (type === "email" && value !== "" && !email(String(value))) return `Проверьте адрес электронной почты в поле «${title}».`;
  if (type === "url" && value !== "") {
    try { new FieldURL(String(value)); }
    catch { return `Укажите полный URL в поле «${title}».`; }
  }
  if (type !== "number" || value === "") return undefined;
  const parsed = decimal(value);
  if (parsed === undefined) return `Проверьте число в поле «${title}».`;
  const min = decimal(field.min), max = decimal(field.max);
  if (min !== undefined && compare(parsed, min) < 0 || max !== undefined && compare(parsed, max) > 0) return `Проверьте диапазон числа в поле «${title}».`;
  const declaredStep = decimal(field.step);
  const step = declaredStep !== undefined && declaredStep.coefficient > 0n ? declaredStep : { coefficient: 1n, exponent: 0 };
  const initial = decimal(field.default);
  const base = min ?? initial ?? { coefficient: 0n, exponent: 0 };
  if (!matchesStep(parsed, base, step)) return `В поле «${title}» нужен шаг ${step === declaredStep ? field.step : 1} от ${min ? field.min : initial ? field.default : 0}.`;
  return undefined;
}
