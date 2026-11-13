// Password-protected documents are opened in this disposable process. Input is private stdin, never argv or a temporary PDF.
declare const imports: any;
declare function print(value: string): void;
declare function printerr(value: string): void;
const { GLib, Poppler } = imports.gi;
const Cairo = imports.cairo;
try {
  const [, raw] = GLib.file_get_contents("/proc/self/fd/0");
  const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  if (typeof request.pdf !== "string" || typeof request.password !== "string") throw new Error();
  const bytes = GLib.base64_decode(request.pdf);
  if (bytes.length > 32 * 1024 * 1024) throw new Error();
  const document = Poppler.Document.new_from_bytes(GLib.Bytes.new(bytes), request.password);
  request.password = "";
  if (request.page === undefined) print(JSON.stringify({ pages: document.get_n_pages() }));
  else {
    if (!Number.isSafeInteger(request.page) || request.page < 1 || request.page > document.get_n_pages()) throw new Error();
    const page = document.get_page(request.page - 1);
    const [w, h] = page.get_size();
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new Error();
    const scale = 1600 / Math.max(w, h);
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, Math.ceil(w * scale), Math.ceil(h * scale));
    const context = new Cairo.Context(surface);
    context.setSourceRGB(1, 1, 1); context.paint(); context.scale(scale, scale);
    page.render(context);
    surface.writeToPNG("/proc/self/fd/1");
    context.$dispose(); surface.finish();
  }
} catch (error: any) {
  printerr(error.matches?.(Poppler.error_quark(), Poppler.Error.ENCRYPTED) ? "PASSWORD_REQUIRED" : "PDF_RENDER_FAILED");
  imports.system.exit(1);
}
export {};
