import { accountsPath, type Harness, type Status } from "./accounts-quota.js";
import { type Gateway, query } from "./gateway.js";
import { Adw, Gio, Gtk } from "./gi.js";
import { readCatalog, type Catalog } from "./model-catalog.js";
import { object, type SettingsDocument } from "./settings-write.js";
import { actionRow, button, clear, column, errorText, label, sheet } from "./ui.js";

interface Verdict { state: string; detail: string }

const instant = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function futureReset(value: string, now: number): number {
  const parts = instant.exec(value);
  if (!parts) return 0;
  const [year, month, day] = parts.slice(1, 4).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (!year || day > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]) return 0;
  const time = Date.parse(value);
  return time > now ? time : 0;
}

type QuotaVerdict = { state: "available" | "unknown" } | { state: "exhausted" | "cooldown"; reset: string; time: number };

function quotaForAccount(snapshot: Status, harness: string, profile: string, now: number): QuotaVerdict {
  const rows = (snapshot.quota ?? []).filter(item => item.subject?.harness === harness && item.subject.subject_id === profile);
  const absences = (snapshot.quota_absences ?? []).filter(item => item.subject?.harness === harness && item.subject.subject_id === profile);
  const key = (item: (typeof rows | typeof absences)[number]) => item.subject.credential_route ?? null;
  const verdicts: QuotaVerdict[] = [];
  for (const route of new Set([...rows, ...absences].map(key))) {
    const evidence = rows.filter(item => key(item) === route);
    const blocks = evidence.flatMap(item => {
      const state = item.availability?.state;
      const reset = item.availability?.resets_at ?? "";
      const time = futureReset(reset, now);
      return time && (state === "exhausted" || state === "cooldown") ? [{ state, reset, time }] : [];
    }).sort((a, b) => a.time - b.time);
    if (blocks.length) {
      verdicts.push({ ...blocks[0], state: blocks.some(block => block.state === "exhausted") ? "exhausted" : "cooldown" });
      continue;
    }
    const measured = evidence.some(item => Array.isArray(item.constraints) && item.constraints.some(raw => {
      const window = object(raw);
      const ratio = window.used_ratio;
      const models = window.applies_to_models;
      const prefixes = window.applies_to_model_prefixes;
      const kinds = window.applies_to_request_kinds;
      return typeof ratio === "number" && ratio >= 0 && ratio <= 1
        && (models == null || Array.isArray(models) && !models.length)
        && (prefixes === undefined || Array.isArray(prefixes) && !prefixes.length)
        && (kinds === undefined || Array.isArray(kinds) && kinds.includes("text"));
    }));
    const available = measured && !absences.some(item => key(item) === route)
      && evidence.every(item => item.freshness === "fresh" && item.availability?.state === "available");
    verdicts.push({ state: available ? "available" : "unknown" });
  }
  return combineQuota(verdicts);
}

function combineQuota(verdicts: QuotaVerdict[]): QuotaVerdict {
  if (verdicts.some(verdict => verdict.state === "available")) return { state: "available" };
  const blocks = verdicts.flatMap(verdict => "time" in verdict ? [verdict] : []).sort((a, b) => a.time - b.time);
  if (!blocks.length || blocks.length !== verdicts.length) return { state: "unknown" };
  return { ...blocks[0], state: blocks.some(block => block.state === "exhausted") ? "exhausted" : "cooldown" };
}

type ModelFact = "exact" | "base" | "missing" | "unknown";

function modelForAccount(harness: Harness, model: string, profile: string): ModelFact {
  if (!model) return "exact";
  if (!Array.isArray(harness.models) || harness.models_error) return "unknown";
  const catalog = harness.model_catalog;
  const account = catalog?.accounts?.find(item => item.credentialProfileId === profile);
  if (catalog && !account?.catalog) return "unknown";
  const spelling = (value: unknown) => {
    const text = typeof value === "string" ? value : "";
    return harness.id === "claude" ? text.replace(/\[1m\]$/i, "[1m]") : text;
  };
  const target = spelling(model);
  const base = harness.id === "claude" && target.endsWith("[1m]") ? target.slice(0, -4) : "";
  let fact: ModelFact = "missing";
  for (const raw of harness.models) {
    const item = object(raw);
    if (item.credential_profile_id && item.credential_profile_id !== profile) continue;
    const names = [spelling(item.id ?? item.value ?? raw), spelling(item.resolved_model)];
    const exact = names.includes(target);
    if (!exact && (!base || !names.includes(base))) continue;
    if (item.credential_profile_id === profile) {
      if (exact) return "exact";
      fact = "base";
    } else if (!catalog && fact === "missing") {
      fact = "unknown";
    }
  }
  return fact;
}

