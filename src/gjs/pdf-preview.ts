import { bindChrome } from "./native-i18n.js";
import { Adw, Gdk, Gio, GLib, Gtk } from "./gi.js";
import { button, column, errorText, label, row } from "./ui.js";

class PdfSizeError extends Error { constructor(readonly limit: string) { super(`Для просмотра PDF должен быть не больше ${limit}.`); } }
const errors: Record<string, string> = {
  "Для чтения PDF нужен пароль.": "A password is required to read this PDF.",
  "Просмотр PDF закрыт.": "PDF preview is closed.",
  "Для предпросмотра PDF нужны утилиты Poppler.": "Poppler tools are required to preview PDF files.",
  "Подготовка страницы PDF заняла слишком много времени.": "Preparing the PDF page took too long.",
  "Poppler не смог прочитать PDF.": "Poppler could not read this PDF.",
  "Не удалось определить число страниц PDF.": "Could not determine the PDF page count.",
};
class PdfPasswordError extends Error { constructor() { super("Для чтения PDF нужен пароль."); } }

const maxPdf = 32 * 1024 * 1024;

async function runPoppler(args: string[], input: any, cancel: any): Promise<any> {
  if (cancel.is_cancelled()) throw new Error("Просмотр PDF закрыт.");
  const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDIN_PIPE
    | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE });
  launcher.setenv("LC_ALL", "C", true);
  const executable = GLib.find_program_in_path(args[0]);
  if (!executable) throw new Error("Для предпросмотра PDF нужны утилиты Poppler.");
  const process = launcher.spawnv([executable, ...args.slice(1)]);
  const signal = cancel.connect(() => process.force_exit());
  let communicated = false;
  let timedOut = false;
  let timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 12, () => {
    timer = 0;
    timedOut = true;
    process.force_exit();
    return GLib.SOURCE_REMOVE;
  });
  try {
    return await new Promise((resolve, reject) => {
      process.communicate_async(input, cancel, (_process: unknown, result: unknown) => {
        try {
          const [, output, diagnostics] = process.communicate_finish(result);
          communicated = true;
          if (timedOut) throw new Error("Подготовка страницы PDF заняла слишком много времени.");
          if (!process.get_successful()) {
            const message = new TextDecoder().decode(diagnostics.get_data());
            if (/incorrect password|password required|PASSWORD_REQUIRED/iu.test(message)) throw new PdfPasswordError();
            throw new Error("Poppler не смог прочитать PDF.");
          }
          resolve(output);
        } catch (error) { reject(error); }
      });
    });
  } finally {
    if (timer) GLib.Source.remove(timer);
    cancel.disconnect(signal);
    if (!communicated || cancel.is_cancelled()) process.force_exit();
    await new Promise<void>(resolve => process.wait_async(null, (_process: unknown, result: unknown) => {
      try { process.wait_finish(result); } finally { resolve(); }
    }));
  }
}

function protectedPdf(pdf: any, password: string, cancel: any, page?: number): Promise<any> {
  const worker = Gio.File.new_for_uri(import.meta.url).get_parent().get_child("pdf-render-worker.js").get_path();
  const input = GLib.Bytes.new(new TextEncoder().encode(JSON.stringify({ pdf: GLib.base64_encode(pdf.get_data()), password, page })));
  return runPoppler(["gjs", "-m", worker], input, cancel);
}

