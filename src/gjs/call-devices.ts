import { readGatewayState, writeGatewayState } from "./gateway-state.js";
import { GLib, gstreamer } from "./gi.js";
import { object } from "./settings-write.js";

export interface CallDevicePrefs {
  microphone: string;
  speaker: string;
  camera: string;
  echo: boolean;
  noise: boolean;
  gain: boolean;
}

export interface CallDevice {
  id: string;
  label: string;
}

export const defaultCallDevices: Readonly<CallDevicePrefs> = {
  microphone: "", speaker: "", camera: "", echo: true, noise: true, gain: true,
};

function path(): string {
  return GLib.build_filenamev([GLib.get_user_config_dir(), "ouroboros-client", "call-devices.json"]);
}

function deviceId(value: unknown): string {
  return typeof value === "string" && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value) ? value : "";
}

export function loadCallDevices(): CallDevicePrefs {
  try {
    const data = object(readGatewayState(path()));
    return { microphone: deviceId(data.microphone), speaker: deviceId(data.speaker), camera: deviceId(data.camera),
      echo: data.echo !== false, noise: data.noise !== false, gain: data.gain !== false };
  } catch { return { ...defaultCallDevices }; }
}

export function saveCallDevices(prefs: CallDevicePrefs): void {
  writeGatewayState(path(), prefs);
}

export function audioDeviceProvider(): any {
  return gstreamer().DeviceProviderFactory.get_by_name("pulsedeviceprovider");
}

function unique(devices: CallDevice[]): CallDevice[] {
  return [...new Map(devices.filter(({ id }) => id).map((device) => [device.id, device])).values()]
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function listCallAudio(provider = audioDeviceProvider()): { microphone: CallDevice[]; speaker: CallDevice[] } {
  if (!provider) throw new Error("Провайдер устройств PulseAudio недоступен.");
  const microphone: CallDevice[] = [];
  const speaker: CallDevice[] = [];
  for (const device of provider.get_devices() ?? []) {
    // The element's device is the Pulse name, including a monitor suffix.
    const id = deviceId(device.create_element(null)?.device);
    if (!id) continue;
    const audio = { id, label: device.get_display_name() || id };
    const kind = device.get_device_class();
    if (kind === "Audio/Source") microphone.push(audio);
    if (kind === "Audio/Sink") speaker.push(audio);
  }
  return { microphone: unique(microphone), speaker: unique(speaker) };
}

export function listCallCameras(fd: number): CallDevice[] {
  const provider = gstreamer().DeviceProviderFactory.get_by_name("pipewiredeviceprovider");
  if (!provider) throw new Error("Провайдер камер PipeWire недоступен.");
  provider.set_property("fd", fd);
  try {
    return unique((provider.get_devices() ?? []).flatMap((device: any) => {
      if (device.get_device_class() !== "Video/Source") return [];
      const id = deviceId(device.get_properties()?.get_string("node.name"));
      return id ? [{ id, label: device.get_display_name() || id }] : [];
    }));
  } finally {
    provider.set_property("fd", -1);
  }
}
