import { Gio, Gtk } from "./gi.js";
import { AccountLogin } from "./accounts-login.js";
import { AccountMaintenance } from "./accounts-maintenance.js";
import { AccountQuota, accountsPath, facts, type Profile, type RoutingEvidence, type Status, type Target, valueText } from "./accounts-quota.js";
import { type Gateway, HttpError, query } from "./gateway.js";
import type { Present } from "./mcp-server.js";
import { showReviewPool } from "./review-pool.js";
import { object, ownerHeaders } from "./settings-write.js";
import { button, clear, column, confirm, errorText, label, row, sheet } from "./ui.js";

interface RestartPreview {
  token: string;
  engine: { state?: string; serving?: unknown; pin?: unknown; direction?: string };
  runs: {
    status: string; total?: number | null; ouroboros?: number | null; other?: number | null;
    items?: { run_id: string; owner?: string; task_id?: string; kind?: string; harness?: string; state?: string; started_at?: string; project?: string }[];
    items_omitted?: number;
    error?: string | null;
  };
  model_calls?: { status?: string; active?: number | null; queued?: number | null };
  warnings?: { message: string }[];
}

interface RestartReply {
  status: Status;
  restart: { stop: string; serving: boolean; error?: string };
}

const readLabels = { ok: "прочитано", not_read: "чтение не выполнялось", failed: "чтение не удалось" };
const count = (value: number | null | undefined) => value == null ? "неизвестно" : String(value);
const profileTarget = ({ profile }: Profile): Target => ({ harness: profile.harness_id, profile_id: profile.profile_id });
const profileLabel = ({ profile, identity }: Profile) => profile.display_name || identity?.email || profile.profile_id;

function verificationLabel(status: Profile["status"]): string {
  const verification = status?.verification;
  if (verification === "passed") {
    if (status?.verification_source === "vendor") return "Вход подтверждён провайдером";
    if (status?.verification_source === "local_store") return "Учётные данные обнаружены локально";
    return "Проверка прошла, источник подтверждения не указан";
  }
  if (verification === "not_run") return status?.availability === "unknown" ? "Статус входа неизвестен" : "Вход не проверялся";
  if (verification === "failed") return "Проверка входа не прошла";
  return verification || "Статус входа не сообщён";
}

function renderRoutingEvidence(content: any, roster: Status["profiles"], target: Target, now: number): void {
  const evidence = roster?.routing_evidence;
  const matching = (entries?: RoutingEvidence[]) =>
    Array.isArray(entries) ? entries.filter(mark => mark?.harness_id === target.harness && mark.profile_id === target.profile_id
      && typeof mark.requested_model === "string" && mark.requested_model) : [];
  const marks = matching(evidence?.capabilities);
  const refusals = matching(evidence?.refusals);
  if (!marks.length && !refusals.length) return;
  const expiry = (value?: string) => {
    const at = Date.parse(value ?? "");
    if (!Number.isFinite(at)) return "Срок действия не указан";
    return at > now ? `Можно проверить снова после ${value}` : "Следующий запрос может проверить доступ снова";
  };
  const details = column(6);
  for (const mark of marks) {
    facts(details, "Временная отметка о недоступности модели", mark.requested_model, mark.state);
    facts(details, mark.provider_reason);
    facts(details, mark.observed_at && `Отмечено ${mark.observed_at}`, expiry(mark.expires_at));
  }
  for (const refusal of refusals) {
    facts(details, "Зафиксирован отказ", refusal.requested_model, refusal.observed_at && `Отмечено ${refusal.observed_at}`,
      refusal.expires_at && `Срок записи до ${refusal.expires_at}`);
  }
  content.append(new Gtk.Expander({ label: "Сведения о доступе к моделям", child: details }));
}

export class Accounts {
  private dialog?: any;
  private snapshot?: Status;
  private readonly login: AccountLogin;
  private readonly quota: AccountQuota;
  private readonly maintenance: AccountMaintenance;
  private reading = 0;
  private busy = false;
  private readCancel?: any;
  private restartDialog?: any;

