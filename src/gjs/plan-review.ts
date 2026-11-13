import { Gtk, Pango } from "./gi.js";
import { renderReviewExecution } from "./review-execution.js";
import { reviewDiagnostic } from "./review-diagnostic.js";
import { type SettingsDocument, object } from "./settings-write.js";
import { column, label } from "./ui.js";

export interface PlanReviewData {
  plan_record?: unknown;
  plan_objections?: unknown;
  plan_review_state?: unknown;
}

type OpenReply = (target: any, ask: string, seat: string, sha256: string) => void;

const seatStatus: Record<string, string> = {
  pending: "Ответ ожидается", answered: "Ответ получен", unparseable: "Ответ не разобран",
  failed: "Ошибка запроса", not_dispatched: "Запрос не отправлен",
};
const legacyStatus: Record<string, string> = {
  open: "Открыта", pending: "Ожидается", closed: "Закрыта", unavailable: "Недоступна", rail_degraded: "Проверка ограничена",
};

const text = (value: unknown): string => typeof value === "string" ? value : "";
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const rows = (value: unknown): SettingsDocument[] => Array.isArray(value) ? value.map(object).filter((row) => Object.keys(row).length > 0) : [];
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item) : [];

function line(target: any, ...values: unknown[]): void {
  const words = values.flatMap((value) => typeof value === "number" ? [String(value)] : text(value) ? [text(value)] : []);
  if (!words.length) return;
  const field = label(words.join(" · "));
  field.set_wrap_mode(Pango.WrapMode.WORD_CHAR);field.set_max_width_chars(64);
  field.set_selectable(true);
  target.append(field);
}

function section(target: any, title: string, expanded = false): any {
  const body = column(5);
  target.append(new Gtk.Expander({ label: title, child: body, expanded }));
  return body;
}

function revisionLabel(value: unknown): string {
  if (value === null) return "Разбор исходного запроса";
  const n = count(value);
  return n === undefined ? "Версия не указана" : `Версия ${n}`;
}

function showObjections(target: any, raw: unknown, modern: boolean): void {
  const view = object(raw);
  const body = section(target, "Возражения к плану", true);
  if (view.unreadable) {
    line(body, "Шлюз не смог прочитать запись плана", reviewDiagnostic(view.unreadable));
    return;
  }
  const legacy = object(view.legacy_unreadable);
  const legacyProblem = Boolean(view.legacy_unreadable && (view.legacy_unreadable !== legacy || Object.keys(legacy).length));
  if (legacyProblem) line(body, "Прежняя запись недоступна", ...[legacy.source, legacy.error ?? view.legacy_unreadable].map(reviewDiagnostic));
  const record = (value: unknown): value is SettingsDocument => value !== null && typeof value === "object" && !Array.isArray(value);
  const fields = (value: SettingsDocument, keys: string[]) => keys.every(key => value[key] == null || typeof value[key] === "string");
  const entries: { seat: string; row: SettingsDocument }[] = [];
  let known = Array.isArray(view.open_objections) || record(view.open_objections);
  const add = (raw: unknown, seat?: string) => {
    if (!record(raw) || !fields(raw, ["seat_id", "id", "text", "ask_id"])
      || !(text(raw.id) || text(raw.text))
      || ["holds", "not_adjudicated", "legacy"].some(key => raw[key] != null && typeof raw[key] !== "boolean")
      || raw.revision != null && count(raw.revision) === undefined) { known = false;return; }
    entries.push({ seat: seat ?? text(raw.seat_id), row: raw });
  };
  if (Array.isArray(view.open_objections)) for (const row of view.open_objections) add(row);
  else if (record(view.open_objections)) for (const [seat, list] of Object.entries(view.open_objections)) {
    if (!Array.isArray(list)) { known = false;continue; }
    for (const row of list) add(row, seat);
  }
  if (!known && (modern || raw !== undefined)) line(body, "Список открытых возражений прочитан не полностью. Отсутствие возражений не подтверждено.");
  if (entries.length) {
    body.append(label("Открытые", "heading"));
    for (const { seat, row } of entries) {
      line(body, seat, row.id, row.ask_id, row.revision != null ? revisionLabel(row.revision) : "",
        row.holds === true ? "Может удерживать решение" : row.holds === false ? "Замечание без удержания" : "",
        row.not_adjudicated === true ? "Решение не зафиксировано" : "",
        row.legacy === true ? "Перенесено из прежней проверки" : "");
      line(body, row.text);
    }
  } else if (known) line(body, legacyProblem ? "В доступной части открытых возражений нет." : "Открытых возражений нет.");
  let withdrawalsKnown = view.withdrawn === undefined || Array.isArray(view.withdrawn);
  const withdrawn = (Array.isArray(view.withdrawn) ? view.withdrawn : []).filter(raw => {
    const valid = record(raw) && fields(raw, ["seat_id", "id", "withdrawn_in", "why"]) && Boolean(text(raw.id));
    if (!valid) withdrawalsKnown = false;return valid;
  });
  if (!withdrawalsKnown) line(body, "Часть сведений об отозванных возражениях недоступна.");
  if (withdrawn.length) {
    body.append(label("Отозванные участниками", "heading"));
    for (const row of withdrawn) line(body, row.seat_id, row.id, row.withdrawn_in && `Отозвано в ${row.withdrawn_in}`, row.why);
  }
}

