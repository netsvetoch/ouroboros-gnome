import { questionLifecycleLines, type QuestionLifecycleFacts } from "./question-lifecycle.js";
import { Adw, Gio, GLib, Gtk, Pango } from "./gi.js";
import { type Gateway, HttpError } from "./gateway.js";
import { button, clear, column, errorText, label, row } from "./ui.js";

import { chrome, chromeText, watchNativeI18n } from "./native-i18n.js";

interface SecretField {
  id: string;
  setting_key: string;
}

export interface SecretRequest {
  plugin_name: string;
  fields: SecretField[];
}

interface SecretKey extends SecretField {
  configured: boolean;
}

interface SecretConsumer {
  name: string;
  enabled: boolean;
  reads: string[];
  granted?: string[];
  unsupported?: boolean;
  grant_unknown?: boolean;
}

export interface SecretOutcome {
  event?: "secret_filled" | "secret_replaced" | "secret_cancelled";
  replaced_fields?: string[];
  consumers?: SecretConsumer[];
  consumers_unknown?: boolean;
  late?: boolean;
  interrupted_save?: boolean;
}

interface SecretStatus extends QuestionLifecycleFacts {
  state?: string;
  keys?: SecretKey[];
  keys_unknown?: boolean;
  consumers?: SecretConsumer[];
  consumers_unknown?: boolean;
  secret_outcome?: SecretOutcome;
  saved?: boolean | null;
  save_unconfirmed?: boolean;
}

const path = "/api/decisions/secret";

function settled(state?: string): boolean {
  return state === "answered" || state === "closed" || state === "superseded";
}

function outcomeText(outcome: SecretOutcome): string {
  const lines = [];
  if (outcome.event === "secret_cancelled") lines.push(chromeText("Secret request cancelled.", undefined, "Запрос секрета отменён."));
  if (outcome.event === "secret_filled") lines.push(chromeText("Secret saved.", undefined, "Секрет сохранён."));
  if (outcome.event === "secret_replaced") lines.push(chromeText("Secret replaced.", undefined, "Секрет заменён."));
  if (outcome.replaced_fields?.length) lines.push(chromeText("Replaced fields: {fields}.", { fields: outcome.replaced_fields.join(", ") }, `Заменены поля: ${outcome.replaced_fields.join(", ")}.`));
  if (outcome.late) lines.push(chromeText("The requesting task has already ended.", undefined, "Запрашивавшая задача уже завершилась."));
  if (outcome.interrupted_save) lines.push(chromeText("The previous save outcome is unknown.", undefined, "Результат предыдущей записи неизвестен."));
  return lines.join(" ");
}

export class SecretQuestion {
  readonly widget = column();
  private readonly fields = column();
  private readonly status = label("", "dim-label");
  private readonly consumers = label("", "dim-label");
  private readonly notice = label("");
  private readonly save = chrome(button("Сохранить секрет", () => void this.submit("save")), "label", "Save secret");
  private readonly cancel = chrome(button("Отменить запрос…", () => void this.cancelRequest()), "label", "Cancel request…");
  private readonly reload = chrome(button("Проверить состояние ключей", () => void this.load()), "label", "Check key status");
  private readonly inputs = new Map<string, any>();
  private readonly requestCancel = new Gio.Cancellable();
  private parentSignal = 0;
  private latest?: SecretStatus;
  private busy = false;
  private disposed = false;
  private confirmation?: any;
  private unwatch = () => {};
  private statusMode: "state" | "reading" | "error" = "state";

