import { type HostModules } from "./host-modules.js";
import { type CaptureLease } from "./capture-lease.js";
import { type HostModule } from "./host-module.js";
import { DictationAudio, dictationFormat } from "./dictation-audio.js";
import { LocalRecognition } from "./local-recognition.js";
import { type Gateway, query } from "./gateway.js";
import { Gio, Gtk } from "./gi.js";
import { contributionRoute, type SpeechProvider, type UiContributions } from "./ui-contributions.js";
import { alert, button, clear, column, errorText, label, row, sheet } from "./ui.js";

export interface DictationDraft {
  room: number;
  revision: number;
  text: string;
  start: number;
  end: number;
  editable: boolean;
}

interface ActiveDictation {
  lease?: CaptureLease;
  room: number;
  provider?: SpeechProvider;
  local?: boolean;
  lang: string;
  cancellable: any;
  recorder?: DictationAudio;
  module?: HostModule;
  started?: boolean;
  draft?: DictationDraft;
}

function destination(value: string | undefined, gateway: string): string {
  if (value === "device") return "Обработка на этом устройстве";
  if (value === "host") return `Обработка на шлюзе Ouroboros (${gateway})`;
  if (value?.startsWith("vendor:")) return `Аудио получит ${value.slice(7)}`;
  return "Место обработки не указано";
}

function speechRoute(provider: SpeechProvider): string | undefined {
  return contributionRoute(provider.skill, provider.route_url);
}

function unavailability(provider: SpeechProvider): string {
  if (provider.runtime !== "server") return "Для этого движка нужен браузерный модуль распознавания.";
  if (!speechRoute(provider)) return "Шлюз не сообщил адрес распознавания.";
  try {
    if (dictationFormat(provider)) return "";
    return "Ни один из форматов движка недоступен на этом устройстве.";
  } catch (error) { return errorText(error); }
}

export class Dictation {
  private readonly local = new LocalRecognition();
  private localSelected = false;
  private readonly localLimits = { formats: ["audio/wav"], max_seconds: 15, max_bytes: 480044 };
  readonly widget = column(4);
  private readonly mic = button("Диктовать", () => this.toggle());
  private readonly cancelButton = button("Отменить диктовку", () => this.cancel());
  private readonly status = label("", "dim-label");
  private readonly offer = column(4);
  private readonly offers = new Map<number, string>();
  private readonly languages = new Map<string, string>();
  private readonly reasons = new WeakMap<SpeechProvider, string>();
  private active?: ActiveDictation;
  private dialog?: any;
  private refreshChoice?: () => void;
  private closed = false;
  private offerRoom?: number;
  private offerWords?: string;
  private offerInsert?: any;

  constructor(private readonly parent: any, private readonly gateway: Gateway,
    private readonly contributions: UiContributions,
    private readonly readDraft: () => DictationDraft,
    private readonly insert: (text: string, snapshot: DictationDraft) => void,
    private readonly openSkills?: (name: string) => void,
    private readonly modules?: HostModules) {
    const controls = row(6);
    controls.append(this.mic);
    controls.append(button("Движок диктовки…", () => this.choose()));
    controls.append(this.cancelButton);
    this.widget.append(controls);
    this.widget.append(this.status);
    this.widget.append(this.offer);
    this.sync();
  }

  private get providers(): SpeechProvider[] {
    return this.contributions.speech("stt");
  }

  private get selectedKey(): string { return this.contributions.current.preferences?.voice?.stt ?? ""; }

  private get selected(): SpeechProvider | undefined {
    return this.providers.find(({ key }) => key === this.selectedKey);
  }

  private reason(provider: SpeechProvider): string {
    if (provider.runtime === "client") return this.modules?.reason(provider) ?? "Модуль движка недоступен.";
    const saved = this.reasons.get(provider);
    if (saved !== undefined) return saved;
    const reason = unavailability(provider);
    this.reasons.set(provider, reason);
    return reason;
  }

  private localReason(): string {
    if (!this.local.available) return "Локальный движок PocketSphinx или английская модель не установлены.";
    try { return dictationFormat(this.localLimits) ? "" : "Микрофон или запись WAV недоступны."; }
    catch (error) { return errorText(error); }
  }

  updated(): void {
    const previous = this.active?.provider;
    const selected = this.selected;
    if (previous && (previous.key !== selected?.key || previous.revision !== selected.revision
      || previous.route_url !== selected.route_url || this.active?.module && (this.active.module !== this.modules?.get(selected) || this.reason(selected)))) {
      this.cancel("Движок диктовки изменился.");
    }
    this.sync();
    this.refreshChoice?.();
  }