export function subagentAvailability(entry: SettingsDocument, snapshot?: Status, now = Date.now()): Verdict {
  const unavailable = (detail: string) => ({ state: "Недоступен", detail });
  const unknown = (detail: string) => ({ state: "Не подтверждено", detail });
  const route = object(entry.route);
  if (route.kind === "api_model") return { state: "Проверяется при запуске", detail: "Шлюз проверит доступность модели при запуске субагента." };
  if (route.kind !== "agent_session" || typeof route.target_id !== "string") return unknown("Маршрут не задан.");
  const [harnessId, model = ""] = route.target_id.split("=", 2);
  const pin = typeof route.credential_profile_id === "string" ? route.credential_profile_id : "";
  if (snapshot?.reads?.catalog !== "ok" || !Array.isArray(snapshot.harnesses)) return unknown("Каталог инструментов недоступен.");
  const harness = snapshot.harnesses.find(tool => tool.id === harnessId);
  if (!harness) return unavailable("Инструмента нет в каталоге шлюза.");
  if (!pin && harness.enabled === false) return unavailable("Инструмент выключен.");
  const access = typeof entry.access === "string" && entry.access ? entry.access : "full";
  const supported = harness.access_profiles_supported;
  if (Array.isArray(supported) && !supported.includes(access)
    && !(access === "workspace_write" && supported.includes("external_sandbox_full"))) {
    return unavailable(`Инструмент не поддерживает права ${access}.`);
  }
  if (snapshot.reads.accounts !== "ok" || !Array.isArray(snapshot.profiles?.profiles)) return unknown("Состояние аккаунтов недоступно.");
  const usable = snapshot.profiles.profiles.filter(({ profile, status }) => profile?.harness_id === harnessId
    && profile.profile_id && (!pin || profile.profile_id === pin) && profile.enabled !== false && status?.verification === "passed");
  if (!usable.length) return unavailable(pin ? `Аккаунт ${pin} выключен, отсутствует или вход не подтверждён.`
    : "Нет включённых аккаунтов с подтверждённым входом.");
  const pool = object(snapshot.profiles.accountPools?.find(item => item.harness_id === harnessId)?.next_up);
  if (!pin && (pool.kind === "none" || pool.kind === "api_key_route")) {
    return unavailable("Шлюз не выбрал аккаунт подписки для этого инструмента.");
  }
  const candidates = usable.map(({ profile }) => ({
    id: profile.profile_id, model: modelForAccount(harness, model, profile.profile_id),
  })).filter(candidate => candidate.model !== "missing");
  if (!candidates.length) return unavailable(`Модель ${model} отсутствует в каталогах подходящих аккаунтов.`);
  const exact = candidates.filter(candidate => candidate.model === "exact");
  const baseOnly = candidates.every(candidate => candidate.model === "base");
  const qualifier = baseOnly ? " В каталоге есть базовая модель. Вариант [1m] проверяется при запуске." : "";
  if (snapshot.reads.quota !== "ok") {
    return unknown((exact.length ? "Вход подтверждён. Квота недоступна." : "Доступ к модели и квота не подтверждены.") + qualifier);
  }
  const scope = snapshot.availability_scope;
  if (scope?.basis !== "quota_block" || scope.requestKind !== "text" || scope.model !== (model || null)) {
    return unknown((exact.length ? "Вход подтверждён. Шлюз не подтвердил квоту для этого маршрута."
      : "Шлюз не подтвердил доступ к модели и квоту для этого маршрута.") + qualifier);
  }
  const facts = candidates.map(candidate => {
    if (candidate.model === "unknown") return { state: "unknown" } as const;
    const fact = quotaForAccount(snapshot, harnessId, candidate.id, now);
    return candidate.model === "base" && fact.state === "available" ? { state: "unknown" } as const : fact;
  });
  const quota = combineQuota(facts);
  if ("reset" in quota) return { state: quota.state === "exhausted" ? "Лимит исчерпан" : "Временное ограничение",
    detail: `Следующая проверка после ${quota.reset}.${qualifier}` };
  if (quota.state === "available") return { state: "Квота доступна", detail: "Шлюз подтвердил квоту для подходящего аккаунта." };
  return unknown((exact.length ? "Вход подтверждён. Данных о квоте недостаточно."
    : "Доступ к модели и квота не подтверждены.") + qualifier);
}

