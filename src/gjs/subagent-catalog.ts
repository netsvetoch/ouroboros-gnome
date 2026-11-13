import { Adw, Gtk } from "./gi.js";
import { type Gateway } from "./gateway.js";
import { type ModelCatalog } from "./model-catalog.js";
import { showReviewPool } from "./review-pool.js";
import { object, type SettingsDocument } from "./settings-write.js";
import { showSubagentAvailability } from "./subagent-availability.js";
import { showSubagentExecutions } from "./subagent-executions.js";
import { showSubagentPreview } from "./subagent-preview.js";
import { pickSubagentSession } from "./subagent-session.js";
import { actionRow, button, clear, column, errorText, label, row, sheet } from "./ui.js";

export const subagentKey = "OUROBOROS_SUBAGENTS";
type Present = (dialog: any, parent?: any) => void;
const kinds = ["api_model", "agent_session"];
const accessModes = ["readonly", "workspace_write", "full"];
const deliveries = ["native", "packet"];
const rowId = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function text(value: unknown): string { return typeof value === "string" ? value : ""; }

function chooser(options: string[], current: string, fallback = 0): any {
  const widget = Gtk.DropDown.new_from_strings(options);
  const index = options.indexOf(current);
  widget.set_selected(index < 0 ? fallback : index);
  return widget;
}

function editRow(parent: any, original: SettingsDocument, gateway: Gateway, models: ModelCatalog, present: Present,
  save: (data: SettingsDocument) => void): void {
  const content = column();
  const dialog = sheet("Настройки субагента", content);
  let open = true;
  let applied = false;
  const parentSignal = parent.connect("closed", () => { if (open) dialog.force_close(); });
  dialog.connect("closed", () => { if (!open) return; open = false; parent.disconnect(parentSignal); });
  const route = object(original.route);
  const entry = (title: string, value: unknown) => {
    const widget = new Gtk.Entry({ text: text(value) });
    content.append(label(title));
    content.append(widget);
    return widget;
  };
  const id = entry("ID субагента", original.subagent_id);
  const guidance = entry("Для каких задач подходит", original.recommended_use);
  content.append(label("Тип маршрута"));
  const kind = chooser(kinds, text(route.kind));
  content.append(kind);
  const target = entry("Цель маршрута · ID модели или harness=model", route.target_id);
  const discover = button("Выбрать из каталога…", () => {
    if (!open) return;
    if (kind.get_selected() === 1) {
      pickSubagentSession(gateway, dialog, present, target.get_text().trim(), pin.get_text().trim(), (value, profile) => {
        if (!open || kind.get_selected() !== 1) return;
        target.set_text(value);
        pin.set_text(profile);
      });
    } else models.pick(dialog, (model) => { if (open && kind.get_selected() === 0) target.set_text(model.value); });
  });
  content.append(discover);
  const effort = entry("Усилие · пусто для автоматического", original.effort);
  const processing = entry("Режим обработки · пусто для наследования", original.processing_preference);
  const session = column();
  const pin = new Gtk.Entry({ text: text(route.credential_profile_id) });
  const access = chooser(accessModes, text(original.access), 2);
  pin.set_name("subagent-account");
  content.append(label("Профиль аккаунта · пусто для Auto"));
  content.append(pin);
  content.append(label("Привязка аккаунта поддерживается сессиями и управляемыми моделями claudexor::. Для обычного API оставьте профиль пустым.", "dim-label"));
  for (const item of [label("Права доступа сессии"), access]) session.append(item);
  const api = column();
  const delivery = chooser(deliveries, text(original.delivery));
  const recheck = new Gtk.CheckButton({ label: "Перепроверяет замечания", active: original.rechecks_flags === true });
  for (const item of [label("Материалы для ревью"), delivery, recheck]) api.append(item);
  const enabled = new Gtk.CheckButton({ label: "Включён", active: original.enabled !== false });
  const eligible = new Gtk.CheckButton({ label: "Входит в пул ревью", active: original.review_eligible === true });
  const status = label("", "error");
  const sync = () => {
    const isSession = kind.get_selected() === 1;
    session.set_visible(isSession);
    api.set_visible(!isSession);
    recheck.set_sensitive(delivery.get_selected() === 1);
  };
  kind.connect("notify::selected", sync);
  delivery.connect("notify::selected", sync);
  const submit = button("Применить к каталогу", () => {
    if (!open || applied) return;
    try {
      const name = id.get_text().trim();
      const targetId = target.get_text().trim();
      if (!rowId.test(name) || !targetId) throw new Error("Укажите допустимый ID и цель маршрута.");
      const isSession = kind.get_selected() === 1;
      const account = pin.get_text().trim();
      if (account && !isSession && (!targetId.startsWith("claudexor::") || targetId.endsWith(" (local)"))) {
        throw new Error("Этот API-маршрут не поддерживает привязку аккаунта. Очистите профиль или выберите управляемую модель claudexor::.");
      }
      const next: SettingsDocument = { ...original, subagent_id: name, recommended_use: guidance.get_text(),
        route: { ...route, kind: kinds[kind.get_selected()], target_id: targetId }, enabled: enabled.get_active(),
        review_eligible: eligible.get_active(), effort: effort.get_text().trim(), processing_preference: processing.get_text().trim() };
      const nextRoute = object(next.route);
      delete nextRoute.credential_profile_id;
      if (account) nextRoute.credential_profile_id = account;
      for (const key of ["access", "delivery", "rechecks_flags"]) delete next[key];
      if (isSession) {
        next.access = accessModes[access.get_selected()];
      } else {
        next.delivery = deliveries[delivery.get_selected()];
        if (next.delivery === "packet" && recheck.get_active()) next.rechecks_flags = true;
      }
      save(next);
      applied = true;
      dialog.close();
    } catch (error) { status.set_label(errorText(error)); }
  });
  submit.add_css_class("suggested-action");
  for (const item of [session, api, enabled, eligible, status, submit]) content.append(item);
  sync();
  present(dialog, parent);
}