  sync(): void {
    const draft = this.readDraft();
    const selected = this.selected;
    const why = this.localSelected ? this.localReason() : selected ? this.reason(selected) : this.selectedKey ? "Выбранный движок недоступен." : "";
    this.mic.set_visible(Boolean(this.active || this.localSelected || selected));
    this.mic.set_sensitive(this.active ? Boolean((this.active.recorder || this.active.started) && !this.active.draft) : draft.editable && !why);
    this.mic.set_label(this.active?.draft ? "Распознавание…" : this.active ? "Завершить запись" : "Диктовать");
    this.mic.set_tooltip_text(!why && this.localSelected ? "На этом устройстве · English (US) · до 15 секунд"
      : selected && !why ? destination(selected.destination, this.gateway.base) : (why || null));
    this.cancelButton.set_visible(Boolean(this.active));
    const words = this.offers.get(draft.room);
    if (draft.room === this.offerRoom && words === this.offerWords) {
      this.offerInsert?.set_sensitive(draft.editable);
      return;
    }
    this.offerRoom = draft.room;
    this.offerWords = words;
    this.offerInsert = undefined;
    clear(this.offer);
    if (!words) return;
    const text = label(words);
    text.set_selectable(true);
    this.offer.append(label("Результат диктовки готов. Его можно вставить в черновик.", "dim-label"));
    this.offer.append(text);
    const actions = row(6);
    const insert = button("Вставить", () => {
      const current = this.readDraft();
      if (this.closed || current.room !== draft.room || !current.editable) return;
      this.offers.delete(draft.room);
      this.insert(words, current);
      this.sync();
    });
    insert.set_sensitive(draft.editable);
    this.offerInsert = insert;
    actions.append(insert);
    actions.append(button("Скопировать", () => { if (!this.closed) this.offer.get_clipboard().set(words); }));
    actions.append(button("Убрать", () => { if (!this.closed) { this.offers.delete(draft.room); this.sync(); } }));
    this.offer.append(actions);
  }

  leave(): void {
    if (this.active && !this.active.draft) this.cancel();
  }

  close(): void {
    this.closed = true;
    this.active?.cancellable.cancel();
    this.active?.recorder?.cancel();
    this.local.close();
    if (this.active?.module) { this.active.module.media.stop(); void this.active.module.call("stop").catch(() => {}); }
    this.active?.lease?.release();
    this.active = undefined;
    this.dialog?.force_close();
    this.offers.clear();
    this.offerInsert = undefined;
    clear(this.offer);
  }

  private toggle(): void {
    if (this.closed) return;
    if (this.active) {
      if (!this.active.draft) {
        this.active.draft = this.readDraft();
        this.active.recorder?.stop();
        if (this.active.module && this.active.started) void this.finishClient(this.active);
        this.sync();
      }
      return;
    }
    const provider = this.selected;
    const draft = this.readDraft();
    if ((!provider && !this.localSelected) || !draft.editable) return;
    try {
      const reason = this.localSelected ? this.localReason() : this.reason(provider!);
      if (reason) throw new Error(reason);
      if (!this.localSelected && provider!.runtime === "client") {
        const provider = this.selected!;
        const module = this.modules?.get(provider);
        if (!module) throw new Error("Модуль движка недоступен.");
        const run: ActiveDictation = { room: draft.room, provider, module, cancellable: new Gio.Cancellable(), lang: this.languages.get(provider.key) ?? "" };
        run.lease = module.media.reserveRecognition();
        this.active = run;
        this.status.set_label("Запускаю диктовку…"); this.sync();
        void module.call("start", { lang: run.lang }, run.cancellable).then(() => {
          if (this.active !== run) return;
          run.started = true; this.status.set_label(`Диктовка запущена. Заявлено навыком: ${destination(module.provider?.destination || provider.destination, this.gateway.base)}.`); this.sync();
        }).catch(error => { if (this.active === run) this.cancel(errorText(error)); });
        return;
      }
      const limits = this.localSelected ? this.localLimits : provider!;
      const format = dictationFormat(limits)!;
      const run: ActiveDictation = { room: draft.room, provider: this.localSelected ? undefined : provider,
        local: this.localSelected, cancellable: new Gio.Cancellable(),
        lang: this.localSelected ? "en-US" : this.languages.get(provider!.key) ?? "" };
      run.recorder = new DictationAudio(format, limits, () => {
        run.draft ??= this.readDraft();
        this.status.set_label("Распознаю запись…");
        this.sync();
      }, (error, bytes) => {
        run.recorder = undefined;
        void this.transcribe(run, format.type, error, bytes);
      });
      this.active = run;
      this.status.set_label(run.local ? "Идёт запись. На этом устройстве · English (US) · до 15 секунд."
        : `Идёт запись. ${destination(provider!.destination, this.gateway.base)}.`);
      this.sync();
      run.recorder.start();
    } catch (error) { this.cancel(errorText(error)); }
  }

