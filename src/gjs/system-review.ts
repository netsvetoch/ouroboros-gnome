import { type Gateway } from "./gateway.js";
import { Gio, GLib, Gtk } from "./gi.js";
import { object, type SettingsDocument } from "./settings-write.js";
import { button, column, label, row, sheet } from "./ui.js";

interface Reviewer {
  id: string;
  title: string;
  detail: string;
  binding: string;
}

async function reviewers(gateway: Gateway, cancel: any): Promise<Reviewer[]> {
  const settings = await gateway.json<SettingsDocument>("GET", "/api/settings", undefined, undefined, false, cancel);
  const value = settings.OUROBOROS_SUBAGENTS;
  if (value == null || value === "") return [];
  const catalog = object(typeof value === "string" ? JSON.parse(value) : value);
  if (!Array.isArray(catalog.items)) throw new Error("Шлюз вернул неполный каталог субагентов.");
  const entries: Reviewer[] = [];
  const seen = new Set<string>();
  for (const item of catalog.items) {
    const agent = object(item);
    const id = typeof agent.subagent_id === "string" ? agent.subagent_id.trim() : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id) || seen.has(id)) {
      throw new Error("Шлюз вернул неоднозначный каталог субагентов.");
    }
    seen.add(id);
    if ([agent.enabled, agent.rechecks_flags].some(value => value != null && typeof value !== "boolean")
      || [agent.effort, agent.access, agent.processing_preference, agent.delivery].some(value => value != null && typeof value !== "string")) {
      throw new Error("Шлюз вернул неполные параметры субагента.");
    }
    if (agent.enabled === false) continue;
    const route = object(agent.route);
    const target = typeof route.target_id === "string" ? route.target_id.trim() : "";
    if (!target) throw new Error("В каталоге субагентов отсутствует маршрут модели.");
    if ([route.kind, route.credential_profile_id].some(value => value != null && typeof value !== "string")) {
      throw new Error("Шлюз вернул некорректный маршрут субагента.");
    }
    const processing = agent.processing_preference || settings.OUROBOROS_PROCESSING_PREFERENCE;
    const facets = [route.kind, agent.effort, agent.access, route.credential_profile_id, processing, agent.delivery,
      typeof agent.rechecks_flags === "boolean" ? (agent.rechecks_flags ? "Перепроверяет замечания" : "Без перепроверки замечаний") : undefined];
    entries.push({ id, title: `${target} · ${id}`, detail: facets.filter(Boolean).join(" · "),
      binding: JSON.stringify([target, ...facets]) });
  }
  return entries;
}

export async function chooseSystemReviewer(gateway: Gateway, present: (dialog: any) => boolean, cancel = new Gio.Cancellable()): Promise<string | undefined> {
  let roster: Reviewer[] = [];
  let missing = false;
  if (cancel.is_cancelled()) return undefined;
  try { roster = await reviewers(gateway, cancel); }
  catch { if (cancel.is_cancelled()) return undefined; missing = true; }
  if (cancel.is_cancelled()) return undefined;
  const content = column();
  const dialog = sheet("Глубокое ревью системы", content);
  content.append(label("Выберите, кто выполнит ревью всей системы. Задача может потребовать расходов модели."));
  if (missing) content.append(label("Каталог субагентов не удалось прочитать. Доступна основная модель.", "dim-label"));
  const selection = Gtk.DropDown.new_from_strings(["Основная модель Main", ...roster.map(item => item.title)]);
  const detail = label("", "dim-label");
  const actions = row();
  selection.connect("notify::selected", () => detail.set_label(roster[selection.get_selected() - 1]?.detail ?? ""));
  content.append(selection);
  content.append(detail);
  content.append(actions);
  const choice = await new Promise<number | undefined>((resolve) => {
    let selected: number | undefined, closing = false, settled = false, signal = 0;
    const finish = (value?: number) => {
      if (settled) return;
      settled = true;
      if (signal) { cancel.disconnect(signal); signal = 0; }
      resolve(value);
    };
    const close = (choice?: number) => {
      if (closing || settled || cancel.is_cancelled()) return;
      closing = true;
      selected = choice;
      actions.set_sensitive(false);
      selection.set_sensitive(false);
      dialog.close();
    };
    const dismiss = button("Отмена", () => close());
    const submit = button("Запросить ревью", () => close(selection.get_selected()));
    submit.add_css_class("suggested-action");
    actions.append(dismiss);
    actions.append(submit);
    dialog.connect("closed", () => finish(cancel.is_cancelled() ? undefined : selected));
    signal = cancel.connect(() => {
      GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        finish();
        if (dialog.get_mapped()) dialog.force_close();
        return GLib.SOURCE_REMOVE;
      });
    });
    if (!present(dialog)) finish();
  });
  if (choice === undefined || cancel.is_cancelled()) return undefined;
  if (choice === 0) return "/review";
  const selected = roster[choice - 1];
  let latest: Reviewer | undefined;
  try { latest = (await reviewers(gateway, cancel)).find(item => item.id === selected?.id); }
  catch (error) { if (cancel.is_cancelled()) return undefined; throw error; }
  if (cancel.is_cancelled()) return undefined;
  if (!latest || latest.binding !== selected.binding) throw new Error("Выбранный субагент изменился. Откройте ревью и выберите модель снова.");
  return `/review ${latest.id}`;
}
