import { type CallDevice, type CallDevicePrefs, listCallAudio, listCallCameras, saveCallDevices } from "./call-devices.js";
import { openPortalVideo } from "./call-portal.js";
import { Adw, Gio, Gtk, gstreamer } from "./gi.js";
import { button, column, errorText, label, sheet } from "./ui.js";

class DeviceChoice {
  readonly widget: any;
  private ids: string[] = [];
  private readonly model = new Gtk.StringList();

  constructor(content: any, caption: string, private readonly defaultLabel = "Системное устройство") {
    content.append(label(caption));
    this.model.append(defaultLabel);
    this.widget = new Gtk.DropDown({ model: this.model });
    content.append(this.widget);
  }

  update(devices: CallDevice[], selected: string): void {
    const names = [this.defaultLabel, ...devices.map(({ label }) => label)];
    this.ids = ["", ...devices.map(({ id }) => id)];
    if (selected && !this.ids.includes(selected)) {
      this.ids.push(selected);
      names.push(`Сохранённое устройство · ${selected}`);
    }
    this.model.splice(0, this.model.get_n_items(), names);
    this.widget.set_selected(Math.max(0, this.ids.indexOf(selected)));
  }

  get value(): string { return this.ids[this.widget.get_selected()] ?? ""; }
}

export class CallDeviceSettings {
  private dialog?: any;
  private disposed = false;

  constructor(private readonly parent: any, private readonly changed: (prefs: CallDevicePrefs) => void,
    private readonly discovery = { audio: listCallAudio, cameras: listCallCameras, open: openPortalVideo }) {}

  show(prefs: CallDevicePrefs, parent = this.parent): void {
    if (this.disposed || this.dialog) return;
    const content = column();
    const status = label("", "dim-label");
    const cameraStatus = label("", "dim-label");
    const dialog = sheet("Устройства вызова", content);
    this.dialog = dialog;
    const cancel = new Gio.Cancellable();
    let open = true, parentSignal = 0, readingCameras = false, saving = false;
    const current = () => open && !this.disposed && this.dialog === dialog;
    const microphone = new DeviceChoice(content, "Микрофон");
    const speaker = new DeviceChoice(content, "Аудиовыход");
    const camera = new DeviceChoice(content, "Камера", "Системная камера");
    dialog.connect("closed", () => {
      if (!open) return;
      open = false;
      cancel.cancel();
      if (this.dialog === dialog) this.dialog = undefined;
      if (parentSignal) { parent.disconnect(parentSignal); parentSignal = 0; }
      for (const choice of [microphone, speaker, camera]) {
        content.remove(choice.widget);
        choice.widget.run_dispose();
      }
    });
    if (parent instanceof Adw.Dialog || parent instanceof Gtk.Window) parentSignal = parent.connect(
      parent instanceof Gtk.Window ? "close-request" : "closed", () => { dialog.force_close(); return false; });
    microphone.update([], prefs.microphone);
    speaker.update([], prefs.speaker);
    camera.update([], prefs.camera);
    const echo = new Gtk.CheckButton({ label: "Запрашивать эхоподавление у аудиосервера", active: prefs.echo });
    const noise = new Gtk.CheckButton({ label: "Подавлять шум микрофона", active: prefs.noise });
    const gain = new Gtk.CheckButton({ label: "Автоматически регулировать усиление микрофона", active: prefs.gain });
    let dsp = false;
    try { dsp = Boolean(gstreamer().ElementFactory.find("webrtcdsp")); } catch { /* The dialog reports unavailable audio below. */ }
    noise.set_sensitive(dsp);
    gain.set_sensitive(dsp);

    const readAudio = () => {
      if (!current()) return;
      try {
        const devices = this.discovery.audio();
        microphone.update(devices.microphone, microphone.value);
        speaker.update(devices.speaker, speaker.value);
        status.set_label("");
      } catch (error) { status.set_label(errorText(error)); }
    };
    const readCameras = button("Получить список камер…", () => {
      if (!current() || readingCameras) return;
      readingCameras = true;
      readCameras.set_sensitive(false);
      cameraStatus.set_label("Запрашиваю доступ к списку камер…");
      void (async () => {
        const remote = await this.discovery.open(parent, "camera", cancel, () => {});
        try {
          if (!current()) return;
          const cameraDevices = this.discovery.cameras(remote.fd);
          camera.update(cameraDevices, camera.value);
          cameraStatus.set_label(cameraDevices.length ? "" : "Портал не вернул доступных камер.");
        } finally { remote.close(); }
      })().catch((error) => { if (current()) cameraStatus.set_label(errorText(error)); })
        .finally(() => { readingCameras = false; if (current()) readCameras.set_sensitive(true); });
    });
    content.append(button("Обновить список аудиоустройств", readAudio));
    content.append(status);
    content.append(readCameras);
    content.append(cameraStatus);
    content.append(echo);
    content.append(noise);
    content.append(gain);
    content.append(label("Настройки хранятся на этом устройстве.", "dim-label"));
    const save = button("Применить", () => {
      if (!current() || saving) return;
      saving = true;
      const next = { microphone: microphone.value, speaker: speaker.value, camera: camera.value,
        echo: echo.get_active(), noise: noise.get_active(), gain: gain.get_active() };
      try {
        saveCallDevices(next);
        this.changed(next);
        dialog.close();
      } catch (error) { saving = false; status.set_label(errorText(error)); }
    });
    save.add_css_class("suggested-action");
    content.append(save);
    dialog.present(parent);
    readAudio();
  }

  close(): void { this.disposed = true; this.dialog?.force_close(); }
}
