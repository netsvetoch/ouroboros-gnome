import { Adw, Gio, GLib, Gtk } from "./gi.js";
import { accountsPath, facts } from "./accounts-quota.js";
import { type Gateway, HttpError, query } from "./gateway.js";
import { gatewayStatePath, readGatewayState, writeGatewayState } from "./gateway-state.js";
import type { Present } from "./mcp-server.js";
import { object, ownerHeaders } from "./settings-write.js";
import { button, clear, column, confirm, errorText, label, row, sheet } from "./ui.js";

const path = `${accountsPath}/maintenance`;
const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
const outcomes: Record<string, string> = {
  queued: "В очереди", running: "Выполняется", succeeded: "Операция завершена", failed: "Операция завершилась ошибкой",
  cancelled: "Отмена зарегистрирована", interrupted: "Операция прервана",
};

type TargetKind = "latest" | "version" | "previous" | "baseline";
interface Target { kind: TargetKind; version?: string }
interface Operation {
  id: string;
  state: string;
  harness?: string;
  phase?: string;
  mechanism?: string;
  target?: Target;
  targetVersion?: string;
  before?: { version?: string };
  after?: { version?: string; selected?: boolean };
  mutation?: string;
  termination?: string;
  limitations?: string[];
  progress?: string[];
  problem?: { code?: string; message?: string; context?: unknown };
  startedAt?: string;
  finishedAt?: string;
}
interface InventoryRow {
  harness: string;
  observedAt?: string;
  maintainable?: boolean;
  canCheckLatest?: boolean;
  remedy?: string;
  targets?: TargetKind[];
  selection?: { kind?: string; version?: string; binary?: string; overrideEnv?: string };
  installed?: { version?: string };
  available?: { version?: string; observedAt?: string };
  availableProblem?: { code?: string; message?: string };
  previous?: { version?: string };
  releaseTested?: { version?: string; verification?: string };
  operation?: Operation | null;
}
interface Request {
  key: string;
  body: { harness: string; target: Target };
  uncertain?: boolean;
}
interface State {
  operation?: Operation;
  request?: Request;
  busy?: boolean;
  reading?: boolean;
  message?: string;
  epoch?: number;
  readSerial?: number;
  readCancel?: any;
}

const titles: Record<TargetKind, string> = {
  latest: "Установить или обновить", version: "Установить точную версию", previous: "Вернуться к предыдущей версии",
  baseline: "Установить версию релиза",
};
const kinds = Object.keys(titles) as TargetKind[];
const pending = (operation: Operation | undefined) => Boolean(operation && (!terminal.has(operation.state) || operation.termination === "unconfirmed"));

export class AccountMaintenance {
  private readonly inventory = new Map<string, InventoryRow>();
  private readonly states = new Map<string, State>();
  private readonly location: string;
  private dialog?: any;
  private display?: any;
  private status?: any;
  private inspectionError = false;
  private inspectionEpoch = 0;
  private timer = 0;
  private readCancel?: any;

  constructor(private readonly gateway: Gateway, private readonly present: Present, private readonly changed: () => void) {
    this.location = gatewayStatePath(gateway.base, "harness-maintenance");
    try {
      const records = readGatewayState(this.location);
      if (!Array.isArray(records)) return;
      for (const record of records) {
        const request = record as Request;
        if (typeof request?.key !== "string" || !request.key || typeof request.body?.harness !== "string" || !request.body.harness
          || !kinds.includes(request.body.target?.kind)) continue;
        this.state(request.body.harness).request = request;
      }
    } catch { /* no saved in-flight request on a new client */ }
  }

