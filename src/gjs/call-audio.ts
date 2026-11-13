import { callRate } from "./call-wire.js";
import { acquireCapture, type CaptureLease } from "./capture-lease.js";
import { audioDeviceProvider, type CallDevicePrefs, defaultCallDevices, listCallAudio } from "./call-devices.js";
import { GLib, gstreamer } from "./gi.js";
import { errorText } from "./ui.js";

export interface CallMedia {
  prepare(): Promise<void>;
  capture(enabled: boolean): void;
  play(item: string, pcm: Uint8Array): void;
  flush(): void;
  updateDevices?(prefs: CallDevicePrefs): void;
  close(): void;
}
export type CallMediaFactory = (handlers: CallAudioHandlers, prefs: CallDevicePrefs) => CallMedia;

export interface CallAudioHandlers {
  capture: (pcm: Uint8Array) => void;
  played: (item: string, milliseconds: number) => void;
  failed: (message: string) => void;
  notice?: (message: string) => void;
}

interface PlaybackSlice { item: string; pcm: Uint8Array; start: number; end: number; counted: number }
interface Played { duration: number; sent: number }
interface AudioElements { source: string; sink: string }
const audioCaps = `audio/x-raw,format=S16LE,layout=interleaved,rate=${callRate},channels=1`;
const inputCap = 64 * 1024;
const nsPerMs = 1_000_000;

export class CallAudio implements CallMedia {
  private lease?: CaptureLease;
  private readonly gst = gstreamer();
  private input?: any;
  private output?: any;
  private mic?: any;
  private speaker?: any;
  private speakerSink?: any;
  private timer = 0;
  private closed = false;
  private enabled = false;
  private inputReady = false;
  private readonly prepared: Promise<void>;
  private ready!: () => void;
  private reject!: (error: unknown) => void;
  private deadline = 0;
  private lastInput = 0;
  private outputEnd = 0;
  private queued: PlaybackSlice[] = [];
  private readonly heard = new Map<string, Played>();
  private provider?: any;
  private microphoneDevice = "";
  private speakerDevice = "";

  constructor(private readonly handlers: CallAudioHandlers, private readonly elements: AudioElements = {
    source: "pulsesrc name=call_input buffer-time=60000 latency-time=10000",
    sink: "pulsesink name=call_output buffer-time=60000 latency-time=10000",
  }, private prefs: Readonly<CallDevicePrefs> = defaultCallDevices) {
    this.prepared = new Promise((resolve, reject) => { this.ready = resolve; this.reject = reject; });
  }

