import { acquireCapture, type CaptureLease } from "./capture-lease.js";
import { GLib, gstreamer } from "./gi.js";

interface RecordingLimits {
  formats?: string[];
  max_bytes?: number;
  max_seconds?: number;
}

interface Format { type: string; elements: string[]; encoder: string }

const formats: Format[] = [
  { type: "audio/webm", elements: ["opusenc", "webmmux"],
    encoder: "opusenc bitrate=32000 bitrate-type=cbr audio-type=voice ! webmmux streamable=true" },
  { type: "audio/ogg", elements: ["opusenc", "oggmux"],
    encoder: "opusenc bitrate=32000 bitrate-type=cbr audio-type=voice ! oggmux max-delay=250000000 max-page-delay=250000000" },
  { type: "audio/mp4", elements: ["avenc_aac", "aacparse", "mp4mux"],
    encoder: "audioconvert ! avenc_aac bitrate=32000 ! aacparse ! mp4mux fragment-duration=500 streamable=true" },
  { type: "audio/mpeg", elements: ["lamemp3enc"],
    encoder: "lamemp3enc target=bitrate bitrate=32 cbr=true" },
  { type: "audio/wav", elements: [], encoder: "" },
];

const rate = 16000;
const bytesPerSecond = rate * 2;
const caps = `audio/x-raw,format=S16LE,layout=interleaved,rate=${rate},channels=1`;
const wavHeader = 44;
export const maxSpeechBytes = 512 * 1024;

export function dictationFormat(limits: RecordingLimits): Format | undefined {
  const gst = gstreamer();
  if (!gst.ElementFactory.find("pulsesrc")) return undefined;
  return formats.find((format) => (!limits.formats?.length || limits.formats.includes(format.type))
    && (format.encoder || (limits.max_bytes ?? maxSpeechBytes) >= wavHeader + 2)
    && format.elements.every((name) => gst.ElementFactory.find(name)));
}

export class DictationAudio {
  private lease?: CaptureLease;
  private readonly gst = gstreamer();
  private readonly maxBytes: number;
  private readonly maxPcm: number;
  private pipeline?: any;
  private sink?: any;
  private timer = 0;
  private deadline = 0;
  private recording = true;
  private stopping = false;
  private closed = false;
  private chunks: Uint8Array[] = [];
  private size = 0;
  private inputAt = 0;

  constructor(readonly format: Format, limits: RecordingLimits,
    private readonly finishing: () => void,
    private readonly result: (error: unknown, bytes?: Uint8Array) => void,
    private readonly source = "pulsesrc buffer-time=60000 latency-time=10000",
    private readonly captureOwner?: object,
    private readonly chunk?: (wav: Uint8Array) => void) {
    this.maxBytes = Math.min(limits.max_bytes || maxSpeechBytes, maxSpeechBytes);
    const seconds = Math.min(limits.max_seconds || 60, 600);
    // Reserve container overhead for compressed audio. The finalized byte count
    // is still checked separately because encoder/container sizes vary.
    const budget = format.encoder ? Math.max(0.1, (this.maxBytes - 2048) / 4700) : (this.maxBytes - wavHeader) / bytesPerSecond;
    // Encoders can include priming samples and round the last frame up.
    const padding = format.encoder ? 0.15 : 0;
    this.maxPcm = Math.floor(Math.min(seconds - padding, budget) * rate) * 2;
    if (chunk && (format.encoder || !Number.isFinite(this.maxPcm) || this.maxPcm < 2)) throw new Error("Непрерывная запись требует ограниченного WAV PCM.");
  }

