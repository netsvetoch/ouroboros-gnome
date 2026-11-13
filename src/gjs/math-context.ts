import { type MarkdownNode } from "./markdown-document.js";
import { mathRuns, type MathRun } from "./markdown-math.js";
import { renderMathSvg, type MathSvg, type MathMacros } from "./math-svg.js";

type Prepared = { shape: MathSvg; error?: undefined } | { shape?: undefined; error: string };
type FormulaRun = Extract<MathRun, { kind: "math" }>;

/** Parse in document order once. Lazy tables/blocks must not replay definitions. */
export class MathContext {
  private readonly prepared = new WeakMap<MarkdownNode, Map<number, Prepared>>();
  constructor(nodes: MarkdownNode[]) {
    const macros: MathMacros = {};
    for (const run of mathRuns(nodes)) {
      if (run.kind !== "math") continue;
      const values = this.prepared.get(run.owner) ?? new Map<number, Prepared>();
      this.prepared.set(run.owner, values);
      try { values.set(run.offset, { shape: renderMathSvg(run.source, run.display, 16, "#242424", macros) }); }
      catch (error) { values.set(run.offset, { error: error instanceof Error ? error.message : String(error) }); }
    }
  }
  formula(run: FormulaRun): MathSvg {
    const value = this.prepared.get(run.owner)?.get(run.offset);
    if (!value) throw new Error("Формула отсутствует в подготовленном документе.");
    if (value.error !== undefined) throw new Error(value.error);
    return value.shape;
  }
}