  private async transcribe(run: ActiveDictation, type: string, error: unknown, bytes?: Uint8Array): Promise<void> {
    if (run !== this.active) return;
    try {
      if (error) throw error;
      if (!bytes?.length) { this.status.set_label("Запись пуста."); return; }
      let result: { text?: string; status?: string; error?: { message?: string } };
      if (run.local) {
        const decoded = await this.local.transcribe(bytes, run.lang, run.cancellable);
        result = { text: decoded.text, status: decoded.text ? "ok" : "no_speech" };
      } else {
        const route = speechRoute(run.provider!)!;
        result = await this.gateway.audio(route + (run.lang ? query({ lang: run.lang }) : ""), type, bytes, run.cancellable);
      }
      if (run !== this.active) return;
      this.accept(run, result);
    } catch (failure) {
      if (run === this.active) this.status.set_label(errorText(failure));
    } finally {
      if (run === this.active) {
        this.active = undefined;
        this.sync();
      }
    }
  }

  private accept(run: ActiveDictation, result: any): void {
    if (run !== this.active) return;
    if ((result?.status === "no_speech" && result.text === "") || result?.no_speech === true) {
      this.status.set_label("Речь в записи не распознана."); return;
    }
    const text = typeof result?.text === "string" ? result.text.trim() : "";
    if (!text) throw new Error(result?.error?.message || "Движок вернул пустую расшифровку.");
    const saved = run.draft, current = this.readDraft();
    if (saved && current.room === run.room && saved.revision === current.revision && saved.text === current.text && current.editable) this.insert(text, saved);
    else this.offers.set(run.room, text);
    this.status.set_label("");
  }

  private async finishClient(run: ActiveDictation): Promise<void> {
    try { this.accept(run, await run.module!.call("finish", {}, run.cancellable)); }
    catch (error) { if (this.active === run) this.status.set_label(errorText(error)); }
    finally {
      run.lease?.release();
      if (this.active === run) { run.module!.media.stop(); this.active = undefined; this.sync(); }
    }
  }

  cancel(message = ""): void {
    const run = this.active;
    this.active = undefined;
    run?.cancellable.cancel();
    run?.recorder?.cancel();
    if (run?.module) { run.module.media.stop(); void run.module.call("stop").catch(() => {}); }
    run?.lease?.release();
    this.status.set_label(message);
    this.sync();
  }

