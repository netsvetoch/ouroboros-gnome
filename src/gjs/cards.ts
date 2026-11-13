import { Gio, GLib } from "./gi.js";
import { type Gateway, type GatewayFrame, HttpError } from "./gateway.js";
import { type CardControl, mountComponents, type Submit } from "./card-components.js";
import { CardApp, type CardAppRef } from "./card-app.js";
import { button, clear, column, errorText, label, row, sheet } from "./ui.js";
import { readWidgets, type WidgetTab } from "./widget-contract.js";
import { WidgetView } from "./widget-view.js";

export interface CardIdentity {
  card_id: string;
  kind: "components" | "widget" | "app";
  title: string;
  revision: number;
}

interface Submission {
  action_id: string;
  label?: string;
  delivery: "owed" | "delivered" | "forwarded";
  reason_code?: string;
  request_id: string;
}

interface Card extends CardIdentity {
  fallback_text?: string;
  pinned: boolean;
  components?: unknown[];
  data?: Record<string, unknown>;
  widget?: { skill: string; tab_id: string; input?: Record<string, unknown> };
  app?: CardAppRef;
  submissions_summary?: Submission[];
  submissions_dropped?: number;
}

type Values = Record<string, string | number | boolean | null>;

interface Attempt {
  id: string;
  fingerprint: string;
}

interface Decision {
  ok?: boolean;
  error?: string;
  delivery?: Submission["delivery"];
  reason_code?: string;
  winner?: Submission;
  decision_id?: string;
  request_id?: string;
  card_id?: string;
  revision?: number;
}

interface AppDraft {
  append: (line: string) => boolean;
  focus: () => void;
}

const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const delivery = (value: unknown): boolean => typeof value === "string" && ["owed", "delivered", "forwarded"].includes(value);
const submission = (value: unknown): boolean => record(value) && typeof value.action_id === "string"
  && typeof value.request_id === "string" && Boolean(value.request_id) && delivery(value.delivery)
  && ["label", "reason_code"].every(key => value[key] === undefined || typeof value[key] === "string");

function readCard(value: unknown, id: string): Card {
  if (!record(value) || value.card_id !== id || !["components", "widget", "app"].includes(value.kind)
    || typeof value.title !== "string" || !count(value.revision) || value.revision < 1 || typeof value.pinned !== "boolean"
    || (value.fallback_text !== undefined && typeof value.fallback_text !== "string")
    || (value.data !== undefined && !record(value.data))
    || (value.kind === "components" && !Array.isArray(value.components))
    || (value.kind === "widget" && (!record(value.widget) || typeof value.widget.skill !== "string"
      || typeof value.widget.tab_id !== "string" || (value.widget.input !== undefined && !record(value.widget.input))))
    || (value.kind === "app" && (!record(value.app) || typeof value.app.sha256 !== "string"
      || !count(value.app.size) || typeof value.app.url !== "string"))
    || (value.submissions_dropped !== undefined && !count(value.submissions_dropped))
    || !Array.isArray(value.submissions_summary) || !value.submissions_summary.every(submission)
    || new Set(value.submissions_summary.map(item => item.request_id)).size !== value.submissions_summary.length) {
    throw new Error("Шлюз вернул неполную или другую карточку. Показана последняя прочитанная версия.");
  }
  return value as Card;
}

function snapshotCard(tab: WidgetTab): Card | undefined {
  const revision = Number(tab.revision);
  if (tab.pinned_card !== true || typeof tab.tab_id !== "string" || !tab.tab_id || typeof tab.title !== "string"
    || !Number.isSafeInteger(revision) || revision < 1 || !record(tab.render) || !Array.isArray(tab.render.components)
    || (tab.render.data !== undefined && !record(tab.render.data))) return;
  return { card_id: tab.tab_id, kind: "components", title: tab.title, revision, pinned: true,
    components: tab.render.components, data: tab.render.data ?? {} };
}

function cardPath(id: string): string {
  return "/api/cards/" + encodeURIComponent(id);
}

function deliveryText(delivery: Submission["delivery"] | undefined, reason?: string): string {
  if (delivery === "owed") return "Действие записано. Доставку можно повторить.";
  if (reason === "awaiting_recipient_read") return "Действие записано в очередь чтения задачи.";
  if (delivery === "forwarded") return "Действие доставлено в чат.";
  if (delivery === "delivered") return "Действие доставлено.";
  return "Шлюз принял действие.";
}

