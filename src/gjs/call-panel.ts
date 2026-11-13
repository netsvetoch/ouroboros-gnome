import { CallSession, defaultCallFeature, type CallPhase, type CallRoom, type CallView } from "./call-session.js";
import { CallSettings, type CallConfig, callSettingsPath, readCallConfig } from "./call-settings.js";
import { CallDeviceSettings } from "./call-device-settings.js";
import { CallContext } from "./call-context.js";
import { CallFeatures } from "./call-features.js";
import { CallVideo } from "./call-video.js";
import { type Gateway, type GatewayFrame } from "./gateway.js";
import { Adw, Gio, Gtk } from "./gi.js";
import { button, column, errorText, label, row } from "./ui.js";

const phases: Record<CallPhase, string> = {
  idle: "", devices: "Подключаю микрофон и аудиовыход…", admitting: "Запрашиваю открытие вызова…",
  preparing: "Ouroboros готовит вызов…", connecting: "Подключаю голосовой канал…", live: "Голосовой вызов",
  reconnecting: "Шлюз восстанавливает голосовое соединение…", closing: "Завершаю вызов…",
  closed: "Вызов завершён", failed: "Вызов прерван",
};

function transcriptText(captions: CallView["captions"]): string {
  return captions.filter((caption) => caption.text).map((caption) =>
    `${caption.speaker === "owner" ? "Вы" : "Ouroboros"} · ${caption.text}`).join("\n");
}

