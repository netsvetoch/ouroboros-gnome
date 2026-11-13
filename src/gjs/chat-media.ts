import { chatAssetPath as assetPath } from "./chat-asset-path.js";
import { type DownloadIdentity, type Gateway, type GatewayFrame } from "./gateway.js";
import { frameChatId } from "./chat-room.js";
import { Gdk, Gio, GLib, Gtk } from "./gi.js";
import { type Present } from "./mcp-server.js";
import { pdfPreview } from "./pdf-preview.js";
import { button, chooseFile, column, errorText, label, row, sheet } from "./ui.js";

type Kind = "image" | "video" | "audio" | "file";
export interface ChatAttachment {
  name?: string; label?: string; kind?: Kind; mime?: string; size?: number | null; available?: boolean; url?: string;
}
export interface MediaRow {
  source?: string;
  sender_label?: string;
  initiator?: string;
  presence_contact?: unknown;
  relay?: unknown;
  reply_to?: unknown;
  chat_id?: number;
  row_address?: string;
  role?: string;
  text?: string;
  ts?: string;
  task_id?: string;
  msg_type?: string;
  title?: string;
  caption?: string;
  mime?: string;
  size_bytes?: number;
  filename?: string;
  download_url?: string;
  download_url_compat?: string;
  attachments?: ChatAttachment[];
  actions?: { label?: string; url?: string }[];
  text_placeholder?: boolean;
}
interface Delivery { row: MediaRow; data?: string; observed?: boolean; ambiguous?: boolean }
interface Asset { name: string; kind: Kind; mime?: string; size?: number | null; path?: string; resolve?: (cancel: any) => Promise<string>; data?: string; identity?: DownloadIdentity; formatName?: string }

const imageLimit = 16 * 1024 * 1024;
const textLimit = 256 * 1024;
const inlineLimit = 4 * Math.ceil(50 * 1024 * 1024 / 3);
const deliveryTypes = new Set(["photo", "video", "document", "links"]);
const names: Record<Kind, string> = { image: "Изображение", video: "Видео", audio: "Аудио", file: "Файл" };


function external(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^https?:\/\//iu.test(value) || /[\\\s\x00-\x1f\x7f]/u.test(value)) return undefined;
  try {
    const url = GLib.Uri.parse(value, GLib.UriFlags.NONE);
    if (url.get_host() && !url.get_userinfo()) return value;
  } catch { /* The host omitted a usable HTTP address. */ }
  return undefined;
}

function filename(value?: string): string {
  const name = value?.split(/[\\/]/u).pop()?.replace(/[\x00-\x1f\x7f]/gu, "_");
  return name && name !== "." && name !== ".." ? name : "attachment";
}

function inlineBytes(value: string, limit?: number): Uint8Array {
  if (!value) return new Uint8Array();
  if (limit !== undefined && value.length > 4 * Math.ceil(limit / 3)) {
    throw new Error(`Для просмотра файл должен быть не больше ${GLib.format_size(limit)}.`);
  }
  if (value.length > inlineLimit || value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new Error("Шлюз передал некорректные данные вложения.");
  }
  return GLib.base64_decode(value);
}

function isPdf(asset: Asset): boolean {
  return asset.kind === "file" && (/^application\/(?:x-)?pdf(?:\s*;|$)/iu.test(asset.mime ?? "") || /\.pdf$/iu.test(asset.formatName ?? asset.name));
}

function sameDelivery(a: MediaRow, b: MediaRow): boolean {
  if (a.row_address && b.row_address) return a.row_address === b.row_address;
  if (a.chat_id !== undefined && b.chat_id !== undefined && a.chat_id !== b.chat_id) return false;
  return Boolean(a.ts && b.ts && a.ts === b.ts && (a.task_id ?? "") === (b.task_id ?? "") && a.msg_type === b.msg_type);
}

export function mediaCaption(message: MediaRow): string {
  if (message.text_placeholder === true && message.attachments?.length) return "";
  if (message.msg_type === "links" && message.title && message.title === message.text) return "";
  if (message.msg_type && deliveryTypes.has(message.msg_type) && message.caption !== undefined) return message.caption;
  return message.text || message.caption || "";
}