export function showSubagentCatalog(settings: SettingsDocument, saved: SettingsDocument, gateway: Gateway, models: ModelCatalog, present: Present,
  stage: (patch: SettingsDocument) => void, openTask?: (id: string) => void): void {
  const raw = settings[subagentKey];
  const metadata = object(object(saved._meta).available_subagents);
  const stored = raw === undefined || raw === null || raw === "" ? metadata.candidate ?? { enabled: true, items: [] }
    : typeof raw === "string" ? JSON.parse(raw) : raw;
  let document = object(stored);
  if (!Array.isArray(document.items) || document.items.some(item => object(item) !== item)) {
    throw new Error("Шлюз вернул нечитаемый каталог субагентов.");
  }
  const entries = [...document.items] as SettingsDocument[];
  const initial = JSON.stringify(document);
  let accepted = false;
  let assignments: SettingsDocument = {};
  const content = column();
  const dialog = sheet("Каталог субагентов", content);
  let open = true;
  let staged = false;
  let generation = 0;
  dialog.connect("closed", () => { open = false; ++generation; });
  dialog.set_content_width(740);
  const enabled = new Gtk.CheckButton({ label: "Разрешить делегирование субагентам", active: document.enabled !== false });
  const status = label("", "dim-label");
  const source = label(metadata.automatic === true ? "Шлюз предлагает автоматический состав. Правки сохраняются только после применения формы."
    : text(metadata.diagnostic), "dim-label");
  const list = column(6);
  const put = (index: number, next: SettingsDocument) => {
    if (!open) return;
    if (entries.some((other, pos) => pos !== index && other.subagent_id === next.subagent_id)) throw new Error("Такой ID уже есть в каталоге.");
    if (next.rechecks_flags === true && entries.some((other, pos) => pos !== index && other.rechecks_flags === true)) {
      throw new Error("Перепроверку замечаний можно назначить одной строке каталога.");
    }
    entries[index] = next;
    render();
  };
  const render = () => {
    const current = ++generation;
    clear(list);
    const reviewers = entries.filter(item => item.enabled !== false && item.review_eligible === true).length;
    status.set_label(`Субагентов · ${entries.length} · Включённых участников ревью · ${reviewers}`);
    entries.forEach((item, index) => {
      const route = object(item.route);
      const group = new Adw.PreferencesGroup();
      const header = actionRow({ title: text(item.subagent_id) || "Без ID", use_markup: false,
        subtitle: [route.target_id, text(route.credential_profile_id) && `Аккаунт · ${text(route.credential_profile_id)}`, item.enabled === false ? "Выключен" : "Включён", item.review_eligible === true ? "Ревью" : ""].filter(Boolean).join(" · ") });
      const actions = row();
      const edit = button("Изменить…", () => {
        if (!open || current !== generation) return;
        editRow(dialog, item, gateway, models, present, next => {
          if (open && current === generation) put(index, next);
        });
      });
      const move = (offset: number) => {
        const target = index + offset;
        if (!open || current !== generation || target < 0 || target >= entries.length) return;
        [entries[index], entries[target]] = [entries[target], entries[index]];
        render();
      };
      const up = button("Выше", () => move(-1));
      const down = button("Ниже", () => move(1));
      up.set_sensitive(index > 0);
      down.set_sensitive(index + 1 < entries.length);
      for (const action of [edit, up, down, button("Убрать", () => { if (!open || current !== generation) return; entries.splice(index, 1); render(); })]) actions.append(action);
      actions.set_valign(Gtk.Align.CENTER);
      header.add_suffix(actions);
      group.add(header);
      list.append(group);
    });
  };
  const add = button("Добавить субагента…", () => {
    if (!open) return;
    const current = generation;
    editRow(dialog, {}, gateway, models, present, next => { if (open && current === generation) put(entries.length, next); });
  });
  const submit = button("Применить в форме", () => {
    if (!open || staged) return;
    staged = true;
    const value = { ...document, enabled: enabled.get_active(), items: entries };
    const serialized = JSON.stringify(value);
    const patch = { ...assignments };
    if (accepted || serialized !== initial) patch[subagentKey] = typeof raw === "string" ? serialized : value;
    stage(patch);
    dialog.close();
  });
  submit.add_css_class("suggested-action");
  const pool = button("Пул ревью на шлюзе…", () => showReviewPool(gateway, present, dialog));
  const availability = button("Доступность маршрутов…", () => { if (open) showSubagentAvailability(gateway, dialog, present, entries, enabled.get_active()); });
  const executions = button("Выполнения субагентов…", () => { if (open) showSubagentExecutions(gateway, dialog, present, entries,
    assignments.OUROBOROS_PROCESSING_PREFERENCE ?? settings.OUROBOROS_PROCESSING_PREFERENCE, openTask); });
  let previewDialog: any;
  const currentCatalog = () => ({ ...document, enabled: enabled.get_active(), items: entries });
  const preview = button("Предложенный состав…", () => {
    if (!open || previewDialog) return;
    const snapshot = JSON.stringify(currentCatalog());
    previewDialog = showSubagentPreview(gateway, { ...settings, ...assignments, [subagentKey]: JSON.parse(snapshot) }, saved, dialog, present,
      (catalog, suggestedModels) => {
        if (!open) return;
        if (JSON.stringify(currentCatalog()) !== snapshot) {
          status.set_label("Каталог изменился. Рассчитайте состав ещё раз.");
          return;
        }
        document = catalog;
        entries.splice(0, entries.length, ...(catalog.items as SettingsDocument[]));
        enabled.set_active(catalog.enabled === true);
        assignments = { ...assignments, ...suggestedModels };
        accepted = true;
        source.set_label(Object.keys(suggestedModels).length
          ? "В черновик перенесены предложенный состав и назначения моделей."
          : "В черновик перенесён предложенный состав.");
        render();
      });
    previewDialog.connect("closed", () => { previewDialog = undefined; });
  });
  for (const item of [source, enabled, status, add, preview, pool, availability, executions, list, submit]) content.append(item);
  render();
  present(dialog);
}
