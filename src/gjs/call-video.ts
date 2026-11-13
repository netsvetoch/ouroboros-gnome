import { type PortalVideo, type PortalVideoOpen, type ShareKind, openPortalVideo } from "./call-portal.js";
import { acquireCapture, type CaptureLease } from "./capture-lease.js";
import { listCallCameras } from "./call-devices.js";
import { maxCallVideo } from "./call-wire.js";
import { Gio, GLib, gstreamer, mediaPortal } from "./gi.js";
import { errorText } from "./ui.js";

export interface CallVideoStatus {
  kind?: ShareKind;
  waiting: boolean;
  announced: boolean;
  error?: string;
  notice?: string;
}
export interface CallVideoHandlers {
  changed: (status: CallVideoStatus) => void;
  epoch: () => number | undefined;
  sendFrame: (bytes: Uint8Array, epoch: number) => boolean;
  share: (kind: ShareKind, sharing: boolean) => void;
}
interface CaptureRun {
  lease?: CaptureLease;
  kind: ShareKind;
  cancel: any;
  remote?: PortalVideo;
  encoder?: CallVideoEncoder;
  timer: number;
  opened: number;
  lastAt: number;
  lastHash?: string;
  lastEpoch?: number;
  announced: boolean;
  lastFrame: number;
  camera: string;
  notice?: string;
}

export function canShareVideo(): boolean {
  try {
    const gst = gstreamer();
    const { Xdp, XdpGtk4 } = mediaPortal();
    return Boolean(Xdp.Portal.prototype.access_camera && Xdp.Portal.prototype.create_screencast_session && XdpGtk4.parent_new_gtk
      && ["pipewiresrc", "decodebin", "videoconvert", "videorate", "videoscale", "jpegenc", "appsink"].every((name) => gst.ElementFactory.find(name)));
  } catch {
    return false;
  }
}

export class CallVideoEncoder {
  private readonly gst = gstreamer();
  private readonly pipeline: any;
  private readonly sink: any;
  private readonly jpeg: any;
  private readonly limit: any;
  private readonly side: number;
  private quality = 0;

  constructor(kind: ShareKind, remote: PortalVideo, source = "pipewiresrc name=video_capture keepalive-time=1000") {
    this.side = kind === "screen" ? 1280 : 768;
    this.pipeline = this.gst.parse_launch(`${source} ! capsfilter caps="video/x-raw;image/jpeg" ! decodebin !
      queue max-size-buffers=1 max-size-bytes=0 max-size-time=0 leaky=downstream ! videoconvert !
      videorate drop-only=true max-rate=2 ! videoscale add-borders=true ! capsfilter name=video_limit !
      jpegenc name=video_jpeg quality=68 ! appsink name=video_jpegs sync=false max-buffers=1 drop=true`);
    const capture = this.pipeline.get_by_name("video_capture");
    this.sink = this.pipeline.get_by_name("video_jpegs");
    this.jpeg = this.pipeline.get_by_name("video_jpeg");
    this.limit = this.pipeline.get_by_name("video_limit");
    if (remote.fd >= 0) {
      capture.set_property("fd", remote.fd);
      capture.set_property("client-name", "Ouroboros");
      const [props] = this.gst.Structure.from_string(`properties,media.type=(string)Video,media.category=(string)Capture,media.role=(string)${kind === "camera" ? "Camera" : "Screen"}`);
      capture.set_property("stream-properties", props);
      if (remote.camera || remote.serial) capture.set_property("target-object", remote.camera || remote.serial);
      else if (remote.node !== undefined) capture.set_property("path", String(remote.node));
    }
    this.setLimit(this.side);
    if (this.pipeline.set_state(this.gst.State.PLAYING) === this.gst.StateChangeReturn.FAILURE) {
      const error = this.busError();
      this.close();
      throw new Error(error || "Не удалось запустить захват видео.");
    }
  }

  frame(): Uint8Array | undefined {
    const error = this.busError();
    if (error) throw new Error(error);
    const sample = this.sink.try_pull_sample(0);
    if (!sample) return;
    const buffer = sample.get_buffer();
    const size = buffer.get_size();
    if (!size) return;
    if (size > maxCallVideo) {
      this.quality++;
      if (this.quality === 1) this.jpeg.set_property("quality", 50);
      else if (this.quality === 2) this.jpeg.set_property("quality", 38);
      else if (this.quality <= 4) this.setLimit(Math.round(this.side * (this.quality === 3 ? 0.75 : 0.5)));
      else throw new Error("Кадр превышает допустимый размер даже после сжатия.");
      return;
    }
    return buffer.extract_dup(0, size);
  }

  close(): void { this.pipeline.set_state(this.gst.State.NULL); }