  prepare(): Promise<void> {
    if (this.timer || this.closed) return this.prepared;
    try {
      this.lease = acquireCapture(this, "Звонок", ["audio"]);
      this.updateProvider();
      this.resolveDevices();
      this.startOutputWithFallback();
      this.startInputWithFallback();
      this.deadline = GLib.get_monotonic_time() + 5_000_000;
      this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
        try { this.poll(); }
        catch (error) {
          this.timer = 0;
          const message = errorText(error);
          const ready = this.inputReady;
          // Settle preparation with the device error before close() supplies
          // its generic cancellation reason for an unfinished preparation.
          if (!ready) this.reject(new Error(message));
          this.close();
          if (ready) this.handlers.failed(message);
          return GLib.SOURCE_REMOVE;
        }
        return this.closed ? GLib.SOURCE_REMOVE : GLib.SOURCE_CONTINUE;
      });
    } catch (error) {
      this.reject(error);
      this.close();
    }
    return this.prepared;
  }

  capture(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    // Discard data queued before a live or unmuted state.
    this.drainInput(false);
  }

  updateDevices(prefs: CallDevicePrefs): void {
    const previous = this.prefs;
    this.prefs = prefs;
    if (this.closed || !this.timer) return;
    const microphone = this.microphoneDevice;
    const speaker = this.speakerDevice;
    this.updateProvider();
    this.resolveDevices();
    if (this.pulseSource && (microphone !== this.microphoneDevice || previous.echo !== prefs.echo || previous.noise !== prefs.noise
      || previous.gain !== prefs.gain)) {
      this.stopInput();
      this.startInputWithFallback();
    }
    if (this.pulseSink && (speaker !== this.speakerDevice || previous.echo !== prefs.echo)) {
      this.restartOutput(true);
    }
    if (!this.inputReady) this.deadline = GLib.get_monotonic_time() + 5_000_000;
  }

  private get pulseSource(): boolean { return this.elements.source.startsWith("pulsesrc "); }
  private get pulseSink(): boolean { return this.elements.sink.startsWith("pulsesink "); }

  private updateProvider(): void {
    const selected = this.pulseSource && this.prefs.microphone || this.pulseSink && this.prefs.speaker;
    if (selected && !this.provider) {
      const provider = audioDeviceProvider();
      if (provider?.start()) this.provider = provider;
    } else if (!selected && this.provider) {
      this.provider.stop();
      this.provider = undefined;
    }
  }

  private resolveDevices(): void {
    this.microphoneDevice = this.pulseSource ? this.prefs.microphone : "";
    this.speakerDevice = this.pulseSink ? this.prefs.speaker : "";
    if (!this.provider) return;
    const devices = listCallAudio(this.provider);
    if (this.microphoneDevice && !devices.microphone.some(({ id }) => id === this.microphoneDevice)) this.fallback("microphone");
    if (this.speakerDevice && !devices.speaker.some(({ id }) => id === this.speakerDevice)) this.fallback("speaker");
  }

  private fallback(device: "microphone" | "speaker"): void {
    if (device === "microphone") this.microphoneDevice = "";
    else this.speakerDevice = "";
    this.handlers.notice?.(device === "microphone" ? "Выбранный микрофон недоступен. Использую системный микрофон."
      : "Выбранный аудиовыход недоступен. Использую системный аудиовыход.");
  }

  private startInput(): void {
    const processing = this.pulseSource && (this.prefs.noise || this.prefs.gain) && this.gst.ElementFactory.find("webrtcdsp")
      ? ` ! webrtcdsp name=call_dsp echo-cancel=false high-pass-filter=false noise-suppression=${this.prefs.noise} gain-control=${this.prefs.gain}` : "";
    this.input = this.gst.parse_launch(`${this.elements.source} ! audioconvert ! audioresample ! ${audioCaps}${processing} ! appsink name=mic sync=false max-buffers=12 drop=true`);
    this.mic = this.input.get_by_name("mic");
    const source = this.input.get_by_name("call_input");
    this.applyPulseRole(source, this.microphoneDevice);
    if (this.input.set_state(this.gst.State.PLAYING) === this.gst.StateChangeReturn.FAILURE) {
      throw new Error(this.busError(this.input) || "Не удалось включить микрофон.");
    }
    this.lastInput = GLib.get_monotonic_time();
  }

  private startInputWithFallback(): void {
    try { this.startInput(); }
    catch (error) {
      this.stopInput();
      if (!this.microphoneDevice) throw error;
      this.fallback("microphone");
      this.startInput();
    }
  }

  private stopInput(): void {
    this.input?.set_state(this.gst.State.NULL);
    this.input = this.mic = undefined;
  }

  private startOutput(): void {
    this.output = this.gst.parse_launch(`appsrc name=speaker is-live=true format=time block=false max-bytes=0 caps="${audioCaps}" ! audioconvert ! audioresample ! ${this.elements.sink} sync=true async=false enable-last-sample=false`);
    this.speaker = this.output.get_by_name("speaker");
    this.speakerSink = this.output.get_by_name("call_output");
    if (!this.speakerSink) throw new Error("Аудиовыход вызова недоступен.");
    this.applyPulseRole(this.speakerSink, this.speakerDevice);
    if (this.output.set_state(this.gst.State.PLAYING) === this.gst.StateChangeReturn.FAILURE) {
      throw new Error(this.busError(this.output) || "Не удалось включить аудиовыход.");
    }
  }

  private startOutputWithFallback(): void {
    try { this.startOutput(); }
    catch (error) {
      this.stopOutput();
      if (!this.speakerDevice) throw error;
      this.fallback("speaker");
      this.startOutput();
    }
  }

  private applyPulseRole(element: any, device: string): void {
    if (element?.get_factory()?.get_name().startsWith("pulse")) {
      if (device) element.set_property("device", device);
      const echo = this.prefs.echo ? ",filter.want=(string)echo-cancel" : "";
      const [properties] = this.gst.Structure.from_string("properties,media.role=(string)phone" + echo);
      element.set_property("stream-properties", properties);
    }
  }

  private busError(pipeline: any): string {
    const types = this.gst.MessageType;
    const bus = pipeline?.get_bus();
    for (let count = 0; count < 8; count++) {
      const message = bus?.pop_filtered(types.ERROR | types.EOS);
      if (!message) break;
      if (message.type === types.ERROR) return message.parse_error()[0].message;
      if (message.type === types.EOS) return "Аудиоустройство прекратило работу.";
    }
    return "";
  }

  private poll(): void {
    this.checkDevices();
    const inputError = this.busError(this.input);
    if (inputError) this.recoverInput(inputError);
    const outputError = this.busError(this.output);
    if (outputError) {
      if (!this.speakerDevice) throw new Error(outputError);
      this.fallback("speaker");
      this.restartOutput(true, false);
    }
    const sample = this.drainInput(this.enabled);
    const now = GLib.get_monotonic_time();
    if (sample) this.lastInput = now;
    else if (this.inputReady && now - this.lastInput > 5_000_000) this.recoverInput("Микрофон перестал передавать звук.");
    if (!this.inputReady && sample && this.output.get_state(0)[1] === this.gst.State.PLAYING) {
      this.inputReady = true;
      this.ready();
    } else if (!this.inputReady && now >= this.deadline) {
      throw new Error("Микрофон и аудиовыход не перешли в рабочее состояние.");
    }
    this.acknowledge();
  }

  private recoverInput(error: string): void {
    if (!this.microphoneDevice) throw new Error(error);
    this.fallback("microphone");
    this.stopInput();
    this.startInput();
  }

  private checkDevices(): void {
    const bus = this.provider?.get_bus();
    if (!bus?.pop_filtered(this.gst.MessageType.DEVICE_REMOVED)) return;
    const devices = listCallAudio(this.provider);
    if (this.microphoneDevice && !devices.microphone.some(({ id }) => id === this.microphoneDevice)) {
      this.recoverInput("Выбранный микрофон отключился.");
    }
    if (this.speakerDevice && !devices.speaker.some(({ id }) => id === this.speakerDevice)) {
      this.fallback("speaker");
      this.restartOutput(true, false);
    }
  }

  private drainInput(send: boolean): boolean {
    if (!this.mic) return false;
    let received = false;
    for (let count = 0; count < 12; count++) {
      const sample = this.mic.try_pull_sample(0);
      if (!sample) break;
      const buffer = sample.get_buffer();
      const length = buffer.get_size() & ~1;
      if (!length) continue;
      received = true;
      if (!send) continue;
      for (let offset = 0; offset < length && this.enabled && !this.closed; offset += inputCap) {
        this.handlers.capture(buffer.extract_dup(offset, Math.min(inputCap, length - offset)));
      }
    }
    return received;
  }

  play(item: string, pcm: Uint8Array): void {
    if (!this.output || !pcm.length || this.closed) return;
    const duration = Math.round(pcm.length * 1_000_000_000 / (callRate * 2));
    const running = this.output.get_current_running_time();
    if (!Number.isSafeInteger(running) || running < 0) throw new Error("Аудиовыход потерял синхронизацию.");
    // A finite queue keeps interruptions and unusually fast senders from accumulating stale speech.
    const start = this.outputEnd > running ? this.outputEnd : running + 30 * nsPerMs;
    if (start - running > 12_000 * nsPerMs) throw new Error("Шлюз передаёт звук быстрее, чем его можно воспроизвести.");
    const buffer = this.gst.Buffer.new_allocate(null, pcm.length, null);
    buffer.fill(0, pcm);
    buffer.pts = start;
    buffer.duration = duration;
    if (this.speaker.push_buffer(buffer) !== this.gst.FlowReturn.OK) throw new Error("Не удалось передать звук в аудиовыход.");
    this.outputEnd = start + duration;
    this.queued.push({ item, pcm: pcm.slice(), start, end: this.outputEnd, counted: start });
  }

  private acknowledge(): void {
    if (!this.speakerSink || !this.queued.length) return;
    const [ok, position] = this.speakerSink.query_position(this.gst.Format.TIME);
    if (!ok || !Number.isSafeInteger(position) || position < 0) return;
    const changed = new Set<string>();
    while (this.queued.length) {
      const slice = this.queued[0];
      const heard = Math.min(slice.end, position);
      if (heard <= slice.counted) break;
      const item = this.heard.get(slice.item) ?? { duration: 0, sent: 0 };
      item.duration += heard - slice.counted;
      slice.counted = heard;
      this.heard.set(slice.item, item);
      changed.add(slice.item);
      if (heard < slice.end) break;
      this.queued.shift();
    }
    for (const id of changed) {
      const item = this.heard.get(id)!;
      const milliseconds = Math.floor(item.duration / nsPerMs);
      if (milliseconds > item.sent) {
        item.sent = milliseconds;
        this.handlers.played(id, milliseconds);
      }
    }
  }

  flush(): void {
    if (this.closed || !this.output || !this.queued.length) return;
    this.restartOutput(false);
  }

  private restartOutput(preserve: boolean, acknowledge = true): void {
    if (acknowledge) this.acknowledge();
    const remaining = preserve ? this.queued.map((slice) => ({
      item: slice.item,
      pcm: slice.pcm.subarray(Math.ceil((slice.counted - slice.start) * callRate / 1_000_000_000) * 2),
    })) : [];
    this.stopOutput();
    this.startOutputWithFallback();
    for (const { item, pcm } of remaining) this.play(item, pcm);
  }

  private stopOutput(): void {
    this.output?.set_state(this.gst.State.NULL);
    this.output = this.speaker = this.speakerSink = undefined;
    this.queued = [];
    this.outputEnd = 0;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.acknowledge();
    if (!this.inputReady) this.reject(new Error("Подготовка звука прервана."));
    if (this.timer) GLib.Source.remove(this.timer);
    this.timer = 0;
    this.stopInput();
    this.stopOutput();
    this.lease?.release(); this.lease = undefined;
    this.provider?.stop();
    this.provider = undefined;
    this.heard.clear();
  }
}
