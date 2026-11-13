import { Gdk, GLib, Gtk } from "./gi.js";
import { ComponentMap } from "./component-map.js";
import { ComponentGallery } from "./component-gallery.js";
import { ComponentKanban } from "./component-kanban.js";
import { componentChart } from "./component-chart.js";
import { componentTable } from "./component-table.js";
import { componentFields, componentGroup } from "./component-layout.js";
import { componentFieldProblem, componentFieldType, componentFieldValue } from "./component-field-validation.js";
import { codeView } from "./code-view.js";
import { markdownView } from "./markdown-view.js";
import { WidgetMedia } from "./widget-media.js";
import { button, column, label } from "./ui.js";

type Data = Record<string, unknown>;
type Value = string | number | boolean | null;

export interface CardControl {
  id: string;
  once: boolean;
  disabled: boolean;
  widget: any;
}

export type Submit = (control: CardControl, values?: Record<string, Value>) => void;

function object(value: unknown): Data {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
}

function records(value: unknown): Data[] {
  return Array.isArray(value) ? value.map(object) : [];
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : typeof value === "boolean" || typeof value === "number" ? String(value) : fallback;
}

function path(data: unknown, selector: unknown): unknown {
  if (typeof selector !== "string" || !selector) return data;
  return selector.split(".").reduce((value: unknown, key) =>
    value && typeof value === "object" && Object.hasOwn(value, key)
      ? (value as Data)[key] : undefined, data);
}

function selectable(value: string, css?: string): any {
  const widget = label(value, css);
  widget.set_selectable(true);
  return widget;
}

function grid(columns: string[], values: string[][]): any {
  const widget = new Gtk.Grid({ column_spacing: 14, row_spacing: 4 });
  columns.forEach((heading, index) => widget.attach(label(heading, "heading"), index, 0, 1, 1));
  values.forEach((values, index) => {
    values.forEach((value, col) => widget.attach(selectable(value), col, index + 1, 1, 1));
  });
  return widget;
}

function formField(field: Data, maxLength: number): { widget: any; read: () => Value } {
  const box = column(4);
  const caption = text(field.label, text(field.name));
  const current = text(field.default);
  let input: any;
  let read: () => Value;
  switch (field.type) {
    case "checkbox":
      input = new Gtk.CheckButton({ label: caption, active: Boolean(field.default) });
      read = () => input.get_active();
      break;
    case "select": {
      const options = Array.isArray(field.options) ? field.options : [];
      const values = options.map((option) => text(object(option).value ?? option));
      input = Gtk.DropDown.new_from_strings(options.map((option, index) => text(object(option).label, values[index])));
      const selected = values.indexOf(current);
      if (selected !== -1) input.set_selected(selected);
      read = () => values[input.get_selected()] ?? "";
      break;
    }
    case "textarea": {
      const view = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR });
      const buffer = view.get_buffer();
      buffer.set_text(current, -1);
      input = new Gtk.ScrolledWindow({ child: view, min_content_height: 80 });
      read = () => buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false);
      break;
    }
    case "password":
      input = new Gtk.PasswordEntry({ placeholder_text: text(field.placeholder), show_peek_icon: true });
      read = () => input.get_text();
      break;
    default: {
      const purpose = field.type === "number" ? Gtk.InputPurpose.NUMBER
        : field.type === "url" ? Gtk.InputPurpose.URL
        : field.type === "email" ? Gtk.InputPurpose.EMAIL : Gtk.InputPurpose.FREE_FORM;
      input = new Gtk.Entry({ text: current, placeholder_text: text(field.placeholder), input_purpose: purpose, max_length: maxLength });
      read = () => componentFieldValue(field.type, input.get_text());
    }
  }
  input.set_sensitive(!field.disabled);
  if (field.type !== "checkbox") box.append(label(caption));
  box.append(input);
  if (field.help) box.append(label(text(field.help), "dim-label"));
  return { widget: box, read };
}