export class Cards {
  private readonly dialogs = new Map<string, CardDialog>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly appStates = new Map<string, string>();
  private pinnedList?: any;
  private reloadPins?: () => Promise<void>;
  private disposed = false;

  constructor(private readonly parent: any, private readonly gateway: Gateway) {}

  close(): void {
    this.disposed = true;
    this.pinnedList?.force_close();
    for (const dialog of this.dialogs.values()) dialog.close();
    this.appStates.clear();
  }

  show(identity: CardIdentity, fallback: string, draft?: AppDraft): void {
    this.open({ ...identity, fallback_text: fallback, pinned: false }, false, draft);
  }

  update(id: string): void {
    void this.dialogs.get(id)?.reload();
    void this.dialogs.get(`pinned:${id}`)?.reload();
  }

  updatePins(): void {
    void this.reloadPins?.();
  }

  widgetFrame(frame: GatewayFrame): void {
    for (const dialog of this.dialogs.values()) {
      if (frame.type === "extension_lifecycle") void dialog.refreshWidget();
      dialog.widgetFrame(frame);
    }
  }

  showSnapshot(tab: WidgetTab): void {
    const card = snapshotCard(tab);
    if (card) this.open(card, true);
  }

  showPinned(): void {
    if (this.disposed) return;
    if (this.pinnedList) {
      this.pinnedList.present(this.parent);
      return;
    }
    const content = column();
    const list = column();
    const status = label("");
    const dialog = sheet("Закреплённые карточки", content);
    this.pinnedList = dialog;
    dialog.connect("closed", () => {
      if (this.pinnedList === dialog) {
        this.pinnedList = undefined;
        this.reloadPins = undefined;
      }
    });
    let read = 0;
    let cancel: any;
    dialog.connect("closed", () => { read++; cancel?.cancel(); reload.set_sensitive(false); });
    const refresh = async () => {
      if (this.disposed || this.pinnedList !== dialog) return;
      cancel?.cancel();
      const token = new Gio.Cancellable();
      cancel = token;
      const version = ++read;
      reload.set_sensitive(false);
      status.set_label("Загружаю карточки…");
      try {
        const tabs = (await readWidgets(this.gateway, token, true)).filter((tab) => tab.pinned_card === true);
        if (tabs.some(tab => !snapshotCard(tab)) || new Set(tabs.map(tab => tab.tab_id)).size !== tabs.length) {
          throw new Error("Шлюз вернул неполный список закреплённых карточек. Показан последний прочитанный список.");
        }
        if (this.pinnedList !== dialog || version !== read) return;
        clear(list);
        for (const tab of tabs) list.append(button(tab.title || tab.tab_id, () => {
          if (!this.disposed && this.pinnedList === dialog && version === read) this.showSnapshot(tab);
        }));
        status.set_label(list.get_first_child() ? "" : "Закреплённых карточек пока нет.");
      } catch (error) {
        if (this.pinnedList === dialog && version === read) status.set_label(errorText(error));
      } finally {
        if (this.pinnedList === dialog && version === read) reload.set_sensitive(true);
      }
    };
    const reload = button("Обновить", () => void refresh());
    content.append(reload);
    content.append(status);
    content.append(list);
    this.reloadPins = refresh;
    dialog.present(this.parent);
    void refresh();
  }

  private open(identity: Card, snapshot = false, draft?: AppDraft): void {
    if (this.disposed) return;
    const key = snapshot ? `pinned:${identity.card_id}` : identity.card_id;
    const existing = this.dialogs.get(key);
    if (existing) {
      existing.present();
      return;
    }
    const dialog = new CardDialog(this.parent, this.gateway, identity, snapshot, this.attempts, this.appStates, draft,
      () => { this.dialogs.delete(key); }, () => this.updatePins());
    this.dialogs.set(key, dialog);
    dialog.present();
    void dialog.reload();
  }
}

