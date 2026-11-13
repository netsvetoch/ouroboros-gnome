import { CallAudio, type CallMedia, type CallMediaFactory } from "./call-audio.js";
import { type CallDevicePrefs, loadCallDevices } from "./call-devices.js";
import { type ShareKind } from "./call-portal.js";
import { canShareVideo, type CallVideo, type CallVideoHandlers, type CallVideoStatus } from "./call-video.js";
import { callAudioPacket, callRate, callUint16, callVideoPacket, newerEpoch, readCallAudio } from "./call-wire.js";
import { type Gateway, type GatewayFrame, HttpError } from "./gateway.js";
import { Gio, GLib, Soup } from "./gi.js";
import { type SettingsDocument, object } from "./settings-write.js";
import { errorText } from "./ui.js";

export interface CallRoom { chatId: number; name: string }
export const defaultCallFeature = "live_conversation:call";
export interface CallNoticeResult { sent: boolean; message: string; uncertain?: boolean }
type ServerPhase = "preparing" | "connecting" | "live" | "reconnecting" | "closing" | "closed";
export type CallPhase = ServerPhase | "idle" | "devices" | "admitting" | "failed";
const serverPhases = new Set<ServerPhase>(["preparing", "connecting", "live", "reconnecting", "closing", "closed"]);
const turns = new Set(["idle", "awaiting", "answering"]);
const encoder = new TextEncoder();

export interface CallCaption {
  key: string;
  speaker: "owner" | "ouroboros";
  text: string;
  final: boolean;
}
export interface CallView {
  active: boolean;
  phase: CallPhase;
  room?: CallRoom;
  callId?: string;
  requestedFeature?: string;
  joined?: boolean;
  engine?: string;
  reason?: string;
  detail?: string;
  action?: string;
  activity?: string;
  turn?: string;
  muted: boolean;
  videoAvailable?: boolean;
  video?: CallVideoStatus;
  deviceNotice?: string;
  captions: readonly CallCaption[];
}

interface Admission { call_id: string; ws_path: string; vision: boolean; joined?: boolean }
interface Attempt {
  id: string;
  room: CallRoom;
  cancel: any;
  media?: CallMedia;
  video?: CallVideo;
  admission?: Admission;
  socket?: any;
  timer: number;
  epoch?: number;
  inputSeq: number;
  outputSeq?: number;
  videoSeq: number;
  admitting: boolean;
  abandoned: boolean;
  shutdown?: () => void;
  items: Map<number, string>;
  captions: Map<string, CallCaption>;
}

function admission(value: unknown): Admission {
  const reply = object(value);
  const id = reply.call_id;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || reply.ws_path !== "/ws/call/" + id
    || typeof reply.vision !== "boolean" || reply.joined !== undefined && typeof reply.joined !== "boolean") {
    throw new Error("Шлюз не вернул проверяемый адрес вызова.");
  }
  return { call_id: id, ws_path: reply.ws_path, vision: reply.vision, joined: reply.joined === true };
}

function words(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }

export class CallSession {
  private attempt?: Attempt;
  private readonly uncertain = new Map<string, string>();
  private draining?: Promise<void>;
  private disposed = false;
  private devicePrefs = loadCallDevices();
  private view: CallView = { active: false, phase: "idle", muted: false, captions: [] };

  constructor(private readonly gateway: Gateway, private readonly changed: (view: CallView) => void,
    private readonly finished: () => void, private readonly media: CallMediaFactory = (handlers, prefs) => new CallAudio(handlers, undefined, prefs),
    private readonly createVideo?: (handlers: CallVideoHandlers) => CallVideo) {}

  get current(): CallView { return this.view; }
  get devices(): CallDevicePrefs { return this.devicePrefs; }

