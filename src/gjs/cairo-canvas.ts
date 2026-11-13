import { Gdk, Pango, canvasGraphics } from "./gi.js";

const initial = () => ({ fillStyle: "#000", strokeStyle: "#000", globalAlpha: 1, lineWidth: 1, lineCap: "butt",
  lineJoin: "miter", miterLimit: 10, lineDashOffset: 0, dash: [] as number[], font: "10px Sans", textAlign: "start",
  textBaseline: "alphabetic", direction: "ltr", globalCompositeOperation: "source-over" });

/** Canvas 2D drawing backed by an owned Cairo surface, never a DOM or browser. */
export class CairoCanvas {
  private w: number;
  private h: number;
  readonly context: CairoCanvasContext;
  readonly style: any = {
    getPropertyValue(name: string) { return this[name] ?? ""; },
    getPropertyPriority() { return ""; },
    setProperty(name: string, value: unknown) { this[name] = value; },
    removeProperty(name: string) { delete this[name]; },
  };
  constructor(width = 600, height = 320) {
    this.w = width; this.h = height;
    this.context = new CairoCanvasContext(this);
  }
  get width(): number { return this.w; }
  set width(value: number) { this.w = Math.max(1, Math.ceil(value)); this.context.reset(); }
  get height(): number { return this.h; }
  set height(value: number) { this.h = Math.max(1, Math.ceil(value)); this.context.reset(); }
  getContext(kind: string): any { return kind === "2d" ? this.context : null; }
  getAttribute(name: string): string | null { return name === "width" ? String(this.w) : name === "height" ? String(this.h) : null; }
  setAttribute(name: string, value: string): void { if (name === "width") this.width = Number(value); if (name === "height") this.height = Number(value); }
  dispose(): void { this.context.dispose(); }
}