interface ManagedScope { key: string; source: string; profile: string; value: string }
interface CatalogRead { data?: Catalog; error?: string; fresh: boolean }

function managedScope(entry: SettingsDocument): ManagedScope | undefined {
  const route = object(entry.route);
  const value = typeof route.target_id === "string" ? route.target_id.trim() : "";
  if (route.kind !== "api_model" || !value.startsWith("claudexor::") || value.endsWith(" (local)")) return;
  const separator = value.indexOf("=", "claudexor::".length);
  if (separator < 0) return;
  const source = value.slice("claudexor::".length, separator).trim();
  const model = value.slice(separator + 1).trim();
  if (!source || !model) return;
  if (route.credential_profile_id != null && typeof route.credential_profile_id !== "string") return;
  const profile = typeof route.credential_profile_id === "string" ? route.credential_profile_id.trim() : "";
  return { key: JSON.stringify([source, profile]), source, profile, value: `claudexor::${source}=${model}` };
}

function scopedCatalog(raw: unknown, scope: ManagedScope): Catalog {
  const data = readCatalog(raw);
  const wrongItem = data.items.some(item => !item.value.startsWith(`claudexor::${scope.source}=`)
    || (item.source_id != null && item.source_id !== scope.source)
    || (scope.profile && item.credential_profile_id && item.credential_profile_id !== scope.profile));
  const wrongAccount = (data.account_catalogs ?? []).some(aggregate => {
    const source = aggregate.source ?? aggregate.sourceId;
    return (source != null && source !== scope.source) || (scope.profile && Array.isArray(aggregate.accounts)
      && aggregate.accounts.some(raw => { const account = object(raw); return account.credentialProfileId && account.credentialProfileId !== scope.profile; }));
  });
  if (wrongItem || wrongAccount) throw new Error("Шлюз вернул каталог другого источника или профиля.");
  return data;
}

function statusSnapshot(raw: unknown): Status {
  const record = (v: unknown): v is Record<string, any> => object(v) === v;
  const strings = (v: Record<string, any>, keys: string[]) => keys.every(key => v[key] == null || typeof v[key] === "string");
  const subject = (v: unknown) => record(v) && typeof v.harness === "string" && strings(v, ["credential_route", "subject_id"]);
  if (!record(raw) || !Array.isArray(raw.harnesses) || !record(raw.profiles) || !record(raw.reads)
    || ["catalog", "accounts", "quota"].some(key => !["ok", "failed", "not_read"].includes(raw.reads[key]))
    || !strings(raw, ["error"])
    || raw.harnesses.some(tool => !record(tool) || typeof tool.id !== "string" || (tool.enabled != null && typeof tool.enabled !== "boolean")
      || (tool.access_profiles_supported !== undefined && (!Array.isArray(tool.access_profiles_supported) || tool.access_profiles_supported.some((v: unknown) => typeof v !== "string")))
      || (tool.models !== undefined && (!Array.isArray(tool.models) || tool.models.some((v: unknown) => typeof v !== "string" && (!record(v) || !strings(v, ["id", "value", "resolved_model", "credential_profile_id"])))))
      || (tool.model_catalog != null && (!record(tool.model_catalog) || (tool.model_catalog.accounts !== undefined
        && (!Array.isArray(tool.model_catalog.accounts) || tool.model_catalog.accounts.some((v: unknown) => !record(v)))))))
    || (raw.profiles.profiles !== undefined && (!Array.isArray(raw.profiles.profiles) || raw.profiles.profiles.some((v: unknown) => !record(v)
      || !record(v.profile) || ![v.profile.harness_id, v.profile.profile_id].every(id => typeof id === "string" && id)
      || (v.profile.enabled != null && typeof v.profile.enabled !== "boolean") || (v.status != null && (!record(v.status) || !strings(v.status, ["verification"]))))))
    || (raw.profiles.accountPools !== undefined && (!Array.isArray(raw.profiles.accountPools) || raw.profiles.accountPools.some((v: unknown) => !record(v)
      || (v.next_up != null && !record(v.next_up)))))
    || ["quota", "quota_absences"].some(key => raw[key] !== undefined && (!Array.isArray(raw[key]) || raw[key].some((v: unknown) => !record(v)
      || !subject(v.subject) || (v.availability != null && (!record(v.availability) || !strings(v.availability, ["state", "resets_at"])))
      || (v.constraints !== undefined && (!Array.isArray(v.constraints) || v.constraints.some((c: unknown) => !record(c)))))))
    || (raw.availability_scope != null && (!record(raw.availability_scope) || !strings(raw.availability_scope, ["model", "basis", "requestKind"])))) {
    throw new Error("Шлюз не вернул пригодные сведения о доступности сессий.");
  }
  return raw as Status;
}

