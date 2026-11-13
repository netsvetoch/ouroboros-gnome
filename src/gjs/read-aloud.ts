import { type HostModules } from "./host-modules.js";
import { type HostModule } from "./host-module.js";
import { type LocalVoice } from "./device-voice.js";
import { Gio, Gtk } from "./gi.js";
import { type SpeechProvider, type UiContributions } from "./ui-contributions.js";
import { alert, button, clear, column, errorText, label, row, sheet } from "./ui.js";

const chunkSize = 240;

function spokenText(text: string): string {
  const lines: string[] = [];
  let fence = "";
  for (const line of text.split(/\r?\n/u)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = "";
      continue;
    }
    if (marker) {
      fence = marker[1];
      lines.push("Блок кода.");
      continue;
    }
    lines.push(line.replace(/^\s*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)?/u, ""));
  }
  return lines.join("\n")
    .replace(/!?\[([^\]\n]*)\]\([^\n)]*\)/gu, "$1")
    .replace(/<https?:\/\/[^>\s]+>/gu, "ссылка")
    .replace(/(`+|\*{1,3}|_{1,3}|~~)([^\n]+?)\1/gu, "$2")
    .trim();
}

function* chunks(text: string): Generator<string> {
  for (const line of text.split("\n")) {
    let group = "";
    for (const piece of line.match(/[^.!?…]+[.!?…]*/gu) ?? []) {
      let remaining = Array.from(piece.trim());
      while (remaining.length > chunkSize) {
        if (group) { yield group; group = ""; }
        const limit = remaining.slice(0, chunkSize + 1).lastIndexOf(" ");
        const take = limit > 0 ? limit : chunkSize;
        const part = remaining.slice(0, take).join("").trim();
        if (part) yield part;
        remaining = remaining.slice(take);
      }
      const part = remaining.join("").trim();
      if (!part) continue;
      if (group && Array.from(group + " " + part).length > chunkSize) {
        yield group;
        group = "";
      }
      group = group ? group + " " + part : part;
    }
    if (group) yield group;
  }
}

interface Controls { address: string; box: any; play: any }
interface Playback { address: string; provider: SpeechProvider; voice: string; module?: HostModule; cancel: any }

export class ReadAloud {
  private rows: Controls[] = [];
  private active?: Playback;
  private dialog?: any;
  private refreshChoice?: () => void;
  private closed = false;

  constructor(private readonly parent: any, private readonly contributions: UiContributions, private readonly modules?: HostModules) {}

  private get providers(): SpeechProvider[] {
    return this.contributions.speech("tts");
  }

  private get preferences() { return this.contributions.current.preferences?.voice ?? {}; }

  private get engine(): SpeechProvider | undefined {
    if (this.preferences.tts) return this.providers.find(({ key }) => key === this.preferences.tts);
    return this.providers.find(provider => !this.reason(provider) && (this.modules?.get(provider)?.provider?.destination || provider.destination) === "device");
  }

  private reason(provider: SpeechProvider | undefined): string {
    if (!provider) return this.preferences.tts ? "Выбранный движок недоступен на шлюзе." : "На шлюзе нет локального движка озвучивания.";
    if (provider.runtime === "client") return this.modules?.reason(provider) ?? "Модуль движка недоступен.";
    return "Для этого движка нужен его собственный модуль озвучивания.";
  }

  updated(): void {
    const current = this.engine;
    if (this.active && (this.active.provider.key !== current?.key || this.active.provider.revision !== current.revision
      || this.active.voice !== (this.preferences.tts_voice ?? "") || this.reason(current))) this.stop();
    this.render();
    this.refreshChoice?.();
  }

  clearRows(): void { this.rows = []; }

  controls(address: string, text: string): any {
    const box = row(6);
    const play = button("Прочитать вслух", () => void this.read(address, text));
    box.append(play);
    box.append(button("Голос озвучивания…", () => this.choose()));
    const controls = { address, box, play };
    this.rows.push(controls);
    this.renderRow(controls);
    return box;
  }

  stop(): void {
    if (!this.active) return;
    const run = this.active;
    this.active = undefined;
    run.cancel.cancel();
    if (run.module) void run.module.call("stop").catch(() => {});
    this.render();
  }

  close(): void {
    this.closed = true;
    this.stop();
    this.clearRows();
    this.dialog?.force_close();
  }

  private render(): void {
    for (const controls of this.rows) this.renderRow(controls);
  }

  private renderRow({ address, box, play }: Controls): void {
    const speaking = this.active?.address === address;
    const engine = this.engine;
    const reason = this.reason(engine);
    box.set_visible(Boolean(this.preferences.tts || this.providers.length));
    play.set_label(speaking ? "Остановить чтение" : "Прочитать вслух");
    play.set_sensitive(speaking || !reason);
    play.set_tooltip_text(reason || engine?.destination || "Место обработки не указано");
  }

  private async read(address: string, text: string): Promise<void> {
    if (this.closed) return;
    if (this.active?.address === address) { this.stop(); return; }
    this.stop();
    const engine = this.engine;
    const reason = this.reason(engine);
    if (!engine || reason) return;
    const words = spokenText(text);
    if (!words) return;
    const run: Playback = { address, provider: engine, voice: this.preferences.tts_voice ?? "", module: this.modules?.get(engine), cancel: new Gio.Cancellable() };
    this.active = run;
    this.render();
    try {
      const voices = await this.voices(engine!, run.cancel);
      if (this.active !== run) return;
      const voice = run.voice ? voices.find(({ id }) => id === run.voice) : undefined;
      if (!voice && (!run.module || run.voice)) throw new Error(run.voice
        ? "Сохранённый голос недоступен на этом устройстве. Выберите голос в настройках озвучивания."
        : "На устройстве нет доступных голосов.");
      for (const chunk of chunks(words)) {
        if (this.active !== run) return;
        if (run.module) await run.module.call("speak", { text: chunk, voice: voice?.id }, run.cancel);
      }
    } catch (error) {
      if (this.active === run) alert(this.parent, "Озвучивание", errorText(error));
    } finally {
      if (this.active === run) {
        this.active = undefined;
        this.render();
      }
    }
  }

  private async voices(engine: SpeechProvider, cancel?: any): Promise<(LocalVoice & { local?: boolean })[]> {
    const module = this.modules?.get(engine);
    if (!module) throw new Error("Модуль движка недоступен.");
    const result = await module.call("voices", {}, cancel);
    if (!Array.isArray(result) || result.some(v => !v || typeof v.id !== "string" || typeof v.label !== "string" || typeof v.lang !== "string")) throw new Error("Движок вернул некорректный список голосов.");
    return result.map(v => ({ id: v.id, label: v.label, language: v.lang, file: "", local: v.local === true }));
  }

  private choose(): void {
    if (this.closed || this.dialog) return;
    const content = column();
    const status = label("Читаю настройки озвучивания…", "dim-label");
    const engines = column(4);
    const options = column(4);
    const dialog = sheet("Голос озвучивания", content);
    this.dialog = dialog;
    content.append(status);
    content.append(engines);
    content.append(options);
    const cancel = new Gio.Cancellable();
    const drafts = new Map<string, string>();
    let version = 0, loaded = false, writing = false, localError = "", voiceCancel: any;
    dialog.connect("closed", () => {
      cancel.cancel(); voiceCancel?.cancel(); version++;
      if (this.dialog === dialog) { this.dialog = undefined; this.refreshChoice = undefined; }
    });
    dialog.present(this.parent);
    const save = async (key: "tts" | "tts_voice", value: string, generation: number) => {
      if (writing || this.closed || this.dialog !== dialog || generation !== version) return;
      writing = true; localError = "";
      engines.set_sensitive(false); options.set_sensitive(false);
      try {
        await this.contributions.saveVoice(key === "tts" ? { tts: value, tts_voice: "" } : { tts_voice: value }, cancel);
        if (this.dialog === dialog) dialog.close();
      } catch (error) {
        if (this.dialog === dialog) { localError = errorText(error); status.set_label(localError); }
      } finally {
        writing = false;
        if (this.dialog === dialog) { engines.set_sensitive(true); options.set_sensitive(true); this.refreshChoice?.(); }
      }
    };
    const render = async () => {
      if (!loaded || writing || this.closed || this.dialog !== dialog) return;
      const generation = ++version;
      voiceCancel?.cancel(); voiceCancel = new Gio.Cancellable();
      const alive = () => !this.closed && this.dialog === dialog && version === generation && !writing;
      clear(engines); clear(options);
      const engine = this.engine, reason = this.reason(engine);
      status.set_label([localError, this.contributions.error, reason].filter(Boolean).join("\n"));
      engines.append(label("Движок озвучивания", "heading"));
      const automatic = button("Автоматически выбирать локальный движок", () => void save("tts", "", generation));
      automatic.set_sensitive(Boolean(this.preferences.tts)); engines.append(automatic);
      for (const provider of this.providers) {
        const why = this.reason(provider), chosen = provider.key === this.preferences.tts;
        const pick = button((this.modules?.get(provider)?.provider?.label || provider.label) + (chosen ? " · Выбран" : ""), () => void save("tts", provider.key, generation));
        pick.set_sensitive(!why && !chosen); pick.set_tooltip_text(why || provider.destination || "Место обработки не указано");
        engines.append(pick); if (why) engines.append(label(why, "dim-label"));
      }
      if (reason || !engine) return;
      try {
        const voices = await this.voices(engine, voiceCancel);
        if (!alive()) return;
        options.append(label("Голос движка", "heading"));
        const selected = this.preferences.tts_voice || "", wanted = drafts.get(engine.key) ?? selected;
        const selectedIndex = wanted ? voices.findIndex(({ id }) => id === wanted) + 1 : 0;
        const choices = ["Автоматически", ...voices.map(({ label, language, local }) => `${label} · ${language} · ${local ? "На этом устройстве" : "Онлайн-голос"}`)];
        const missing = Boolean(wanted && selectedIndex === 0);
        if (missing) choices.unshift("Выбранный голос недоступен");
        const select = Gtk.DropDown.new_from_strings(choices);
        select.set_enable_search(true); select.set_selected(selectedIndex);
        const value = (): string | undefined => {
          const index = select.get_selected() - Number(missing);
          return index < 0 ? undefined : voices[index - 1]?.id ?? "";
        };
        const apply = button("Сохранить голос", () => { const next = value(); if (next !== undefined) void save("tts_voice", next, generation); });
        const changed = (remember: boolean) => { if (alive()) {
          const next = value();
          if (remember && next !== undefined) { if (next === selected) drafts.delete(engine.key); else drafts.set(engine.key, next); }
          apply.set_sensitive(next !== undefined && next !== selected);
        } };
        changed(false); select.connect("notify::selected", () => changed(true));
        options.append(select); options.append(apply);
        if (!voices.length) options.append(label("Движок пока не сообщил голоса. Можно использовать автоматический выбор.", "dim-label"));
      } catch (error) { if (alive()) status.set_label(errorText(error)); }
    };
    this.refreshChoice = () => { void render(); };
    void this.contributions.refresh().then(() => { loaded = true; this.refreshChoice?.(); }).catch(error => { if (this.dialog === dialog) status.set_label(errorText(error)); });
  }
}
