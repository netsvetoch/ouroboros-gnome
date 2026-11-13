import { GLib } from "./gi.js";

export function gatewayStatePath(base: string, name: string): string {
  const fingerprint = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, base, -1);
  return GLib.build_filenamev([GLib.get_user_state_dir(), "ouroboros-client", `${name}-${fingerprint}.json`]);
}

export function readGatewayState(path: string): unknown {
  const [, bytes] = GLib.file_get_contents(path);
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function writeGatewayState(path: string, value: unknown): void {
  if (GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700) !== 0) throw new Error("Не удалось создать каталог состояния клиента.");
  GLib.file_set_contents_full(path, JSON.stringify(value), GLib.FileSetContentsFlags.CONSISTENT | GLib.FileSetContentsFlags.DURABLE, 0o600);
}
