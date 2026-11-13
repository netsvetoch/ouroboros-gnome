import { Gtk } from "./gi.js";
import { button, column } from "./ui.js";
import { exactWorkTarget } from "./work-actions.js";

export interface NestedTaskRow { task_id?: string; parent_task_id?: string }

/** Build one native group per child, preserving its recorded ancestry. */
export class NestedTasks {
  private readonly parents = new Map<string, string>();
  private readonly groups = new Map<string, { panel: any; body: any }>();
  private readonly mounted = new Set<string>();

  constructor(private readonly target: any, rows: NestedTaskRow[], expanded: boolean,
    choices: Map<string, boolean>, open?: (task: string) => void) {
    const conflicts = new Set<string>();
    for (const { task_id: task, parent_task_id: parent } of rows) {
      if (!exactWorkTarget(task) || !parent) continue;
      if (!exactWorkTarget(parent) || task === parent) { conflicts.add(task); continue; }
      if (this.parents.has(task) && this.parents.get(task) !== parent) conflicts.add(task);
      this.parents.set(task, parent);
    }
    for (const task of conflicts) this.parents.delete(task);
    for (const task of this.parents.keys()) {
      const seen = new Set<string>();
      let node: string | undefined = task;
      while (node && !seen.has(node)) { seen.add(node); node = this.parents.get(node); }
      if (node) continue; // An inconsistent lineage stays visible as ordinary rows.
      const body = column(4);
      body.set_margin_start(14);
      if (open) {
        const show = button("Открыть подзадачу", () => open(task));
        show.set_halign(Gtk.Align.START);
        body.append(show);
      }
      const panel = new Gtk.Expander({ label: `Субагент · ${task}`, child: body,
        expanded: choices.get(task) ?? expanded, tooltip_text: `Родительская задача · ${this.parents.get(task)}` });
      panel.connect("notify::expanded", () => choices.set(task, panel.get_expanded()));
      this.groups.set(task, { panel, body });
    }
  }

  append(task: string | undefined, widget: any, reveal = false): void {
    if (!task || !this.groups.has(task)) { this.target.append(widget); return; }
    const chain: string[] = [];
    let node: string | undefined = task;
    while (node && this.groups.has(node)) { chain.push(node); node = this.parents.get(node); }
    for (const id of chain.toReversed()) {
      const group = this.groups.get(id)!;
      if (!this.mounted.has(id)) {
        const parent = this.groups.get(this.parents.get(id) ?? "");
        (parent?.body ?? this.target).append(group.panel);
        this.mounted.add(id);
      }
      if (reveal) group.panel.set_expanded(true);
    }
    this.groups.get(task)!.body.append(widget);
  }
}