  constructor(
    private readonly parent: any,
    private readonly gateway: Gateway,
    private readonly decisionId: string,
    private readonly request: SecretRequest,
    private readonly changed: () => void,
  ) {
    if (parent instanceof Adw.Dialog || parent instanceof Gtk.Window) this.parentSignal = parent.connect(
      parent instanceof Gtk.Window ? "close-request" : "closed", () => { this.close(); return false; });
    this.widget.append(chrome(label(`Секрет для навыка ${request.plugin_name}`, "title-4"), "label", "Secret for skill {skill}", { skill: request.plugin_name }));
    this.widget.append(this.status);
    this.widget.append(this.notice);
    this.widget.append(this.consumers);
    this.widget.append(this.fields);
    const actions = row();
    actions.append(this.save);
    actions.append(this.cancel);
    this.widget.append(actions);
    this.widget.append(this.reload);
    this.save.add_css_class("suggested-action");
    this.unwatch = watchNativeI18n(() => this.paint());
    this.sync();
    void this.load();
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.parentSignal) { this.parent.disconnect(this.parentSignal); this.parentSignal = 0; }
    this.requestCancel.cancel();
    this.unwatch();
    this.confirmation?.force_close();
    this.clearInputs();
  }

  observe(status: SecretStatus): void {
    if (this.disposed) return;
    if (settled(status.state)) {
      this.latest = { ...this.latest, ...status };
      this.render();
    }
  }

  private async load(): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true;
    this.statusMode = "reading";
    this.status.set_label("Читаю состояние ключей…");
    chrome(this.status, "label", "Reading key status…");
    this.sync();
    try {
      await this.readStatus();
    } catch (error) {
      if (!this.disposed) this.statusFailed(error);
    } finally {
      this.busy = false;
      if (!this.disposed) this.sync();
    }
  }

  private statusFailed(error: unknown): void {
    // A failed read cannot erase a completion already received over WebSocket.
    if (settled(this.latest?.state)) { this.render(); return; }
    this.latest = undefined;
    this.statusMode = "error";
    this.status.set_label(errorText(error));
    this.clearInputs();
  }

  private async readStatus(): Promise<void> {
    const status = await this.gateway.json<SecretStatus>("POST", path, {
      decision_id: this.decisionId, action: "status",
    }, undefined, false, this.requestCancel);
    if (this.disposed) return;
    // A newer live closure cannot be undone by a status read already in flight.
    if (!settled(this.latest?.state) || settled(status.state)) this.latest = status;
    this.render();
  }

  private keyStates(): SecretKey[] | undefined {
    const state = this.latest;
    if (state?.keys_unknown || !Array.isArray(state?.keys) || !this.request.fields.length
      || !(state.state === "open" || state.state === "expired_terminal")) return undefined;
    const keys = state.keys;
    if (keys.length !== this.request.fields.length) return undefined;
    return this.request.fields.every(({ id, setting_key }) => keys.some((key) =>
      key.id === id && key.setting_key === setting_key && typeof key.configured === "boolean")) ? keys : undefined;
  }

  private clearInputs(): void {
    for (const input of this.inputs.values()) input.set_text("");
    this.inputs.clear();
    clear(this.fields);
  }

  private render(): void {
    this.clearInputs();
    const state = this.latest;
    const outcome = state?.secret_outcome;
    const keys = this.keyStates();
    this.statusMode = "state";
    if (!settled(state?.state) && keys) {
      const group = new Adw.PreferencesGroup();
      for (const field of this.request.fields) {
        const key = keys.find(({ id }) => id === field.id)!;
        const input = new Adw.PasswordEntryRow({
          title: `${field.setting_key} · ${key.configured ? "уже настроен" : "пуст"}`,
        });
        input.connect("changed", () => this.sync());
        group.add(input);
        this.inputs.set(field.id, input);
      }
      this.fields.append(group);
    }
    this.paint();
  }

  // Locale changes repaint labels only; render() deliberately retires password inputs on network reconciliation.
  private paint(): void {
    if (this.disposed) return;
    const state = this.latest, outcome = state?.secret_outcome, keys = this.keyStates();
    if (this.statusMode === "state") {
      const summary = settled(state?.state)
        ? outcome && outcomeText(outcome) || chromeText("Request completed.", undefined, "Запрос завершён.")
        : !keys ? chromeText("Requested key status is unavailable.", undefined, "Состояние запрошенных ключей недоступно.")
        : state?.save_unconfirmed ? chromeText("The previous save outcome is unknown. Current key status is shown below.", undefined, "Результат предыдущей записи неизвестен. Ниже показано текущее состояние ключей.")
        : state?.state === "expired_terminal" ? chromeText("The requesting task has ended. Saving a secret will not resume it.", undefined, "Запрашивавшая задача завершилась. Сохранение секрета не возобновляет её.")
        : chromeText("Values are stored in gateway settings.", undefined, "Значения сохраняются в настройках шлюза.");
      this.status.set_label([summary, ...questionLifecycleLines(state ?? {}, !outcome?.late)].join("\n"));
      this.status.set_selectable(true);this.status.set_wrap_mode(Pango.WrapMode.WORD_CHAR);this.status.set_max_width_chars(64);
    }
    for (const key of keys ?? []) {
      const input = this.inputs.get(key.id);
      if (input) {
        input.set_title(`${key.setting_key} · ${key.configured ? "уже настроен" : "пуст"}`);
        chrome(input, "title", key.configured ? "{key} · configured" : "{key} · empty", { key: key.setting_key });
      }
    }
    const readers = outcome && (Array.isArray(outcome.consumers) || outcome.consumers_unknown !== undefined) ? outcome : state;
    const consumers = readers?.consumers;
    if (readers?.consumers_unknown) {
      this.consumers.set_label(chromeText("Skill access to these keys could not be verified.", undefined, "Доступ навыков к этим ключам не удалось проверить."));
    } else if (consumers?.length) {
      this.consumers.set_label(consumers.map((consumer) => {
        const access = consumer.unsupported ? chromeText("Does not receive keys", undefined, "не получает ключи")
          : consumer.grant_unknown ? chromeText("Permission unknown", undefined, "разрешение неизвестно")
          : consumer.granted?.length ? chromeText("Granted: {keys}", { keys: consumer.granted.join(", ") }, `разрешены ${consumer.granted.join(", ")}`)
          : chromeText("No permissions", undefined, "разрешений нет");
        const enabled = consumer.enabled ? chromeText("Enabled", undefined, "включён") : chromeText("Disabled", undefined, "выключен");
        return chromeText("{skill} · reads {keys} · {enabled} · {access}", { skill: consumer.name, keys: consumer.reads.join(", "), enabled, access },
          `${consumer.name} · читает ${consumer.reads.join(", ")} · ${enabled} · ${access}`);
      }).join("\n"));
    } else {
      this.consumers.set_label(Array.isArray(consumers) ? chromeText("No installed skill reads these keys yet.", undefined, "Ни один установленный навык пока не читает эти ключи.") : "");
    }
    this.sync();
  }

  private sync(): void {
    if (this.disposed) return;
    const keys = this.keyStates();
    const active = !settled(this.latest?.state);
    if (!active) this.confirmation?.force_close();
    const replace = keys?.some((key) => key.configured);
    this.save.set_label(replace ? "Заменить существующие значения" : "Сохранить секрет");
    chrome(this.save, "label", replace ? "Replace existing values" : "Save secret");
    this.save.set_visible(Boolean(keys));
    this.save.set_sensitive(!this.busy && this.inputs.size > 0 && [...this.inputs.values()].every((input) => input.get_text().length > 0));
    this.fields.set_sensitive(!this.busy);
    this.cancel.set_visible(active);
    this.cancel.set_sensitive(!this.busy && this.latest !== undefined);
    this.reload.set_sensitive(!this.busy);
  }

  private cancelRequest(): void {
    if (this.disposed || this.busy || settled(this.latest?.state)) return;
    if (this.confirmation) { this.confirmation.present(this.parent); return; }
    const dialog = new Adw.AlertDialog({ heading: "Отменить запрос секрета?",
      body: "Запрос закроется. Настроенные значения останутся в настройках." });
    chrome(dialog, "heading", "Cancel secret request?");
    chrome(dialog, "body", "The request will close. Configured values will remain in settings.");
    this.confirmation = dialog;
    dialog.add_response("cancel", "Не отменять");
    dialog.add_response("ok", "Отменить запрос");
    let active = true;
    const repaint = () => {
      if (!active) return;
      dialog.set_response_label("cancel", chromeText("Keep request", undefined, "Не отменять"));
      dialog.set_response_label("ok", chromeText("Cancel request", undefined, "Отменить запрос"));
    };
    const stop = watchNativeI18n(repaint); repaint();
    const release = () => { active = false; stop(); };
    dialog.connect("closed", release);
    dialog.set_close_response("cancel");
    dialog.set_default_response("cancel");
    dialog.set_response_appearance("ok", Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.connect("response", (_dialog: any, response: string) => {
      if (this.disposed || this.confirmation !== dialog) return;
      release();
      this.confirmation = undefined;
      if (response === "ok") void this.submit("cancel");
    });
    dialog.present(this.parent);
  }

  private async submit(action: "save" | "cancel"): Promise<void> {
    if (this.disposed || this.busy || settled(this.latest?.state)) return;
    const body: Record<string, unknown> = {
      decision_id: this.decisionId, request_id: GLib.uuid_string_random(), action,
    };
    if (action === "save") {
      const keys = this.keyStates();
      if (!keys) return;
      const values = Object.fromEntries(keys.map(({ id }) => [id, String(this.inputs.get(id)?.get_text() ?? "")]));
      if (Object.values(values).some((value) => !value)) return;
      body.values = values;
      body.observed = Object.fromEntries(keys.map(({ id, configured }) => [id, configured]));
    }
    this.busy = true;
    this.notice.set_label("");
    this.clearInputs();
    this.sync();
    try {
      const request = this.gateway.json<SecretStatus>("POST", path, body, undefined, false, this.requestCancel);
      delete body.values;
      const receipt = await request;
      if (this.disposed) return;
      this.latest = receipt;
      this.render();
    } catch (error) {
      if (this.disposed) return;
      const receipt = error instanceof HttpError && typeof error.body === "object"
        ? error.body as SecretStatus | null : null;
      const description = errorText(error);
      this.notice.set_label(receipt?.saved === false ? description : `Результат требует проверки. ${description}`);
      if (receipt?.saved !== false) chrome(this.notice, "label", "The outcome needs verification. {detail}", { detail: description });
      try {
        await this.readStatus();
      } catch (readError) {
        if (!this.disposed) this.statusFailed(readError);
      }
    } finally {
      this.busy = false;
      if (!this.disposed) {
        this.sync();
        this.changed();
      }
    }
  }
}
