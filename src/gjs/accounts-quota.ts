import { QuotaRefreshView } from "./quota-refresh.js";
import { Adw, Gio, GLib, Gtk } from "./gi.js";
import { type Gateway, HttpError } from "./gateway.js";
import { gatewayStatePath, readGatewayState, writeGatewayState } from "./gateway-state.js";
import type { Present } from "./mcp-server.js";
import { object, ownerHeaders } from "./settings-write.js";
import { button, clear, column, confirm, errorText, label, row, sheet } from "./ui.js";

export const accountsPath = "/api/claudexor";
export interface Target { harness: string; profile_id: string }
interface Subject { harness: string; credential_route?: string | null; subject_id: string | null }
type Read = "ok" | "not_read" | "failed";

export interface Profile {
  profile: { harness_id: string; profile_id: string; display_name?: string; enabled?: boolean };
  status?: { verification?: string; verification_source?: string; availability?: string; reason?: string;
    last_verified_at?: string; [key: string]: unknown };
  identity?: { email?: string; plan?: string };
}

export interface RoutingEvidence {
  harness_id: string;
  profile_id: string;
  requested_model: string;
  provider_reason?: string;
  observed_at?: string;
  expires_at?: string;
  state?: string;
}

interface AccountPool {
  harness_id: string;
  next_up?: { kind?: string; profileId?: string; route?: string; reason?: string } | null;
}

export interface Harness {
  id: string;
  display_name?: string;
  status?: string;
  enabled?: boolean;
  provider_family?: string;
  access_profiles_supported?: string[];
  models?: unknown;
  models_error?: string;
  model_catalog?: { partial?: boolean; accounts?: { credentialProfileId?: string; catalog?: unknown; problem?: { message?: string } }[] };
}

interface Window {
  label?: string;
  used_ratio?: number | null;
  freshness?: string;
  resets_at?: string;
  cooldown_until?: string;
  availability?: unknown;
  applies_to_models?: string[];
  request_kinds?: string[];
}
interface Quota {
  subject: Subject;
  freshness?: string;
  observed_at?: string;
  constraints?: Window[];
  availability?: { state?: string; resets_at?: string | null };
}
interface Absence { subject: Subject; reason?: string; detail?: string; observed_at?: string }
interface Facet<T> { value?: T | null; freshness?: string; observed_at?: string; last_attempt_at?: string; last_error?: unknown }
interface Amount { label?: string; unit?: string; currency?: string | null; decimal_places?: number | null }
interface Balance extends Amount { amount?: string | null; has_balance?: boolean | null; unlimited?: boolean }
interface Spend extends Amount { used?: string | null; limit?: string | null; enabled?: boolean | null; resets_at?: string; reason?: unknown }
interface Grant { id: string; label?: string; available_count?: number | null; usable_now?: boolean | null; starts_at?: string; expires_at?: string }
interface Offer extends Grant { kind?: string; eligible?: boolean | null; reason?: unknown; grants?: Grant[] }
interface Resource {
  target: Target;
  balances?: Facet<Balance[]>;
  spending?: Facet<Spend[]>;
  resets?: Facet<Offer[]>;
  diagnostics?: unknown;
}
export interface Status {
  view?: string;
  daemon?: Record<string, unknown>;
  config_dir?: string;
  harnesses?: Harness[];
  profiles?: {
    profiles?: Profile[];
    accountPools?: AccountPool[];
    routing_evidence?: { capabilities?: RoutingEvidence[]; refusals?: RoutingEvidence[] };
    routing_evidence_read?: { state?: Read; observed_at?: string };
  };
  quota?: Quota[];
  quota_absences?: Absence[];
  availability_scope?: { model?: string | null; requestKind?: string; basis?: string };
  resources?: Resource[];
  reads?: { catalog?: Read; accounts?: Read; quota?: Read };
  read_errors?: Record<string, { code?: string; status_code?: number }>;
  facets?: Record<string, { observed_at?: string; stale?: boolean; error?: unknown }>;
  resource_capabilities?: { refresh?: boolean; reset?: boolean; inspect_reset?: boolean; read?: boolean };
  resource_capabilities_read?: Read;
  error?: string;
}
interface ResetBody { target: Target; offer_id: string; grant_id?: string }
interface Receipt {
  id: string;
  state: string;
  request: ResetBody;
  outcome?: string;
  detail?: string;
  readback?: { state?: string; detail?: string };
}
interface RecordEntry { key: string; body: ResetBody; receipt?: Receipt }

