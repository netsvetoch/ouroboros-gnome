import { Gdk, GLib, Soup, svgRenderer } from "./gi.js";
import { type Gateway } from "./gateway.js";
import { chatAssetPath } from "./chat-asset-path.js";
import { FieldURL } from "./vendor/field-url.js";

export type DiagramImageLoader = (source: string, cancel: any) => Promise<string>;
const limit = 16 * 1024 * 1024;

function address(source: string, base?: string): any {
  const parsed = new FieldURL(source, base);
  const uri = new FieldURL(parsed.href.split("#", 1)[0]);
  if (!["http:", "https:"].includes(uri.protocol) || !uri.hostname || uri.username || uri.password) throw new Error("Источник изображения должен быть HTTP/HTTPS без встроенных учётных данных.");
  return uri;
}

async function anonymousBytes(source: string, cancel: any): Promise<Uint8Array> {
  let uri = address(source);
  const session = new Soup.Session({ timeout: 20, user_agent: "OuroborosGNOME/0.6.0" });
  try {
    for (let redirect = 0; redirect <= 5; redirect++) {
      const message = Soup.Message.new("GET", uri.href); message.add_flags(Soup.MessageFlags.NO_REDIRECT);
      const stream = await new Promise<any>((resolve, reject) => session.send_async(message, GLib.PRIORITY_DEFAULT, cancel, (_session: unknown, result: unknown) => {
        try { resolve(session.send_finish(result)); } catch (error) { reject(error); }
      }));
      try {
        const status = message.get_status();
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = message.response_headers.get_one("Location");
          if (!location || redirect === 5) throw new Error("Не удалось разрешить перенаправление изображения.");
          uri = address(location, uri.href); continue;
        }
        if (status !== 200) throw new Error(`Изображение недоступно: HTTP ${status}.`);
        const length = Number(message.response_headers.get_one("Content-Length"));
        if (Number.isFinite(length) && length > limit) throw new Error("Изображение превышает 16 МиБ.");
        const chunks: Uint8Array[] = []; let size = 0;
        while (true) {
          const bytes = await new Promise<any>((resolve, reject) => stream.read_bytes_async(Math.min(64 * 1024, limit - size + 1), GLib.PRIORITY_DEFAULT, cancel, (_stream: unknown, result: unknown) => {
            try { resolve(stream.read_bytes_finish(result)); } catch (error) { reject(error); }
          }));
          const chunk: Uint8Array = bytes.get_data(); if (!chunk.length) break;
          size += chunk.length; if (size > limit) throw new Error("Изображение превышает 16 МиБ."); chunks.push(chunk);
        }
        const data = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
        return data;
      } finally { stream.close(null); }
    }
    throw new Error("Слишком много перенаправлений изображения.");
  } finally { session.abort(); }
}

function inlineBytes(source: string): Uint8Array {
  const match = /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml)(?:;charset=[\w-]+)?(;base64)?,([\s\S]*)$/iu.exec(source);
  if (!match || match[2].length > 4 * Math.ceil(limit / 3)) throw new Error("Неподдерживаемое встроенное изображение.");
  if (match[1]) {
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(match[2])) throw new Error("Некорректное base64-изображение.");
    return GLib.base64_decode(match[2]);
  }
  return new TextEncoder().encode(decodeURIComponent(match[2]));
}

/** Canonical PNG keeps the worker and exported SVG independent of remote URLs. */
export function diagramPng(bytes: Uint8Array): string {
  if (bytes.length > limit) throw new Error("Изображение превышает 16 МиБ.");
  let texture;
  const bounded = (width: number, height: number) => {
    if (![width, height].every(value => Number.isFinite(value) && value > 0 && value <= 16384) || width * height > 16 * 1024 * 1024) throw new Error("Размер изображения превышает предел отображения.");
  };
  const prefix = new TextDecoder().decode(bytes.slice(0, 2048));
  if (/^\s*</u.test(prefix) && /<svg(?:\s|>)/iu.test(prefix)) {
    const handle = svgRenderer().Handle.new_from_data(bytes);
    let [sized, width, height] = handle.get_intrinsic_size_in_pixels();
    if (!sized) { const [, , , , viewBox, box] = handle.get_intrinsic_dimensions(); width = viewBox ? box.width : 300; height = viewBox ? box.height : 150; }
    bounded(width, height);
    texture = Gdk.Texture.new_for_pixbuf(handle.get_pixbuf_and_error());
  } else texture = Gdk.Texture.new_from_bytes(GLib.Bytes.new(bytes));
  bounded(texture.get_width(), texture.get_height());
  const png = texture.save_to_png_bytes();
  if (png.get_size() > limit) throw new Error("Встроенное изображение превышает 16 МиБ.");
  return "data:image/png;base64," + GLib.base64_encode(png.get_data());
}

export function diagramImageLoader(gateway?: Gateway, base = gateway?.base): DiagramImageLoader {
  return async (source, cancel) => {
    let bytes: Uint8Array;
    if (/^data:/iu.test(source)) bytes = inlineBytes(source);
    else {
      const uri = address(source, base);
      const route = gateway && uri.origin === new FieldURL(gateway.base).origin ? chatAssetPath(uri.pathname + uri.search) : undefined;
      bytes = route ? await gateway!.previewBytes(route, limit, cancel) : await anonymousBytes(uri.href, cancel);
    }
    if (cancel.is_cancelled()) throw new Error("Загрузка изображения отменена.");
    return diagramPng(bytes);
  };
}
