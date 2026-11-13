type Frame = Record<string, unknown>;
const object = (value: unknown): value is Frame => value !== null && typeof value === "object" && !Array.isArray(value);
const roomNumber = (value: unknown, fallback = 1): number | undefined => {
  if (value == null) return fallback;
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
};

/** Main includes external positive transport rooms. Project membership comes
 * from the server stamp/registry, never from the magnitude of the room ID. */
export function frameChatId(frame: Frame): number | undefined { return roomNumber(frame.chat_id); }

export function chatThreadAccepts(frame: Frame, room: number, projects: ReadonlySet<number>): boolean {
  const chat = frameChatId(frame);
  if (room === 1) return !frame.project_thread && chat !== undefined && chat > 0 && !projects.has(chat);
  return chat === room || Array.isArray(frame.also_rooms) && frame.also_rooms.some(id => roomNumber(id, 0) === room);
}

export function chatFrameAccepts(frame: Frame, room: number, projects: ReadonlySet<number>): boolean {
  if (frame.type !== "log") return chatThreadAccepts(frame, room, projects);
  const data = object(frame.data) ? frame.data : undefined;
  if (data && Object.hasOwn(data, "chat_id")) {
    return chatThreadAccepts({ ...frame, ...data, chat_id: data.chat_id,
      project_thread: Boolean(frame.project_thread || data.project_thread) }, room, projects);
  }
  // Legacy unaddressed bridge logs used outer zero; an explicit INNER zero is
  // the hidden Skill Review partition and was handled above.
  if (frame.chat_id !== undefined && roomNumber(frame.chat_id, 0) === 0) return room === 1 && !frame.project_thread;
  return chatThreadAccepts(frame, room, projects);
}