function showRevision(target: any, revision: SettingsDocument, latest: boolean): void {
  const body = section(target, [revisionLabel(revision.n), latest ? "Текущая" : "", text(revision.ts)].filter(Boolean).join(" · "), latest);
  if (revision.goal) line(body, "Цель", revision.goal);
  if (revision.body === true) line(body, "План меняет ядро Ouroboros", revision.body_note);
  if (revision.plan_inline === false) line(body, "Текст вынесен в сохранённый источник.");
  else line(body, revision.plan);
  const criteria = rows(revision.done_when);
  if (criteria.length) {
    body.append(label("Критерии завершения", "heading"));
    for (const item of criteria) {
      line(body, item.id, item.claim, item.surface);
      if (item.support) line(body, "Подтверждение", item.support);
    }
  }
  const paths = strings(revision.affected_paths);
  if (paths.length) line(body, "Затронутые пути", paths.join("\n"));
  if (revision.content_sha256) line(body, "Отпечаток версии", revision.content_sha256);
}

function showCoverage(target: any, seat: SettingsDocument): void {
  const delivery = object(seat.room_delivery);
  const inline = count(delivery.conversation_inline_rows), total = count(delivery.conversation_rows);
  if (seat.status !== "not_dispatched" && inline !== undefined && total !== undefined) {
    line(target, `Строки разговора в запросе ${inline} из ${total}`,
      seat.status === "pending" ? "Доставка пока не подтверждена" : "");
    const other = count(delivery.other_rows);
    if (other) line(target, "Дополнительные строки в файле снимка", other);
  }
  const coverage = object(seat.room_read_coverage);
  const covered = count(coverage.covered_chars), complete = count(coverage.complete_chars);
  const provenance = coverage.provenance === "host_observed" ? "Наблюдение шлюза"
    : coverage.provenance === "harness_observed" ? "По журналу движка" : "";
  if (provenance && ["complete", "incomplete"].includes(text(coverage.status)) && covered !== undefined && complete !== undefined) {
    line(target, `Чтение файла охватило ${covered} из ${complete} символов`, provenance);
  }
}

