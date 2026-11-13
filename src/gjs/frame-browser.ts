import { Gio, GLib, webKit } from "./gi.js";

const filters = new Map<string, Promise<any>>();

export interface FrameRule {
  trigger: { "url-filter": string };
  action: { type: string };
}

export function frameSecret(): string {
  const stream = Gio.File.new_for_path("/dev/urandom").read(null);
  try {
    const bytes = stream.read_bytes(32, null);
    if (bytes.get_size() !== 32) throw new Error("Не удалось создать ключ канала виджета.");
    return Array.from(bytes.get_data() as Uint8Array, (byte) => byte.toString(16).padStart(2, "0")).join("");
  } finally { stream.close(null); }
}

export function createFrameBrowser(options: { isolated?: boolean; permission?: (request: any) => void } = {}): { kit: any; manager: any; view: any } {
  const kit = webKit();
  const manager = new kit.UserContentManager();
  const view = new kit.WebView({ user_content_manager: manager, network_session: kit.NetworkSession.new_ephemeral(), hexpand: true,
    ...(options.isolated ? { web_context: new kit.WebContext() } : {}) });
  const settings = view.get_settings();
  settings.set_enable_developer_extras(false);
  settings.set_javascript_can_open_windows_automatically(false);
  settings.set_enable_media_stream(false);
  settings.set_enable_webrtc(false);
  view.connect("permission-request", (_view: unknown, permission: any) => {
    if (options.permission) { try { options.permission(permission); } catch { permission.deny(); } }
    else permission.deny();
    return true;
  });
  return { kit, manager, view };
}

export function compileFrameFilter(kit: any, rules: FrameRule[]): Promise<any> {
  const source = JSON.stringify(rules);
  const id = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, source, -1);
  const cached = filters.get(id);
  if (cached) return cached;
  const promise = new Promise<any>((resolve, reject) => {
    const path = GLib.build_filenamev([GLib.get_user_cache_dir(), "ouroboros-client", "widget-filters"]);
    if (GLib.mkdir_with_parents(path, 0o700) !== 0) { reject(new Error("Не удалось подготовить сетевую политику виджета.")); return; }
    const store = kit.UserContentFilterStore.new(path);
    store.save(id, GLib.Bytes.new(new TextEncoder().encode(source)), null, (_store: unknown, result: unknown) => {
      try { resolve(store.save_finish(result)); } catch (error) { reject(error); }
    });
  });
  filters.set(id, promise);
  void promise.catch(() => { if (filters.get(id) === promise) filters.delete(id); });
  return promise;
}

export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function frameHostDocument(program: string, config: object): string {
  return `<!doctype html><html><head><meta name="referrer" content="no-referrer"><style>html,body,iframe{width:100%;height:100%;margin:0;border:0;display:block}body{overflow:hidden}</style></head><body><script>${program}(${scriptJson(config)});</script></body></html>`;
}