class CardDialog {
  private readonly content = column();
  private readonly heading = label("", "title-3");
  private readonly fallback = label("");
  private readonly status = label("", "dim-label");
  private readonly body = column();
  private readonly submissions = column();
  private readonly pin = button("", () => void this.togglePin());
  private readonly dialog: any;
  private readonly busy = new Set<string>();
  private controls: CardControl[] = [];
  private retryControls: { widget: any; id: string }[] = [];
  private card: Card;
  private bodyKey = "";
  private componentView?: ReturnType<typeof mountComponents>;
  private disposed = false;
  private readonly cancel = new Gio.Cancellable();
  private readCancel?: any;
  private confirmed = false;
  private readFailed = false;
  private bodyGeneration = 0;
  private submissionsGeneration = 0;
  private read = 0;
  private pinning = false;
  private widgetView?: WidgetView;
  private widgetVersion = "";
  private widgetRead = 0;
  private appView?: CardApp;
  private focusDraft = false;

  constructor(
    private readonly parent: any,
    private readonly gateway: Gateway,
    identity: Card,
    private readonly snapshot: boolean,
    private readonly attempts: Map<string, Attempt>,
    private readonly appStates: Map<string, string>,
    private readonly appDraft: AppDraft | undefined,
    close: () => void,
    private readonly pinsChanged: () => void,
  ) {
    this.card = identity;
    const actions = row();
    actions.append(button("Обновить", () => void this.reload()));
    actions.append(this.pin);
    for (const widget of [this.heading, this.fallback, actions, this.status, this.body, this.submissions]) this.content.append(widget);
    this.dialog = sheet("Карточка Ouroboros", this.content);
    this.dialog.connect("closed", () => {
      this.disposed = true;
      this.confirmed = false;
      this.cancel.cancel();
      this.readCancel?.cancel();
      this.sync();
      this.componentView?.close();
      this.widgetView?.close();
      this.appView?.close();
      close();
      if (this.focusDraft) this.appDraft?.focus();
    });
    this.render();
  }

  close(): void { if (!this.disposed) this.dialog.force_close(); }
  present(): void { this.dialog.present(this.parent); }
  widgetFrame(frame: GatewayFrame): void {
    this.widgetView?.frame(frame);
    if (frame.type === "extension_lifecycle") this.appView?.reportHolds();
  }

  async refreshWidget(): Promise<void> {
    const ref = this.card.widget;
    if (this.disposed || this.card.kind !== "widget" || !ref) return;
    const read = ++this.widgetRead;
    try {
      const tabs = await readWidgets(this.gateway, this.cancel);
      if (this.disposed || read !== this.widgetRead || ref !== this.card.widget) return;
      const tab = tabs.find((item) => item.skill === ref.skill && item.tab_id === ref.tab_id && !item.pinned_card);
      const version = tab ? JSON.stringify([ref, tab.revision, tab.render, tab.ws_prefix,
        tab.render.entry_type === "module" ? tab.generation : undefined]) : "missing";
      if (version === this.widgetVersion) {
        if (tab) this.widgetView?.updateTab(tab);
        return;
      }
      this.widgetVersion = version;
      this.widgetView?.close();
      this.widgetView = undefined;
      clear(this.body);
      if (tab) {
        this.widgetView = new WidgetView(this.gateway, tab, ref.input, { where: "message", stopKey: "card:" + this.card.card_id });
        this.body.append(this.widgetView.widget);
        this.widgetView.setActive(true);
      } else this.body.append(label("Этот виджет навыка сейчас недоступен.", "dim-label"));
    } catch (error) {
      if (!this.disposed && read === this.widgetRead) this.status.set_label(errorText(error));
    }
  }

  async reload(): Promise<void> {
    if (this.disposed) return;
    const read = ++this.read;
    this.readCancel?.cancel();
    const cancel = new Gio.Cancellable();
    this.readCancel = cancel;
    try {
      const result = readCard(await this.gateway.json<unknown>("GET", cardPath(this.card.card_id), undefined, undefined, false, cancel), this.card.card_id);
      if (this.disposed || read !== this.read) return;
      if (result.revision < this.card.revision) throw new Error("Шлюз ещё не подтвердил текущую версию карточки.");
      if (this.readFailed) this.status.set_label("");
      this.readFailed = false;
      const pinnedChanged = this.card.pinned !== result.pinned;
      this.card = this.snapshot ? {
        ...this.card, pinned: result.pinned, submissions_summary: result.submissions_summary,
        submissions_dropped: result.submissions_dropped,
      } : result;
      this.confirmed = true;
      this.render();
      if (pinnedChanged) this.pinsChanged();
      void this.refreshWidget();
    } catch (error) {
      if (!this.disposed && read === this.read) {
        this.confirmed = false;
        this.readFailed = true;
        this.status.set_label(errorText(error));
        this.sync();
      }
    } finally { if (this.readCancel === cancel) this.readCancel = undefined; }
  }