function fact(content: any, title: string, value: unknown): void {
  if (value == null || value === "") return;
  const text = typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
  const widget = label(`${title} · ${text}`);
  widget.set_selectable(true);
  content.append(widget);
}

function managedFacts(scope: ManagedScope, read: CatalogRead | undefined): { verdict: Verdict; content: any } {
  const content = column(4);
  fact(content, "Источник модели", scope.source);
  fact(content, "Запрошенный профиль", scope.profile || "Auto");
  if (!read?.fresh) fact(content, "Чтение каталога", read?.error || "Не подтверждено");
  if (!read?.data) return { content, verdict: { state: "Не подтверждено", detail: "Каталог управляемой модели не прочитан." } };
  const data = read.data;
  const matches = data.items.filter(item => item.value === scope.value && (item.source_id == null || item.source_id === scope.source)
    && (!scope.profile || item.credential_profile_id === scope.profile));
  for (const source of data.model_sources.filter(source => source.id === scope.source)) {
    fact(content, "Название источника", source.label);
    fact(content, "Инструмент учётных данных", source.credentialHarness);
  }
  if (!read.fresh) content.append(label("Показан последний прочитанный каталог. Текущее состояние не подтверждено.", "dim-label"));
  if (data.partial) content.append(label("Шлюз вернул частичный каталог.", "dim-label"));
  for (const error of data.errors) fact(content, "Ошибка каталога", [error.credential_profile_id, error.code, error.error].filter(Boolean).join(" · "));
  for (const item of matches) {
    const info = column(4);
    fact(info, "Маршрут", item.value);
    fact(info, "Профиль", item.credential_profile_id || "Аккаунт не указан");
    fact(info, "Доступность модели в каталоге", item.availability);
    fact(info, "Проблема модели", item.problem);
    fact(info, "Отпечаток аккаунта", item.account_fingerprint);
    fact(info, "Источник сведений", item.provenance);
    fact(info, "Время проверки", item.observed_at);
    content.append(new Gtk.Expander({ label: `Модель · ${item.credential_profile_id || "Auto"}`, child: info }));
  }
  let readableProfile = false;
  for (const aggregate of data.account_catalogs ?? []) {
    const source = aggregate.source ?? aggregate.sourceId;
    if (source !== scope.source || !Array.isArray(aggregate.accounts)) continue;
    for (const raw of aggregate.accounts) {
      const account = object(raw);
      if (scope.profile && account.credentialProfileId !== scope.profile) continue;
      const info = column(4), catalog = object(account.catalog);
      if (scope.profile && account.credentialProfileId === scope.profile && account.catalog === catalog) readableProfile = true;
      fact(info, "Профиль", account.credentialProfileId);
      fact(info, "Доступность аккаунта", account.availability);
      fact(info, "Проблема аккаунта", account.problem);
      if (Object.hasOwn(account, "catalog")) fact(info, "Снимок каталога", account.catalog === null ? "Недоступен"
        : account.catalog === catalog ? "Получен" : "Формат неизвестен");
      if (Array.isArray(catalog.models)) fact(info, "Моделей в снимке", catalog.models.length);
      fact(info, "Отпечаток аккаунта", catalog.accountFingerprint);
      fact(info, "Источник сведений", catalog.provenance);
      fact(info, "Время проверки", catalog.observedAt);
      content.append(new Gtk.Expander({ label: `Аккаунт · ${String(account.label || account.credentialProfileId || "Без ID")}`, child: info }));
    }
  }
  const verdict = !read.fresh ? { state: "Не подтверждено", detail: "Не удалось обновить каталог управляемой модели." }
    : matches.length ? { state: "Модель перечислена", detail: `Записей модели для выбранной области · ${matches.length}. Состояние аккаунтов показано отдельно.` }
      : scope.profile && !readableProfile ? { state: "Не подтверждено", detail: "Шлюз не подтвердил каталог запрошенного профиля." }
      : data.partial || data.errors.length ? { state: "Не подтверждено", detail: "Модель не перечислена в полученной части каталога." }
        : { state: "Модель не перечислена", detail: "В полученном каталоге выбранного источника и профиля этой модели нет." };
  return { content, verdict };
}

