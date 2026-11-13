import { Adw, Gtk } from "./gi.js";
import { button, label, row } from "./ui.js";
import { type HostContribution } from "./ui-contributions.js";
import { acquireCapture, type CaptureKind, type CaptureLease } from "./capture-lease.js";

interface Claim { lease: CaptureLease; kinds: Set<CaptureKind>; opened: boolean }

/** Browser capture stays native to WebKit, with visible GNOME consent and stop controls. */
export class HostMedia {
  readonly widget = row(6);
  private readonly status = label("");
  private readonly pending = new Map<any, { dialog: any; finish: (allow: boolean) => void }>();
  private readonly signals: number[] = [];
  private closed = false;
  private deviceInfoAllowed = false;
  private recognitionState?: "recording" | "processing";
  private readonly claims = new Map<string, Claim>();
  private readonly recognitionReservations = new Set<CaptureLease>();

  constructor(private readonly view: any, private readonly kit: any, private readonly item: HostContribution, private readonly gateway: string,
    private readonly changed: () => void, private readonly stopped: () => void, private readonly stopRecognition?: () => void) {
    this.widget.append(this.status);
    this.widget.append(button("Остановить захват", () => this.stop()));
    view.get_settings().set_enable_media_stream(true);
    view.get_settings().set_enable_webrtc(true);
    for (const name of ["microphone-capture-state", "camera-capture-state", "display-capture-state"]) {
      this.signals.push(view.connect("notify::" + name, () => this.update()));
    }
    this.widget.set_visible(false);
  }

  private update(): void {
    if (this.closed) return;
    this.releaseInactive();
    const kinds = [];
    if (this.recognitionState === "recording" || this.view.get_microphone_capture_state() !== this.kit.MediaCaptureState.NONE) kinds.push("микрофон");
    if (this.recognitionState === "processing") kinds.push("распознавание на устройстве");
    if (this.view.get_camera_capture_state() !== this.kit.MediaCaptureState.NONE) kinds.push("камера");
    if (this.view.get_display_capture_state() !== this.kit.MediaCaptureState.NONE) kinds.push("экран или окно");
    this.status.set_label(`${this.item.skill_label || this.item.skill}: ${kinds.join(", ")}`);
    this.widget.set_visible(kinds.length > 0);
    this.changed();
  }

  reserveRecognition(): CaptureLease {
    const owned = acquireCapture(this, `Диктовка (${this.item.label})`, ["audio"]);
    const lease: CaptureLease = { release: kinds => {
      owned.release(kinds);
      if (!kinds || kinds.includes("audio")) this.recognitionReservations.delete(lease);
    } };
    this.recognitionReservations.add(lease);
    return lease;
  }

  setRecognitionState(state?: "recording" | "processing"): void { this.recognitionState = state; this.update(); }

  control(op: string, text: string): object {
    if (this.closed) return { ok: false, message: "Модуль закрыт." };
    const value = JSON.parse(text), id = value?.id;
    if (typeof id !== "string" || !id || id.length > 128) throw new Error("Некорректный запрос захвата.");
    if (op === "media-acquire") {
      if (!Array.isArray(value.kinds) || value.kinds.length > 2 || value.kinds.some((k: unknown) => k !== "audio" && k !== "visual") || this.claims.has(id)) throw new Error("Некорректный запрос захвата.");
      try {
        const kinds = new Set<CaptureKind>(value.kinds);
        const lease = acquireCapture(this, `${this.item.skill_label || this.item.skill}: ${this.item.label}`, [...kinds]);
        this.claims.set(id, { lease, kinds, opened: false });
        return { ok: true };
      } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
    }
    const claim = this.claims.get(id);
    if (op === "media-opened") { if (claim) claim.opened = true; return { ok: !!claim }; }
    if (op === "media-release") {
      if (claim && !claim.opened) { claim.lease.release(); this.claims.delete(id); }
      this.releaseInactive();
      return { ok: true };
    }
    throw new Error("Неизвестный запрос захвата.");
  }

  private releaseInactive(): void {
    for (const [id, claim] of this.claims) {
      if (!claim.opened) continue;
      for (const kind of [...claim.kinds]) {
        const states = kind === "audio" ? [this.view.get_microphone_capture_state()]
          : [this.view.get_camera_capture_state(), this.view.get_display_capture_state()];
        if (states.some(state => state !== this.kit.MediaCaptureState.NONE)) continue;
        claim.lease.release([kind]); claim.kinds.delete(kind);
      }
      if (!claim.kinds.size) this.claims.delete(id);
    }
  }

  request(permission: any): void {
    const parent = this.view.get_root();
    if (this.closed || !(parent instanceof Gtk.Window)) { permission.deny(); return; }
    const info = permission instanceof this.kit.DeviceInfoPermissionRequest;
    if (info && this.deviceInfoAllowed) { permission.allow(); return; }
    if (!info && !(permission instanceof this.kit.UserMediaPermissionRequest)) { permission.deny(); return; }
    const display = !info && this.kit.user_media_permission_is_for_display_device(permission);
    const audio = !info && this.kit.user_media_permission_is_for_audio_device(permission);
    const video = !info && this.kit.user_media_permission_is_for_video_device(permission);
    if (!info && !audio && !video && !display) { permission.deny(); return; }
    const devices = info ? "список микрофонов и камер" : display ? audio ? "экран или окно со звуком" : "экран или окно"
      : audio && video ? "микрофон и камеру" : audio ? "микрофон" : "камеру";
    const dialog = new Adw.AlertDialog({ heading: info ? "Разрешить список устройств?" : `Разрешить ${devices}?`,
      body: `Навык «${this.item.skill_label || this.item.skill}» (${this.item.label}) на ${this.gateway} запрашивает ${devices}. Разрешение действует в текущем модуле. Захват можно остановить в чате.` });
    dialog.add_response("deny", "Не разрешать");
    dialog.add_response("allow", "Разрешить");
    dialog.set_close_response("deny"); dialog.set_default_response("deny");
    let done = false;
    const finish = (allow: boolean) => {
      if (done) return;
      done = true; this.pending.delete(permission);
      if (allow && !this.closed) { if (info) this.deviceInfoAllowed = true; permission.allow(); } else permission.deny();
    };
    this.pending.set(permission, { dialog, finish });
    dialog.connect("response", (_: unknown, response: string) => finish(response === "allow"));
    dialog.present(parent);
  }

  stop(): void {
    this.stopRecognition?.();
    for (const lease of this.recognitionReservations) lease.release();
    this.stopped();
    for (const { dialog, finish } of [...this.pending.values()]) { finish(false); if (dialog.get_mapped()) dialog.force_close(); }
    this.view.set_microphone_capture_state(this.kit.MediaCaptureState.NONE);
    this.view.set_camera_capture_state(this.kit.MediaCaptureState.NONE);
    this.view.set_display_capture_state(this.kit.MediaCaptureState.NONE);
    if (!this.closed) this.releaseInactive();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true; this.stop(); this.widget.set_visible(false);
    for (const signal of this.signals) this.view.disconnect(signal);
    this.signals.length = 0;
  }

  dispose(): void {
    this.close();
    for (const claim of this.claims.values()) claim.lease.release();
    this.claims.clear();
  }
}
