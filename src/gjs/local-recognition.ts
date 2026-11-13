import { Gio, GLib } from "./gi.js";

export class RecognitionError extends Error {
  constructor(readonly code: "unavailable" | "language" | "audio" | "busy" | "cancelled" | "engine", message: string) {
    super(message);
    this.name = "RecognitionError";
  }
}

export interface RecognitionResult {
  text: string;
  language: "en-US";
  duration: number;
  /** Decoder probability, not a calibrated estimate of transcript accuracy. */
  probability: number | null;
}

/** Accept the bounded recording format produced by native DictationAudio. */
export function recognitionWavDuration(bytes: Uint8Array): number {
  return recordingPcm(bytes).length / 32000;
}

function recordingPcm(bytes: Uint8Array): Uint8Array {
  const invalid = () => new RecognitionError("audio", "Нужен WAV: PCM16, моно, 16000 Гц, до 60 секунд.");
  if (!(bytes instanceof Uint8Array) || bytes.length < 46 || bytes.length > 1_920_000 + 4096) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || view.getUint32(4, true) !== bytes.length - 8) throw invalid();
  let format = false, size = 0, offset = 12, pcmAt = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw invalid();
    const length = view.getUint32(offset + 4, true), start = offset + 8;
    if (start + length + (length % 2) > bytes.length) throw invalid();
    if (tag(offset) === "fmt ") {
      if (format || size || length !== 16 || view.getUint16(start, true) !== 1
        || view.getUint16(start + 2, true) !== 1 || view.getUint32(start + 4, true) !== 16000
        || view.getUint32(start + 8, true) !== 32000 || view.getUint16(start + 12, true) !== 2
        || view.getUint16(start + 14, true) !== 16) throw invalid();
      format = true;
    } else if (tag(offset) === "data") {
      if (!format || size || !length || length % 2 || length > 1_920_000) throw invalid();
      size = length;
      pcmAt = start;
    }
    offset = start + length + (length % 2);
  }
  if (!format || !size) throw invalid();
  return bytes.subarray(pcmAt, pcmAt + size);
}

interface DecodeRun { process?: any; phase: "vad" | "decode"; cancel: any }

/** Local decoder only. Capture permission and the skill contract belong to their owners. */
export class LocalRecognition {
  readonly language = "en-US";
  readonly available: boolean;
  private active?: DecodeRun;
  private closed = false;
  private readonly model: string;
  private readonly vad: string;