export class CallPanel {
  readonly widget = column(4);
  private readonly controls = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, column_spacing: 6, row_spacing: 4 });
  private readonly start = button("Позвонить", () => {
    if (!this.disposed && this.start.get_sensitive() && this.start.get_visible()) void this.session.start(this.room, this.features.selected);
  });
  private readonly settingsButton = button("Настройки вызовов…", () => this.openSelectedSettings());
  private readonly featureButton = button("Функция вызова…", () => this.features.show());
  private readonly devicesButton = button("Устройства вызова…", () => { if (!this.disposed) this.deviceSettings.show(this.session.devices); });
  private readonly contextButton = button("Контекст вызова…", () => this.context.show());
  private readonly mute = button("Выключить микрофон", () => this.session.setMuted(!this.session.current.muted));
  private readonly end = button("Завершить", () => this.session.end());
  private readonly copy = button("Скопировать расшифровку", () => { if (!this.disposed) this.widget.get_clipboard().set(transcriptText(this.session.current.captions)); });
  private readonly status = label("", "dim-label");
  private readonly featureStatus = label("", "dim-label");
  private readonly vision = row();
  private readonly camera = button("Показать камеру", () => this.session.toggleVideo("camera"));
  private readonly screen = button("Показать экран или окно", () => this.session.toggleVideo("screen"));
  private readonly visionStatus = label("", "dim-label");
  private readonly transcript = new Gtk.TextView({ editable: false, cursor_visible: false, wrap_mode: Gtk.WrapMode.WORD_CHAR });
  private readonly scroll = new Gtk.ScrolledWindow({ child: this.transcript, min_content_height: 95, max_content_height: 145,
    propagate_natural_height: true, hscrollbar_policy: Gtk.PolicyType.NEVER });
  private readonly session: CallSession;
  private readonly settings: CallSettings;
  private readonly deviceSettings: CallDeviceSettings;
  private readonly context: CallContext;
  private readonly features: CallFeatures;
  private config?: CallConfig;
  private configProblem = "";
  private reading?: any;
  private parentSignal = 0;
  private disposed = false;
  private read = 0;
  private lastCaptions?: CallView["captions"];

  constructor(private readonly parent: any, private readonly gateway: Gateway, private room: CallRoom,
    finished: () => void, private readonly changed?: (view: CallView) => void) {
    this.session = new CallSession(gateway, (view) => {
      this.render();
      this.changed?.(view);
    }, finished, undefined, (handlers) => new CallVideo(parent, handlers));
    this.features = new CallFeatures(parent, gateway, () => this.session.current.active, () => this.render());
    this.context = new CallContext(parent, this.session);
    this.settings = new CallSettings(parent, gateway, (config) => {
      this.read++;
      this.reading?.cancel();
      this.acceptConfig(config);
    }, (dialog) => this.deviceSettings.show(this.session.devices, dialog));
    this.deviceSettings = new CallDeviceSettings(parent, (prefs) => this.session.setDevices(prefs));
    this.controls.append(this.start);
    this.controls.append(this.mute);
    this.controls.append(this.end);
    this.controls.append(this.settingsButton);
    this.controls.append(this.featureButton);
    this.controls.append(this.devicesButton);
    this.controls.append(this.contextButton);
    this.controls.append(this.copy);
    this.end.add_css_class("destructive-action");
    this.widget.append(this.controls);
    this.widget.append(this.status);
    this.widget.append(this.featureStatus);
    this.vision.append(this.camera);
    this.vision.append(this.screen);
    this.widget.append(this.vision);
    this.widget.append(this.visionStatus);
    this.widget.append(this.scroll);
    this.status.set_selectable(true);
    if (parent instanceof Adw.Dialog || parent instanceof Gtk.Window) this.parentSignal = parent.connect(
      parent instanceof Gtk.Window ? "close-request" : "closed", () => {
        if (this.parentSignal) { parent.disconnect(this.parentSignal); this.parentSignal = 0; }
        void this.close(); return false;
      });
    this.render();
    void this.refresh();
  }

  setRoom(room: CallRoom): void { if (!this.disposed) { this.room = room; this.render(); } }

  showSettings(parent: any): void { this.settings.show(parent); }

  endCall(): void { if (!this.disposed) this.session.end(); }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    const version = ++this.read;
    this.reading?.cancel();
    const cancel = new Gio.Cancellable();
    this.reading = cancel;
    const features = this.features.refresh();
    try {
      const raw = await this.gateway.json<unknown>("GET", callSettingsPath, undefined, undefined, false, cancel);
      if (!this.disposed && version === this.read) this.acceptConfig(readCallConfig(raw));
    } catch (error) {
      if (!this.disposed && version === this.read) {
        this.config = undefined;
        this.configProblem = `Не удалось проверить готовность вызовов. ${errorText(error)}`;
        this.render();
      }
    } finally { if (this.reading === cancel) this.reading = undefined; }
    await features;
  }

  frame(frame: GatewayFrame): void {
    if (this.disposed) return;
    if (frame.type === "extension_lifecycle" && typeof frame.skill === "string" && frame.skill !== "_cards") {
      void this.refresh();
    }
    this.session.onChatFrame(frame);
  }

  close(): Promise<void> | undefined {
    if (this.disposed) return this.session.close();
    this.disposed = true;
    if (this.parentSignal) { this.parent.disconnect(this.parentSignal); this.parentSignal = 0; }
    ++this.read;
    this.reading?.cancel();
    this.settings.close();
    this.deviceSettings.close();
    this.context.close();
    this.features.close();
    return this.session.close();
  }

  private acceptConfig(config: CallConfig): void {
    this.config = config;
    this.configProblem = "";
    const view = this.session.current;
    if (config.enabled === false && view.active && view.requestedFeature === defaultCallFeature && view.joined !== true) this.session.end();
    this.render();
  }

  private render(): void {
    if (this.disposed) return;
    const view = this.session.current;
    this.features.update();
    this.context.update(view);
    const sameRoom = view.room?.chatId === this.room.chatId;
    const standard = this.features.selected === defaultCallFeature;
    this.featureStatus.set_label(standard ? this.configProblem : [`Выбрана функция ${this.features.selected}`, this.features.notice].filter(Boolean).join(" · "));
    this.featureStatus.set_visible(!view.active && (!standard || Boolean(this.configProblem)));
    this.start.set_visible(!view.active && (standard ? this.config?.enabled === true && this.config.offered === true : this.features.offered));
    this.settingsButton.set_label(standard ? "Настройки вызовов…" : "Настройки функции…");
    this.featureButton.set_sensitive(!view.active);
    this.start.set_label(view.action === "retry" && sameRoom ? "Позвонить снова" : "Позвонить");
    this.mute.set_visible(view.active);
    this.mute.set_sensitive(view.phase !== "closing");
    this.mute.set_label(view.muted ? "Включить микрофон" : "Выключить микрофон");
    this.end.set_visible(view.active);
    this.end.set_sensitive(view.phase !== "closing");
    this.contextButton.set_visible(view.active);
    this.contextButton.set_sensitive(view.phase === "live");
    const visible = view.active || sameRoom;
    const status = visible ? [phases[view.phase], !sameRoom ? view.room?.name : "", view.engine, view.detail || view.reason,
      view.requestedFeature && view.requestedFeature !== defaultCallFeature ? `Запрошена функция ${view.requestedFeature}` : "",
      view.joined ? "Подключено к существующему вызову комнаты" : "",
      view.activity, view.deviceNotice, view.turn === "awaiting" ? "Готовит ответ" : view.turn === "answering" ? "Отвечает" : ""].filter(Boolean).join(" · ")
      : "";
    this.status.set_label(status);
    this.status.set_visible(Boolean(status));
    this.scroll.set_visible(visible && Boolean(view.captions.length));
    const vision = view.video;
    this.vision.set_visible(view.active && view.videoAvailable === true);
    this.camera.set_label(vision?.kind === "camera" ? "Остановить камеру" : "Показать камеру");
    this.screen.set_label(vision?.kind === "screen" ? "Остановить демонстрацию" : "Показать экран или окно");
    this.camera.set_sensitive(view.phase === "live" || vision?.kind === "camera");
    this.screen.set_sensitive(view.phase === "live" || vision?.kind === "screen");
    this.visionStatus.set_label([vision?.error || (vision?.waiting ? "Ожидаю разрешение и первый кадр…"
      : vision?.announced ? vision.kind === "camera" ? "Камера передаёт кадры" : "Идёт демонстрация" : ""), vision?.notice].filter(Boolean).join(" · "));
    this.visionStatus.set_visible(Boolean(this.visionStatus.get_label()));
    this.copy.set_visible(visible && Boolean(view.captions.length));
    if (view.captions !== this.lastCaptions) {
      this.lastCaptions = view.captions;
      const buffer = this.transcript.get_buffer();
      const adjustment = this.scroll.get_vadjustment();
      const follow = adjustment.get_upper() - adjustment.get_page_size() - adjustment.get_value() < 32;
      // Pango lays out each logical line as a unit. Keep unusual transcripts
      // responsive while the copy action preserves the exact text.
      buffer.set_text(transcriptText(view.captions).replace(/[^\n]{512}(?=[^\n])/gu, "$&\n"), -1);
      if (follow) this.transcript.scroll_to_iter(buffer.get_end_iter(), 0, false, 0, 1);
    }
  }

  private openSelectedSettings(): void {
    if (this.disposed) return;
    if (this.features.selected === defaultCallFeature) this.settings.show();
    else this.features.showSettings();
  }
}