export class CairoCanvasContext {
  private readonly graphics = canvasGraphics();
  private state: any = initial();
  private stack: any[] = [];
  private cr: any;
  surface: any;
  private readonly metrics = new Map<string, any>();
  constructor(readonly canvas: CairoCanvas) { this.reset(); }
  reset(): void {
    this.dispose();
    this.surface = new this.graphics.Cairo.ImageSurface(this.graphics.Cairo.Format.ARGB32, this.canvas.width, this.canvas.height);
    this.cr = new this.graphics.Cairo.Context(this.surface);
    this.state = initial(); this.stack = []; this.metrics.clear();
  }
  dispose(): void { this.cr?.$dispose(); this.cr = undefined; this.surface?.finish(); this.surface = undefined; }
  save(): void { this.stack.push({ ...this.state, dash: [...this.state.dash] }); this.cr.save(); }
  restore(): void { if (this.stack.length) { this.state = this.stack.pop(); this.cr.restore(); } }
  beginPath(): void { this.cr.newPath(); }
  closePath(): void { this.cr.closePath(); }
  moveTo(x: number, y: number): void { this.cr.moveTo(x, y); }
  lineTo(x: number, y: number): void { this.cr.lineTo(x, y); }
  bezierCurveTo(a: number, b: number, c: number, d: number, e: number, f: number): void { this.cr.curveTo(a, b, c, d, e, f); }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    const [ox, oy] = this.cr.hasCurrentPoint() ? this.cr.getCurrentPoint() : [cx, cy];
    this.cr.curveTo(ox + (cx - ox) * 2 / 3, oy + (cy - oy) * 2 / 3, x + (cx - x) * 2 / 3, y + (cy - y) * 2 / 3, x, y);
  }
  rect(x: number, y: number, w: number, h: number): void { this.cr.rectangle(x, y, w, h); }
  arc(x: number, y: number, radius: number, start: number, end: number, counterclockwise = false): void {
    (counterclockwise ? this.cr.arcNegative : this.cr.arc).call(this.cr, x, y, radius, start, end);
  }
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, start: number, end: number, ccw = false): void {
    this.cr.save(); this.cr.translate(x, y); this.cr.rotate(rotation); this.cr.scale(rx || 1e-12, ry || 1e-12);
    this.arc(0, 0, 1, start, end, ccw); this.cr.restore();
  }
  private colour(value: unknown): void {
    const rgba = new Gdk.RGBA();
    if (!rgba.parse(typeof value === "string" ? value : "#000")) rgba.parse("#000");
    this.cr.setSourceRGBA(rgba.red, rgba.green, rgba.blue, rgba.alpha * this.state.globalAlpha);
  }
  private line(): void {
    const { Cairo } = this.graphics;
    this.cr.setLineWidth(this.state.lineWidth);
    this.cr.setLineCap(this.state.lineCap === "round" ? Cairo.LineCap.ROUND : this.state.lineCap === "square" ? Cairo.LineCap.SQUARE : Cairo.LineCap.BUTT);
    this.cr.setLineJoin(this.state.lineJoin === "round" ? Cairo.LineJoin.ROUND : this.state.lineJoin === "bevel" ? Cairo.LineJoin.BEVEL : Cairo.LineJoin.MITER);
    this.cr.setMiterLimit(this.state.miterLimit); this.cr.setDash(this.state.dash, this.state.lineDashOffset);
  }
  stroke(): void { this.colour(this.state.strokeStyle); this.line(); this.cr.strokePreserve(); }
  fill(rule = "nonzero"): void {
    this.colour(this.state.fillStyle);
    this.cr.setFillRule(rule === "evenodd" ? this.graphics.Cairo.FillRule.EVEN_ODD : this.graphics.Cairo.FillRule.WINDING);
    this.cr.fillPreserve();
  }
  clip(rule = "nonzero"): void {
    this.cr.setFillRule(rule === "evenodd" ? this.graphics.Cairo.FillRule.EVEN_ODD : this.graphics.Cairo.FillRule.WINDING);
    this.cr.clipPreserve();
  }
  private rectangleOp(x: number, y: number, w: number, h: number, action: () => void): void {
    const path = this.cr.copyPath(); this.cr.newPath(); this.rect(x, y, w, h); action(); this.cr.newPath(); this.cr.appendPath(path);
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    this.cr.save(); this.cr.setOperator(this.graphics.Cairo.Operator.CLEAR);
    this.rectangleOp(x, y, w, h, () => this.cr.fill()); this.cr.restore();
  }
  fillRect(x: number, y: number, w: number, h: number): void { this.rectangleOp(x, y, w, h, () => this.fill()); }
  strokeRect(x: number, y: number, w: number, h: number): void { this.rectangleOp(x, y, w, h, () => this.stroke()); }
  translate(x: number, y: number): void { this.cr.translate(x, y); }
  rotate(angle: number): void { this.cr.rotate(angle); }
  scale(x: number, y: number): void { this.cr.scale(x, y); }
  resetTransform(): void { this.cr.identityMatrix(); }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void { this.resetTransform(); this.transform(a, b, c, d, e, f); }
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.translate(e, f);
    if (b === 0 && c === 0) { this.scale(a, d); return; }
    // SVD expresses an affine linear transform using Cairo's GJS rotate/scale API.
    const theta = .5 * Math.atan2(2 * (a * c + b * d), a * a + b * b - c * c - d * d);
    const x = a * Math.cos(theta) + c * Math.sin(theta), y = b * Math.cos(theta) + d * Math.sin(theta);
    const sx = Math.hypot(x, y) || 1e-12;
    this.rotate(Math.atan2(y, x)); this.scale(sx, (a * d - b * c) / sx || 1e-12); this.rotate(-theta);
  }
  setLineDash(values: number[]): void {
    const dash = values.map(Number);
    if (dash.some(value => !Number.isFinite(value) || value < 0)) return;
    this.state.dash = dash.every(value => value === 0) ? [] : dash.length % 2 ? [...dash, ...dash] : dash;
  }
  getLineDash(): number[] { return [...this.state.dash]; }
  private layout(text: unknown): any {
    const { PangoCairo } = this.graphics;
    const layout = PangoCairo.create_layout(this.cr);
    const match = this.state.font.match(/([\d.]+)px\s+(.+)$/u);
    const description = new Pango.FontDescription();
    description.set_family((match?.[2] ?? "Sans").replace(/["']/gu, ""));
    description.set_absolute_size((Number(match?.[1]) || 10) * Pango.SCALE);
    if (/\b(?:bold|[6-9]00)\b/u.test(this.state.font)) description.set_weight(Pango.Weight.BOLD);
    if (/\b(?:italic|oblique)\b/u.test(this.state.font)) description.set_style(Pango.Style.ITALIC);
    layout.set_font_description(description); layout.set_text(String(text), -1);
    layout.get_context().set_base_dir(this.state.direction === "rtl" ? Pango.Direction.RTL : Pango.Direction.LTR);
    return layout;
  }
  measureText(text: unknown): any {
    const key = this.state.font + "\0" + String(text);
    let result = this.metrics.get(key);
    if (!result) {
      const layout = this.layout(text), [, logical] = layout.get_pixel_extents();
      const ascent = layout.get_baseline() / Pango.SCALE;
      result = { width: logical.width, actualBoundingBoxLeft: 0, actualBoundingBoxRight: logical.width,
        actualBoundingBoxAscent: ascent, actualBoundingBoxDescent: logical.height - ascent,
        fontBoundingBoxAscent: ascent, fontBoundingBoxDescent: logical.height - ascent };
      if (this.metrics.size > 2048) this.metrics.clear();
      this.metrics.set(key, result);
    }
    return result;
  }
  private text(text: unknown, x: number, y: number, maxWidth: number | undefined, stroke: boolean): void {
    const layout = this.layout(text), [, logical] = layout.get_pixel_extents();
    const path = this.cr.copyPath(); this.cr.newPath();
    let align = this.state.textAlign;
    if (align === "start") align = this.state.direction === "rtl" ? "right" : "left";
    if (align === "end") align = this.state.direction === "rtl" ? "left" : "right";
    const width = maxWidth && maxWidth < logical.width ? maxWidth : logical.width;
    if (align === "center") x -= width / 2; else if (align === "right") x -= width;
    const baseline = this.state.textBaseline;
    if (baseline === "middle") y -= logical.height / 2;
    else if (baseline === "bottom" || baseline === "ideographic") y -= logical.height;
    else if (baseline !== "top" && baseline !== "hanging") y -= layout.get_baseline() / Pango.SCALE;
    this.cr.save(); this.cr.translate(x, y);
    if (logical.width && width !== logical.width) this.cr.scale(width / logical.width, 1);
    this.colour(stroke ? this.state.strokeStyle : this.state.fillStyle); this.cr.moveTo(0, 0);
    if (stroke) { this.graphics.PangoCairo.layout_path(this.cr, layout); this.line(); this.cr.stroke(); }
    else this.graphics.PangoCairo.show_layout(this.cr, layout);
    this.cr.restore(); this.cr.newPath(); this.cr.appendPath(path);
  }
  fillText(text: unknown, x: number, y: number, maxWidth?: number): void { this.text(text, x, y, maxWidth, false); }
  strokeText(text: unknown, x: number, y: number, maxWidth?: number): void { this.text(text, x, y, maxWidth, true); }
}

for (const name of Object.keys(initial()).filter(name => name !== "dash")) Object.defineProperty(CairoCanvasContext.prototype, name, {
  get(this: any) { return this.state[name]; }, set(this: any, value: unknown) { this.state[name] = value; },
});