export function pdfPreview(name: string, size: number | null | undefined,
  read: (limit: number) => Uint8Array | Promise<Uint8Array>, cancel: any): any {
  const bindings = new Map<any, Map<string, () => void>>();
  function text(widget: any, property: string, source: string, fallback: string, params?: Record<string, string | number>): void {
    if (cancel.is_cancelled()) return;
    const properties = bindings.get(widget) ?? new Map<string, () => void>();
    properties.get(property)?.();
    widget.set_property(property, fallback);
    properties.set(property, bindChrome(widget, property, source, params));
    bindings.set(widget, properties);
  }
  function plain(widget: any, property: string, value: string): void {
    bindings.get(widget)?.get(property)?.(); bindings.get(widget)?.delete(property);
    widget.set_property(property, value);
  }
  function failure(error: unknown): void {
    if (error instanceof PdfSizeError) text(status, "label", "PDF files must be no larger than {limit} to preview.", error.message, { limit: error.limit });
    else { const value = errorText(error), source = errors[value];
      if (source) text(status, "label", source, value); else plain(status, "label", value); }
  }
  const content = column(6);
  const status = label("Загружаю PDF для просмотра…", "dim-label");
  const picture = new Gtk.Picture({ can_shrink: true });
  const viewport = new Gtk.ScrolledWindow({ child: picture, min_content_height: 390, max_content_height: 580,
    propagate_natural_height: true, visible: false });
  const navigation = row();
  const page = Gtk.SpinButton.new_with_range(1, 1, 1);
  page.set_numeric(true);
  page.set_width_chars(5);
  const caption = new Gtk.Label({ label: "_Страница", use_underline: true, mnemonic_widget: page });
  const total = label("");
  total.set_wrap(false);
  const previous = button("Назад", () => page.set_value(page.get_value_as_int() - 1));
  const next = button("Вперёд", () => page.set_value(page.get_value_as_int() + 1));
  const zoom = new Gtk.ToggleButton({ label: "Увеличить" });
  for (const widget of [previous, caption, page, total, next, zoom]) navigation.append(widget);
  navigation.set_visible(false);
  for (const widget of [navigation, status, viewport]) content.append(widget);
  zoom.connect("toggled", () => resizePage());
  const password = new Adw.PasswordEntryRow({ title: "Пароль PDF" });
  const credentials = column(6), passwordGroup = new Adw.PreferencesGroup();
  passwordGroup.add(password); credentials.append(passwordGroup);
  const unlockButton = button("Открыть PDF с паролем", () => void unlock());
  credentials.append(unlockButton); credentials.set_visible(false); content.prepend(credentials);
  let retainedPassword: string | undefined;
  let pdf: any;
  let pages = 0;
  let rendering = false;
  let loading = false;
  const reload = button("Перечитать PDF", () => void start());
  const retry = button("Повторить страницу", () => void renderPage());
  retry.set_visible(false);
  content.prepend(retry);
  content.prepend(reload);
  password.connect("changed", () => unlockButton.set_sensitive(!loading && !rendering && password.get_text().length > 0));
  for (const [widget, property, source, fallback] of [
    [status, "label", "Loading PDF preview…", "Загружаю PDF для просмотра…"],
    [caption, "label", "_Page", "_Страница"], [previous, "label", "Previous", "Назад"],
    [next, "label", "Next", "Вперёд"], [zoom, "label", "Zoom in", "Увеличить"],
    [password, "title", "PDF password", "Пароль PDF"],
    [unlockButton, "label", "Open PDF with password", "Открыть PDF с паролем"],
    [reload, "label", "Reload PDF", "Перечитать PDF"], [retry, "label", "Retry page", "Повторить страницу"],
  ] as [any, string, string, string][]) text(widget, property, source, fallback);
  cancel.connect(() => {
    for (const properties of bindings.values()) for (const release of properties.values()) release();
    bindings.clear();
    retainedPassword = undefined; password.set_text(""); pdf = undefined; picture.set_paintable(null); });

  function resizePage(): void {
    const large = zoom.get_active();
    picture.set_can_shrink(!large);
    const texture = picture.get_paintable();
    picture.set_size_request(-1, !large && texture ? Math.min(texture.get_height(), 580) : -1);
    text(zoom, "label", large ? "Fit page" : "Zoom in", large ? "Уместить" : "Увеличить");
  }

  async function renderPage(): Promise<void> {
    if (!pdf || rendering || cancel.is_cancelled()) return;
    const index = page.get_value_as_int();
    rendering = true;
    retry.set_visible(false);
    reload.set_sensitive(false);
    navigation.set_sensitive(false);
    picture.set_paintable(null);
    viewport.set_visible(false);
    viewport.get_hadjustment().set_value(0);
    viewport.get_vadjustment().set_value(0);
    status.set_visible(true);
    text(status, "label", "Preparing page {page}…", `Подготавливаю страницу ${index}…`, { page: index });
    try {
      const output = retainedPassword !== undefined ? await protectedPdf(pdf, retainedPassword, cancel, index) : await runPoppler(["pdftoppm", "-f", String(index), "-l", String(index), "-singlefile", "-cropbox",
        "-scale-to", "1600", "-png", "-"], pdf, cancel);
      if (cancel.is_cancelled()) return;
      const texture = Gdk.Texture.new_from_bytes(output);
      text(picture, "alternative-text", "{name} · page {page}", `${name} · страница ${index}`, { name, page: index });
      picture.set_paintable(texture);
      resizePage();
      viewport.set_visible(true);
      plain(status, "label", "");
      status.set_visible(false);
    } catch (error) {
      if (!cancel.is_cancelled()) { failure(error); retry.set_visible(true); }
    } finally {
      rendering = false;
      if (!cancel.is_cancelled()) {
        reload.set_sensitive(true);
        navigation.set_sensitive(true);
        previous.set_sensitive(index > 1);
        next.set_sensitive(index < pages);
        if (page.get_value_as_int() !== index) void renderPage();
      }
    }
  }

  function applyPages(count: number): void {
    pages = count;
    if (!Number.isSafeInteger(pages) || pages < 1) throw new Error("Не удалось определить число страниц PDF.");
    page.set_range(1, pages); text(total, "label", "of {pages}", `из ${pages}`, { pages }); navigation.set_visible(true);
  }

  async function unlock(): Promise<void> {
    if (!pdf || loading || rendering || cancel.is_cancelled() || !password.get_text()) return;
    const entered = password.get_text(); password.set_text("");
    loading = true; credentials.set_sensitive(false); unlockButton.set_sensitive(false); reload.set_sensitive(false);
    text(status, "label", "Opening password-protected PDF…", "Открываю защищённый PDF…");
    try {
      const information = await protectedPdf(pdf, entered, cancel);
      if (cancel.is_cancelled()) return;
      const count = JSON.parse(new TextDecoder().decode(information.get_data())).pages;
      retainedPassword = entered; applyPages(count); credentials.set_visible(false);
      await renderPage();
    } catch (error) {
      if (!cancel.is_cancelled()) {
        retainedPassword = undefined;
        if (error instanceof PdfPasswordError) text(status, "label", "Incorrect PDF password. Try again.", "Неверный пароль PDF. Попробуйте снова.");
        else failure(error);
      }
    } finally { loading = false; if (!cancel.is_cancelled()) { credentials.set_sensitive(true); unlockButton.set_sensitive(password.get_text().length > 0); reload.set_sensitive(true); } }
  }

  async function load(): Promise<void> {
    const tooLarge = () => new PdfSizeError(GLib.format_size(maxPdf));
    if (typeof size === "number" && size > maxPdf) throw tooLarge();
    const bytes = await read(maxPdf);
    if (cancel.is_cancelled()) return;
    if (bytes.length > maxPdf) throw tooLarge();
    pdf = GLib.Bytes.new(bytes);
    const information = await runPoppler(["pdfinfo", "-"], pdf, cancel);
    if (cancel.is_cancelled()) return;
    applyPages(Number(/^Pages:\s+(\d+)\s*$/m.exec(new TextDecoder().decode(information.get_data()))?.[1]));
    await renderPage();
  }

  page.connect("value-changed", () => void renderPage());
  async function start(): Promise<void> {
    if (loading || rendering || cancel.is_cancelled()) return;
    loading = true;
    retainedPassword = undefined; password.set_text(""); credentials.set_visible(false);
    reload.set_sensitive(false);
    pdf = undefined;
    navigation.set_visible(false);
    viewport.set_visible(false);
    picture.set_paintable(null);
    retry.set_visible(false);
    status.set_visible(true);
    text(status, "label", "Loading PDF preview…", "Загружаю PDF для просмотра…");
    try { await load(); }
    catch (error) { if (!cancel.is_cancelled()) {
      failure(error);
      if (error instanceof PdfPasswordError) { credentials.set_visible(true); unlockButton.set_sensitive(false); password.grab_focus(); }
    } }
    finally { loading = false; if (!cancel.is_cancelled()) reload.set_sensitive(true); }
  }
  void start();
  return content;
}
