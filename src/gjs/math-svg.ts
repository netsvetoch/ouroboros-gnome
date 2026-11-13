import { mathSvg } from "./vendor/math-engine.js";

export interface MathSvg { svg: string; width: number; height: number; baseline: number }
export type MathMacros = Record<string, unknown>;

export function renderMathSvg(source: string, display: boolean, em = 16, color = "#242424", macros: MathMacros = {}): MathSvg {
  if (source.length > 32768) throw new Error("Формула слишком велика для отображения.");
  const result = mathSvg(source, display, macros);
  const box = String(result.viewBox).trim().split(/\s+/u).map(Number);
  if (box.length !== 4 || !box.every(Number.isFinite) || box[2] < 0 || box[3] < 0) throw new Error("Не удалось определить размер формулы.");
  const scale = Math.max(8, Math.min(64, em)) / 1000;
  const width = Math.max(1, Math.ceil(box[2] * scale)), height = Math.max(1, Math.ceil(box[3] * scale));
  if (width > 16384 || height > 8192 || width * height > 16 * 1024 * 1024) throw new Error("Размер формулы превышает предел отображения.");
  // Font paths are embedded. No external resources or interactive SVG enter librsvg.
  if (/(?:\b(?:href|src)\s*=|url\s*\(|<(?:script|image|foreignObject|a)\b|<!)/iu.test(result.svg)) throw new Error("Формула содержит неподдерживаемые внешние ссылки.");
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/u.test(result.svg)) throw new Error("Формула содержит недопустимый символ.");
  const ink = /^#[\da-f]{6}$/iu.test(color) ? color : "#242424";
  const svg = result.svg.replace(/^<svg /u, `<svg color="${ink}" `).replace(/width="[^"]*"/u, `width="${width}"`).replace(/height="[^"]*"/u, `height="${height}"`);
  return { svg, width, height, baseline: Math.min(height, Math.max(0, Math.round(-box[1] * scale))) };
}
