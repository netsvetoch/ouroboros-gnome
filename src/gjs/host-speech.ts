import { DeviceVoice, type LocalVoice } from "./device-voice.js";
import { GLib } from "./gi.js";

/** Local speech capability of one module; providers still execute their reviewed JS. */
export class HostSpeech {
  private readonly voice = new DeviceVoice();
  private voices: LocalVoice[] = [];
  private run = 0;
  private closed = false;

  constructor(private readonly event: (args: object) => void) {}

  async prepare(): Promise<void> {
    if (!this.voice.available) return;
    try { this.voices = await this.voice.voices(); } catch { this.voices = []; }
  }

  configuration(): object | null {
    const languages: string[] = GLib.get_language_names().map((s: string) => s.split(/[.@]/u)[0].replaceAll("_", "-").toLowerCase());
    let preferred: LocalVoice | undefined;
    for (const lang of [...languages, "en-us", "en"]) {
      preferred = this.voices.find(v => v.language.toLowerCase() === lang);
      if (preferred) break;
    }
    preferred ??= this.voices[0];
    return this.voices.length ? { voices: [...this.voices].sort((a, b) => Number(b === preferred) - Number(a === preferred))
      .map(v => ({ voiceURI: v.id, name: v.label, lang: v.language, localService: true, default: v === preferred })) } : null;
  }

  receive(message: any): void {
    if (this.closed) return;
    if (message.op === "cancel") { this.run++; this.voice.stop(); return; }
    if (message.op === "pause") { this.voice.pause(); return; }
    if (message.op === "resume") { this.voice.resume(); return; }
    if (message.op !== "speak" || !Number.isSafeInteger(message.id) || typeof message.text !== "string") return;
    const id = message.id, run = ++this.run;
    this.voice.stop();
    const selected = this.voices.find(v => v.id === message.voice);
    if (!selected) { this.event({ id, type: "error", error: "voice-unavailable" }); return; }
    const valid = (n: unknown, low: number, high: number) => typeof n === "number" && Number.isFinite(n) && n >= low && n <= high;
    if (!valid(message.rate, 0.1, 10) || !valid(message.pitch, 0, 2) || !valid(message.volume, 0, 1)) {
      this.event({ id, type: "error", error: "invalid-argument" }); return;
    }
    const current = () => !this.closed && run === this.run;
    void this.voice.speak(message.text, selected, { rate: message.rate, pitch: message.pitch, volume: message.volume,
      start: () => { if (current()) this.event({ id, type: "start" }); },
    }).then(() => { if (current()) this.event({ id, type: "end" }); })
      .catch(() => { if (current()) this.event({ id, type: "error", error: "synthesis-failed" }); });
  }

  close(): void { this.closed = true; this.run++; this.voice.stop(); }
}
