import { type Harness, type Status, accountsPath } from "./accounts-quota.js";
import { type Gateway } from "./gateway.js";
import { Adw, Gio, Gtk } from "./gi.js";
import { object } from "./settings-write.js";
import { button, column, errorText, label, sheet } from "./ui.js";

interface Choice { id: string; title: string }

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const modelIdentifier = /^[^\s:=]+$/u;
const automatic = { id: "", title: "Автоматический выбор аккаунта" };
const defaultModel = { id: "", title: "Модель инструмента по умолчанию" };

function select(widget: any, items: Choice[], preferred: string): void {
  const model = widget.get_model();
  model.splice(0, model.get_n_items(), items.map(({ title }) => title));
  const index = items.findIndex(({ id }) => id === preferred);
  widget.set_selected(index < 0 ? 0 : index);
}

function readStatus(raw: unknown): Status {
  const record = (v: unknown): v is Record<string, any> => object(v) === v;
  const strings = (v: Record<string, any>, keys: string[]) => keys.every(key => v[key] == null || typeof v[key] === "string");
  const seen = new Set<string>();
  if (!record(raw) || !Array.isArray(raw.harnesses) || !strings(raw, ["error"])
    || raw.harnesses.some(tool => !record(tool) || typeof tool.id !== "string" || seen.has(tool.id) || !seen.add(tool.id)
      || !strings(tool, ["display_name", "models_error"]) || (tool.enabled != null && typeof tool.enabled !== "boolean")
      || (tool.models !== undefined && (!Array.isArray(tool.models) || tool.models.some((model: unknown) => !record(model)
        || typeof model.id !== "string" || !strings(model, ["label", "displayName", "credential_profile_id"]))))
      || (tool.model_catalog != null && (!record(tool.model_catalog)
        || (tool.model_catalog.partial != null && typeof tool.model_catalog.partial !== "boolean")
        || (tool.model_catalog.accounts !== undefined && (!Array.isArray(tool.model_catalog.accounts)
          || tool.model_catalog.accounts.some((account: unknown) => !record(account) || !strings(account, ["credentialProfileId"])
            || (account.catalog != null && !record(account.catalog))
            || (account.problem != null && (!record(account.problem) || !strings(account.problem, ["message"])))))))))
    || (raw.profiles !== undefined && (!record(raw.profiles) || (raw.profiles.profiles !== undefined
      && (!Array.isArray(raw.profiles.profiles) || raw.profiles.profiles.some((wrapper: unknown) => !record(wrapper)
        || !record(wrapper.profile) || ![wrapper.profile.harness_id, wrapper.profile.profile_id].every(v => typeof v === "string" && v.length > 0)
        || !strings(wrapper.profile, ["display_name"]) || (wrapper.profile.enabled != null && typeof wrapper.profile.enabled !== "boolean")
        || (wrapper.identity != null && (!record(wrapper.identity) || !strings(wrapper.identity, ["email"]))))))))
    || (raw.reads !== undefined && (!record(raw.reads) || ["catalog", "accounts"].some(key => raw.reads[key] !== undefined
      && !["ok", "failed", "not_read"].includes(raw.reads[key]))))) {
    throw new Error("Шлюз не вернул пригодный каталог сессий.");
  }
  return raw as Status;
}