  constructor(private readonly gateway: Gateway, private readonly present: Present) {
    this.login = new AccountLogin(gateway, present, () => void this.load());
    this.quota = new AccountQuota(gateway, present, () => void this.load());
    this.maintenance = new AccountMaintenance(gateway, present, () => void this.load());
  }

  private status?: any;
  private data?: any;
  private notice?: any;

  show(): void {
    if (this.dialog) return;
    const content = column(10);
    const dialog = sheet("Аккаунты Claudexor", content);
    dialog.set_content_width(740);
    dialog.set_content_height(680);
    this.dialog = dialog;
    if (this.snapshot) this.snapshot = { ...this.snapshot, reads: { ...this.snapshot.reads, accounts: "not_read" } };
    this.status = label("Читаю состояние…", "dim-label");
    this.notice = label("", "dim-label");
    this.data = column();
    const action = (title: string, callback: () => void) => button(title, () => {
      if (this.dialog === dialog) callback();
    });
    const actions = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, column_spacing: 6, row_spacing: 6 });
    actions.append(action("Перечитать состояние", () => void this.load()));
    actions.append(action("Запустить Claudexor", () => void this.wake()));
    actions.append(action("Перезапустить…", () => this.restart()));
    actions.append(action("Начать или продолжить вход…", () => this.login.show(dialog)));
    actions.append(action("Наблюдения квоты…", () => this.quota.show(dialog, undefined, "Квота аккаунтов", this.snapshot ?? {}, false)));
    actions.append(action("Пул ревью…", () => showReviewPool(this.gateway, this.present, dialog)));
    actions.append(action("Обслуживание инструментов…", () => this.maintenance.show(dialog, this.snapshot?.harnesses?.map(({ id }) => id) ?? [])));
    for (const widget of [actions, this.status, this.notice, this.data]) content.append(widget);
    dialog.connect("closed", () => {
      this.dialog = undefined;
      this.status = this.notice = this.data = undefined;
      this.reading++;
      this.readCancel?.cancel();
    });
    this.present(dialog);
    this.render();
    void this.load();
  }

  private async load(includeModels = false): Promise<void> {
    const dialog = this.dialog;
    if (!dialog) return;
    const generation = ++this.reading;
    this.readCancel?.cancel();
    const cancel = this.readCancel = new Gio.Cancellable();
    try {
      const result = await this.gateway.json<Status>("GET", `${accountsPath}/status${query({ include: includeModels ? "models" : undefined })}`, undefined, undefined, true, cancel);
      if (this.dialog !== dialog || generation !== this.reading) return;
      this.apply(result);
      this.status.set_label("");
    } catch (error) {
      if (this.dialog === dialog && generation === this.reading) {
        if (this.snapshot) this.snapshot = { ...this.snapshot, reads: { accounts: "failed", catalog: "failed", quota: "failed" } };
        this.render();
        this.status.set_label(errorText(error));
      }
    }
  }

  private apply(result: Status): void {
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Шлюз не подтвердил состояние аккаунтов.");
    for (const field of ["harnesses", "quota", "quota_absences", "resources"] as const) {
      if (result[field] !== undefined && !Array.isArray(result[field])) throw new Error("Шлюз вернул неполное состояние аккаунтов.");
    }
    if ((result.harnesses ?? []).some((item) => !item || typeof item.id !== "string")) throw new Error("Шлюз вернул инструмент без идентификатора.");
    const profiles = result.profiles?.profiles;
    if ((profiles !== undefined && !Array.isArray(profiles)) || (profiles ?? []).some((item) => !item?.profile
      || typeof item.profile.harness_id !== "string" || !item.profile.harness_id
      || typeof item.profile.profile_id !== "string" || !item.profile.profile_id
      || (item.profile.enabled !== undefined && typeof item.profile.enabled !== "boolean"))) {
      throw new Error("Шлюз вернул неполный список аккаунтов.");
    }
    if (result.profiles?.accountPools !== undefined && (!Array.isArray(result.profiles.accountPools)
      || result.profiles.accountPools.some((item) => !item))) throw new Error("Шлюз вернул неполные маршруты аккаунтов.");
    if (result.reads?.accounts === "ok" && !Array.isArray(profiles)) throw new Error("Шлюз не подтвердил прочитанный список аккаунтов.");
    const old = this.snapshot;
    this.snapshot = {
      ...result,
      ...(result.reads?.accounts === "ok" ? {} : { profiles: result.profiles?.profiles?.length ? result.profiles : old?.profiles ?? result.profiles }),
      ...(result.reads?.catalog === "ok" ? {} : { harnesses: result.harnesses?.length ? result.harnesses : old?.harnesses ?? result.harnesses }),
      ...(result.reads?.quota === "ok" ? {} : {
        quota: result.quota?.length ? result.quota : old?.quota ?? result.quota,
        quota_absences: result.quota_absences?.length ? result.quota_absences : old?.quota_absences ?? result.quota_absences,
        resources: result.resources?.length ? result.resources : old?.resources ?? result.resources,
      }),
    };
    this.render();
  }

  private render(): void {
    if (!this.data) return;
    clear(this.data);
    const state = this.snapshot;
    if (!state) return;
    const dialog = this.dialog;
    const action = (title: string, callback: () => void) => button(title, () => {
      if (this.dialog === dialog) callback();
    });
    const daemon = state.daemon;
    facts(this.data, daemon?.status ?? daemon?.state, daemon?.version, daemon?.last_error ?? daemon?.error, state.error, state.config_dir);
    for (const [key, title] of [["catalog", "Инструменты"], ["accounts", "Аккаунты"], ["quota", "Квота"]] as const) {
      const status = state.reads?.[key] ?? "not_read";
      const facet = state.facets?.[key];
      facts(this.data, title, readLabels[status], facet?.stale && "последнее известное", facet?.observed_at,
        facet?.error || state.read_errors?.[key]?.code);
    }
    this.data.append(label("Инструменты", "title-3"));
    for (const harness of state.harnesses ?? []) {
      facts(this.data, harness.display_name || harness.id, harness.id, harness.status, harness.provider_family);
      if (harness.models_error) facts(this.data, "Не удалось прочитать модели", harness.models_error);
      if (harness.models) {
        const models = label(valueText(harness.models));
        models.set_selectable(true);
        this.data.append(new Gtk.Expander({ label: "Модели инструмента", child: models }));
      }
      this.data.append(action(`Войти · ${harness.display_name || harness.id}…`, () => this.login.show(dialog, harness.id)));
    }
    this.data.append(action("Перечитать с моделями", () => void this.load(true)));
    this.data.append(label("Аккаунты", "title-3"));
    const profiles = state.profiles?.profiles ?? [];
    const fresh = state.reads?.accounts === "ok" && !state.facets?.accounts?.stale;
    const evidenceRead = state.profiles?.routing_evidence_read;
    if (fresh && evidenceRead?.state === "failed") {
      facts(this.data, "Не удалось прочитать сведения о доступе к моделям", evidenceRead.observed_at);
    }
    if (!profiles.length) facts(this.data, fresh ? "В шлюзе нет сохранённых аккаунтов." : "Актуальный список аккаунтов недоступен.");
    const now = Date.now();
    for (const entry of profiles) {
      const target = profileTarget(entry);
      if (!target.harness || !target.profile_id) continue;
      const content = column(4);
      const status = entry.status;
      this.data.append(new Gtk.Expander({ label: [profileLabel(entry), target.harness,
        fresh ? (entry.profile.enabled === false ? "отключён" : "включён") : "последнее известное состояние",
        verificationLabel(status)].filter(Boolean).join(" · "), child: content }));
      facts(content, target.profile_id, entry.identity?.email, entry.identity?.plan);
      facts(content, status?.verification, status?.verification_source, status?.availability, status?.reason,
        status?.last_verified_at && `Проверено ${status.last_verified_at}`);
      if (fresh && evidenceRead?.state !== "failed") renderRoutingEvidence(content, state.profiles, target, now);
      const actions = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, column_spacing: 6, row_spacing: 6 });
      actions.append(action("Войти заново…", () => this.login.show(dialog, target.harness, target.profile_id)));
      actions.append(action("Квота и ресурсы…", () => this.quota.show(dialog, target, `Квота · ${profileLabel(entry)}`, state,
        state.resource_capabilities?.reset === true && state.resource_capabilities_read !== "failed")));
      if (fresh) {
        actions.append(action(entry.profile.enabled === false ? "Включить" : "Отключить", () => void this.profile(entry, false)));
        actions.append(action("Убрать аккаунт…", () => void this.profile(entry, true)));
      }
      content.append(actions);
    }
    if (!fresh) return;
    for (const entry of state.profiles?.accountPools ?? []) {
      const next = entry.next_up;
      if (!next) continue;
      const harness = state.harnesses?.find(tool => tool.id === entry.harness_id)?.display_name || entry.harness_id;
      if (next.kind === "profile" && next.profileId) {
        const profile = profiles.find(item => item.profile.harness_id === entry.harness_id && item.profile.profile_id === next.profileId);
        const name = profile ? profileLabel(profile) : next.profileId;
        facts(this.data, "Следующий аккаунт в ротации", harness, name, name !== next.profileId && next.profileId, next.route, next.reason);
      } else if (next.kind === "api_key_route") {
        facts(this.data, "Следующий маршрут", harness, "Ключ API", next.route, next.reason);
      } else if (next.kind === "none") {
        facts(this.data, harness, "Шлюз не выбрал следующий маршрут", next.reason);
      } else {
        facts(this.data, harness, "Следующий маршрут неизвестен");
      }
    }
  }

  private async wake(): Promise<void> {
    const dialog = this.dialog;
    if (!dialog || this.busy) return;
    this.busy = true;
    this.notice.set_label("Шлюз запускает Claudexor…");
    this.reading++;
    this.readCancel?.cancel();
    try {
      const result = await this.gateway.json<Status>("POST", `${accountsPath}/wake`, {}, ownerHeaders, true);
      if (this.dialog === dialog) {
        this.reading++;
        this.readCancel?.cancel();
        this.apply(result);
        this.notice.set_label(result.error ?? (result.daemon?.state === "running"
          ? "Движок отвечает после запроса запуска." : "Шлюз не подтвердил готовность движка после запроса запуска."));
      }
    } catch (error) {
      if (this.dialog === dialog) {
        this.notice.set_label(`Ответ о запуске не подтверждён. ${errorText(error)}`);
        await this.load();
      }
    } finally { this.busy = false; }
  }

  private async profile(entry: Profile, remove: boolean): Promise<void> {
    const dialog = this.dialog;
    if (!dialog || this.busy) return;
    const target = profileTarget(entry);
    if (this.snapshot?.reads?.accounts !== "ok" || this.snapshot.facets?.accounts?.stale
      || !this.snapshot.profiles?.profiles?.includes(entry)) return;
    if (remove && !await confirm(dialog, `Убрать аккаунт «${profileLabel(entry)}»?`,
      "Шлюз удалит привязку Claudexor. Состояние учётных данных у провайдера будет указано в квитанции.", "Убрать")) return;
    if (this.dialog !== dialog || this.busy || this.snapshot?.reads?.accounts !== "ok"
      || this.snapshot.facets?.accounts?.stale || !this.snapshot.profiles?.profiles?.includes(entry)) return;
    this.busy = true;
    const enabled = entry.profile.enabled === false;
    const path = `${accountsPath}/credential-profiles/${encodeURIComponent(target.harness)}/${encodeURIComponent(target.profile_id)}`;
    try {
      const receipt = await this.gateway.json<{ ok?: boolean; harness?: string; profile_id?: string; enabled?: boolean;
        removed?: boolean; profile?: Profile["profile"]; credentialCleanup?: string; cleanupWarning?: string;
        vendorCredentialDisposition?: { owner?: string; state?: string; scope?: string }; error?: string }>(
        remove ? "DELETE" : "PATCH", path, remove ? undefined : { enabled }, ownerHeaders);
      if (this.dialog !== dialog) return;
      if (receipt?.ok === false) throw new Error(receipt.error ?? "Шлюз отклонил изменение.");
      if (remove) {
        if (typeof receipt?.removed !== "boolean" || receipt.profile?.harness_id !== target.harness
          || receipt.profile?.profile_id !== target.profile_id) throw new Error("Квитанция не подтвердила удаление выбранной привязки.");
        const disposition = receipt.vendorCredentialDisposition;
        const retained = disposition?.owner === "vendor" && disposition.state === "left_unchanged" && disposition.scope === "os_user";
        this.notice.set_label([receipt.removed ? "Привязка удалена" : "Шлюз не удалил привязку",
          receipt.credentialCleanup && `Очистка: ${receipt.credentialCleanup}`, receipt.cleanupWarning,
          retained ? "Учётные данные провайдера для этого пользователя ОС оставлены без изменений; вне Ouroboros вход может сохраняться."
            : valueText(disposition)].filter(Boolean).join(" · "));
      } else {
        if (receipt?.ok !== true || receipt.harness !== target.harness || receipt.profile_id !== target.profile_id
          || receipt.enabled !== enabled) throw new Error("Квитанция не подтвердила изменение выбранного аккаунта.");
        this.notice.set_label("Шлюз принял изменение участия в ротации.");
      }
    } catch (error) {
      if (this.dialog === dialog) this.notice.set_label(`Итог изменения не подтверждён. ${errorText(error)}`);
    } finally {
      if (this.dialog === dialog) await this.load();
      this.busy = false;
    }
  }

  private restart(): void {
    const parent = this.dialog;
    if (!parent || this.busy || this.restartDialog) return;
    const content = column();
    const dialog = sheet("Перезапуск Claudexor", content);
    this.restartDialog = dialog;
    dialog.set_content_width(700);
    const status = label("Читаю план…", "dim-label");
    const plan = column();
    let open = true;
    let busy = false;
    let epoch = 0;
    let cancel = new Gio.Cancellable();
    let currentPreview: RestartPreview | undefined;
    const parentClosed = parent.connect("closed", () => dialog.force_close());
    dialog.connect("closed", () => {
      if (!open) return;
      open = false;
      epoch++;
      cancel.cancel();
      parent.disconnect(parentClosed);
      if (this.restartDialog === dialog) this.restartDialog = undefined;
    });
    const endpoint = `${accountsPath}/restart`;
    const render = (preview: RestartPreview) => {
      currentPreview = undefined;
      clear(plan);
      if (!preview || typeof preview.token !== "string" || !preview.token || !preview.engine || !preview.runs
        || typeof preview.runs.status !== "string"
        || (preview.runs.items !== undefined && (!Array.isArray(preview.runs.items) || preview.runs.items.some(item => !item)))
        || (preview.warnings !== undefined && (!Array.isArray(preview.warnings) || preview.warnings.some(item => !item)))) {
        throw new Error("Шлюз не подтвердил план перезапуска. Перечитайте план перед действием.");
      }
      currentPreview = preview;
      const runs = preview.runs;
      facts(plan, "Движок", preview.engine.state, preview.engine.serving, preview.engine.pin, preview.engine.direction);
      facts(plan, "Запуски", runs.status, `всего ${count(runs.total)}`, `Ouroboros ${count(runs.ouroboros)}`, `другие программы ${count(runs.other)}`, runs.error);
      facts(plan, "Вызовы моделей", preview.model_calls?.status, `активных ${count(preview.model_calls?.active)}`, `в очереди ${count(preview.model_calls?.queued)}`);
      for (const warning of preview.warnings ?? []) facts(plan, warning.message);
      for (const run of runs.items ?? []) facts(plan, run.run_id, run.owner, run.task_id, run.harness, run.kind, run.state, run.started_at, run.project);
      if (runs.items_omitted) facts(plan, "Других запусков вне списка", runs.items_omitted);
      const execute = button("Перезапустить по этому плану…", () => {
        void (async () => {
          if (!open || this.dialog !== parent || currentPreview !== preview || busy || this.busy) return;
          busy = true;
          let submitted = false;
          execute.set_sensitive(false);
          try {
            if (!await confirm(dialog, "Перезапустить Claudexor?",
              "Шлюз остановит движок и его активные запуски, включая запуски других программ. Вызовы моделей будут прерваны.",
              "Перезапустить") || !open || this.dialog !== parent || currentPreview !== preview) return;
            if (this.busy) { status.set_label("Дождитесь текущей операции и перечитайте план."); return; }
            this.busy = true;
            submitted = true;
            this.reading++;
            this.readCancel?.cancel();
            reread.set_sensitive(false);
            status.set_label("Шлюз выполняет перезапуск…");
            const result = await this.gateway.json<RestartReply>("POST", endpoint, { token: preview.token }, ownerHeaders, true);
            if (!result?.restart || typeof result.restart.stop !== "string" || !result.restart.stop
              || typeof result.restart.serving !== "boolean") throw new Error("Шлюз не подтвердил квитанцию перезапуска.");
            let statusError = "";
            if (this.dialog === parent) {
              this.reading++;
              this.readCancel?.cancel();
              try { this.apply(result.status); } catch (error) { statusError = `Состояние после перезапуска не прочитано: ${errorText(error)}`; }
            }
            const message = [result.restart.stop === "unconfirmed" ? "Остановка прежнего процесса не подтверждена" : result.restart.stop,
              result.restart.serving ? "Движок отвечает" : "Движок не отвечает", result.restart.error, statusError].filter(Boolean).join(" · ");
            if (this.dialog === parent) this.notice.set_label(message);
            if (!open) return;
            status.set_label(message);
            currentPreview = undefined;
            clear(plan);
          } catch (error) {
            currentPreview = undefined;
            clear(plan);
            if (open && error instanceof HttpError && error.status === 409 && error.reason === "restart_preview_stale") {
              status.set_label("Список затронутых запусков изменился. Шлюз отклонил перезапуск.");
              const fresh = object(error.body).preview as RestartPreview | undefined;
              if (fresh) {
                try { render(fresh); } catch (invalid) { status.set_label(errorText(invalid)); }
              }
            } else if (open) status.set_label(`Ответ о перезапуске не подтверждён. ${errorText(error)}`);
            if (this.dialog === parent) {
              this.notice.set_label(error instanceof HttpError && error.status === 409 && error.reason === "restart_preview_stale"
                ? "Шлюз отклонил перезапуск: план изменился."
                : `Ответ о перезапуске не подтверждён. ${errorText(error)}`);
              void this.load();
            }
          } finally {
            busy = false;
            if (submitted) this.busy = false;
            if (open) {
              reread.set_sensitive(true);
              if (currentPreview === preview) execute.set_sensitive(true);
            }
          }
        })();
      });
      plan.append(execute);
    };
    const read = async () => {
      if (!open || busy || this.dialog !== parent) return;
      cancel.cancel();
      cancel = new Gio.Cancellable();
      const generation = ++epoch;
      currentPreview = undefined;
      clear(plan);
      status.set_label("Читаю план…");
      try {
        const preview = await this.gateway.json<RestartPreview>("GET", endpoint, undefined, undefined, false, cancel);
        if (!open || generation !== epoch) return;
        render(preview);
        status.set_label("");
      } catch (error) { if (open && generation === epoch) status.set_label(errorText(error)); }
    };
    const reread = button("Перечитать план", () => void read());
    for (const widget of [reread, status, plan]) content.append(widget);
    this.present(dialog, parent);
    void read();
  }

}
