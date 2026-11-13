import { Gio, GLib, Gtk, mediaPortal } from "./gi.js";

export type ShareKind = "screen" | "camera";
export interface PortalVideo {
  fd: number;
  node?: number;
  serial?: string;
  camera?: string;
  cameraScan?: () => PortalVideo;
  close: () => void;
}
export type PortalVideoOpen = (kind: ShareKind, cancel: any, stopped: () => void) => Promise<PortalVideo>;

function aborted(cancel: any): void {
  if (cancel.is_cancelled()) throw new Error("Запрос доступа отменён.");
}

function portalFailure(error: unknown, kind: ShareKind): unknown {
  const matches = (error as { matches?: (domain: unknown, code: number) => boolean } | null)?.matches;
  if (typeof matches === "function" && matches.call(error, Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED)) {
    return new Error(kind === "camera" ? "Запрос доступа к камере отменён." : "Выбор экрана или окна отменён.");
  }
  return error;
}

function media(fd: number, properties: Omit<PortalVideo, "fd" | "close">, finish: () => void): PortalVideo {
  if (!Number.isInteger(fd) || fd < 0) throw new Error("Портал не выдал соединение PipeWire.");
  let closed = false;
  return { fd, ...properties, close: () => {
    if (closed) return;
    closed = true;
    try { GLib.close(fd); } finally { finish(); }
  } };
}

export async function openPortalVideo(window: any, kind: ShareKind, cancel: any, stopped: () => void): Promise<PortalVideo> {
  aborted(cancel);
  const root = window instanceof Gtk.Window ? window : window?.get_root?.();
  if (!(root instanceof Gtk.Window)) throw new Error("Не удалось определить окно для запроса доступа.");
  const { Xdp, XdpGtk4 } = mediaPortal();
  const portal = Xdp.Portal.new();
  const parent = XdpGtk4.parent_new_gtk(root);
  if (kind === "camera") {
    if (!portal.is_camera_present()) throw new Error("Портал GNOME не обнаружил камеру.");
    await new Promise<void>((resolve, reject) => {
      portal.access_camera(parent, Xdp.CameraFlags.NONE, cancel, (_portal: unknown, result: unknown) => {
        try {
          if (!portal.access_camera_finish(result)) throw new Error("Портал не разрешил доступ к камере.");
          resolve();
        } catch (error) { reject(portalFailure(error, kind)); }
      });
    });
    aborted(cancel);
    const openRemote = () => media(portal.open_pipewire_remote_for_camera(), {}, () => {});
    return { ...openRemote(), cameraScan: openRemote };
  }

  const session = await new Promise<any>((resolve, reject) => {
    portal.create_screencast_session(Xdp.OutputType.MONITOR | Xdp.OutputType.WINDOW, Xdp.ScreencastFlags.NONE,
      Xdp.CursorMode.EMBEDDED, Xdp.PersistMode.NONE, null, cancel, (_portal: unknown, result: unknown) => {
        try { resolve(portal.create_screencast_session_finish(result)); }
        catch (error) { reject(error); }
      });
  }).catch((error) => { throw portalFailure(error, kind); });
  let closed = false;
  const signal = session.connect("closed", () => {
    closed = true;
    stopped();
  });
  const release = () => {
    session.disconnect(signal);
    if (!closed) session.close();
    closed = true;
  };
  try {
    aborted(cancel);
    await new Promise<void>((resolve, reject) => {
      session.start(parent, cancel, (_session: unknown, result: unknown) => {
        try {
          if (!session.start_finish(result)) throw new Error("Портал не разрешил демонстрацию.");
          resolve();
        } catch (error) { reject(error); }
      });
    });
    aborted(cancel);
    const streams = session.get_streams()?.recursiveUnpack();
    const entry = Array.isArray(streams) ? streams[0] : undefined;
    if (closed || !Array.isArray(entry) || !Number.isInteger(entry[0]) || entry[0] < 0 || entry[0] > 0xffff_ffff) {
      throw new Error("Портал не вернул выбранный экран или окно.");
    }
    const serial = entry[1]?.["pipewire-serial"];
    const hasSerial = typeof serial === "bigint" ? serial > 0n
      : typeof serial === "number" && Number.isSafeInteger(serial) && serial > 0;
    return media(session.open_pipewire_remote(), {
      node: entry[0], serial: hasSerial ? String(serial) : undefined,
    }, release);
  } catch (error) {
    release();
    throw portalFailure(error, kind);
  }
}