export class LiveChatMedia {
  private frames: Delivery[] = [];
  version = 0;

  clear(): void { this.frames = []; this.version++; }

  frame(frame: GatewayFrame): boolean {
    if (!deliveryTypes.has(frame.type) || typeof frame.ts !== "string" || !frame.ts) return false;
    const type = frame.type;
    const text = (field: string) => typeof frame[field] === "string" ? frame[field] as string : undefined;
    const row: MediaRow = { msg_type: type, chat_id: frameChatId(frame),
      source: text("source"), sender_label: text("sender_label"), initiator: text("initiator"), presence_contact: frame.presence_contact, relay: frame.relay, reply_to: frame.reply_to,
      row_address: text("row_address"), task_id: text("task_id"), ts: frame.ts,
      role: frame.role === "user" ? "user" : "assistant", text: text("content"), caption: text("caption"), filename: text("filename"),
      title: text("title"), mime: text("mime"), size_bytes: typeof frame.size_bytes === "number" ? frame.size_bytes : undefined,
      download_url: text("download_url"), download_url_compat: text("download_url_compat"),
      actions: Array.isArray(frame.actions) ? frame.actions : undefined };
    const raw = !row.download_url && !row.download_url_compat
      ? text(type === "photo" ? "image_base64" : type === "video" ? "video_base64" : "file_base64") : undefined;
    const data = raw !== undefined && raw.length <= inlineLimit && (raw || type === "document" && row.size_bytes === 0) ? raw : undefined;
    const prior = this.frames.find((item) => sameDelivery(item.row, row));
    row.row_address ??= prior?.row.row_address;
    this.frames = this.frames.filter((item) => !sameDelivery(item.row, row));
    this.frames.push({ row, data, observed: prior?.observed, ambiguous: prior?.ambiguous });
    let held = this.frames.reduce((sum, item) => sum + (item.data?.length ?? 0), 0);
    while (this.frames.length > 32 || held > inlineLimit) held -= this.frames.shift()?.data?.length ?? 0;
    this.version++;
    return true;
  }

  extra(stored: MediaRow[]): MediaRow[] {
    for (const item of this.frames) {
      const matches = stored.filter((message) => sameDelivery(message, item.row));
      if (!matches.length) continue;
      item.observed = true;
      item.ambiguous = matches.length > 1;
      if (!item.ambiguous && !item.row.row_address && matches[0].row_address) item.row.row_address = matches[0].row_address;
    }
    return this.frames.filter((item) => !item.observed).map(({ row }) => row);
  }

  dataFor(row: MediaRow): string | undefined {
    return row.download_url || row.download_url_compat ? undefined : this.frames.find((item) => !item.ambiguous && sameDelivery(item.row, row))?.data;
  }
}

export class ChatMedia {
  private readonly dialogs = new Set<any>();

  constructor(private readonly gateway: Gateway, private readonly present: Present = (dialog, parent) => dialog.present(parent)) {}

  close(): void { for (const dialog of [...this.dialogs].reverse()) dialog.force_close(); }

  append(parent: any, target: any, message: MediaRow, data?: string): void {
    if (message.msg_type === "links") {
      const links = column(4);
      for (const action of Array.isArray(message.actions) ? message.actions : []) {
        const uri = external(action?.url);
        const title = typeof action?.label === "string" ? action.label.trim() : "";
        if (uri && title) links.append(new Gtk.LinkButton({ label: title, uri, halign: Gtk.Align.START, tooltip_text: uri }));
      }
      if (message.title) links.prepend(label(message.title, "heading"));
      if (links.get_first_child()) target.append(links);
    }
    for (const view of Array.isArray(message.attachments) ? message.attachments : []) if (view) this.attachment(parent, target, view);
    const type = message.msg_type;
    if (type === "photo" || type === "video" || type === "document" || message.download_url || message.download_url_compat) {
      const kind: Kind = type === "photo" ? "image" : type === "video" ? "video" : message.mime?.startsWith("audio/") ? "audio" : "file";
      const path = assetPath(message.download_url) ?? (!message.download_url ? assetPath(message.download_url_compat) : undefined);
      const name = message.filename || (kind === "image" ? "image" : kind === "video" ? "video" : "document");
      this.asset(parent, target, { name, kind, mime: message.mime, size: message.size_bytes, path, data });
    }
  }

