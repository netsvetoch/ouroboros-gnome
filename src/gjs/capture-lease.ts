export type CaptureKind = "audio" | "visual";
export interface CaptureLease { release(kinds?: readonly CaptureKind[]): void }
interface Holder { owner: object; label: string; tickets: Set<symbol> }
const holders = new Map<CaptureKind, Holder>();

export class CaptureBusy extends Error {
  readonly code = "in_use";
  constructor(readonly kind: CaptureKind, readonly owner: object, readonly label: string) {
    super(`${kind === "audio" ? "Микрофон" : "Камера или экран"} занят: ${label}. Сначала остановите текущий захват.`);
  }
}

/** One application-wide owner per resource; nested work shares only its owner's lease. */
export function acquireCapture(owner: object, label: string, kinds: readonly CaptureKind[]): CaptureLease {
  const requested = [...new Set(kinds)];
  for (const kind of requested) {
    const holder = holders.get(kind);
    if (holder && holder.owner !== owner) throw new CaptureBusy(kind, holder.owner, holder.label);
  }
  const ticket = Symbol(), owned = new Map<CaptureKind, Holder>();
  for (const kind of requested) {
    const holder = holders.get(kind) ?? { owner, label, tickets: new Set<symbol>() };
    holder.tickets.add(ticket); holders.set(kind, holder); owned.set(kind, holder);
  }
  return { release(released = [...owned.keys()]) {
    for (const kind of released) {
      const holder = owned.get(kind); if (!holder) continue;
      owned.delete(kind); holder.tickets.delete(ticket);
      if (!holder.tickets.size && holders.get(kind) === holder) holders.delete(kind);
    }
  } };
}