  private latest(actionId: string): Submission | undefined {
    return this.card.submissions_summary?.findLast((entry) => entry.action_id === actionId);
  }

  private render(): void {
    if (this.disposed) return;
    this.heading.set_label(this.card.title || "Карточка");
    this.fallback.set_label(this.card.fallback_text || "");
    this.fallback.set_visible(Boolean(this.card.fallback_text));
    const key = JSON.stringify([this.card.revision, this.card.kind, this.card.components, this.card.data, this.card.widget, this.card.app]);
    if (this.bodyKey !== key) {
      this.bodyGeneration++;
      this.componentView?.close();
      this.componentView = undefined;
      this.bodyKey = key;
      this.widgetRead++;
      this.widgetView?.close();
      this.widgetView = undefined;
      this.widgetVersion = "";
      this.appView?.close();
      this.appView = undefined;
      clear(this.body);
      if (Array.isArray(this.card.components) && this.card.kind === "components") {
        const revision = this.card.revision;
        const generation = this.bodyGeneration;
        const mounted = mountComponents(this.card.components, this.card.data ?? {},
          (control, values) => { if (generation === this.bodyGeneration) void this.press(control, revision, values); }, { fields: 50, length: 4000, base: this.gateway.base });
        this.componentView = mounted;
        this.controls = mounted.controls;
        this.body.append(mounted.widget);
      } else {
        this.controls = [];
        if (this.card.kind === "app" && this.card.app) {
          this.appView = new CardApp(this.gateway, this.card.card_id, this.card.title, this.card.app, this.appStates, (line) => {
            if (!this.appDraft?.append(line)) return false;
            this.focusDraft = true;
            this.dialog.close();
            return true;
          });
          this.body.append(this.appView.widget);
          this.appView.open();
        }
        if (this.card.widget) this.body.append(label(`Виджет навыка · ${this.card.widget.skill} / ${this.card.widget.tab_id}`, "dim-label"));
      }
    }
    const submissionGeneration = ++this.submissionsGeneration;
    const revision = this.card.revision;
    this.retryControls = [];
    clear(this.submissions);
    if (typeof this.card.submissions_dropped === "number" && this.card.submissions_dropped > 0) {
      this.submissions.append(label(`Более ранних действий удалено шлюзом · ${this.card.submissions_dropped}`, "dim-label"));
    }
    for (const entry of this.card.submissions_summary ?? []) {
      const details = row();
      details.append(label(`${entry.label || entry.action_id} · ${deliveryText(entry.delivery, entry.reason_code)}`));
      if (entry.delivery === "owed" && entry.request_id) {
        const retry = button("Повторить доставку", () => { if (submissionGeneration === this.submissionsGeneration) void this.pressRecorded(entry, revision); });
        retry.set_sensitive(this.confirmed && !this.disposed && !this.busy.has(entry.action_id));
        this.retryControls.push({ widget: retry, id: entry.action_id });
        details.append(retry);
      }
      this.submissions.append(details);
    }
    this.sync();
  }

  private sync(): void {
    this.pin.set_visible(this.card.kind === "components" && Boolean(this.card.components));
    this.pin.set_label(this.card.pinned ? "Открепить" : "Закрепить");
    this.pin.set_sensitive(this.confirmed && !this.disposed && !this.pinning);
    for (const control of this.retryControls) control.widget.set_sensitive(this.confirmed && !this.disposed && !this.busy.has(control.id));
    for (const control of this.controls) {
      const latest = this.latest(control.id);
      control.widget.set_sensitive(this.confirmed && !this.disposed && !control.disabled && !this.busy.has(control.id) && !(control.once && latest));
    }
  }

