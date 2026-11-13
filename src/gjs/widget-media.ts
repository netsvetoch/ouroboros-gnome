import { type Gateway } from "./gateway.js";
import { Gdk, Gio, GLib, Gtk } from "./gi.js";
import { type SettingsDocument, object } from "./settings-write.js";
import { button, chooseFile, clear, column, errorText, label } from "./ui.js";
import { widgetMediaPath, widgetPath, widgetRoute, widgetText } from "./widget-contract.js";

interface MediaSource { path?: string; data?: string }

function sourceFor(skill: string, spec: SettingsDocument, value: unknown): MediaSource {
  if (spec.route || spec.api_route) return { path: widgetRoute(skill, spec.route || spec.api_route, object(spec.query)) };
  const raw = widgetText(spec.path ? widgetPath(value, spec.path) ?? spec.src : spec.src).trim();
  const match = /^data:(?:image\/(?:png|jpe?g|gif|webp)|(?:audio|video)\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(raw);
  if (match && match[1].length <= 16 * 1024 * 1024) return { data: match[1] };
  return { path: widgetMediaPath(skill, raw) };
}

export class WidgetMedia {
  readonly widget = column(4);
  private identity = "";
  private revision = 0;
  private file?: any;
  private stream?: any;
  private cancel?: any;

  constructor(private readonly gateway: Gateway | undefined, private readonly skill: string,
    private readonly spec: SettingsDocument) {
    this.widget.connect("unmap", () => this.pause());
  }

  setData(value: unknown): void {
    let source: MediaSource = {};
    const title = widgetText(this.spec.label ?? this.spec.alt, "Медиафайл");
    try { source = sourceFor(this.gateway ? this.skill : "", this.spec, value); }
    catch { /* An invalid extension path is an unavailable source. */ }
    const identity = source.path ?? source.data ?? "";
    if (identity === this.identity && this.widget.get_first_child()) return;
    this.identity = identity;
    this.release();
    clear(this.widget);
    const version = this.revision;
    const cancel = this.cancel = new Gio.Cancellable();
    const active = () => version === this.revision;
    if (!identity) { this.widget.append(label(`${title} · источник недоступен`, "dim-label")); return; }
    const type = this.spec.type;
    const status = label("", "dim-label");
    const read = () => source.path && this.gateway ? this.gateway.bytes(source.path, cancel) : Promise.resolve(GLib.Bytes.new(GLib.base64_decode(source.data)));
    if (type === "image") {
      status.set_label(title);
      this.widget.append(status);
      void read().then((bytes) => {
        if (!active()) return;
        if (bytes.get_size() > 16 * 1024 * 1024) throw new Error("Изображение слишком велико.");
        const texture = Gdk.Texture.new_from_bytes(bytes);
        const image = new Gtk.Picture({ paintable: texture, can_shrink: true, alternative_text: widgetText(this.spec.alt, title),
          height_request: Math.min(320, texture.get_height()) });
        this.widget.append(image);
      }).catch((error) => { if (active()) status.set_label(errorText(error)); });
      return;
    }
    const name = widgetText(this.spec.filename)
      || source.path?.split("?", 1)[0].split("/").pop()
      || (type === "audio" ? "audio" : type === "video" ? "video" : "download");
    const save = button(type === "file" ? title : "Скачать файл…", () => {
      save.set_sensitive(false);
      void (async () => {
        const destination = await chooseFile(this.widget.get_root(), name.replace(/[/\\\x00-\x1f]/g, "_"));
        if (!destination || !active()) return;
        if (source.path && this.gateway) await this.gateway.download(source.path, destination, true, cancel);
        else destination.replace_contents(GLib.base64_decode(source.data), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        if (active()) status.set_label("Файл сохранён.");
      })().catch((error) => { if (active()) status.set_label(errorText(error)); })
        .finally(() => { if (active()) save.set_sensitive(true); });
    });
    if (type === "audio" || type === "video") {
      const open = button(type === "audio" ? "Открыть аудио" : "Открыть видео", () => {
        open.set_sensitive(false);
        void (async () => {
          const [file, handle] = Gio.File.new_tmp("ouroboros-widget-XXXXXX");
          handle.close(null);
          try {
            if (source.path && this.gateway) await this.gateway.download(source.path, file, true, cancel);
            else file.replace_contents(GLib.base64_decode(source.data), null, false, Gio.FileCreateFlags.PRIVATE, null);
            if (!active()) return;
            const stream = Gtk.MediaFile.new_for_file(file);
            stream.connect("notify::error", () => {
              if (active() && stream.get_error()) status.set_label(errorText(stream.get_error()));
            });
            this.file = file;
            this.stream = stream;
            const player = type === "audio" ? new Gtk.MediaControls({ media_stream: stream })
              : new Gtk.Video({ media_stream: stream, height_request: 180 });
            this.widget.prepend(player);
            open.set_visible(false);
            status.set_label("");
          } finally {
            if (this.file !== file) file.delete(null);
          }
        })().catch((error) => { if (active()) status.set_label(errorText(error)); })
          .finally(() => { if (active()) open.set_sensitive(true); });
      });
      this.widget.append(label(title));
      this.widget.append(open);
    }
    this.widget.append(save);
    this.widget.append(status);
  }

  pause(): void { this.stream?.pause(); }

  release(): void {
    this.revision++;
    this.cancel?.cancel(); this.cancel = undefined;
    this.pause();
    this.stream?.clear();
    this.stream = undefined;
    try { this.file?.delete(null); } catch { /* The temporary file may have been removed already. */ }
    this.file = undefined;
  }
}