  start(): void {
    if (this.closed || this.timer) return;
    try {
      this.lease = acquireCapture(this.captureOwner ?? this, "Диктовка", ["audio"]);
      this.open(`${this.source} ! audioconvert ! audioresample ! ${caps}`);
      this.inputAt = GLib.get_monotonic_time();
      this.deadline = this.inputAt + this.maxPcm / bytesPerSecond * 1_000_000 + 1_000_000;
      this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
        try { this.poll(); }
        catch (error) { this.finish(error); }
        if (!this.closed) return GLib.SOURCE_CONTINUE;
        this.timer = 0;
        return GLib.SOURCE_REMOVE;
      });
    } catch (error) { this.finish(error); }
  }

  stop(): void { this.stopping = true; }

  cancel(): void {
    if (this.timer) GLib.Source.remove(this.timer);
    this.timer = 0;
    this.close();
  }

  private open(description: string): void {
    this.pipeline = this.gst.parse_launch(`${description} ! appsink name=dictation_sink sync=false max-buffers=16`);
    this.sink = this.pipeline.get_by_name("dictation_sink");
    if (this.pipeline.set_state(this.gst.State.PLAYING) === this.gst.StateChangeReturn.FAILURE) {
      throw new Error(this.pipeline.get_bus().pop_filtered(this.gst.MessageType.ERROR)?.parse_error()[0].message
        || "Не удалось запустить запись звука.");
    }
  }

  private poll(): void {
    const now = GLib.get_monotonic_time();
    const types = this.gst.MessageType;
    const message = this.pipeline.get_bus().pop_filtered(types.ERROR | types.EOS);
    if (message?.type === types.ERROR) throw new Error(message.parse_error()[0].message);
    for (let count = 0; count < 64; count++) {
      const sample = this.sink.try_pull_sample(0);
      if (!sample) break;
      const buffer = sample.get_buffer();
      if (!buffer) continue;
      const length = buffer.get_size();
      if (this.recording && this.chunk) {
        // A GstBuffer may cross several segment boundaries. Preserve every
        // remaining sample; keep the original capture pipeline running.
        for (let offset = 0; offset < (length & ~1);) {
          const take = Math.min((length & ~1) - offset, this.maxPcm - this.size);
          this.chunks.push(buffer.extract_dup(offset, take)); this.size += take; offset += take;
          this.inputAt = now;
          if (this.size === this.maxPcm) {
            const wav = this.wav(); this.chunks = []; this.size = 0;
            this.chunk(wav);
            if (this.closed) return;
          }
        }
      } else if (this.recording) {
        const take = Math.min(length & ~1, this.maxPcm - this.size);
        if (take) {
          this.chunks.push(buffer.extract_dup(0, take));
          this.size += take;
          this.inputAt = now;
        }
        if (this.size >= this.maxPcm) { this.stopping = true; break; }
      } else {
        if (this.size + length > this.maxBytes) throw new Error("Запись превышает лимит движка. Попробуйте более короткую фразу.");
        if (length) {
          this.chunks.push(buffer.extract_dup(0, length));
          this.size += length;
        }
      }
    }
    if (this.recording) {
      if (now - this.inputAt >= 4_000_000) throw new Error("Микрофон не передаёт звук.");
      if (this.stopping || (!this.chunk && this.size && now >= this.deadline) || message?.type === types.EOS
        || (this.chunk && this.sink.is_eos())) this.endCapture();
    } else if (message?.type === types.EOS || (this.size && this.sink.is_eos())) {
      this.finish(null, this.join());
    } else if (now >= this.deadline) {
      throw new Error("Не удалось завершить кодирование записи.");
    }
  }

  private endCapture(): void {
    this.recording = false;
    this.releasePipeline();
    this.finishing();
    if (!this.size) { this.finish(null, new Uint8Array()); return; }
    if (!this.format.encoder) {
      this.finish(null, this.wav());
      return;
    }
    const pcm = this.join();
    this.chunks = [];
    this.size = 0;
    this.open(`appsrc name=dictation_source format=time caps="${caps}" ! ${this.format.encoder}`);
    const input = this.pipeline.get_by_name("dictation_source");
    const buffer = this.gst.Buffer.new_allocate(null, pcm.length, null);
    buffer.fill(0, pcm);
    buffer.pts = 0;
    buffer.duration = pcm.length * 1_000_000_000 / bytesPerSecond;
    if (input.push_buffer(buffer) !== this.gst.FlowReturn.OK || input.end_of_stream() !== this.gst.FlowReturn.OK) {
      throw new Error("Не удалось передать запись кодировщику.");
    }
    this.deadline = GLib.get_monotonic_time() + 12_000_000;
  }

  private join(prefix = 0): Uint8Array {
    const bytes = new Uint8Array(prefix + this.size);
    let offset = prefix;
    for (const chunk of this.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }

  private wav(): Uint8Array {
    const bytes = this.join(wavHeader);
    const header = new DataView(bytes.buffer);
    bytes.set([82, 73, 70, 70], 0); // RIFF
    header.setUint32(4, bytes.length - 8, true);
    bytes.set([87, 65, 86, 69, 102, 109, 116, 32], 8); // WAVEfmt
    header.setUint32(16, 16, true);
    header.setUint16(20, 1, true);
    header.setUint16(22, 1, true);
    header.setUint32(24, rate, true);
    header.setUint32(28, bytesPerSecond, true);
    header.setUint16(32, 2, true);
    header.setUint16(34, 16, true);
    bytes.set([100, 97, 116, 97], 36); // data
    header.setUint32(40, this.size, true);
    return bytes;
  }

  private finish(error: unknown, bytes?: Uint8Array): void {
    this.close();
    this.result(error, bytes);
  }

  private close(): void {
    this.closed = true;
    this.releasePipeline();
    this.lease?.release(); this.lease = undefined;
    this.chunks = [];
  }

  private releasePipeline(): void {
    this.pipeline?.set_state(this.gst.State.NULL);
    this.pipeline = this.sink = undefined;
  }
}
