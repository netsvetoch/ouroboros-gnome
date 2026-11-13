import { type Gateway } from "./gateway.js";
import { Gtk } from "./gi.js";
import { setupPath } from "./onboarding-receipt.js";
import { type SettingsDocument, object } from "./settings-write.js";
import { button, clear, column, errorText, label } from "./ui.js";

export function setupRows(value: unknown): SettingsDocument[] {
  return Array.isArray(value) ? value.map(object) : [];
}

export class StarterSkills {
  readonly widget: any;
  private readonly selection = new Map<string, boolean>();
  private readonly trust = new Map<string, string>();

  constructor(gateway: Gateway, current: () => boolean, cancel?: any) {
    const content = column(5);
    let loading = false;
    let loaded = false, generation = 0;
    const options = column(5);
    const status = label("", "dim-label");
    const customize = new Gtk.CheckButton({ label: "Выбрать навыки вручную" });
    customize.set_sensitive(false);
    options.set_sensitive(false);
    customize.connect("toggled", () => { if (current()) options.set_sensitive(customize.get_active()); });
    const groups = column(5);
    const hub = column(5);
    options.append(groups);
    const reload = button("Перечитать навыки", () => void load());
    for (const widget of [status, reload, customize, options, hub]) content.append(widget);
    this.widget = new Gtk.Expander({ label: "Начальные навыки и доверие к источникам", child: content });
    const load = async () => {
      if (!current() || loading) return;
      loading = true;
      reload.set_sensitive(false);
      status.set_label("Читаю начальные навыки…");
      try {
        const data = await gateway.json<SettingsDocument>("GET", setupPath + "/starter-skills", undefined, undefined, false, cancel);
        if (!current()) return;
        const groupsData = setupRows(data?.groups), sources = setupRows(data?.hub_rows);
        const ids = groupsData.flatMap(group => setupRows(group.items).map(skill => skill.id));
        if (!Array.isArray(data?.groups) || !Array.isArray(data?.hub_rows)
          || groupsData.some(group => !Array.isArray(group.items) || (group.label !== undefined && typeof group.label !== "string")
            || setupRows(group.items).some(skill => typeof skill.id !== "string" || !skill.id || typeof skill.name !== "string"
              || (skill.recommended !== undefined && typeof skill.recommended !== "boolean")))
          || sources.some(source => typeof source.id !== "string" || !source.id || typeof source.name !== "string" || typeof source.trust !== "string")
          || new Set(ids).size !== ids.length || new Set(sources.map(source => source.id)).size !== sources.length) {
          throw new Error("Шлюз не вернул полный каталог начальных навыков.");
        }
        const accepted = ++generation;
        loaded = true;
        const previous = new Map(this.selection);
        this.selection.clear();
        clear(groups);
        clear(hub);
        for (const group of groupsData) {
          groups.append(label(String(group.label ?? group.category ?? ""), "heading"));
          for (const skill of setupRows(group.items)) {
            if (typeof skill.id !== "string") continue;
            const id = skill.id;
            const active = previous.get(id) ?? skill.recommended === true;
            this.selection.set(id, active);
            const item = new Gtk.CheckButton({ label: String(skill.name ?? id), active });
            item.connect("toggled", () => {
              if (current() && generation === accepted) this.selection.set(id, item.get_active());
            });
            groups.append(item);
            const description = [skill.description, Array.isArray(skill.needs_keys) && skill.needs_keys.length
              ? `Ключи · ${skill.needs_keys.join(", ")}` : ""].filter(Boolean).join(" · ");
            if (description) groups.append(label(description, "dim-label"));
          }
        }
        customize.set_sensitive(true);
        for (const source of sources) {
          if (typeof source.id !== "string") continue;
          const id = source.id;
          const values = ["", "review", "trusted"];
          hub.append(label(`${source.name ?? id} · ${source.part || id} · ${source.trust ?? ""}`));
          const choice = Gtk.DropDown.new_from_strings(["Оставить как есть", "На проверку", "Доверять"]);
          choice.set_selected(Math.max(0, values.indexOf(this.trust.get(id) ?? "")));
          choice.connect("notify::selected", () => {
            if (!current() || generation !== accepted) return;
            const value = values[choice.get_selected()];
            if (value) this.trust.set(id, value);
            else this.trust.delete(id);
          });
          hub.append(choice);
        }
        const sourceIds = new Set(setupRows(data?.hub_rows).map((source) => source.id));
        for (const id of this.trust.keys()) if (!sourceIds.has(id)) this.trust.delete(id);
        status.set_label(this.selection.size ? customize.get_active() ? "Сохранён выбор начальных навыков." : "По умолчанию шлюз установит рекомендованный набор." : "Каталог начальных навыков пуст.");
      } catch (error) {
        if (current()) status.set_label([errorText(error), loaded ? "Показан последний прочитанный каталог. Выбор сохранён." : ""].filter(Boolean).join("\n"));
      } finally {
        loading = false;
        if (current()) reload.set_sensitive(true);
      }
    };
    this.widget.connect("notify::expanded", () => {
      if (this.widget.get_expanded() && !status.get_label()) void load();
    });
    this.payload = () => ({
      ...(customize.get_active() ? { starter_skills: [...this.selection].filter(([, active]) => active).map(([id]) => id) } : {}),
      ...(this.trust.size ? { skill_source_trust: Object.fromEntries(this.trust) } : {}),
    });
  }

  readonly payload: () => SettingsDocument;
}