  constructor(private readonly executable: string | null = GLib.find_program_in_path("pocketsphinx"), model?: string, vad?: string) {
    this.model = model ?? (executable
      ? GLib.build_filenamev([GLib.path_get_dirname(GLib.path_get_dirname(executable)), "share", "pocketsphinx", "model", "en-us"])
      : "");
    this.vad = vad ?? (executable ? GLib.build_filenamev([GLib.path_get_dirname(executable), "ouroboros-vad"]) : "");
    this.available = Boolean(executable && [executable, this.vad].every(path =>
      GLib.file_test(path, GLib.FileTest.IS_REGULAR) && GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE))
      && ["en-us/mdef", "en-us/means", "en-us/variances", "en-us/transition_matrices", "en-us/sendump",
        "en-us/feat.params", "en-us/noisedict", "cmudict-en-us.dict", "en-us.lm.bin"]
        .every((path) => GLib.file_test(`${this.model}/${path}`, GLib.FileTest.IS_REGULAR)));
  }

  async transcribe(wav: Uint8Array, language = "en-US", caller?: any): Promise<RecognitionResult> {
    if (this.closed || caller?.is_cancelled()) throw this.cancelled();
    if (!this.available) throw new RecognitionError("unavailable", "Локальный движок распознавания или модель не установлены.");
    if (!["en", "en-us"].includes(language.toLowerCase())) {
      throw new RecognitionError("language", "Установленная модель поддерживает только английский (США).");
    }
    const pcm = recordingPcm(wav), duration = pcm.length / 32000;
    if (this.active) throw new RecognitionError("busy", "Распознавание уже выполняется.");
    // Single-utterance decoders can invent words even for digital silence.
    // This cheap exact-zero guard precedes the native WebRTC voice activity gate.
    if (pcm.every((byte) => byte === 0)) return { text: "", language: "en-US", duration, probability: null };
    // The CLI reads until EOF rather than respecting the data chunk length.
    // Normalize accepted ancillary chunks so they can never become speech samples.
    const input = new Uint8Array(44 + pcm.length), header = new DataView(input.buffer);
    input.set(new TextEncoder().encode("RIFF"), 0);
    input.set(new TextEncoder().encode("WAVEfmt "), 8);
    input.set(new TextEncoder().encode("data"), 36);
    for (const [at, value] of [[4, input.length - 8], [16, 16], [24, 16000], [28, 32000], [40, pcm.length]]) header.setUint32(at, value, true);
    for (const [at, value] of [[20, 1], [22, 1], [32, 2], [34, 16]]) header.setUint16(at, value, true);
    input.set(pcm, 44);
    const run: DecodeRun = { phase: "vad", cancel: new Gio.Cancellable() };
    this.active = run;
    const handler = caller?.connect(() => this.stop(run));
    // Bound decoder runtime as well as audio duration; no network or temporary audio files.
    let timedOut = false;
    const deadline = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 90, () => {
      timedOut = true;
      this.stop(run);
      return GLib.SOURCE_REMOVE;
    });
    try {
      const gate = this.json(await this.output(run, [this.vad], pcm), 1024), samples = pcm.length / 2;
      if (gate?.samples !== samples || !Number.isSafeInteger(gate.voiced_samples) || gate.voiced_samples < 0 || gate.voiced_samples > samples
        || !Number.isSafeInteger(gate.longest_samples) || gate.longest_samples < 0 || gate.longest_samples > gate.voiced_samples
        || typeof gate.speech !== "boolean" || gate.speech !== (gate.longest_samples >= 2880)) throw new Error("invalid VAD result");
      if (!gate.speech) return { text: "", language: "en-US", duration, probability: null };
      run.phase = "decode";
      const data = this.json(await this.output(run, [this.executable!, "-hmm", `${this.model}/en-us`, "-dict", `${this.model}/cmudict-en-us.dict`,
        "-lm", `${this.model}/en-us.lm.bin`, "-loglevel", "ERROR", "single", "-"], input), 256 * 1024);
      if (!data || typeof data.t !== "string" || data.t.length > 16000
        || !Number.isFinite(data.b) || data.b !== 0 || !Number.isFinite(data.d) || data.d < 0 || data.d > duration + 0.1
        || !Number.isFinite(data.p) || data.p < 0 || data.p > 1) throw new Error("invalid result");
      return { text: data.t.trim(), language: "en-US", duration: data.d, probability: data.p };
    } catch (error) {
      if (timedOut) throw new RecognitionError("engine", "Превышено время локального распознавания.");
      if (run.cancel.is_cancelled() || this.closed) throw this.cancelled();
      if (error instanceof RecognitionError) throw error;
      throw new RecognitionError("engine", "Не удалось прочитать результат локального распознавания.");
    } finally {
      // communicate has settled; disconnect outside the cancellation signal callback.
      if (handler) caller.disconnect(handler);
      if (!timedOut) GLib.Source.remove(deadline);
      if (this.active === run) this.active = undefined;
    }
  }

  private json(output: Uint8Array, limit: number): any {
    if (output.length > limit) throw new Error("oversize");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output));
  }

  private async output(run: DecodeRun, argv: string[], input: Uint8Array): Promise<Uint8Array> {
    if (run.cancel.is_cancelled() || this.closed) throw this.cancelled();
    const flags = Gio.SubprocessFlags;
    let process: any;
    try { process = Gio.Subprocess.new(argv, flags.STDIN_PIPE | flags.STDOUT_PIPE | flags.STDERR_SILENCE); }
    catch { throw new RecognitionError("engine", "Не удалось запустить локальное распознавание."); }
    run.process = process;
    try {
      const bytes = await new Promise<Uint8Array>((resolve, reject) => {
        process.communicate_async(GLib.Bytes.new(input), run.cancel, (_source: unknown, result: unknown) => {
          try {
            const [, stdout] = process.communicate_finish(result);
            if (!process.get_successful()) throw new RecognitionError("engine", "Локальное распознавание завершилось с ошибкой.");
            resolve(stdout?.get_data() ?? new Uint8Array());
          } catch (error) { reject(error); }
        });
      });
      if (run.cancel.is_cancelled() || this.closed) throw this.cancelled();
      return bytes;
    } finally { if (run.process === process) run.process = undefined; }
  }

  close(): void {
    this.closed = true;
    if (this.active) this.stop(this.active);
  }

  private stop(run: DecodeRun): void {
    if (run.cancel.is_cancelled()) return;
    run.cancel.cancel();
    run.process?.force_exit();
  }

  private cancelled(): RecognitionError { return new RecognitionError("cancelled", "Распознавание отменено."); }
}
