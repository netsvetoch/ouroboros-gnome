import { defaultCallFeature } from "./call-session.js";
import { showExtensionSettings } from "./extension-settings.js";
import { type Gateway } from "./gateway.js";
import { Adw, Gio, Gtk } from "./gi.js";
import { button, column, errorText, label, sheet } from "./ui.js";

export class CallFeatures {
  selected = defaultCallFeature;
  private available = new Set<string>();
  private loaded = false;
  private problem = "";
  private generation = 0;
  private closed = false;
  private reading?: any;
  private view?: { dialog: any; rebuild: () => void; update: () => void };
  private readonly settings = new Set<any>();

  constructor(private readonly parent: any, private readonly gateway: Gateway,
    private readonly active: () => boolean, private readonly changed: () => void) {
    if (parent instanceof Adw.Dialog || parent instanceof Gtk.Window) {
      this.parentSignal = parent.connect(parent instanceof Gtk.Window ? "close-request" : "closed", () => {
        this.close(); return false;
      });
    }
  }
  private parentSignal = 0;

  get offered(): boolean { return this.loaded && this.available.has(this.selected); }
  get notice(): string {
    return this.problem || (this.loaded && !this.available.has(this.selected) ? "Выбранная функция не загружена на шлюзе." : "");
  }

  async refresh(): Promise<void> {
    if (this.closed) return;
    const generation = ++this.generation;
    this.reading?.cancel();
    const cancel = new Gio.Cancellable();
    this.reading = cancel;
    try {
      const reply = await this.gateway.json<{ live?: { conversation_features?: unknown } }>(
        "GET", "/api/extensions", undefined, undefined, false, cancel);
      if (this.closed || generation !== this.generation) return;
      const keys = reply?.live?.conversation_features;
      if (!Array.isArray(keys) || keys.some(key => typeof key !== "string" || !/^[^\s:]+:[^\s:]+$/u.test(key))
        || new Set(keys).size !== keys.length) {
        throw new Error("Шлюз не вернул список функций голосового вызова.");
      }
      this.available = new Set(keys);
      this.loaded = true;
      this.problem = "";
    } catch (error) {
      if (this.closed || generation !== this.generation) return;
      this.loaded = false;
      this.problem = errorText(error);
    } finally {
      if (this.reading === cancel) this.reading = undefined;
    }
    this.view?.rebuild();
    this.changed();
  }

  show(): void {
    if (this.closed) return;
    if (this.view) { this.view.dialog.present(this.parent); return; }
    const content = column();
    const dialog = sheet("Функция голосового вызова", content);
    const model = new Gtk.StringList();
    const choices = new Gtk.DropDown({ model });
    const feedback = label("", "dim-label");
    feedback.set_selectable(true);
    let open = true;
    let keys: string[] = [];
    const choose = button("Выбрать функцию", () => {
      if (!open || this.closed) return;
      const key = keys[choices.get_selected()];
      if (this.active() || !key || !this.available.has(key) || !this.loaded) return;
      this.selected = key;
      this.changed();
      dialog.close();
    });
    const update = () => {
      if (!open || this.closed) return;
      const key = keys[choices.get_selected()];
      choose.set_sensitive(!this.active() && this.loaded && Boolean(key) && this.available.has(key));
      feedback.set_label(this.active() ? "Функцию можно сменить после завершения текущего вызова." : this.notice);
    };
    const rebuild = () => {
      if (!open || this.closed) return;
      const pending = keys[choices.get_selected()] ?? this.selected;
      keys = [...new Set([defaultCallFeature, this.selected, pending, ...[...this.available].sort()])];
      const captions = keys.map(key => `${key}${key === defaultCallFeature ? " · по умолчанию" : ""}${this.loaded && !this.available.has(key) ? " · не загружена" : ""}`);
      model.splice(0, model.get_n_items(), captions);
      choices.set_selected(keys.indexOf(pending));
      update();
    };
    content.append(label("Выберите зарегистрированную функцию навыка. Шлюз проверит её готовность при открытии разговора. В комнате может уже идти вызов, к которому шлюз подключит вас."));
    for (const widget of [choices, feedback, button("Перечитать список", () => { if (open && !this.closed) void this.refresh(); }), choose]) content.append(widget);
    choices.connect("notify::selected", update);
    this.view = { dialog, rebuild, update };
    dialog.connect("closed", () => {
      if (!open) return;
      open = false;
      ++this.generation;
      this.reading?.cancel();
      if (this.view?.dialog === dialog) this.view = undefined;
      content.remove(choices);
      choices.run_dispose();
    });
    rebuild();
    dialog.present(this.parent);
    void this.refresh();
  }

  showSettings(parent = this.parent): void {
    if (this.closed) return;
    const skill = this.selected.split(":")[0];
    showExtensionSettings(this.gateway, skill, dialog => {
      if (this.closed) { dialog.force_close(); return; }
      this.settings.add(dialog);
      dialog.connect("closed", () => this.settings.delete(dialog));
      dialog.present(parent);
    }, parent);
  }

  update(): void { this.view?.update(); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.parentSignal) { this.parent.disconnect(this.parentSignal); this.parentSignal = 0; }
    ++this.generation;
    this.reading?.cancel();
    this.view?.dialog.force_close();
    for (const dialog of this.settings) dialog.force_close();
  }
}
