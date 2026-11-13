import { Gio, GLib, gstreamer } from "./gi.js";

export interface LocalVoice { id: string; file: string; label: string; language: string }

export class DeviceVoice {
  constructor(private readonly sink = "pulsesink") {}

  private readonly executable = GLib.find_program_in_path("espeak-ng");
  readonly available = this.checkAvailability();
  private catalog?: Promise<LocalVoice[]>;
  private discovery?: { process: any; cancel: any };
  private synthesis?: { process: any; cancel: any };
  private endPlayback?: () => void;
  private pipeline?: any;
  private paused = false;

  private checkAvailability(): boolean {
    if (!this.executable) return false;
    try {
      const gst = gstreamer();
      return ["wavparse", "pulsesink"].every((name) => Boolean(gst.ElementFactory.find(name)));
    } catch { return false; }
  }

  voices(): Promise<LocalVoice[]> {
    this.catalog ??= this.loadVoices().catch((error) => {
      this.catalog = undefined;
      throw error;
    });
    return this.catalog;
  }

  private async loadVoices(): Promise<LocalVoice[]> {
    const process = this.command(["--voices"]);
    const query = { process, cancel: new Gio.Cancellable() };
    this.discovery = query;
    let data: Uint8Array;
    try { data = await this.output(process, null, query.cancel); }
    finally { if (this.discovery === query) this.discovery = undefined; }
    const voices = new Map<string, LocalVoice>();
    for (const line of new TextDecoder().decode(data).split("\n")) {
      const match = /^\s*\d+\s+(\S+)\s+[\d-]+\/[MF-]\s+(\S+)\s+([\w./-]+)(?:\s|$)/u.exec(line);
      if (!match) continue;
      const [, language, name, file] = match;
      const id = `espeak-ng:${file}`;
      if (id.length <= 120 && !file.startsWith("mb/")) {
        voices.set(id, { id, file, label: name.replace(/_/g, " "), language });
      }
    }
    return [...voices.values()].sort((a, b) => a.label.localeCompare(b.label) || a.language.localeCompare(b.language));
  }

  async speak(text: string, voice: LocalVoice, options: { rate?: number; pitch?: number; volume?: number; start?: () => void } = {}): Promise<void> {
    const cancel = new Gio.Cancellable();
    const process = this.command(["--stdout", "--stdin", "-b", "1", "-v", voice.file,
      "-s", String(Math.round(175 * (options.rate ?? 1))), "-p", String(Math.min(99, Math.round(50 * (options.pitch ?? 1)))),
      "-a", String(Math.round(100 * (options.volume ?? 1)))], true);
    const run = { process, cancel };
    this.synthesis = run;
    let wav: Uint8Array;
    try {
      wav = await this.output(process, GLib.Bytes.new(new TextEncoder().encode(text)), cancel);
    } finally {
      if (this.synthesis === run) this.synthesis = undefined;
    }
    if (cancel.is_cancelled() || !wav.length) return;
    // eSpeak streams a RIFF header with placeholder lengths on stdout. Use the
    // actual lengths so the decoder can drain the last audio on EOS.
    const signature = (start: number) => new TextDecoder().decode(wav.subarray(start, start + 4));
    if (wav.length < 44 || signature(0) !== "RIFF" || signature(8) !== "WAVE" || signature(36) !== "data") {
      throw new Error("Движок вернул некорректный звук.");
    }
    if (wav.length === 44) return;
    const header = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    header.setUint32(4, wav.length - 8, true);
    header.setUint32(40, wav.length - 44, true);
    await this.play(wav, options.start);
  }

  stop(): void {
    this.paused = false;
    const query = this.discovery;
    this.discovery = undefined;
    if (query) { query.cancel.cancel(); query.process.force_exit(); }
    const run = this.synthesis;
    this.synthesis = undefined;
    if (run) {
      run.cancel.cancel();
      run.process.force_exit();
    }
    this.endPlayback?.();
  }

  pause(): void { this.paused = true; this.pipeline?.set_state(gstreamer().State.PAUSED); }
  resume(): void { this.paused = false; this.pipeline?.set_state(gstreamer().State.PLAYING); }

  private command(args: string[], input = false): any {
    if (!this.executable) throw new Error("eSpeak NG недоступен на этом устройстве.");
    const flags = Gio.SubprocessFlags;
    return Gio.Subprocess.new([this.executable, ...args],
      flags.STDOUT_PIPE | flags.STDERR_SILENCE | (input ? flags.STDIN_PIPE : flags.NONE));
  }

  private output(process: any, input: any, cancel: any): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      process.communicate_async(input, cancel, (_source: unknown, result: unknown) => {
        try {
          const [, stdout] = process.communicate_finish(result);
          if (!process.get_successful()) throw new Error("eSpeak NG завершился с ошибкой.");
          resolve(stdout.get_data() ?? new Uint8Array());
        } catch (error) { reject(error); }
      });
    });
  }

  private play(wav: Uint8Array, start?: () => void): Promise<void> {
    const gst = gstreamer();
    const pipeline = gst.parse_launch(`appsrc name=voice_source caps="audio/x-wav" ! wavparse ! audioconvert ! audioresample ! ${this.sink}`);
    const bus = pipeline.get_bus();
    this.pipeline = pipeline;
    return new Promise((resolve, reject) => {
      bus.add_signal_watch();
      let started = false;
      const handler = bus.connect("message", (_bus: unknown, message: any) => {
        if (!started && message.type === gst.MessageType.STATE_CHANGED && message.src === pipeline
          && message.parse_state_changed()[1] === gst.State.PLAYING) { started = true; start?.(); }
        if (message.type === gst.MessageType.ERROR) finish(new Error(message.parse_error()[0].message));
        if (message.type === gst.MessageType.EOS) finish();
      });
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        this.endPlayback = undefined;
        if (this.pipeline === pipeline) this.pipeline = undefined;
        bus.disconnect(handler);
        bus.remove_signal_watch();
        pipeline.set_state(gst.State.NULL);
        if (error) reject(error); else resolve();
      };
      this.endPlayback = finish;
      try {
        const input = pipeline.get_by_name("voice_source");
        if (pipeline.set_state(this.paused ? gst.State.PAUSED : gst.State.PLAYING) === gst.StateChangeReturn.FAILURE) throw new Error("Аудиовыход недоступен.");
        const buffer = gst.Buffer.new_allocate(null, wav.length, null);
        buffer.fill(0, wav);
        if (input.push_buffer(buffer) !== gst.FlowReturn.OK || input.end_of_stream() !== gst.FlowReturn.OK) {
          throw new Error("Не удалось воспроизвести озвученный ответ.");
        }
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  }
}