export function pickSubagentSession(gateway: Gateway, parent: any, present: (dialog: any, parent: any) => void,
  initialTarget: string, initialPin: string, choose: (target: string, pin: string) => void): void {
  const content = column();
  const dialog = sheet("Каталог сессий Claudexor", content);
  const harness = Gtk.DropDown.new_from_strings([]);
  const account = Gtk.DropDown.new_from_strings([]);
  const model = Gtk.DropDown.new_from_strings([]);
  const status = label("", "dim-label");
  const notes = label("", "dim-label");
  let data: Status | undefined;
  let harnesses: Harness[] = [];
  let accounts: Choice[] = [];
  let models: Choice[] = [];
  let updating = false;
  let open = true;
  let reading = false;
  let ready = false;
  let chosen = false;
  let pending: any;
  let parentSignal = 0;
  const dispose = () => {
    if (!open) return;
    open = false;
    pending?.cancel();
    pending = undefined;
    if (parentSignal) { parent.disconnect(parentSignal); parentSignal = 0; }
    // Release list-item bindings before GJS finalizes their model wrappers.
    for (const control of [harness, account, model]) {
      control.set_sensitive(false);
      content.remove(control);
      control.run_dispose();
    }
  };
  dialog.connect("closed", dispose);
  if (parent instanceof Adw.Dialog || parent instanceof Gtk.Window) parentSignal = parent.connect(
    parent instanceof Gtk.Window ? "close-request" : "closed", () => { if (open) { dispose(); dialog.force_close(); } return false; });
  const sensitive = (value: boolean) => { for (const widget of [harness, account, model]) widget.set_sensitive(value); };
  const currentHarness = () => harnesses[harness.get_selected()];
  const pin = () => accounts[account.get_selected()]?.id ?? "";
  const modelId = () => models[model.get_selected()]?.id ?? "";

  const fillModels = (preferred = "") => {
    const tool = currentHarness();
    const selectedPin = pin();
    const rows = Array.isArray(tool?.models) ? tool.models : [];
    const seen = new Set<string>();
    models = [defaultModel];
    for (const raw of rows) {
      const item = object(raw);
      const id = typeof item.id === "string" ? item.id : "";
      if (!modelIdentifier.test(id) || seen.has(id) || selectedPin && item.credential_profile_id !== selectedPin) continue;
      seen.add(id);
      const name = typeof item.label === "string" ? item.label : typeof item.displayName === "string" ? item.displayName : id;
      models.push({ id, title: name === id ? id : `${name} · ${id}` });
    }
    if (preferred && modelIdentifier.test(preferred) && !seen.has(preferred)) {
      models.push({ id: preferred, title: `${preferred} · доступность не подтверждена` });
    }
    select(model, models, preferred);
    const envelope = tool?.model_catalog;
    const observed = envelope?.accounts?.filter(item => !selectedPin || item.credentialProfileId === selectedPin);
    const unread = observed?.filter(item => !item.catalog).map(item => item.problem?.message || item.credentialProfileId || "");
    const report = [tool?.models_error, ...(unread ?? [])].filter(Boolean).join(" · ");
    const noModels = observed?.some(item => item.catalog)
      ? "Шлюз не перечислил моделей для выбранного аккаунта."
      : "Шлюз не подтвердил список моделей для выбранного аккаунта.";
    notes.set_label(report ? `Каталог моделей прочитан частично или недоступен · ${report}`
      : envelope?.partial && (!selectedPin || !observed?.length) ? "Шлюз вернул частичный каталог моделей."
        : selectedPin && !seen.size ? noModels : "");
  };

  const fillAccounts = (preferredPin = "", preferredModel = "") => {
    const tool = currentHarness();
    accounts = [automatic];
    const known = new Set<string>();
    for (const { profile, identity } of data?.profiles?.profiles ?? []) {
      if (!profile || profile.harness_id !== tool?.id || !profile.profile_id || known.has(profile.profile_id)) continue;
      known.add(profile.profile_id);
      const name = profile.display_name || identity?.email || profile.profile_id;
      const title = [name, name !== profile.profile_id ? profile.profile_id : "", profile.enabled === false ? "выключен" : ""].filter(Boolean).join(" · ");
      accounts.push({ id: profile.profile_id, title });
    }
    if (preferredPin && !known.has(preferredPin)) accounts.push({ id: preferredPin, title: `${preferredPin} · профиль не подтверждён` });
    select(account, accounts, preferredPin);
    fillModels(preferredModel);
  };
  harness.connect("notify::selected", () => { if (open && ready && !updating) { updating = true; fillAccounts(); updating = false; } });
  account.connect("notify::selected", () => { if (open && ready && !updating) fillModels(modelId()); });

  const submit = button("Выбрать маршрут сессии", () => {
    if (!open || chosen || reading || !ready) return;
    const tool = currentHarness();
    if (!tool) return;
    const value = modelId();
    chosen = true;
    choose(value ? `${tool.id}=${value}` : tool.id, pin());
    dialog.close();
  });
  submit.add_css_class("suggested-action");
  const load = async () => {
    if (!open || reading) return;
    const [initialHarness, initialModel] = initialTarget.split("=", 2);
    const preferredHarness = currentHarness()?.id ?? initialHarness;
    const preferredPin = currentHarness() ? pin() : initialPin;
    const preferredModel = currentHarness() ? modelId() : initialModel;
    reading = true;
    ready = false;
    const cancel = pending = new Gio.Cancellable();
    sensitive(false);
    submit.set_sensitive(false);
    status.set_label("Читаю инструменты, аккаунты и модели Claudexor…");
    try {
      const raw = await gateway.json<unknown>("GET", `${accountsPath}/status?include=models`, undefined, undefined, true, cancel);
      if (!open) return;
      data = readStatus(raw);
      harnesses = (data.harnesses ?? []).filter(tool => identifier.test(tool.id));
      const missing = preferredHarness && identifier.test(preferredHarness) && !harnesses.some(tool => tool.id === preferredHarness);
      if (missing) harnesses.push({ id: preferredHarness, display_name: `${preferredHarness} · инструмент не подтверждён` });
      updating = true;
      select(harness, harnesses.map(tool => ({ id: tool.id, title: [tool.display_name || tool.id,
        tool.display_name && tool.display_name !== tool.id ? tool.id : "", tool.enabled === false ? "выключен" : ""].filter(Boolean).join(" · ") })), preferredHarness);
      const sameHarness = currentHarness()?.id === preferredHarness;
      fillAccounts(sameHarness ? preferredPin : "", sameHarness ? preferredModel : "");
      updating = false;
      ready = data.reads?.catalog === "ok";
      status.set_label([data.error, missing && "Сохранённый инструмент не найден в каталоге; его маршрут оставлен без замены.", data.reads?.catalog === "failed" ? "Не удалось прочитать каталог инструментов." : "",
        data.reads?.accounts === "failed" ? "Не удалось прочитать аккаунты." : "",
        !harnesses.length ? "Шлюз не вернул инструменты для выбора." : ""].filter(Boolean).join(" "));
    } catch (error) {
      if (open) status.set_label([data ? "Показан последний прочитанный каталог. Выбор недоступен до успешного чтения." : "", errorText(error)].filter(Boolean).join(" "));
    } finally {
      updating = false;
      reading = false;
      if (pending === cancel) pending = undefined;
      if (open) { sensitive(ready); submit.set_sensitive(ready && Boolean(currentHarness())); }
    }
  };
  for (const item of [status, button("Перечитать каталог", () => void load()), label("Инструмент"), harness,
    label("Аккаунт"), account, label("Модель"), model, notes, submit]) content.append(item);
  present(dialog, parent);
  void load();
}