  attachment(parent: any, target: any, view: ChatAttachment): void {
    const kind = view.kind && Object.hasOwn(names, view.kind) ? view.kind : "file";
    const path = view.available === false ? undefined : assetPath(view.url);
    this.asset(parent, target, { name: view.name || view.label || "Вложение", kind, mime: view.mime, size: view.size, path });
  }

  openDownload(parent: any, route: string): void {
    const path = assetPath(route);
    if (!path) return;
    const query = path.slice(path.indexOf("?") + 1);
    const encoded = query.startsWith("path=") ? query.slice(5) : "";
    let name = "Файл";
    try { name = decodeURIComponent(encoded.replace(/\+/gu, " ")).split("/").pop() || name; } catch { /* Validated route still has a fallback label. */ }
    this.open(parent, { name, kind: "file", path });
  }

  /** Explicit retained material: caller supplies a canonical artifact route and recorded identity. */
  openVerifiedArtifact(parent: any, name: string, path: string | ((cancel: any) => Promise<string>), identity: DownloadIdentity, formatName = name): void {
    const kind: Kind = /\.(png|jpe?g|gif|webp|avif|bmp|tiff?)$/iu.test(formatName) ? "image"
      : /\.(mp4|webm|mkv|mov|ogv)$/iu.test(formatName) ? "video"
      : /\.(mp3|wav|ogg|oga|opus|flac|m4a|aac)$/iu.test(formatName) ? "audio" : "file";
    this.open(parent, { name, ...(typeof path === "string" ? { path } : { resolve: path }), kind, size: identity.size, identity, formatName });
  }