  private choose(): void {
    if (this.closed || this.dialog) return;
    const content = column();
    const status = label("Читаю список движков…", "dim-label");
    const list = column();
    const dialog = sheet("Движок диктовки", content);
    this.dialog = dialog;
    content.append(status);
    content.append(list);
    const cancel = new Gio.Cancellable();
    let version = 0, loaded = false, localError = "";
    dialog.connect("closed", () => { cancel.cancel(); version++; if (this.dialog === dialog) { this.dialog = undefined; this.refreshChoice = undefined; } });
    dialog.present(this.parent);
    let busy = false;
    const write = async (work: () => Promise<void>) => {
      if (busy || this.closed || this.dialog !== dialog) return;
      busy = true; localError = "";
      list.set_sensitive(false);
      try {
        await work();
        if (this.dialog === dialog) dialog.close();
      } catch (error) {
        if (this.dialog === dialog) { localError = errorText(error); status.set_label(localError); }
      } finally {
        busy = false;
        if (this.dialog === dialog) { list.set_sensitive(true); this.refreshChoice?.(); }
      }
    };
    const browse = (name: string) => {
      if (this.closed || this.dialog !== dialog || !this.openSkills) return;
      dialog.close();
      this.openSkills(name);
    };
    const render = () => {
      if (!loaded || busy || this.dialog !== dialog || this.closed) return;
      const generation = ++version;
      const execute = (work: () => Promise<void>) => { if (generation === version) void write(work); };
      const selectRemote = (work: () => Promise<void>) => execute(async () => {
        await work();
        if (this.closed || this.dialog !== dialog) return;
        if (this.localSelected) this.cancel(this.status.get_label());
        this.localSelected = false; this.sync();
      });
      const view = (name: string) => { if (generation === version) browse(name); };
      clear(list);
      status.set_label(localError || this.contributions.error || (!this.localSelected && this.selectedKey && !this.selected
        ? `Выбранный движок недоступен (${this.selectedKey}).` : ""));
      list.append(button("Отключить диктовку", () => selectRemote(() => this.contributions.saveVoice({ stt: "" }, cancel))));
      const localWhy = this.localReason();
      const local = column(4);
      const chooseLocal = button("PocketSphinx · English (US)" + (this.localSelected ? " · Выбран" : ""), () => {
        if (generation !== version || this.closed || this.dialog !== dialog) return;
        this.cancel(); this.localSelected = true; this.sync(); dialog.close();
      });
      chooseLocal.set_sensitive(!localWhy && !this.localSelected);
      local.append(chooseLocal);
      local.append(label(["Обработка на этом устройстве · Только английский (США) · До 15 секунд.",
        "Выбор действует в этом окне до закрытия подключения. Настройка движка на шлюзе сохраняется.",
        "В шуме возможны ошибочные слова. Проверьте текст перед отправкой.", localWhy].filter(Boolean).join("\n"), "dim-label"));
      list.append(local);
      for (const provider of this.providers) {
        const why = this.reason(provider);
        const group = column(4);
        const pick = button((this.modules?.get(provider)?.provider?.label || provider.label) + (!this.localSelected && provider.key === this.selectedKey ? " · Выбран" : ""),
          () => selectRemote(() => this.contributions.saveVoice({ stt: provider.key }, cancel)));
        pick.set_sensitive(!why && (this.localSelected || provider.key !== this.selectedKey));
        group.append(pick);
        group.append(label([destination(provider.destination, this.gateway.base), provider.title, why]
          .filter(Boolean).join("\n"), "dim-label"));
        if (this.modules?.get(provider)?.provider?.nativeRecognition) group.append(label(
          "Доступный интерфейс SpeechRecognition: обработка на этом устройстве · Только English (US). Навык может использовать собственный движок; его заявление о месте обработки показано выше.", "dim-label"));
        const languages = provider.languages?.filter((value) => value && value !== "auto" && value !== "*") ?? [];
        if (!why && languages.length) {
          const values = ["", ...languages];
          const language = Gtk.DropDown.new_from_strings(["Язык автоматически", ...languages]);
          language.set_selected(Math.max(0, values.indexOf(this.languages.get(provider.key) ?? "")));
          language.connect("notify::selected", () => { if (generation === version && this.dialog === dialog && !this.closed) this.languages.set(provider.key, values[language.get_selected()] ?? ""); });
          group.append(language);
        }
        list.append(group);
      }
      for (const offer of this.contributions.current.offers?.stt ?? []) {
        const key = `${offer.skill}:${offer.id}`;
        if (this.providers.some((provider) => provider.key === key)) continue;
        const group = column(4);
        group.append(label([offer.label, destination(offer.destination, this.gateway.base), offer.title,
          offer.install_size].filter(Boolean).join("\n")));
        if (offer.installed) {
          group.append(button("Включить и выбрать", () => selectRemote(async () => {
            const result = await this.gateway.json<{ pending?: boolean; message?: string; extension_action?: string; extension_reason?: string }>(
              "POST", `/api/skills/${encodeURIComponent(offer.skill)}/toggle`, { enabled: true }, undefined, false, cancel);
            if (this.closed || this.dialog !== dialog) return;
            if (result?.extension_action === "extension_load_error") {
              throw new Error(result.extension_reason || "Не удалось запустить навык.");
            }
            if (result?.pending) {
              await this.contributions.saveVoice({ stt: key }, cancel);
              this.status.set_label(result.message || "Шлюз запускает движок диктовки.");
              return;
            }
            await this.contributions.refresh();
            const provider = this.providers.find((candidate) => candidate.key === key);
            const why = provider ? this.reason(provider) : "Движок ещё не опубликован шлюзом. Обновите список после запуска навыка.";
            if (why) throw new Error(why);
            await this.contributions.saveVoice({ stt: key }, cancel);
          })));
        } else if (this.openSkills) {
          group.append(button("Найти в каталоге", () => view(offer.skill)));
        }
        list.append(group);
      }
      if (this.openSkills) {
        list.append(button("Найти движок в каталоге навыков…", () => view("")));
        if (!this.providers.some(({ skill }) => skill === "whisper-voice")) {
          list.append(button("Найти Whisper в каталоге…", () => view("whisper-voice")));
        }
      }
    };
    this.refreshChoice = render;
    void this.contributions.refresh().then(() => { loaded = true; render(); }).catch((error) => { if (this.dialog === dialog) alert(this.parent, "Диктовка", errorText(error)); });
  }
}