  show(parent: any, harnesses: string[]): void {
    if (this.dialog) return;
    const content = column();
    const dialog = sheet("Обслуживание инструментов Claudexor", content);
    dialog.set_content_width(740);
    dialog.set_content_height(660);
    this.dialog = dialog;
    this.readCancel = new Gio.Cancellable();
    this.status = label("", "dim-label");
    this.display = column(12);
    for (const harness of harnesses) this.state(harness);
    const action = (title: string, callback: () => void) => button(title, () => {
      if (this.dialog === dialog) callback();
    });
    const actions = row();
    actions.append(action("Проверить установленные версии", () => void this.inspect(undefined, true)));
    actions.append(action("Проверить новые версии", () => void this.inspect(undefined, true, true)));
    actions.append(action("Указать инструмент…", () => this.manual()));
    for (const widget of [actions, this.status, this.display]) content.append(widget);
    const parentClosed = parent instanceof Adw.Dialog ? parent.connect("closed", () => dialog.force_close()) : undefined;
    dialog.connect("closed", () => {
      if (this.dialog !== dialog) return;
      this.readCancel?.cancel();
      for (const state of this.states.values()) { state.readCancel?.cancel(); state.epoch = (state.epoch ?? 0) + 1; state.readSerial = (state.readSerial ?? 0) + 1; state.reading = false; }
      if (parentClosed !== undefined) parent.disconnect(parentClosed);
      this.dialog = undefined;
      this.status = this.display = undefined;
      this.inspectionEpoch++;
      if (this.timer) GLib.Source.remove(this.timer);
      this.timer = 0;
    });
    this.present(dialog, parent);
    this.render();
    void this.inspect();
    this.timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
      for (const [harness, state] of this.states) if (pending(state.operation)) void this.read(harness);
      return GLib.SOURCE_CONTINUE;
    });
  }

  private state(harness: string): State {
    const found = this.states.get(harness);
    if (found) return found;
    const created: State = { epoch: 0 };
    this.states.set(harness, created);
    return created;
  }

  private save(): void {
    writeGatewayState(this.location, [...this.states.values()].flatMap((state) => state.request ? [state.request] : []));
  }

  private async inspect(harness?: string, fresh = false, latest = false): Promise<void> {
    if (!this.dialog) return;
    const epoch = ++this.inspectionEpoch;
    this.status.set_label("Шлюз проверяет версии инструментов…");
    try {
      const result = await this.gateway.json<{ harnesses: InventoryRow[]; observedAt: string }>("GET",
        `${path}/harnesses${query({ harness, fresh: fresh || undefined, checkLatest: latest || undefined })}`, undefined, undefined, true, this.readCancel);
      if (epoch !== this.inspectionEpoch || !this.dialog) return;
      if (!result || !Array.isArray(result.harnesses) || result.harnesses.some(row => !row || typeof row.harness !== "string" || !row.harness
        || (row.targets !== undefined && !Array.isArray(row.targets)))) throw new Error("Шлюз не подтвердил список установленных инструментов.");
      for (const row of result.harnesses) if (row.operation) this.validate(row.harness, row.operation);
      this.inspectionError = false;
      if (!harness) this.inventory.clear();
      for (const row of result.harnesses) {
        if (!row.harness) continue;
        this.inventory.set(row.harness, row);
        const state = this.state(row.harness);
        if (row.operation?.id && !state.request && !state.busy && !state.reading) this.accept(row.harness, row.operation);
      }
      this.status.set_label(result.observedAt ? `Наблюдение шлюза · ${result.observedAt}` : "");
    } catch (error) {
      if (epoch !== this.inspectionEpoch || !this.dialog) return;
      this.inspectionError = true;
      this.status.set_label(`Инвентаризация недоступна. ${errorText(error)}`);
    }
    this.render();
  }

  private validate(harness: string, operation: Operation, id?: string): void {
    if (!operation || typeof operation.id !== "string" || !operation.id || !["queued", "running", ...terminal].includes(operation.state)
      || (operation.harness && operation.harness !== harness) || (id && operation.id !== id)
      || [operation.progress, operation.limitations].some(items => items != null && (!Array.isArray(items) || items.some(item => typeof item !== "string")))) {
      throw new Error("Шлюз не вернул подходящую квитанцию операции.");
    }
  }

  private accept(harness: string, operation: Operation, id?: string): boolean {
    this.validate(harness, operation, id);
    const state = this.state(harness);
    const prior = state.operation;
    if (prior?.id === operation.id && terminal.has(prior.state) && !terminal.has(operation.state)) return false;
    state.operation = operation;
    state.message = "";
    return !pending(operation) && (prior?.id !== operation.id || pending(prior));
  }

  private render(): void {
    if (!this.display || !this.dialog) return;
    clear(this.display);
    const dialog = this.dialog;
    for (const harness of new Set([...this.inventory.keys(), ...this.states.keys()])) {
      const entry = this.inventory.get(harness);
      const state = this.state(harness);
      const operation = state.operation;
      const group = column(4);
      group.append(label(harness, "heading"));
      const after = Boolean(operation?.finishedAt && entry?.observedAt && Date.parse(entry.observedAt) > Date.parse(operation.finishedAt));
      const unknown = Boolean(state.request?.uncertain || (!after && operation && (operation.mutation === "unknown"
        || operation.phase === "installing" || (terminal.has(operation.state) && operation.mutation === "applied"))));
      const selection = entry?.selection;
      const selected = selection?.kind === "missing" && !unknown ? "Инструмент отсутствует" : `Выбранная версия · ${unknown ? "неизвестно до проверки" : selection?.version ?? "неизвестно"}`;
      facts(group, selected, selection?.kind, selection?.binary, selection?.overrideEnv, entry?.observedAt,
        this.inspectionError && "последнее известное");
      facts(group, `Управляемая копия · ${unknown ? "неизвестно" : entry?.installed?.version ?? "неизвестно"}`,
        `Доступная версия · ${entry?.available?.version ?? "не проверена"}`, entry?.available?.observedAt);
      facts(group, entry?.releaseTested?.version && `Версия релиза · ${entry.releaseTested.version}`, entry?.releaseTested?.verification,
        entry?.previous?.version && `Предыдущая версия · ${entry.previous.version}`, entry?.remedy);
      facts(group, entry?.availableProblem?.code, entry?.availableProblem?.message, state.message);
      if (operation) {
        facts(group, operation.id, outcomes[operation.state] ?? operation.state, operation.phase, operation.mechanism,
          operation.targetVersion ?? operation.target?.version, operation.startedAt, operation.finishedAt);
        facts(group, operation.before?.version && `До · ${operation.before.version}`, operation.after?.version && `После · ${operation.after.version}`,
          operation.after?.selected === false && "Установленная копия сейчас не выбрана", operation.mutation,
          operation.termination === "unconfirmed" && "Остановка процесса установки не подтверждена");
        facts(group, operation.problem?.code, operation.problem?.message, operation.limitations?.join(", "));
        if (operation.progress?.length) {
          const progress = label(operation.progress.join("\n"));
          progress.set_selectable(true);
          group.append(new Gtk.Expander({ label: "Ход операции", child: progress }));
        }
      }
      const actions = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, column_spacing: 6, row_spacing: 4 });
      const add = (title: string, work: () => void, enabled = true) => {
        const control = button(title, () => { if (this.dialog === dialog) work(); });
        control.set_sensitive(enabled && !state.busy);
        actions.append(control);
      };
      add("Проверить версию", () => void this.inspect(harness, true, entry?.canCheckLatest === true));
      if (state.request) add("Повторить тот же запрос…", () => void this.recover(harness, state.request!));
      if (operation) add("Проверить операцию", () => void this.read(harness), !state.reading);
      if (operation && pending(operation)) add("Отменить операцию…", () => void this.cancel(harness, operation.id));
      if (!state.request && !pending(operation) && entry?.maintainable) {
        for (const kind of entry.targets ?? []) {
          if (!kinds.includes(kind)) continue;
          if (kind === "version") add(`${titles[kind]}…`, () => this.manual(harness, kind));
          else add(`${titles[kind]}${kind === "previous" && entry.previous?.version ? ` · ${entry.previous.version}`
            : kind === "baseline" && entry.releaseTested?.version ? ` · ${entry.releaseTested.version}` : ""}…`,
          () => void this.start(harness, { kind }));
        }
      }
      group.append(actions);
      this.display.append(group);
    }
  }

  private manual(initial = "", exact?: TargetKind): void {
    const parent = this.dialog;
    if (!parent) return;
    const content = column();
    const dialog = sheet("Цель обслуживания", content);
    let open = true;
    const parentClosed = parent.connect("closed", () => dialog.force_close());
    dialog.connect("closed", () => { if (!open) return; open = false; parent.disconnect(parentClosed); });
    const harness = new Gtk.Entry({ text: initial, editable: !initial, placeholder_text: "Идентификатор инструмента" });
    const kind = Gtk.DropDown.new_from_strings(kinds.map((item) => titles[item]));
    if (exact) kind.set_selected(kinds.indexOf(exact));
    kind.set_sensitive(!exact);
    const version = new Gtk.Entry({ placeholder_text: "Точная версия пакета" });
    const sync = () => version.set_visible(kinds[kind.get_selected()] === "version");
    kind.connect("notify::selected", sync);
    sync();
    const error = label("");
    const submit = button("Продолжить…", () => {
      if (!open || this.dialog !== parent) return;
      const id = harness.get_text().trim();
      const choice = kinds[kind.get_selected()];
      const text = version.get_text().trim();
      if (!id || (choice === "version" && !text)) {
        error.set_label("Укажите инструмент и, для точной установки, версию.");
        return;
      }
      dialog.close();
      void this.start(id, { kind: choice, ...(choice === "version" ? { version: text } : {}) });
    });
    for (const widget of [harness, kind, version, error, submit]) content.append(widget);
    this.present(dialog, parent);
  }

  private async start(harness: string, target: Target): Promise<void> {
    const dialog = this.dialog;
    const state = this.state(harness);
    if (!dialog || state.busy || state.request || pending(state.operation)) return;
    const entry = this.inventory.get(harness);
    if (entry && !this.inspectionError && (!entry.maintainable || !entry.targets?.includes(target.kind))) {
      state.message = "Шлюз не предложил эту операцию для установленного инструмента.";
      this.render();
      return;
    }
    if (!await confirm(dialog, `${titles[target.kind]} · ${harness}?`,
      [target.version, target.kind === "previous" && entry?.previous?.version, target.kind === "baseline" && entry?.releaseTested?.version,
        "Шлюз может заменить файлы инструмента. Новые сессии могут временно не запускаться."].filter(Boolean).join("\n"), "Запустить операцию")) return;
    if (this.dialog !== dialog || state.busy || state.request || pending(state.operation)) return;
    state.operation = undefined;
    state.request = { key: GLib.uuid_string_random(), body: { harness, target } };
    await this.submit(harness);
  }

  private async recover(harness: string, request: Request): Promise<void> {
    const dialog = this.dialog;
    if (!dialog || this.state(harness).busy || this.state(harness).request !== request) return;
    if (!await confirm(dialog, "Восстановить запрос обслуживания?",
      "Шлюз получит тот же ключ и те же параметры операции.", "Повторить запрос")) return;
    if (this.dialog === dialog && this.state(harness).request === request) await this.submit(harness);
  }

  private async submit(harness: string): Promise<void> {
    const state = this.state(harness);
    const request = state.request;
    if (!this.dialog || !request || state.busy) return;
    const priorUnknown = request.uncertain === true;
    request.uncertain = true;
    try { this.save(); } catch (error) {
      request.uncertain = priorUnknown;
      state.message = errorText(error);
      this.render();
      return;
    }
    state.busy = true;
    state.readCancel?.cancel();
    state.readSerial = (state.readSerial ?? 0) + 1;
    state.reading = false;
    state.epoch = (state.epoch ?? 0) + 1;
    state.message = "Запрос отправлен шлюзу…";
    this.render();
    let joined = false;
    let settled = false;
    try {
      const result = await this.gateway.json<Operation>("POST", `${path}/operations`, request.body,
        { ...ownerHeaders, "Idempotency-Key": request.key }, true);
      if (result?.target && (result.target.kind !== request.body.target.kind || result.target.version !== request.body.target.version)) {
        throw new Error("Квитанция указывает другую цель обслуживания. Исход запроса неизвестен.");
      }
      settled = this.accept(harness, result);
      state.request = undefined;
    } catch (error) {
      const body = error instanceof HttpError ? object(error.body) : {};
      const problem = object(body.error);
      const context = object(problem.context);
      const preparation = context.scope === "this_attempt" && context.acceptance === "not_submitted";
      if (problem.code === "maintenance_already_active" && typeof context.operationId === "string" && context.operationId) {
        if (!priorUnknown) state.request = undefined;
        state.operation = { id: context.operationId, harness, state: "running" };
        state.message = "Шлюз указал уже выполняющуюся операцию.";
        joined = true;
      } else {
        const refusal = error instanceof HttpError && [400, 409].includes(error.status) && typeof problem.code === "string";
        if (!priorUnknown && (preparation || refusal)) state.request = undefined;
        state.message = [state.request ? "Итог запроса неизвестен. Доступен повтор с прежним ключом." : "Шлюз отклонил запрос.",
          problem.code === "maintenance_restart_required" && "Перезапустите Claudexor из окна аккаунтов.",
          problem.code, errorText(error)].filter(Boolean).join("\n");
      }
    } finally {
      state.busy = false;
      try { this.save(); } catch (error) { state.message = [state.message, errorText(error)].filter(Boolean).join("\n"); }
      this.render();
    }
    if (joined) await this.read(harness);
    if (settled) this.settled(harness);
  }

  private async read(harness: string): Promise<void> {
    const state = this.state(harness);
    const dialog = this.dialog;
    const id = state.operation?.id;
    if (!dialog || !id || state.reading || state.busy) return;
    const epoch = state.epoch;
    state.reading = true;
    const serial = state.readSerial = (state.readSerial ?? 0) + 1;
    const cancel = state.readCancel = new Gio.Cancellable();
    let settled = false;
    try {
      const result = await this.gateway.json<Operation>("GET", `${path}/operations/${encodeURIComponent(id)}`, undefined, undefined, false, cancel);
      if (this.dialog === dialog && state.operation?.id === id && state.epoch === epoch) settled = this.accept(harness, result, id);
    } catch (error) {
      if (this.dialog === dialog && state.operation?.id === id && state.epoch === epoch) state.message = `Состояние операции не подтверждено. ${errorText(error)}`;
    } finally { if (state.readSerial === serial) state.reading = false; }
    this.render();
    if (settled) this.settled(harness);
  }

  private async cancel(harness: string, id: string): Promise<void> {
    const dialog = this.dialog;
    const state = this.state(harness);
    if (!dialog || state.busy || state.operation?.id !== id || !pending(state.operation)) return;
    if (!await confirm(dialog, "Отменить обслуживание?",
      "Шлюз запросит отмену. После ответа клиент продолжит проверять, завершился ли процесс.", "Отменить операцию")) return;
    if (this.dialog !== dialog || state.busy || state.operation?.id !== id || !pending(state.operation)) return;
    state.busy = true;
    state.readCancel?.cancel();
    state.readSerial = (state.readSerial ?? 0) + 1;
    state.reading = false;
    state.epoch = (state.epoch ?? 0) + 1;
    let settled = false;
    try {
      const result = await this.gateway.json<Operation>("POST", `${path}/operations/${encodeURIComponent(id)}/cancel`, {}, ownerHeaders, true);
      settled = this.accept(harness, result, id);
    } catch (error) {
      state.message = `Отмена не подтверждена. ${errorText(error)}`;
    } finally { state.busy = false; }
    this.render();
    if (settled) this.settled(harness);
    else if (pending(state.operation)) void this.read(harness);
  }

  private settled(harness: string): void {
    this.changed();
    void this.inspect(harness, true);
  }
}