  private async readPreview(asset: Asset, limit: number, cancel: any): Promise<Uint8Array> {
    const path = asset.resolve ? await asset.resolve(cancel) : asset.path;
    const bytes = path ? await this.gateway.previewBytes(path, limit, cancel) : inlineBytes(asset.data!, limit);
    if (asset.identity && (bytes.length !== asset.identity.size
      || GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, bytes) !== asset.identity.sha256)) {
      throw new Error("Размер или контрольная сумма сохранённого материала не совпали.");
    }
    return bytes;
  }

  private asset(parent: any, target: any, asset: Asset): void {
    if (!asset.path && asset.data === undefined) {
      target.append(label(`${asset.name} · файл недоступен`, "dim-label"));
      return;
    }
    const item = column(4);
    item.append(label([asset.name, names[asset.kind], asset.mime,
      typeof asset.size === "number" && asset.size >= 0 ? GLib.format_size(asset.size) : ""].filter(Boolean).join(" · "), "dim-label"));
    const actions = row();
    actions.append(button(asset.kind === "image" ? "Посмотреть изображение…" : asset.kind === "video" ? "Воспроизвести видео…"
      : asset.kind === "audio" ? "Воспроизвести аудио…" : isPdf(asset) ? "Посмотреть PDF…" : "Открыть файл…", () => this.open(parent, asset)));
    item.append(actions);
    target.append(item);
  }

  private open(parent: any, asset: Asset): void {
    const content = column();
    const dialog = sheet(asset.name, content);
    const pdf = isPdf(asset);
    if (pdf) {
      dialog.set_content_width(760);
      dialog.set_content_height(650);
    }
    const cancel = new Gio.Cancellable();
    const status = label("", "dim-label");
    const view = column();
    let opened = true;
    let file: any;
    let stream: any;
    this.dialogs.add(dialog);
    const remove = (temporary: any) => { try { temporary?.delete(null); } catch { /* Temporary file already gone. */ } };
    dialog.connect("closed", () => {
      opened = false;
      cancel.cancel();
      stream?.pause();
      stream?.clear();
      remove(file);
      this.dialogs.delete(dialog);
    });
    const save = button("Скачать файл…", () => {
      if (!opened) return;
      save.set_sensitive(false);
      void (async () => {
        const destination = await chooseFile(dialog, filename(asset.name), cancel);
        if (!destination || !opened) return;
        await this.save(asset, destination, cancel);
        if (opened) status.set_label("Файл сохранён.");
      })().catch((error) => { if (opened) status.set_label(errorText(error)); })
        .finally(() => { if (opened) save.set_sensitive(true); });
    });
    content.append(save);
    content.append(status);
    content.append(view);
    this.present(dialog, parent);
    const load = async () => {
      const textual = /^(?:text\/(?:plain|markdown|csv|tab-separated-values)|application\/(?:json|xml))(?:;|$)/iu.test(asset.mime ?? "")
        || /\.(?:txt|md|csv|tsv|log|json|jsonl|patch|diff|xml|html|css|js|ts|py|yaml|yml|toml)$/iu.test(asset.formatName ?? asset.name);
      if (asset.kind === "file" && !textual) { status.set_label("Файл доступен для скачивания."); return; }
      status.set_label("Загружаю для просмотра…");
      if (asset.kind === "video" || asset.kind === "audio") {
        const [temporary, handle] = Gio.File.new_tmp("ouroboros-chat-media-XXXXXX");
        handle.close(null);
        try {
          await this.save(asset, temporary, cancel);
          if (!opened) return;
          stream = Gtk.MediaFile.new_for_file(temporary);
          file = temporary;
          stream.connect("notify::error", () => {
            if (opened && stream.get_error()) status.set_label(errorText(stream.get_error()));
          });
          view.append(asset.kind === "video" ? new Gtk.Video({ media_stream: stream, height_request: 300 })
            : new Gtk.MediaControls({ media_stream: stream }));
          status.set_label(stream.get_error() ? errorText(stream.get_error()) : "");
        } finally { if (file !== temporary) remove(temporary); }
        return;
      }
      const limit = asset.kind === "image" ? imageLimit : textLimit;
      if (typeof asset.size === "number" && asset.size > limit) throw new Error(`Для просмотра файл должен быть не больше ${GLib.format_size(limit)}.`);
      const bytes = await this.readPreview(asset, limit, cancel);
      if (!opened) return;
      if (bytes.length > limit) throw new Error(`Для просмотра файл должен быть не больше ${GLib.format_size(limit)}.`);
      if (asset.kind === "image") {
        const texture = Gdk.Texture.new_from_bytes(GLib.Bytes.new(bytes));
        view.append(new Gtk.Picture({ paintable: texture, can_shrink: true, alternative_text: asset.name,
          height_request: Math.min(440, texture.get_height()) }));
      } else {
        const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (value.includes("\0")) throw new Error("Файл не удалось прочитать как текст UTF-8.");
        const text = new Gtk.TextView({ editable: false, monospace: true, wrap_mode: Gtk.WrapMode.NONE });
        text.get_buffer().set_text(value, -1);
        view.append(new Gtk.ScrolledWindow({ child: text, min_content_height: 150, max_content_height: 420,
          propagate_natural_height: true }));
      }
      status.set_label("");
    };
    const start = async () => {
      if (asset.resolve) {
        save.set_sensitive(false);status.set_label("Проверяю адрес материала…");
        try { await asset.resolve(cancel); } finally { if (opened) save.set_sensitive(true); }
      }
      if (!opened) return;
      if (pdf) { view.append(pdfPreview(asset.name, asset.size, (limit) => this.readPreview(asset, limit, cancel), cancel));return; }
      await load();
    };
    void start().catch((error) => { if (opened) status.set_label(errorText(error)); });
  }

  private async save(asset: Asset, destination: any, cancel: any): Promise<void> {
    const path = asset.resolve ? await asset.resolve(cancel) : asset.path;
    if (path) return this.gateway.download(path, destination, true, cancel, asset.identity);
    const bytes = GLib.Bytes.new(inlineBytes(asset.data!));
    await new Promise<void>((resolve, reject) => {
      destination.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, cancel,
        (_file: unknown, result: unknown) => {
          try { destination.replace_contents_finish(result); resolve(); } catch (error) { reject(error); }
        });
    });
  }
}
