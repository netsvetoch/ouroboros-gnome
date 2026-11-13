import { Gtk } from "./gi.js";
import { kanbanColumns, type KanbanCard, type KanbanColumn } from "./component-kanban-model.js";
import { button, clear, column, label, row } from "./ui.js";

export class ComponentKanban {
  readonly widget = column(8);
  private readonly content = column(8);
  private readonly position = label("", "dim-label");
  private readonly previous = button("Предыдущие колонки", () => { this.start = Math.max(0, this.start - 4); this.render(); });
  private readonly next = button("Следующие колонки", () => { if (this.start + 4 < this.groups.length) this.start += 4; this.render(); });
  private groups: KanbanColumn[] = [];
  private start = 0;
  private busy = false;
  private readonly pages = new Map<string, number>();
  private readonly drafts = new Map<string, string>();
  private live = new Set<string>();

  constructor(private readonly columns: unknown, cards: unknown,
    private readonly move?: (card: KanbanCard, destination: string) => void) {
    const controls = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, row_spacing: 4, column_spacing: 6 });
    controls.append(this.previous); controls.append(this.next);
    this.widget.append(this.position); this.widget.append(controls); this.widget.append(this.content);
    this.setCards(cards);
  }
  setBusy(busy: boolean): void { this.busy = busy; this.widget.set_sensitive(!busy); }
  setCards(cards: unknown): void {
    this.groups = kanbanColumns(this.columns, cards);
    this.live = new Set(this.groups.flatMap(group => group.cards.map(card => card.key)));
    const columns = new Set(this.groups.map(group => group.id));
    for (const key of this.pages.keys()) if (!columns.has(key)) this.pages.delete(key);
    for (const key of this.drafts.keys()) if (!this.live.has(key)) this.drafts.delete(key);
    this.start = Math.min(this.start, Math.max(0, Math.floor((this.groups.length - 1) / 4) * 4));
    this.render();
  }
  private render(): void {
    clear(this.content);
    const paged = this.groups.length > 4;
    this.previous.set_visible(paged); this.next.set_visible(paged);
    this.previous.set_sensitive(this.start > 0); this.next.set_sensitive(this.start + 4 < this.groups.length);
    this.position.set_label(`Колонки ${this.groups.length ? this.start + 1 : 0}–${Math.min(this.groups.length, this.start + 4)} из ${this.groups.length} · Карточек ${[...new Map(this.groups.map(group => [group.id, group.cards.length])).values()].reduce((sum, count) => sum + count, 0)}`);
    if (!this.groups.length) this.content.append(label("Нет колонок канбана.", "dim-label"));
    for (const group of this.groups.slice(this.start, this.start + 4)) {
      const body = column(4);
      body.append(label(`${group.label} · ${group.cards.length}`, group.known ? "heading" : "warning"));
      let start = Math.min(this.pages.get(group.id) ?? 0, Math.max(0, Math.floor((group.cards.length - 1) / 50) * 50));
      this.pages.set(group.id, start);
      if (!group.cards.length) body.append(label("Нет карточек.", "dim-label"));
      if (group.cards.length > 50) {
        body.append(label(`Карточки ${start + 1}–${Math.min(group.cards.length, start + 50)} из ${group.cards.length}`, "dim-label"));
        const pages = row();
        const previous = button("Предыдущие карточки", () => { this.pages.set(group.id, Math.max(0, start - 50)); this.render(); });
        const next = button("Следующие карточки", () => { this.pages.set(group.id, start + 50); this.render(); });
        previous.set_sensitive(start > 0); next.set_sensitive(start + 50 < group.cards.length);
        pages.append(previous); pages.append(next); body.append(pages);
      }
      for (const card of group.cards.slice(start, start + 50)) body.append(this.card(card));
      this.content.append(body);
    }
    this.widget.set_sensitive(!this.busy);
  }
  private card(card: KanbanCard): any {
    const box = column(4);
    const text = label(card.label); text.set_selectable(true); box.append(text);
    if (!this.move) return box;
    const choices = this.groups.filter(group => group.known);
    const chosen = this.drafts.get(card.key) ?? card.column;
    const index = choices.findIndex(group => group.id === chosen);
    const offset = index < 0 ? 1 : 0;
    const select = Gtk.DropDown.new_from_strings([...(offset ? ["Выберите колонку"] : []), ...choices.map(group => group.label)]);
    select.set_selected(index < 0 ? 0 : index);
    select.update_property([Gtk.AccessibleProperty.LABEL], [`Колонка для ${card.label}`]);
    const submit = button("Переместить", () => {
      const destination = choices[select.get_selected() - offset]?.id;
      if (this.busy || !select.get_mapped() || !this.live.has(card.key) || !destination || destination === card.column) return;
      this.move?.(card, destination);
    });
    submit.update_property([Gtk.AccessibleProperty.LABEL], [`Переместить ${card.label}`]);
    const changed = () => {
      const destination = choices[select.get_selected() - offset]?.id;
      if (destination) this.drafts.set(card.key, destination);
      submit.set_sensitive(Boolean(destination && destination !== card.column));
    };
    select.connect("notify::selected", changed); changed();
    const controls = row(); controls.append(select); controls.append(submit); box.append(controls);
    return box;
  }
}