  private setLimit(side: number): void {
    const caps = this.gst.Caps.from_string(`video/x-raw,width=(int)[1,${side}],height=(int)[1,${side}],pixel-aspect-ratio=1/1`);
    this.limit.set_property("caps", caps);
  }

  private busError(): string {
    const message = this.pipeline.get_bus().pop_filtered(this.gst.MessageType.ERROR | this.gst.MessageType.EOS);
    if (!message) return "";
    return message.type === this.gst.MessageType.ERROR ? message.parse_error()[0].message : "Видеоустройство прекратило захват.";
  }
}

export class CallVideo {
  private run?: CaptureRun;
  private camera = "";

  constructor(window: any, private readonly handlers: CallVideoHandlers,
    private readonly portal: PortalVideoOpen = (kind, cancel, stopped) => openPortalVideo(window, kind, cancel, stopped),
    private readonly encoder = (kind: ShareKind, remote: PortalVideo) => new CallVideoEncoder(kind, remote)) {}

  async toggle(kind: ShareKind): Promise<void> {
    const previous = this.run?.kind;
    this.stop();
    if (previous === kind) return;
    await this.start(kind, kind === "camera" ? this.camera : "");
  }

  setCamera(camera: string): void {
    if (this.camera === camera) return;
    this.camera = camera;
    if (this.run?.kind === "camera") {
      this.stop();
      void this.start("camera", camera);
    }
  }

  private async start(kind: ShareKind, camera: string, notice?: string): Promise<void> {
    const run: CaptureRun = {
      kind, cancel: new Gio.Cancellable(), timer: 0, opened: 0, lastAt: 0, announced: false, lastFrame: 0,
      camera: "", notice,
    };
    this.run = run;
    this.handlers.changed({ kind, waiting: true, announced: false, notice });
    try {
      run.lease = acquireCapture(run, "Видео звонка", ["visual"]);
      const remote = await this.portal(kind, run.cancel, () => {
        if (this.run === run) this.stop("Демонстрация остановлена в системном портале.");
      });
      if (this.run !== run) { remote.close(); return; }
      run.remote = remote;
      if (camera) {
        let present = false;
        let scan: PortalVideo | undefined;
        try {
          scan = remote.cameraScan?.();
          if (scan) present = listCallCameras(scan.fd).some(({ id }) => id === camera);
        } catch { /* Keep the portal's default route. */ }
        finally { scan?.close(); }
        if (present) run.camera = camera;
        else run.notice = "Выбранная камера недоступна. Использую системную камеру.";
      }
      run.encoder = this.encoder(kind, run.camera ? { ...remote, camera: run.camera } : remote);
      run.opened = GLib.get_monotonic_time();
      run.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
        try { this.poll(run); }
        catch (error) { this.captureFailed(run, error); }
        return this.run === run ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
      });
    } catch (error) {
      this.captureFailed(run, error);
    }
  }

  private captureFailed(run: CaptureRun, error: unknown): void {
    if (this.run !== run) return;
    if (run.camera) {
      this.stop();
      void this.start("camera", "", "Выбранная камера отключилась. Подключаю системную камеру.");
    } else this.stop(errorText(error));
  }

  stop(error?: string): void {
    const run = this.run;
    this.run = undefined;
    if (run) {
      run.cancel.cancel();
      if (run.timer) GLib.Source.remove(run.timer);
      try { run.encoder?.close(); } catch (failure) { error ??= errorText(failure); }
      try { run.remote?.close(); } catch (failure) { error ??= errorText(failure); }
      run.lease?.release(); run.lease = undefined;
      if (run.announced) this.handlers.share(run.kind, false);
    }
    this.handlers.changed({ waiting: false, announced: false, error });
  }

  private poll(run: CaptureRun): void {
    const frame = run.encoder?.frame();
    const now = GLib.get_monotonic_time();
    if (!frame) {
      if (now - (run.lastFrame || run.opened) > 10_000_000) throw new Error("От выбранного источника не поступает видео.");
      return;
    }
    run.lastFrame = now;
    const epoch = this.handlers.epoch();
    if (epoch === undefined || now - run.lastAt < 1_000_000) return;
    const hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, GLib.Bytes.new(frame));
    if (epoch === run.lastEpoch && hash === run.lastHash) return;
    if (!this.handlers.sendFrame(frame, epoch)) {
      if (!run.announced && now - run.opened > 10_000_000) throw new Error("Канал вызова пока не принимает видеокадры.");
      return;
    }
    run.lastAt = now;
    run.lastHash = hash;
    run.lastEpoch = epoch;
    if (!run.announced) {
      run.announced = true;
      this.handlers.share(run.kind, true);
      this.handlers.changed({ kind: run.kind, waiting: false, announced: true, notice: run.notice });
    }
  }
}