function showAsk(target: any, ask: SettingsDocument, openReply: OpenReply, expanded: boolean): void {
  const id = text(ask.ask_id);
  const body = section(target, [id && `Запрос ${id}`, revisionLabel(ask.revision), text(ask.ts)].filter(Boolean).join(" · "), expanded);
  line(body, ask.message);
  const added = strings(ask.host_added);
  if (added.length) line(body, "Шлюз добавил участников", added.join(", "));
  if (ask.reason) line(body, "Причина запроса", ask.reason);
  for (const item of rows(ask.attached)) line(body, "Приложение", item.locator, item.sha256, item.bytes);
  for (const omission of Array.isArray(ask.omissions) ? ask.omissions : []) {
    const item = object(omission);
    line(body, "Вложение пропущено", item.locator, item.reason ?? omission);
  }
  const seats = rows(ask.participants);
  for (const seat of seats) {
    const seatId = text(seat.seat_id);
    const status = text(seat.status);
    const participant = section(body, [seatId, text(seat.model) && `Назначено · ${text(seat.model)}`, Object.hasOwn(seatStatus, status) ? seatStatus[status] : status].filter(Boolean).join(" · ") || "Участник",
      seats.length === 1);
    if (seat.owner_marked === true) line(participant, "Назначен владельцем");
    if (seat.host_added === true) line(participant, "Добавлен шлюзом");
    line(participant, ...[seat.not_dispatched_reason, seat.error, seat.parse_error].map(reviewDiagnostic));
    renderReviewExecution(participant, seat);
    if (seat.unresolved === true) line(participant, "Исход вызова неизвестен.");
    showCoverage(participant, seat);
    const reply = object(seat.reply);
    line(participant, reply.prose);
    const points = rows(reply.objections);
    if (points.length) {
      participant.append(label(ask.revision === null ? "Советы к исходному запросу" : "Замечания в этом ответе", "heading"));
      for (const point of points) line(participant, point.id, point.text);
    }
    for (const point of rows(reply.withdrawn)) line(participant, "Отзыв в ответе", point.id, point.why);
    for (const point of rows(reply.ignored)) line(participant, "Шлюз пропустил элемент ответа", point.key, point.index, point.id, point.reason);
    const source = object(seat.reply_ref);
    const sha = text(object(source.ref).sha256 ?? source.sha256);
    if ((!source.status || source.status === "retained") && id && seatId && /^[a-f0-9]{64}$/.test(sha)) {
      openReply(participant, id, seatId, sha);
    } else if (source.status || reply.prose_inline === false) {
      line(participant, "Сохранённый ответ недоступен", source.reason ?? source.status);
    }
  }
}

function showLegacy(target: any, state: SettingsDocument): void {
  const current = object(state.current_attempt);
  const projection = object(state.legacy_v1_projection);
  const waves = rows(state.waves);
  if (!Object.keys(current).length && !Object.keys(projection).length && !waves.length) return;
  const body = section(target, "Прежние проверки плана");
  const status = text(projection.status ?? current.status);
  line(body, Object.hasOwn(legacyStatus, status) ? legacyStatus[status] : status, projection.outcome, projection.reason ?? current.reason);
  const author = object(current.author_subject);
  if (author.author_disposition) {
    line(body, "Решение автора", author.author_disposition, author.rationale);
    line(body, "Отпечаток проверенного плана", author.review_fingerprint);
    if (current.fingerprint) line(body, "Отпечаток выбранного плана", current.fingerprint);
  }
  for (const wave of waves) {
    const review = object(wave.review);
    const index = count(wave.cycle_index);
    const entry = section(body, index === undefined ? "Запись прежней проверки" : `Раунд ${index}`);
    line(entry, wave.request_fingerprint, wave.phase, wave.aggregate ?? review.aggregate_signal,
      wave.closed === true || review.closed === true ? "Закрыта" : "");
    for (const actor of rows(wave.actors)) line(entry, actor.slot_id, actor.model, actor.status, actor.error);
    for (const finding of rows(wave.findings)) {
      line(entry, finding.slot, finding.finding_id, finding.class, finding.summary, finding.breaks);
    }
  }
}

export function renderPlanReview(target: any, data: PlanReviewData | undefined, openReply: OpenReply): void {
  if (!data) return;
  const record = object(data.plan_record);
  const revisions = rows(record.revisions);
  const asks = rows(record.asks);
  const attempts = rows(record.attempts);
  const modern = Boolean(revisions.length || asks.length || attempts.length);
  if (modern || data.plan_objections) showObjections(target, data.plan_objections, modern);
  if (object(data.plan_objections).unreadable) return;
  if (revisions.length) {
    const body = section(target, "Версии плана");
    for (const [index, revision] of revisions.toReversed().entries()) showRevision(body, revision, index === 0);
  }
  if (asks.length || attempts.length) {
    const body = section(target, "Реплики к плану");
    for (const ask of asks) showAsk(body, ask, openReply, asks.length === 1);
    for (const attempt of attempts) {
      line(body, "Попытка без отправки", revisionLabel(attempt.revision), attempt.ts, attempt.kind, attempt.ask);
      for (const [seat, reason] of Object.entries(object(attempt.not_sendable))) line(body, seat, reason);
    }
  }
  if (!modern) showLegacy(target, object(data.plan_review_state));
}
