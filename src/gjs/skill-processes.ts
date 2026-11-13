import { type Gateway } from "./gateway.js";
import { Adw, Gio, GLib, Gtk } from "./gi.js";
import { object, type SettingsDocument } from "./settings-write.js";
import { actionRow, button, column, errorText, label, sheet } from "./ui.js";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stateOf(process: SettingsDocument): string {
  const code = process.returncode;
  if (typeof code === "number" && Number.isSafeInteger(code)) {
    return code < 0 ? `Завершён сигналом · ${-code}` : `Завершён · код ${code}`;
  }
  if (text(process.retiring)) return "Остановка процесса не подтверждена";
  return code === null ? "Работает" : "Состояние неизвестно";
}

function processRow(key: string, process: SettingsDocument): { widget: any; updated: any } {
  const skill = text(process.skill_name);
  const name = text(process.name);
  const ports = Array.isArray(process.ports)
    ? process.ports.filter(port => Number.isInteger(port) && port >= 0 && port <= 65535) : [];
  const pid = typeof process.pid === "number" && Number.isSafeInteger(process.pid) && process.pid > 0
    ? `PID ${process.pid}` : "";
  const title = skill && name ? `${skill} · ${name}` : key;
  const item = new Adw.ExpanderRow({ use_markup: false });
  item.set_title(title);
  item.set_subtitle([stateOf(process), pid, ports.length && `Порты по описанию · ${ports.join(", ")}`].filter(Boolean).join(" · "));
  const reason = text(process.retiring);
  if (reason) item.add_row(actionRow({ title: "Причина завершения", subtitle: reason, use_markup: false }));
  const updated = actionRow({ title: "Время снимка на шлюзе", use_markup: false });
  item.add_row(updated);
  const raw = label(JSON.stringify({ key, ...process }, null, 2), "monospace");
  raw.set_selectable(true);
  raw.set_margin_start(12);
  raw.set_margin_end(12);
  raw.set_margin_top(6);
  raw.set_margin_bottom(6);
  item.add_row(raw);
  return { widget: item, updated };
}

export function showSkillProcesses(gateway: Gateway, present: (dialog: any) => void, skill?: string, parent?: any): void {
  const content = column();
  const list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
  list.add_css_class("boxed-list");
  const status = label("", "dim-label");
  const search = new Gtk.SearchEntry({ placeholder_text: "Навык, процесс, PID или порт" });
  const count = label("", "dim-label");
  const empty = label("", "dim-label");
  const dialog = sheet("Процессы навыков", content);
  dialog.set_content_width(660);
  const cancel = new Gio.Cancellable();
  const refresh = button("Обновить процессы", () => void read());
  const rows = new Map<string, ReturnType<typeof processRow> & { signature: string }>();
  let snapshot: { key: string; process: SettingsDocument }[] = [];
  let reading = false;
  let disposed = false;
  let parentSignal = 0;
  let lastRead = "";
  if (skill) content.append(label(`Навык · ${skill}`, "heading"));
  for (const widget of [refresh, search, status, count, empty, list]) content.append(widget);
  const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
    void read();
    return GLib.SOURCE_CONTINUE;
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancel.cancel();
    GLib.Source.remove(timer);
    if (parentSignal) { parent.disconnect(parentSignal); parentSignal = 0; }
    snapshot = [];
    rows.clear();
  };
  dialog.connect("closed", dispose);
  if (parent instanceof Adw.Dialog) parentSignal = parent.connect("closed", dispose);
  search.connect("search-changed", () => { if (!disposed) render(); });

  function render(): void {
    const needle = search.get_text().trim().toLocaleLowerCase();
    const visible = snapshot.filter(({ key, process }) => !needle || [key, process.skill_name, process.name,
      process.pid, ...(Array.isArray(process.ports) ? process.ports : []), process.retiring]
      .map(String).join(" ").toLocaleLowerCase().includes(needle));
    const showing = new Set(visible.map(item => rows.get(item.key)?.widget));
    for (let child = list.get_first_child(); child;) {
      const next = child.get_next_sibling();
      if (!showing.has(child)) list.remove(child);
      child = next;
    }
    visible.forEach(({ key }, index) => {
      const widget = rows.get(key)?.widget;
      if (!widget) return;
      if (widget.get_parent() === list && widget.get_index() !== index) list.remove(widget);
      if (!widget.get_parent()) list.insert(widget, index);
    });
    count.set_label(`Показано · ${visible.length} из ${snapshot.length}`);
    empty.set_label(needle ? "По этому поиску процессов нет." : skill ? "В снимке нет процессов выбранного навыка." : "В снимке шлюза нет процессов.");
    empty.set_visible(!visible.length);
    list.set_visible(Boolean(visible.length));
  }

  async function read(): Promise<void> {
    if (reading || cancel.is_cancelled()) return;
    reading = true;
    refresh.set_sensitive(false);
    if (!lastRead) status.set_label("Читаю список процессов…");
    try {
      const result = object(await gateway.json("GET", "/api/skills/daemons", undefined, undefined, false, cancel));
      if (cancel.is_cancelled()) return;
      const entries = result.companions;
      if (entries !== object(entries) || result.error) throw new Error("Шлюз не вернул снимок процессов навыков.");
      const visible = Object.entries(object(entries)).flatMap(([key, value]) => {
        const process = object(value);
        if (value !== process || [process.skill_name, process.name, process.retiring, process.updated_at]
          .some(value => value !== undefined && typeof value !== "string")
          || process.pid !== undefined && (typeof process.pid !== "number" || !Number.isSafeInteger(process.pid) || process.pid <= 0)
          || process.returncode != null && !Number.isSafeInteger(process.returncode)
          || process.ports !== undefined && (!Array.isArray(process.ports)
            || process.ports.some(port => !Number.isSafeInteger(port) || port < 0 || port > 65535))) throw new Error("Шлюз вернул некорректную запись процесса.");
        return skill && process.skill_name !== skill ? [] : [{ key, process }];
      }).sort((left, right) => left.key.localeCompare(right.key));
      const keys = new Set(visible.map(item => item.key));
      for (const [key, entry] of rows) {
        if (keys.has(key)) continue;
        if (entry.widget.get_parent() === list) list.remove(entry.widget);
        rows.delete(key);
      }
      for (const { key, process } of visible) {
        const { updated_at, ...runtime } = process;
        const signature = JSON.stringify(runtime);
        const current = rows.get(key);
        let entry = current;
        if (current?.signature !== signature) {
          entry = { ...processRow(key, runtime), signature };
          if (current) {
            entry.widget.set_expanded(current.widget.get_expanded());
            if (current.widget.get_parent() === list) list.remove(current.widget);
          }
          rows.set(key, entry);
        }
        entry?.updated.set_subtitle(text(updated_at));
        entry?.updated.set_visible(Boolean(text(updated_at)));
      }
      snapshot = visible;
      render();
      lastRead = GLib.DateTime.new_now_local().format("%H:%M:%S");
      status.set_label(`Снимок получен · ${lastRead}`);
    } catch (error) {
      if (!cancel.is_cancelled()) status.set_label([
        lastRead && `Показан последний снимок · ${lastRead}`,
        `Не удалось обновить процессы. ${errorText(error)}`,
      ].filter(Boolean).join("\n"));
    } finally {
      reading = false;
      if (!cancel.is_cancelled()) refresh.set_sensitive(true);
    }
  }

  present(dialog);
  void read();
}
