import { DictationAudio, dictationFormat } from "./dictation-audio.js";
import { LocalRecognition } from "./local-recognition.js";
import { type CaptureLease } from "./capture-lease.js";
import { type HostMedia } from "./host-media.js";
import { type HostContribution } from "./ui-contributions.js";
import { Adw, Gio, Gtk } from "./gi.js";

export interface RecognitionCapability { language: "en-US"; localService: true; maxSeconds: number }
interface Run {
  id: number; continuous: boolean; ending: boolean; started: boolean; audio: boolean; results: number;
  cancel: any; lease: CaptureLease; dialog?: any; recorder?: DictationAudio;
  queue: Uint8Array[]; decoding: boolean; captureEnded: boolean;
}

/** The native side of SpeechRecognition, owned by one reviewed module. */
export class HostRecognition {
  private readonly decoder = new LocalRecognition();
  private readonly limits = { formats: ["audio/wav"], max_seconds: 15, max_bytes: 480044 };
  private active?: Run;
  private closed = false;

  constructor(private readonly view: any, private readonly media: HostMedia, private readonly item: HostContribution,
    private readonly gateway: string, private readonly event: (value: object) => void,
    private readonly notice?: (message: string) => void) {}

  configuration(): RecognitionCapability | null {
    try { return this.decoder.available && dictationFormat(this.limits) ? { language: "en-US", localService: true, maxSeconds: 15 } : null; }
    catch { return null; }
  }

  receive(message: any): void {
    if (this.closed || !Number.isSafeInteger(message.id) || message.id < 1) return;
    if (message.op === "abort") { if (this.active?.id === message.id) this.abort(); return; }
    if (message.op === "stop") { if (this.active?.id === message.id) this.finish(); return; }
    if (message.op !== "start") return;
    const refuse = (error: string) => { this.event({ id: message.id, type: "error", error }); this.event({ id: message.id, type: "end" }); };
    if (this.active) { refuse("audio-capture"); return; }
    if (!this.configuration()) { refuse("service-not-allowed"); return; }
    if (typeof message.lang !== "string" || !["", "en", "en-us"].includes(message.lang.toLowerCase())) { refuse("language-not-supported"); return; }
    const parent = this.view.get_root();
    if (!(parent instanceof Gtk.Window)) { refuse("not-allowed"); return; }
    let lease: CaptureLease;
    try { lease = this.media.reserveRecognition(); } catch { refuse("audio-capture"); return; }
    const run: Run = { id: message.id, continuous: message.continuous === true, ending: false, started: false, audio: false,
      results: 0, lease, cancel: new Gio.Cancellable(), queue: [], decoding: false, captureEnded: false };
    this.active = run;
    const dialog = new Adw.AlertDialog({ heading: "Разрешить распознавание речи?",
      body: `Навык «${this.item.skill_label || this.item.skill}» (${this.item.label}) на ${this.gateway} запрашивает микрофон. SpeechRecognition выполняется на этом устройстве: PocketSphinx, только English (US), запись блоками до 15 секунд. Этот интерфейс передаёт навыку распознанный текст. Захват и распознавание можно остановить в чате.` });
    run.dialog = dialog;
    dialog.add_response("deny", "Не разрешать"); dialog.add_response("allow", "Разрешить");
    dialog.set_default_response("deny"); dialog.set_close_response("deny");
    dialog.connect("response", (_: unknown, response: string) => {
      if (this.active !== run || this.closed) return;
      run.dialog = undefined;
      if (response !== "allow") { this.end(run, "not-allowed"); return; }
      this.record(run);
    });
    dialog.present(parent);
  }

  finish(): void {
    const run = this.active; if (!run || run.ending) return;
    run.ending = true;
    if (run.dialog) this.end(run);
    else run.recorder?.stop();
  }

  abort(): void { if (this.active) this.end(this.active, "aborted"); }

  close(): void { this.closed = true; this.abort(); this.decoder.close(); }

  private emit(run: Run, type: string, extra: object = {}): void {
    if (!this.closed && this.active === run) this.event({ id: run.id, type, ...extra });
  }

  private record(run: Run): void {
    if (this.closed || this.active !== run) return;
    const format = dictationFormat(this.limits);
    if (!format) { this.end(run, "audio-capture"); return; }
    run.recorder = new DictationAudio(format, this.limits, () => {
      if (this.active !== run) return;
      this.audioEnd(run); this.media.setRecognitionState("processing");
    }, (error, bytes) => {
      run.recorder = undefined;
      if (this.active !== run) return;
      run.captureEnded = true;
      if (error) { this.end(run, "audio-capture"); return; }
      this.enqueue(run, bytes);
    }, undefined, this.media, run.continuous ? bytes => this.enqueue(run, bytes) : undefined);
    run.recorder.start();
    if (this.active !== run) return;
    if (!run.started) { run.started = true; this.emit(run, "start"); }
    run.audio = true; this.media.setRecognitionState("recording"); this.emit(run, "audiostart");
  }

  private audioEnd(run: Run): void {
    if (run.audio) { run.audio = false; this.emit(run, "audioend"); }
  }

  private enqueue(run: Run, bytes?: Uint8Array): void {
    if (this.closed || this.active !== run) return;
    if (bytes?.length) {
      // One in-flight segment and at most two waiting segments. A slow engine
      // must stop explicitly, never silently discard audio or grow unbounded.
      if (run.queue.length >= 2) {
        this.end(run, "service-not-allowed");
        this.notice?.("Распознавание не успевает за записью. Запись остановлена. Попробуйте короткие фразы.");
        return;
      }
      run.queue.push(bytes);
    }
    void this.drain(run);
  }

  private async drain(run: Run): Promise<void> {
    if (this.closed || this.active !== run || run.decoding) return;
    run.decoding = true;
    try {
      while (run.queue.length) {
        const bytes = run.queue.shift()!;
        const text = (await this.decoder.transcribe(bytes, "en-US", run.cancel)).text;
        if (this.closed || this.active !== run) return;
        if (text) { run.results++; this.emit(run, "result", { text }); }
      }
      if (run.captureEnded) this.end(run, !run.results ? "no-speech" : undefined);
    } catch { if (this.active === run) this.end(run, "service-not-allowed"); }
    finally { run.decoding = false; }
  }

  private end(run: Run, error?: string): void {
    if (this.active !== run) return;
    this.audioEnd(run);
    this.active = undefined;
    run.queue.length = 0;
    run.cancel.cancel(); run.recorder?.cancel();
    if (run.dialog?.get_mapped()) run.dialog.force_close();
    run.dialog = undefined;
    run.lease.release(); this.media.setRecognitionState();
    if (!this.closed) {
      if (error) this.event({ id: run.id, type: "error", error });
      this.event({ id: run.id, type: "end" });
    }
  }
}