export function showSubagentAvailability(gateway: Gateway, parent: any, present: (dialog: any, parent: any) => void,
  entries: SettingsDocument[], enabled: boolean): void {
  const rows: SettingsDocument[] = entries.map(entry => ({ ...entry, route: { ...object(entry.route) } }));
  const scopes = new Map<string, ManagedScope>();
  for (const entry of rows) { const scope = managedScope(entry); if (scope) scopes.set(scope.key, scope); }
  const content = column();
  const dialog = sheet("Доступность маршрутов субагентов", content);
  const status = label("", "dim-label");
  const list = column();
  let open = true, loading = false, parentSignal = 0;
  let pending: any;
  let snapshot: Status | undefined;
  let sessionFresh = false;
  const catalogs = new Map<string, CatalogRead>();
  const dispose = () => {
    if (!open) return;
    open = false;
    pending?.cancel();
    pending = undefined;
    if (parentSignal) { parent.disconnect(parentSignal); parentSignal = 0; }
  };
  dialog.connect("closed", dispose);
  if (parent instanceof Adw.Dialog || parent instanceof Gtk.Window) parentSignal = parent.connect(
    parent instanceof Gtk.Window ? "close-request" : "closed", () => { if (open) { dispose(); dialog.force_close(); } return false; });
  const render = () => {
    if (!open) return;
    clear(list);
    if (!rows.length) list.append(label("В каталоге нет субагентов.", "dim-label"));
    const now = Date.now();
    for (const entry of rows) {
      const route = object(entry.route), scope = managedScope(entry);
      const managed = scope ? managedFacts(scope, catalogs.get(scope.key)) : undefined;
      const verdict = managed?.verdict ?? subagentAvailability(entry, sessionFresh ? snapshot : undefined, now);
      const group = new Adw.PreferencesGroup();
      group.add(actionRow({ use_markup: false, title: String(entry.subagent_id || "Без ID"),
        subtitle: [route.target_id, route.credential_profile_id, entry.enabled === false && "Строка выключена",
          `${verdict.state} · ${verdict.detail}`].filter(Boolean).join("\n") }));
      if (managed) {
        managed.content.append(label("Наличие модели и состояние аккаунта — сведения каталога на момент чтения. Возможность запуска проверяет шлюз.", "dim-label"));
        group.add(new Gtk.Expander({ label: "Сведения управляемой модели", child: managed.content }));
      }
      list.append(group);
    }
  };
  const reload = button("Перечитать", () => void load());
  const load = async () => {
    if (!open || loading) return;
    loading = true;
    const cancel = pending = new Gio.Cancellable();
    reload.set_sensitive(false);
    status.set_label("Читаю каталог, аккаунты и квоту…");
    const requests = [gateway.json<unknown>("GET", `${accountsPath}/status?include=models`, undefined, undefined, true, cancel).then(statusSnapshot),
      ...[...scopes.values()].map(scope => gateway.json<unknown>("GET", `/api/model-catalog${query({ source_id: scope.source, credential_profile_id: scope.profile || undefined })}`,
        undefined, undefined, true, cancel).then(value => scopedCatalog(value, scope)))];
    try {
      const [state, ...modelReads] = await Promise.allSettled(requests);
      if (!open) return;
      const errors: string[] = [];
      sessionFresh = state.status === "fulfilled";
      if (state.status === "fulfilled") { snapshot = state.value as Status; if (snapshot.error) errors.push(snapshot.error); }
      else errors.push(`Состояние сессий не прочитано · ${errorText(state.reason)}`);
      [...scopes.values()].forEach((scope, index) => {
        const result = modelReads[index];
        if (result.status === "fulfilled") catalogs.set(scope.key, { data: result.value as Catalog, fresh: true });
        else { const error = errorText(result.reason); catalogs.set(scope.key, { data: catalogs.get(scope.key)?.data, error, fresh: false }); errors.push(`Источник ${scope.source} / ${scope.profile || "Auto"} · ${error}`); }
      });
      status.set_label(errors.length ? errors.join("\n") : "Состояние на момент чтения. Возможность запуска проверяет шлюз.");
      render();
    } finally {
      if (pending === cancel) pending = undefined;
      loading = false;
      if (open) reload.set_sensitive(true);
    }
  };
  content.append(label("Показаны маршруты из формы на момент открытия, включая несохранённые правки.", "dim-label"));
  if (!enabled) content.append(label("Делегирование в открытой форме выключено.", "dim-label"));
  for (const item of [reload, status, list]) content.append(item);
  present(dialog, parent);
  void load();
}