const targetKey = ({ harness, profile_id }: Target) => JSON.stringify([harness, profile_id]);
const sameTarget = (a: Target | undefined, b: Target) => a?.harness === b.harness && a?.profile_id === b.profile_id;
const sameSubject = (a: Subject | undefined, b: Target) => a?.harness === b.harness && a?.subject_id === b.profile_id;
const sameRequest = (a: ResetBody | undefined, b: ResetBody) => sameTarget(a?.target, b.target)
  && a?.offer_id === b.offer_id && a?.grant_id === b.grant_id;
const recoverable = (entry: RecordEntry) => !entry.receipt || !entry.receipt.outcome || entry.receipt.state === "running"
  || ["pending", "unknown", "already_used"].includes(entry.receipt.outcome ?? "");

export function valueText(value: unknown): string {
  return value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function facts(target: any, ...values: unknown[]): void {
  const line = values.filter((value) => value !== false).map(valueText).filter(Boolean).join(" · ");
  if (!line) return;
  const widget = label(line);
  widget.set_selectable(true);
  target.append(widget);
}

function amount(value: string | null | undefined, unit: Amount): string {
  if (typeof value !== "string" || !value) return "сумма не сообщена";
  const digits = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  const places = unit.decimal_places;
  if (digits && typeof places === "number" && Number.isInteger(places) && places > 0 && places <= 100) {
    const expanded = digits[2].padStart(places + 1, "0");
    value = `${digits[1]}${expanded.slice(0, -places)}.${expanded.slice(-places)}${digits[3] ?? ""}`;
  }
  return [value, unit.currency || unit.unit].filter(Boolean).join(" ");
}

function facetFacts(target: any, title: string, value: Facet<unknown> | undefined, stale: boolean): void {
  facts(target, title, stale ? "последнее известное" : value?.freshness,
    value?.value == null ? "данные отсутствуют" : "", value?.observed_at, value?.last_attempt_at, value?.last_error);
}

export class AccountQuota {
  private readonly records = new Map<string, RecordEntry>();
  private readonly location: string;
  private readonly busy = new Set<string>();
  private readonly readback = new Set<string>();

  constructor(private readonly gateway: Gateway, private readonly present: Present, private readonly changed: () => void) {
    this.location = gatewayStatePath(gateway.base, "account-resets");
    try {
      const entries = readGatewayState(this.location);
      if (!Array.isArray(entries)) return;
      for (const entry of entries) {
        const { key, body, receipt } = object(entry);
        const request = body as ResetBody | undefined;
        if (typeof key !== "string" || !key || !request?.target?.harness || !request.target.profile_id || !request.offer_id) continue;
        const loaded = receipt as Receipt | undefined;
        if (loaded && (!sameRequest(loaded.request, request) || !loaded.id)) continue;
        this.records.set(targetKey(request.target), { key, body: request, receipt: loaded });
      }
    } catch { /* the first run has no local receipts */ }
  }

  private save(): void {
    writeGatewayState(this.location, [...this.records.values()]);
  }

  show(parent: any, target: Target | undefined, title: string, initial: Status, allowReset: boolean): void {
    const content = column(10);
    const dialog = sheet(title, content);
    dialog.set_content_width(680);
    const status = label("", "dim-label");
    const receiptBox = column();
    const refreshView = new QuotaRefreshView(target);
    const refreshCancel = new Gio.Cancellable();
    const data = column();
    const key = target && targetKey(target);
    let current = true;
    let snapshot = initial;
    let reading = false;
    let writing = false;
    let readEpoch = 0;
    let readCancel = new Gio.Cancellable();
    const inspectCancel = new Gio.Cancellable();
    let readProblem = "";
    const validate = (value: Status) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Шлюз не подтвердил представление квоты.");
      for (const field of ["quota", "quota_absences", "resources"] as const) {
        if (value[field] !== undefined && !Array.isArray(value[field])) throw new Error("Шлюз вернул неполную структуру квоты.");
      }
      for (const item of value.quota ?? []) {
        if (!item?.subject || (item.constraints !== undefined && (!Array.isArray(item.constraints)
          || item.constraints.some((row) => !row || typeof row !== "object"
            || [row.applies_to_models, row.request_kinds].some((names) => names != null && (!Array.isArray(names) || names.some((name) => typeof name !== "string"))))))) throw new Error("Шлюз вернул неполные окна квоты.");
      }
      if ((value.quota_absences ?? []).some((item) => !item?.subject)) throw new Error("Шлюз вернул неполные причины отсутствия квоты.");
      for (const item of value.resources ?? []) {
        if (!item?.target?.harness || !item.target.profile_id) throw new Error("Шлюз вернул ресурс без аккаунта.");
        for (const facet of [item.balances, item.spending, item.resets]) {
          if (facet?.value != null && (!Array.isArray(facet.value) || facet.value.some((row) => !row || typeof row !== "object"))) {
            throw new Error("Шлюз вернул неполные ресурсы аккаунта.");
          }
        }
        for (const offer of item.resets?.value ?? []) {
          if (offer.grants !== undefined && (!Array.isArray(offer.grants) || offer.grants.some((grant) => !grant))) {
            throw new Error("Шлюз вернул неполные варианты сброса.");
          }
        }
      }
    };
    const render = () => {
      if (!current) return;
      refreshButton.set_visible(!target || snapshot.resource_capabilities?.refresh === true);
      clear(data);
      clear(receiptBox);
      const verdict = snapshot.reads?.quota;
      const stale = verdict !== "ok" || snapshot.facets?.quota?.stale === true;
      const resource = target && snapshot.resources?.find((row) => sameTarget(row.target, target));
      facts(data, "Квота", stale ? "текущее состояние неизвестно" : "прочитана", snapshot.facets?.quota?.observed_at);
      if (snapshot.read_errors) for (const [facet, error] of Object.entries(snapshot.read_errors)) facts(data, facet, error.code, error.status_code);
      const windows = (snapshot.quota ?? []).filter((row) => !target || sameSubject(row.subject, target));
      const absences = (snapshot.quota_absences ?? []).filter((row) => !target || sameSubject(row.subject, target));
      for (const window of windows) {
        facts(data, window.subject?.harness, window.subject?.subject_id ?? "без указанного профиля",
          window.observed_at, stale ? "последнее известное" : window.freshness);
        for (const constraint of window.constraints ?? []) {
          facts(data, constraint.label, constraint.freshness ?? "свежесть окна неизвестна",
            typeof constraint.used_ratio === "number" ? `израсходовано ${Math.round(constraint.used_ratio * 100)}%` : "расход неизвестен",
            constraint.availability, constraint.resets_at && `сброс ${constraint.resets_at}`, constraint.cooldown_until,
            constraint.applies_to_models?.join(", "), constraint.request_kinds?.join(", "));
        }
      }
      for (const entry of absences) facts(data, entry.subject?.harness, entry.subject?.subject_id, entry.reason, entry.detail, entry.observed_at);
      if (!windows.length && !absences.length) facts(data, verdict === "ok" ? "Для этой выборки нет опубликованных окон квоты." : "Сведения об окнах квоты недоступны.");
      if (!target) {
        for (const item of snapshot.resources ?? []) facts(data, item.target.harness, item.target.profile_id,
          "ресурсы доступны в карточке аккаунта");
        return;
      }
      if (resource) {
        facetFacts(data, "Баланс", resource.balances, stale);
        for (const item of resource.balances?.value ?? []) facts(data, item.label, item.unlimited ? "без ограничения" : amount(item.amount, item),
          item.has_balance != null ? (item.has_balance ? "баланс доступен" : "доступного баланса нет") : "");
        facetFacts(data, "Расход", resource.spending, stale);
        for (const item of resource.spending?.value ?? []) facts(data, item.label, `использовано ${amount(item.used, item)}`,
          `лимит ${amount(item.limit, item)}`, item.enabled === false && "выключен", item.resets_at, item.reason);
        facetFacts(data, "Сбросы", resource.resets, stale);
        const pending = key && this.records.get(key);
        for (const offer of resource.resets?.value ?? []) {
          facts(data, offer.label ?? offer.id, offer.kind, offer.available_count ?? "число не сообщено", offer.reason);
          for (const grant of offer.grants?.length ? offer.grants : [undefined]) {
            if (grant) facts(data, grant.label ?? grant.id, grant.available_count, grant.starts_at, grant.expires_at);
            const eligible = allowReset && snapshot.resource_capabilities?.reset === true && !stale && resource.resets?.freshness === "fresh" && Boolean(offer.id)
              && (!pending || !recoverable(pending)) && offer.usable_now !== false && offer.eligible !== false
              && offer.available_count !== 0 && grant?.available_count !== 0 && grant?.usable_now !== false;
            if (eligible) data.append(button(`Использовать сброс · ${grant?.label || offer.label || offer.id}…`, () => {
              void createReset(offer, grant);
            }));
          }
        }
        if (resource.diagnostics) facts(data, "Диагностика ресурса", resource.diagnostics);
      }
      const entry = key && this.records.get(key);
      if (entry) {
        facts(receiptBox, "Квитанция о сбросе", entry.receipt?.id ?? "идентификатор операции пока неизвестен",
          entry.receipt?.state, entry.receipt?.outcome ?? "итог не подтверждён", entry.receipt?.detail,
          entry.receipt?.readback?.state, entry.receipt?.readback?.detail);
        if (recoverable(entry)) receiptBox.append(button("Повторить тот же запрос…", () => {
          void (async () => {
            if (!current || !key || this.busy.has(key)) return;
            if (!await confirm(dialog, "Проверить предыдущий запрос сброса?",
              "Будут отправлены прежние параметры и прежний ключ запроса.", "Повторить запрос") || !current) return;
            await submit(entry);
          })();
        }));
        if (entry.receipt && snapshot.resource_capabilities?.inspect_reset === true) receiptBox.append(button("Перечитать квитанцию", () => void inspect(entry)));
      }
    };
    const load = async (replace = false) => {
      if ((reading && !replace) || !current) return;
      readCancel.cancel();
      readCancel = new Gio.Cancellable();
      const epoch = ++readEpoch;
      reading = true;
      readButton.set_sensitive(false);
      try {
        const result = await this.gateway.json<Status>("GET", `${accountsPath}/status?view=quota`, undefined, undefined, false, readCancel);
        if (!current || epoch !== readEpoch) return;
        validate(result);
        if (status.get_label() === readProblem) status.set_label("");
        readProblem = "";
        if (result.view !== "quota") {
          status.set_label("Этот шлюз вернул полный статус вместо отдельного представления квоты.");
        }
        const known = result.reads?.quota === "ok";
        snapshot = { ...snapshot, ...result, ...(known ? {} : { quota: snapshot.quota, quota_absences: snapshot.quota_absences, resources: snapshot.resources }) };
        render();
      } catch (error) {
        if (current && epoch === readEpoch) {
          readProblem = errorText(error);
          status.set_label(readProblem);
          snapshot = { ...snapshot, reads: { ...snapshot.reads, quota: "failed" } };
          render();
        }
      } finally { if (epoch === readEpoch) { reading = false; readButton.set_sensitive(true); } }
    };
    const refresh = async () => {
      if (writing || !current || (target && snapshot.resource_capabilities?.refresh !== true)) return;
      writing = true;
      try {
        if (!await confirm(dialog, "Запросить обновление квоты?",
          target ? `Шлюз проверит квоту аккаунта ${target.harness} · ${target.profile_id}.`
            : "Шлюз проверит квоты всех доступных аккаунтов. Проверка может обращаться к провайдерам.", "Проверить квоту") || !current) return;
        status.set_label("Шлюз запрашивает обновление квоты…");
        refreshView.begin();
        const response = await this.gateway.json("POST", `${accountsPath}/quota/refresh`, target ? { target } : {}, ownerHeaders, true, refreshCancel);
        if (current) {
          const valid = refreshView.receive(response);
          status.set_label(valid ? "Получен ответ обновления квоты. Читаю текущие наблюдения…"
            : "Ответ обновления квоты не удалось прочитать. Читаю текущие наблюдения…");
          await load(true);
        }
        if (current) this.changed();
      } catch (error) {
        if (current) {
          refreshView.fail(errorText(error));
          status.set_label(`Ответ обновления квоты не подтверждён. Читаю текущие наблюдения… ${errorText(error)}`);
          await load(true);
        }
      }
      finally { writing = false; }
    };
    const accept = (entry: RecordEntry, receipt: Receipt) => {
      if (!receipt || typeof receipt.id !== "string" || !receipt.id || !["running", "completed"].includes(receipt.state) || !sameRequest(receipt.request, entry.body) || (entry.receipt && receipt.id !== entry.receipt.id)) {
        throw new Error("Квитанция не совпадает с выбранным запросом. Исход остаётся неизвестным.");
      }
      if (entry.receipt?.state === "completed" && receipt.state === "running") return;
      entry.receipt = {
        id: receipt.id, request: entry.body, state: receipt.state, outcome: receipt.outcome,
        detail: receipt.detail, readback: receipt.readback && { state: receipt.readback.state, detail: receipt.readback.detail },
      };
      this.save();
    };
    const submit = async (entry: RecordEntry) => {
      if (!key || this.busy.has(key) || !current) return;
      this.busy.add(key);
      status.set_label("Шлюз обрабатывает запрос сброса…");
      try {
        const receipt = await this.gateway.json<Receipt>("POST", `${accountsPath}/account-resets`, entry.body,
          { ...ownerHeaders, "Idempotency-Key": entry.key }, true);
        accept(entry, receipt);
        if (current) status.set_label("");
        if (receipt.state !== "running") { await load(); this.changed(); }
      } catch (error) {
        if (current) status.set_label(`Итог запроса не подтверждён. ${errorText(error)}`);
      } finally {
        this.busy.delete(key);
        render();
      }
    };
    const inspect = async (entry: RecordEntry) => {
      if (!key || !entry.receipt?.id || this.readback.has(key) || this.busy.has(key) || !current) return;
      this.readback.add(key);
      try {
        const receipt = await this.gateway.json<Receipt>("GET", `${accountsPath}/account-resets/${encodeURIComponent(entry.receipt.id)}`, undefined, undefined, false, inspectCancel);
        accept(entry, receipt);
        if (current) status.set_label("");
        if (receipt.state !== "running") { await load(); this.changed(); }
      } catch (error) {
        if (current) status.set_label(error instanceof HttpError && error.status === 404
          ? "Шлюз не нашёл квитанцию. Можно повторить исходный запрос с прежним ключом." : errorText(error));
      } finally {
        this.readback.delete(key);
        render();
      }
    };
    const createReset = async (offer: Offer, grant?: Grant) => {
      if (!key || !target || !current || writing) return;
      const validOffer = () => snapshot.reads?.quota === "ok" && snapshot.facets?.quota?.stale !== true
        && snapshot.resource_capabilities?.reset === true && snapshot.resources?.some((resource) => sameTarget(resource.target, target)
          && resource.resets?.freshness === "fresh" && resource.resets.value?.includes(offer));
      if (!validOffer()) return;
      const old = this.records.get(key);
      if ((old && recoverable(old)) || this.busy.has(key)) return;
      if (!await confirm(dialog, `Использовать сброс для ${target.profile_id}?`,
        [target.harness, grant?.label || offer.label || offer.id,
          "Этот запрос может израсходовать выбранный ресурс сброса."].join("\n"), "Использовать сброс") || !current) return;
      if (this.records.get(key) !== old || this.busy.has(key) || !validOffer()) return;
      const entry = { key: GLib.uuid_string_random(), body: { target, offer_id: offer.id, ...(grant ? { grant_id: grant.id } : {}) } };
      this.records.set(key, entry);
      try { this.save(); } catch (error) {
        if (old) this.records.set(key, old);
        else this.records.delete(key);
        status.set_label(errorText(error));
        return;
      }
      await submit(entry);
    };
    const tools = row();
    const readButton = button("Перечитать квоту", () => void load());
    tools.append(readButton);
    const refreshButton = button("Запросить обновление квоты", () => void refresh());
    tools.append(refreshButton);
    for (const widget of [tools, status, refreshView.widget, receiptBox, data]) content.append(widget);
    const poll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
      const entry = key && this.records.get(key);
      if (entry && entry.receipt?.state === "running" && snapshot.resource_capabilities?.inspect_reset === true) void inspect(entry);
      return GLib.SOURCE_CONTINUE;
    });
    const parentClosed = parent instanceof Adw.Dialog ? parent.connect("closed", () => dialog.force_close()) : undefined;
    dialog.connect("closed", () => {
      if (!current) return;
      current = false;
      readEpoch++;
      readCancel.cancel();
      refreshCancel.cancel();
      refreshView.close();
      inspectCancel.cancel();
      GLib.Source.remove(poll);
      if (parentClosed !== undefined) parent.disconnect(parentClosed);
    });
    this.present(dialog, parent);
    render();
    void load();
  }
}