  private async togglePin(): Promise<void> {
    if (this.disposed || !this.confirmed || this.pinning) return;
    const pinned = !this.card.pinned;
    this.confirmed = false;
    this.read++;
    this.readCancel?.cancel();
    this.pinning = true;
    this.sync();
    try {
      const result = await this.gateway.json<{ ok: boolean; card_id: string; pinned: boolean }>(
        pinned ? "POST" : "DELETE", cardPath(this.card.card_id) + "/pin", undefined, undefined, false, this.cancel,
      );
      if (result?.ok !== true || result.card_id !== this.card.card_id || result.pinned !== pinned) throw new Error("Шлюз не подтвердил закрепление карточки.");
      if (!this.disposed) {
        this.card.pinned = result.pinned;
        this.pinsChanged();
      }
    } catch (error) {
      if (!this.disposed) this.status.set_label(`Результат закрепления не подтверждён. ${errorText(error)}`);
    } finally {
      this.pinning = false;
      if (!this.disposed) { this.sync(); void this.reload(); }
    }
  }

  private async press(control: Parameters<Submit>[0], revision: number, values?: Values): Promise<void> {
    if (this.disposed || !this.confirmed || revision !== this.card.revision || this.busy.has(control.id) || control.disabled) return;
    if (control.once && this.latest(control.id)) return;
    const key = `${this.card.card_id}:${control.id}:${revision}`;
    const fingerprint = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, JSON.stringify(values ?? null), -1);
    const previous = this.attempts.get(key);
    const id = previous?.fingerprint === fingerprint ? previous!.id : String(GLib.uuid_string_random());
    this.attempts.set(key, { id, fingerprint });
    await this.send(control.id, revision, id, values, key);
  }

  private async pressRecorded(recorded: Submission, revision: number): Promise<void> {
    await this.send(recorded.action_id, revision, recorded.request_id);
  }

  private async send(actionId: string, revision: number, requestId: string, values?: Values, key?: string): Promise<void> {
    if (this.disposed || !this.confirmed || revision !== this.card.revision || this.busy.has(actionId)) return;
    this.read++;
    this.readCancel?.cancel();
    this.busy.add(actionId);
    this.render();
    this.status.set_label("Отправляю действие…");
    try {
      const response = await this.gateway.json<Decision>("POST", "/api/decisions", {
        decision_id: `card:${this.card.card_id}:${actionId}`, request_id: requestId, revision, values,
      }, undefined, false, this.cancel);
      if (this.disposed) return;
      if (response?.ok === false) throw new Error(response.error ?? "Шлюз отклонил действие.");
      if (response?.ok !== true || response.card_id !== this.card.card_id || response.decision_id !== `card:${this.card.card_id}:${actionId}`
        || response.request_id !== requestId || !count(response.revision) || response.revision! < 1 || !delivery(response.delivery)
        || (response.reason_code !== undefined && typeof response.reason_code !== "string")) {
        this.confirmed = false;
        throw new Error("Шлюз не подтвердил результат действия. Перечитайте карточку перед повтором.");
      }
      if (key && response.delivery !== "owed") this.attempts.delete(key);
      this.record({ action_id: actionId, request_id: requestId, delivery: response.delivery ?? "delivered", reason_code: response.reason_code });
      this.status.set_label(deliveryText(response.delivery, response.reason_code));
    } catch (error) {
      if (this.disposed) return;
      this.status.set_label(errorText(error));
      if (!(error instanceof HttpError) || error.status >= 500 || error.status === 408) this.confirmed = false;
      if (error instanceof HttpError) {
        if (key && error.status < 500 && error.status !== 408 && error.status !== 429) this.attempts.delete(key);
        const response = error.body as Decision | null;
        if (error.reason === "card_action_once" && typeof response?.winner?.request_id === "string" && response.winner.request_id && delivery(response.winner.delivery)) {
          this.record({ ...response.winner, action_id: actionId });
          this.status.set_label(deliveryText(response.winner.delivery));
        } else if (error.reason === "card_stale" && this.snapshot) {
          this.status.set_label("Закреплённая копия устарела. Откройте карточку в чате, чтобы закрепить её новую версию.");
        }
      }
    } finally {
      this.busy.delete(actionId);
      if (!this.disposed) {
        this.render();
        void this.reload();
      }
    }
  }

  private record(submission: Submission): void {
    const previous = this.card.submissions_summary ?? [];
    this.card.submissions_summary = [...previous.filter((item) => item.request_id !== submission.request_id), submission];
  }
}
