export const callRate = 48000;
const maxAudio = 64 * 1024;
export const maxCallVideo = 512 * 1024;
const headerBytes = 16;
const version = 1;

export interface CallAudioFrame {
  kind: 1 | 2;
  epoch: number;
  sequence: number;
  rate: number;
  stream: number;
  pcm: Uint8Array;
}

export function callAudioPacket(pcm: Uint8Array, epoch: number, sequence: number): Uint8Array {
  if (pcm.length > maxAudio || pcm.length % 2) throw new Error("Некорректный блок аудио вызова.");
  return packet(1, pcm, epoch, sequence, callRate);
}

export function callVideoPacket(jpeg: Uint8Array, epoch: number, sequence: number): Uint8Array {
  if (jpeg.length < 3 || jpeg.length > maxCallVideo || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) {
    throw new Error("Некорректный кадр вызова.");
  }
  return packet(3, jpeg, epoch, sequence, 1);
}

function packet(kind: 1 | 3, payload: Uint8Array, epoch: number, sequence: number, rate: number): Uint8Array {
  const bytes = new Uint8Array(headerBytes + payload.length);
  bytes.set([0x4f, 0x43, version, kind]);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, epoch, true);
  view.setUint32(6, sequence, true);
  view.setUint32(10, rate, true);
  bytes.set(payload, headerBytes);
  return bytes;
}

export function readCallAudio(bytes: Uint8Array): CallAudioFrame {
  const pcmSize = bytes.length - headerBytes;
  const kind = bytes[3];
  if (pcmSize < 0 || pcmSize > maxAudio || pcmSize % 2 || bytes[0] !== 0x4f || bytes[1] !== 0x43
    || bytes[2] !== version || kind !== 1 && kind !== 2) throw new Error("Шлюз вернул некорректный аудиоблок вызова.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { kind, epoch: view.getUint16(4, true), sequence: view.getUint32(6, true),
    rate: view.getUint32(10, true), stream: view.getUint16(14, true), pcm: bytes.subarray(headerBytes) };
}

export function newerEpoch(next: number, previous: number): boolean {
  const distance = (next - previous) & 0xffff;
  return distance > 0 && distance < 0x8000;
}

export function callUint16(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff;
}