function inlineImage(component: Data, data: unknown): any {
  const title = text(component.label, text(component.alt, "Изображение"));
  const source = text(path(data, component.path), text(component.src)).trim();
  const match = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=]+)$/i.exec(source);
  if (!match || match[2].length > 8 * 1024 * 1024) return label(`${title} · изображение недоступно`, "dim-label");
  try {
    const texture = Gdk.Texture.new_from_bytes(GLib.Bytes.new(GLib.base64_decode(match[2])));
    const view = new Gtk.Picture({ paintable: texture, can_shrink: true, alternative_text: title });
    view.set_size_request(-1, Math.min(320, texture.get_height()));
    return view;
  } catch {
    return label(`${title} · изображение недоступно`, "dim-label");
  }
}

export function mountComponents(nodes: unknown, data: unknown, submit: Submit,
  limits: { fields?: number; length?: number; base?: string } = { fields: 50, length: 4000 }): { widget: any; controls: CardControl[]; close: () => void; setActive: (active: boolean) => void } {
  const controls: CardControl[] = [];
  const media: WidgetMedia[] = [];
  const maps: ComponentMap[] = [];
  const galleries: ComponentGallery[] = [];
  const maxLength = limits.length ?? 0;
  let remaining = 256;
  function tree(nodes: unknown, depth: number, layout?: unknown, columns?: unknown): any {
    const box = componentGroup(layout, columns);
    if (depth > 8) return box;
    for (const node of records(nodes)) {
      if (--remaining < 0) break;
      const child = render(node, depth);
      if (child) box.append(child);
    }
    return box;
  }

  function render(node: Data, depth: number): any {
    const source = !node.target || node.target === "result" ? data : undefined;
    if (node.condition_key && !path(source, node.condition_key)) return null;
    const title = text(node.title, text(node.label));
    const value = path(source, node.path);
    switch (node.type) {
      case "group": {
        const box = column();
        if (title) box.append(label(title, "title-4"));
        if (node.description) box.append(label(text(node.description)));
        box.append(tree(node.components, depth + 1, node.layout, node.columns));
        return box;
      }
      case "tabs": {
        const box = column();
        const stack = new Gtk.Stack({ vexpand: true });
        box.append(new Gtk.StackSwitcher({ stack }));
        box.append(stack);
        records(node.tabs).forEach((tab, i) => stack.add_titled(tree(tab.components, depth + 1), String(i), text(tab.label ?? tab.title, `Вкладка ${i + 1}`)));
        return box;
      }
      case "action":
      case "form": {
        const spec = object(node.submit);
        const id = text(spec.id);
        if (!/^[a-z0-9_]{1,40}$/.test(id)) return label("Действие карточки недоступно.", "dim-label");
        const isForm = node.type === "form";
        const fields = isForm ? records(node.fields).slice(0, limits.fields).filter((field) => typeof field.name === "string" && field.name)
          .map((raw) => {
            const field: Data = { ...raw, type: componentFieldType(raw.type) };
            return { field, ...formField(field, maxLength) };
          }) : [];
        const box = column(6);
        const validation = label("", "error");
        validation.set_visible(false);
        if (isForm && title) box.append(label(title, "title-4"));
        if (isForm) box.append(componentFields(fields, node.columns));
        const submitLabel = isForm ? text(node.submit_label, "Отправить") : title || "Выполнить";
        const activate = button(submitLabel, () => {
          const values: [string, Value][] = [];
          for (const { field, read } of fields) {
            const value = read();
            const problem = componentFieldProblem(field, value, maxLength);
            if (problem) { validation.set_label(problem); validation.set_visible(true); return; }
            values.push([text(field.name), value]);
          }
          validation.set_label("");
          validation.set_visible(false);
          submit(control, isForm ? Object.fromEntries(values) : undefined);
        });
        const control = { id, once: spec.once === true, disabled: Boolean(node.disabled), widget: activate };
        controls.push(control);
        activate.set_sensitive(!control.disabled);
        box.append(activate);
        box.append(validation);
        return box;
      }
      case "metric": {
        const scalar = node.value ?? value;
        const raw = text(scalar).trim();
        const missing = !raw || /^[-+]?(?:nan|inf(?:inity)?)$/i.test(raw);
        const rendered = !missing && Number.isFinite(Number(raw)) && Number.isInteger(node.precision)
          ? Number(raw).toFixed(Math.max(0, Math.min(12, Number(node.precision)))) : raw;
        return selectable([title, missing ? "—" : [rendered, text(node.unit)].filter(Boolean).join(" ")].filter(Boolean).join(" · "), "heading");
      }
      case "markdown":
        return markdownView(text(node.text ?? value), limits.base);
      case "code":
        return codeView(text(node.text ?? value), typeof node.language === "string" ? node.language : undefined, title);
      case "callout":
        return selectable(text(node.text ?? value));
      case "json": {
        const expander = new Gtk.Expander({ label: title || "JSON" });
        expander.set_child(selectable(JSON.stringify(value ?? null, null, 2), "monospace"));
        return expander;
      }
      case "status":
        return label(text(node.idle, title || "Готово"), "dim-label");
      case "kv":
        return grid([], records(node.fields).map((field) => [text(field.label, text(field.path)), text(path(source, field.path), "—")]));
      case "key_value":
        return componentTable([{ label: "Ключ", path: "key" }, { label: "Значение", path: "value" }],
          records(path(source, node.items_key ?? node.path)).map(item => ({ key: text(item.key, text(item.label)), value: text(item.value, "—") })));
      case "table": {
        const columns = records(node.columns);
        return componentTable(columns, records(value), limits.base);
      }
      case "chart": {
        const axis = node.labels ?? path(value, node.labels_path ?? "labels");
        const labels = Array.isArray(axis) ? axis.map((item) => String(item ?? "")) : [];
        const datasets = node.datasets ?? path(value, node.datasets_path ?? "datasets");
        const series = (Array.isArray(datasets) ? datasets : []).map(raw => {
          const dataset = object(raw);
          return { label: String(dataset.label ?? "Ряд"), values: (Array.isArray(dataset.data) ? dataset.data : []).map(cell =>
            (typeof cell === "number" || typeof cell === "string" && cell.trim()) && Number.isFinite(Number(cell)) ? Number(cell) : null) };
        });
        return componentChart(text(node.aria_label, title), text(node.unit), node.chart_type === "bar", labels, series);
      }
      case "progress": {
        const percent = Number(path(source, node.path ?? node.value_key ?? "progress"));
        return Number.isFinite(percent) ? new Gtk.ProgressBar({
          fraction: Math.max(0, Math.min(100, percent)) / 100,
          show_text: true,
          text: [`${Math.max(0, Math.min(100, percent))}%`, text(path(source, node.label_key))].filter(Boolean).join(" · "),
        }) : label("Ход выполнения неизвестен", "dim-label");
      }
      case "image":
        return inlineImage(node, source);
      case "audio":
      case "video": {
        // A component card has no route or gateway authority: only inline data can resolve.
        const player = new WidgetMedia(undefined, "", node);
        media.push(player);
        player.setData(source);
        return player.widget;
      }
      case "gallery": {
        const gallery = new ComponentGallery(undefined, "", node);
        galleries.push(gallery); gallery.setData(source); return gallery.widget;
      }
      case "calendar":
        return componentTable([{ label: "Событие", path: "label" }, { label: "Начало", path: "start" },
          { label: "Окончание", path: "end" }, { label: "Группа", path: "row" }], records(node.items ?? value));
      case "map": {
        const view = new ComponentMap(node.markers, node.tiles_url, title || "Карта");
        maps.push(view); return view.widget;
      }
      case "kanban":
        return new ComponentKanban(node.columns, node.cards ?? value).widget;
      default:
        return label(`Компонент пока недоступен · ${title || text(node.type, "неизвестный тип")}`, "dim-label");
    }
  }

  return { widget: tree(nodes, 1), controls,
    setActive: active => { for (const view of maps) view.setActive(active); for (const view of galleries) view.setActive(active); if (!active) for (const player of media) player.pause(); },
    close: () => { for (const player of media) player.release(); for (const view of maps) view.release(); for (const view of galleries) view.release(); } };
}
