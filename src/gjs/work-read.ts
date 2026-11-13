const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: Record<string, any>, keys: string[]) => keys.every(key => value[key] == null || typeof value[key] === "string");
const flags = (value: Record<string, any>, keys: string[]) => keys.every(key => value[key] === undefined || typeof value[key] === "boolean");
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const list = (value: any, valid: (item: any) => boolean) => value == null || Array.isArray(value) && value.every(valid);
const nested = (value: any, valid: (item: Record<string, any>) => boolean) => value == null || object(value) && valid(value);
const author = (value: Record<string, any>) => strings(value, ["actor", "text"]);
const resume = (value: Record<string, any>) => strings(value, ["error", "text"]) && nested(value.by, author);
const reason = (value: any) => object(value) && strings(value, ["code", "text"])
  && (value.count == null || count(value.count)) && nested(value.by, author)
  && list(value.wake, item => object(item) && strings(item, ["kind", "name", "at"]) && (item.count == null || count(item.count)));
const room = (value: any) => object(value) && strings(value, ["activity", "transition", "call"]) && flags(value, ["confirmed", "amber"]);
const work = (value: any) => object(value) && typeof value.work_id === "string" && Boolean(value.work_id.trim())
  && strings(value, ["name", "project_id", "activity", "transition", "call", "mark", "outcome"])
  && (value.room == null || typeof value.room === "string" || typeof value.room === "number" && Number.isSafeInteger(value.room))
  && flags(value, ["confirmed"])
  && nested(value.episode, item => strings(item, ["task_id"]) && flags(item, ["live"]))
  && nested(value.focus, item => strings(item, ["text"])) && nested(value.last_resume, resume)
  && list(value.because, reason) && list(value.tails, reason)
  && list(value.turn, item => object(item) && strings(item, ["kind", "task_id", "quiz_id", "wait_id", "code"]))
  && list(value.controls, item => object(item) && typeof item.action === "string" && Boolean(item.action)
    && typeof item.target === "string" && Boolean(item.target) && (item.scope === undefined || typeof item.scope === "string"))
  && nested(value.members, item => list(item.ids, id => typeof id === "string")
    && nested(item.states, states => Object.values(states).every(state => object(state) && strings(state, ["activity"])
      && nested(state.last_resume, resume) && list(state.reasons, reason))));

/** Only consumed fields; unknown string enums/additive fields remain compatible.
 * works_gaps is an independent diagnostic and cannot grant or revoke authority. */
export function validWorkSnapshot(value: unknown): boolean {
  if (!object(value) || !Array.isArray(value.works) || !flags(value, ["supervisor_ready", "works_complete"])) return false;
  const seen = new Set<string>();
  if (!value.works.every(item => { if (!work(item) || seen.has(item.work_id)) return false;seen.add(item.work_id);return true; })) return false;
  if (!nested(value.rooms, rooms => Object.values(rooms).every(room))) return false;
  const activities = new Set<string>();
  return list(value.active_chat_activities, item => {
    if (!object(item) || typeof item.activity_id !== "string" || !item.activity_id || activities.has(item.activity_id)
      || item.task_attempt !== undefined && (!count(item.task_attempt) || item.task_attempt <= 0)) return false;
    activities.add(item.activity_id);return true;
  });
}