  async start(room: CallRoom, feature = defaultCallFeature): Promise<void> {
    if (this.disposed || this.attempt) return;
    const route = JSON.stringify([room.chatId, feature]);
    const id = this.uncertain.get(route) ?? GLib.uuid_string_random();
    const run: Attempt = { id, room, cancel: new Gio.Cancellable(), timer: 0, inputSeq: 0, videoSeq: 0, admitting: false, abandoned: false,
      items: new Map(), captions: new Map() };
    this.attempt = run;
    this.publish({ active: true, phase: "devices", room, requestedFeature: feature, muted: false, captions: [] }, true);
    try {
      run.media = this.media({
        capture: (pcm) => this.capture(run, pcm),
        played: (item, milliseconds) => this.send(run, { type: "played", item_id: item, played_ms: milliseconds }),
        failed: (message) => {
          if (this.attempt === run && !run.abandoned) this.fail(run, message, "audio_failed");
        },
        notice: (message) => {
          if (this.attempt !== run) return;
          const notices = new Set(this.view.deviceNotice?.split(" · "));
          notices.add(message);
          this.publish({ deviceNotice: [...notices].join(" · ") });
        },
      }, this.devicePrefs);
      await run.media.prepare();
      if (this.attempt !== run || run.abandoned) return;
      this.publish({ phase: "admitting" });
      run.admitting = true;
      const opened = await this.gateway.json<unknown>("POST", "/api/call/open", { chat_id: room.chatId, client_message_id: id, feature });
      run.admission = admission(opened);
      run.admitting = false;
      if (this.uncertain.get(route) === id) this.uncertain.delete(route);
      if (this.attempt !== run || run.abandoned) {
        if (!run.admission.joined) this.drain(this.release(run.admission));
        if (this.attempt === run) this.finish(run, { phase: "closed", reason: "owner_end" });
        return;
      }
      if (run.admission.vision && this.createVideo && canShareVideo()) {
        run.video = this.createVideo({
          changed: (video) => { if (this.attempt === run) this.publish({ video }); },
          epoch: () => this.attempt === run && this.view.phase === "live" ? run.epoch : undefined,
          sendFrame: (bytes, epoch) => this.sendVideo(run, bytes, epoch),
          share: (kind, sharing) => this.send(run, { type: "share", kind, sharing }),
        });
        run.video.setCamera(this.devicePrefs.camera);
      }
      this.publish({ phase: "connecting", callId: run.admission.call_id, joined: run.admission.joined,
        videoAvailable: Boolean(run.video) });
      this.armAnswer(run, 12);
      const socket = await this.gateway.connect(run.admission.ws_path, run.cancel);
      if (this.attempt !== run || run.abandoned) {
        if (socket.get_state() === Soup.WebsocketState.OPEN) socket.close(1000, null);
        return;
      }
      run.socket = socket;
      if (socket.get_state() !== Soup.WebsocketState.OPEN) throw new Error(socket.get_close_data() || "Шлюз закрыл канал вызова.");
      socket.set_max_incoming_payload_size(0);
      socket.set_keepalive_interval(6);
      socket.set_keepalive_pong_timeout?.(12);
      socket.connect("message", (_socket: unknown, type: number, bytes: any) => {
        if (this.attempt !== run) return;
        try {
          if (type === Soup.WebsocketDataType.BINARY) this.receiveAudio(run, bytes.get_data());
          else if (type === Soup.WebsocketDataType.TEXT) this.receive(run, object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.get_data()))));
        } catch (error) { this.fail(run, errorText(error), "protocol_mismatch"); }
      });
      socket.connect("closed", () => {
        if (this.attempt === run) this.finish(run, { phase: "failed", reason: "socket_closed",
          detail: socket.get_close_data() || "Соединение вызова оборвалось.", action: "retry" });
      });
      this.send(run, { type: "hello", protocol: 1, role: "owner", mic: true, speaker: true, rate: callRate,
        ...(run.video ? { video: true } : {}) });
      if (this.view.muted) this.send(run, { type: "mute", muted: true });
    } catch (error) {
      const refused = error instanceof HttpError && error.status >= 400 && error.status < 500 && object(error.body).ok === false;
      if (run.admitting && !refused) this.uncertain.set(route, id);
      else if (this.uncertain.get(route) === id && refused) this.uncertain.delete(route);
      run.admitting = false;
      if (this.attempt !== run) return;
      if (run.abandoned) { this.finish(run, { phase: "closed", reason: "owner_end" }); return; }
      this.fail(run, errorText(error), error instanceof HttpError ? error.reason : undefined, refused ? "settings" : "retry");
    }
  }

  setMuted(muted: boolean): void {
    const run = this.attempt;
    if (!run || run.abandoned || muted === this.view.muted) return;
    this.publish({ muted });
    run.media?.capture(!muted && this.view.phase === "live");
    this.send(run, { type: "mute", muted });
  }

  sendContext(callId: string, text: string): CallNoticeResult {
    if (!text.trim()) return { sent: false, message: "Введите факт для контекста беседы." };
    return this.sendNotice(callId, { type: "context", text: text.trim(), source: "gnome_owner_note" });
  }

  sendParticipant(callId: string, label: string, speaking: boolean): CallNoticeResult {
    if (!label.trim()) return { sent: false, message: "Укажите имя участника." };
    return this.sendNotice(callId, { type: "participant", label: label.trim(), speaking });
  }

  private sendNotice(callId: string, control: SettingsDocument): CallNoticeResult {
    const run = this.attempt;
    if (this.disposed || !run || run.abandoned || run.admission?.call_id !== callId || this.view.phase !== "live"
      || run.socket?.get_state() !== Soup.WebsocketState.OPEN) {
      return { sent: false, message: "Этот вызов сейчас недоступен для отправки." };
    }
    const json = JSON.stringify(control);
    if (encoder.encode(json).length > 16 * 1024) {
      return { sent: false, message: "Сообщение слишком длинное. Сократите текст." };
    }
    try {
      run.socket.send_text(json);
      return { sent: true, message: "Передано в канал текущего вызова." };
    } catch (error) {
      return { sent: false, uncertain: true, message: `Результат отправки неизвестен. ${errorText(error)}` };
    }
  }

  toggleVideo(kind: ShareKind): void {
    const run = this.attempt;
    if (!run?.video || run.abandoned || this.view.phase !== "live" && this.view.video?.kind !== kind) return;
    void run.video.toggle(kind);
  }

  setDevices(prefs: CallDevicePrefs): void {
    this.devicePrefs = prefs;
    const run = this.attempt;
    if (!run || run.abandoned || this.view.phase === "closing") return;
    this.publish({ deviceNotice: undefined });
    try {
      run.media?.updateDevices?.(prefs);
      run.video?.setCamera(prefs.camera);
    } catch (error) { this.fail(run, errorText(error), "audio_failed"); }
  }

  end(): void {
    const run = this.attempt;
    if (!run || run.abandoned) return;
    if (run.admitting) {
      run.abandoned = true;
      run.media?.close();
      this.publish({ phase: "closing", detail: "Ожидаю ответ на открытие вызова…" });
      return;
    }
    this.finish(run, { phase: "closed", reason: "owner_end", detail: undefined, action: undefined }, "left");
  }

  close(): Promise<void> | undefined {
    if (this.disposed) return this.draining;
    this.disposed = true;
    const run = this.attempt;
    if (run?.admitting) {
      this.end();
      return new Promise((resolve) => {
        const timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
          run.shutdown = undefined;
          resolve();
          return GLib.SOURCE_REMOVE;
        });
        run.shutdown = () => {
          GLib.Source.remove(timeout);
          resolve();
        };
      });
    }
    if (run) this.finish(run, { phase: "closed", reason: "owner_end" }, "left");
    return this.draining;
  }

  onChatFrame(frame: GatewayFrame): void {
    const run = this.attempt;
    if (frame.type !== "conversation_finished" || !run?.admission || frame.call_id !== run.admission.call_id
      || frame.chat_id !== run.room.chatId) return;
    this.finish(run, { phase: "closed", reason: words(frame.reason), detail: undefined, action: undefined });
  }

  private publish(patch: Partial<CallView>, reset = false): void {
    this.view = reset ? patch as CallView : { ...this.view, ...patch };
    if (!this.disposed) this.changed(this.view);
  }

  private capture(run: Attempt, pcm: Uint8Array): void {
    if (this.attempt !== run || run.abandoned || this.view.phase !== "live" || this.view.muted || run.epoch === undefined
      || run.socket?.get_state() !== Soup.WebsocketState.OPEN) return;
    try {
      run.socket.send_binary(callAudioPacket(pcm, run.epoch, run.inputSeq++));
    } catch (error) { this.fail(run, errorText(error), "audio_failed"); }
  }

  private send(run: Attempt, control: SettingsDocument): void {
    if (run.socket?.get_state() !== Soup.WebsocketState.OPEN) return;
    const json = JSON.stringify(control);
    if (encoder.encode(json).length <= 16 * 1024) run.socket.send_text(json);
  }

  private sendVideo(run: Attempt, bytes: Uint8Array, epoch: number): boolean {
    if (this.attempt !== run || this.view.phase !== "live" || epoch !== run.epoch
      || run.socket?.get_state() !== Soup.WebsocketState.OPEN) return false;
    const output = run.socket.get_io_stream().get_output_stream();
    // Never feed a new image to a socket whose transport cannot currently write.
    if (output.can_poll?.() !== true || output.is_writable?.() !== true) return false;
    run.socket.send_binary(callVideoPacket(bytes, epoch, run.videoSeq++));
    return true;
  }

  private flush(run: Attempt, epoch: number): void {
    if (run.epoch !== undefined && !newerEpoch(epoch, run.epoch)) return;
    run.media?.flush();
    run.epoch = epoch;
    run.outputSeq = undefined;
    run.items.clear();
  }

  private receiveAudio(run: Attempt, bytes: Uint8Array): void {
    if (run.abandoned || this.view.phase === "closing") return;
    const packet = readCallAudio(bytes);
    if (packet.kind !== 2 || packet.rate !== callRate) throw new Error("Шлюз вернул неподдерживаемое аудио вызова.");
    if (run.epoch === undefined || newerEpoch(packet.epoch, run.epoch)) this.flush(run, packet.epoch);
    if (packet.epoch !== run.epoch) return;
    const item = run.items.get(packet.stream);
    if (!item) throw new Error("Для аудио отсутствует идентификатор реплики.");
    if (run.outputSeq !== undefined) {
      const delta = (packet.sequence - run.outputSeq) >>> 0;
      if (!delta || delta >= 0x8000_0000) return;
    }
    run.outputSeq = packet.sequence;
    run.media?.play(item, packet.pcm);
  }

  private receive(run: Attempt, message: SettingsDocument): void {
    switch (message.type) {
      case "state": {
        const phase = message.state as ServerPhase;
        if (!serverPhases.has(phase)) return;
        // The hub starts with a state snapshot. Additive messages cannot prove
        // admission succeeded or remove the deadline for that snapshot.
        this.clearAnswer(run);
        const facts = { phase, reason: words(message.reason), detail: words(message.detail) ?? words(message.phase),
          engine: words(message.engine), action: words(message.action) };
        if (phase === "closed") { this.finish(run, facts); return; }
        run.media?.capture(phase === "live" && !this.view.muted);
        if (phase === "closing") {
          run.video?.stop();
          run.media?.flush();
        }
        this.publish(facts);
        break;
      }
      case "flush":
        if (!callUint16(message.epoch)) throw new Error("Некорректная эпоха воспроизведения.");
        this.flush(run, message.epoch);
        break;
      case "turn":
        if (typeof message.turn === "string" && turns.has(message.turn)) this.publish({ turn: message.turn });
        break;
      case "activity":
        this.publish({ activity: message.activity === "working" ? words(message.label)?.slice(0, 200) || "Выполняю задачу…" : undefined });
        break;
      case "caption":
        this.caption(run, message);
        break;
    }
  }

  private caption(run: Attempt, message: SettingsDocument): void {
    const { speaker, item_id, text, final } = message;
    if (speaker !== "owner" && speaker !== "ouroboros" || typeof item_id !== "string" || typeof text !== "string" || typeof final !== "boolean") {
      throw new Error("Шлюз вернул некорректную реплику вызова.");
    }
    if (message.epoch !== undefined && message.epoch !== run.epoch) return;
    if (speaker === "ouroboros" && item_id && !final) {
      const stream = message.stream ?? 0;
      if (!callUint16(stream)) throw new Error("Некорректный аудиопоток реплики.");
      run.items.set(stream, item_id);
    }
    const key = speaker + ":" + item_id;
    const previous = run.captions.get(key);
    if (previous?.final && !final) return;
    run.captions.set(key, { key, speaker, final, text: final || message.replace === true ? text : (previous?.text ?? "") + text });
    if (run.captions.size > 60) {
      const oldest = run.captions.keys().next().value;
      if (oldest !== undefined) run.captions.delete(oldest);
    }
    this.publish({ captions: [...run.captions.values()] });
  }

  private armAnswer(run: Attempt, seconds: number): void {
    run.timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
      run.timer = 0;
      if (this.attempt === run) this.fail(run, "Сокет вызова не ответил.", "socket_silent");
      return GLib.SOURCE_REMOVE;
    });
  }

  private clearAnswer(run: Attempt): void {
    if (run.timer) { GLib.Source.remove(run.timer); run.timer = 0; }
  }

  private fail(run: Attempt, detail: string, reason = "call_failed", action = "retry"): void {
    this.finish(run, { phase: "failed", reason, detail, action }, "client_error");
  }

  private finish(run: Attempt, patch: Partial<CallView>, bye?: string): void {
    if (this.attempt !== run) return;
    this.attempt = undefined;
    this.clearAnswer(run);
    run.video?.stop();
    try { run.media?.close(); } catch { /* Still release the socket if a device fails during teardown. */ }
    if (bye) this.send(run, { type: "bye", reason: bye });
    if (run.socket?.get_state() === Soup.WebsocketState.OPEN) this.drain(this.closeSocket(run.socket));
    else if (bye && run.admission && !run.admission.joined && !run.socket) this.drain(this.release(run.admission));
    run.cancel.cancel();
    this.publish({ ...patch, active: false, muted: false, activity: undefined, turn: undefined,
      videoAvailable: false, video: undefined, deviceNotice: undefined });
    if (run.shutdown) {
      const settle = () => { run.shutdown?.(); run.shutdown = undefined; };
      if (this.draining) void this.draining.finally(settle);
      else settle();
    }
    if (!this.disposed) this.finished();
  }

  private async release(opened: Admission): Promise<void> {
    const cancel = new Gio.Cancellable();
    let expired = false;
    const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
      expired = true;
      cancel.cancel();
      return GLib.SOURCE_REMOVE;
    });
    try {
      const socket = await this.gateway.connect(opened.ws_path, cancel);
      if (socket.get_state() !== Soup.WebsocketState.OPEN) return;
      socket.send_text(JSON.stringify({ type: "hello", protocol: 1, role: "owner", mic: false, speaker: false, rate: callRate }));
      socket.send_text(JSON.stringify({ type: "bye", reason: "left" }));
      await this.closeSocket(socket);
    } catch { /* The gateway may already have ended the unjoined call. */ }
    finally { if (!expired) GLib.Source.remove(timer); }
  }

  private drain(pending: Promise<void>): void {
    this.draining = pending;
    void pending.finally(() => { if (this.draining === pending) this.draining = undefined; });
  }

  private closeSocket(socket: any): Promise<void> {
    return new Promise((resolve) => {
      let timer = 0;
      const done = () => {
        if (timer) GLib.Source.remove(timer);
        socket.disconnect(signal);
        resolve();
      };
      const signal = socket.connect("closed", done);
      timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
        timer = 0;
        done();
        return GLib.SOURCE_REMOVE;
      });
      socket.close(1000, null);
    });
  }
}
