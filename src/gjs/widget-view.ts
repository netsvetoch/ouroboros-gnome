import { ComponentMap } from "./component-map.js";
import { ComponentGallery } from "./component-gallery.js";
import { ComponentKanban } from "./component-kanban.js";
import { mountComponents } from "./card-components.js";
import { componentGroup } from "./component-layout.js";
import { type Gateway, type GatewayFrame } from "./gateway.js";
import { Gtk } from "./gi.js";
import { type SettingsDocument, object } from "./settings-write.js";
import { button, clear, column, label, row } from "./ui.js";
import { type WidgetTab, widgetPath, widgetRows, widgetText } from "./widget-contract.js";
import { WidgetMedia } from "./widget-media.js";
import { WidgetSession, type WidgetValue } from "./widget-session.js";
import { WidgetLaunch, type WidgetLaunchOptions } from "./widget-launch.js";

export class WidgetView {
  readonly widget = column(6);
  private readonly session: WidgetSession;
  private readonly media = new Set<WidgetMedia>();
  private readonly maps = new Set<ComponentMap>();
  private readonly galleries = new Set<ComponentGallery>();
  private readonly components = new Set<ReturnType<typeof mountComponents>>();
  private active = false;
  private readonly framed?: WidgetLaunch;
  private remaining = 256;

  constructor(private readonly gateway: Gateway, private readonly tab: WidgetTab, private readonly input: SettingsDocument = {},
    options: WidgetLaunchOptions = {}) {
    this.session = new WidgetSession(gateway, tab);
    if (tab.render.kind === "declarative") {
      this.widget.append(this.tree(tab.render.components, "components", "", false, 1));
    } else if (tab.render.kind === "module" || tab.render.kind === "iframe") {
      this.framed = new WidgetLaunch(gateway, tab, options);
      this.widget.append(this.framed.widget);
    } else this.widget.append(label("Неизвестный формат виджета.", "dim-label"));
  }

  setActive(active: boolean): void {
    this.active = active;
    for (const view of this.maps) view.setActive(active);
    for (const view of this.galleries) view.setActive(active);
    for (const component of this.components) component.setActive(active);
    this.session.setActive(active);
    this.framed?.setActive(active);
    if (!active) for (const media of this.media) media.pause();
  }

  close(): void {
    this.session.close();
    this.framed?.close();
    for (const media of this.media) media.release();
    this.media.clear();
    for (const view of this.maps) view.release();
    this.maps.clear();
    for (const view of this.galleries) view.release();
    this.galleries.clear();
    for (const component of this.components) component.close();
    this.components.clear();
  }

  updateTab(tab: WidgetTab): void { this.framed?.update(tab); }
  setLaunchMode(mode: unknown): void { this.framed?.setMode(mode); }

  frame(frame: GatewayFrame): void {
    this.session.frame(frame);
    this.framed?.frame(frame);
  }

  private tree(nodes: unknown, path: string, inherited: string, passive: boolean, depth: number, layout?: unknown, columns?: unknown): any {
    const container = componentGroup(layout, columns);
    if (depth > 8) return container;
    for (const [index, spec] of widgetRows(nodes).entries()) {
      if (--this.remaining < 0) break;
      const position = `${path}.${index}`;
      const key = typeof spec.id === "string" && spec.id.trim() ? `id:${spec.id.trim()}` : `path:${position}`;
      const target = widgetText(spec.target) || inherited || "result";
      const wrapper = column(4);
      this.render(wrapper, spec, key, position, target, passive, depth);
      if (spec.condition_key) this.session.observe(target, ({ data }) =>
        wrapper.set_visible(Boolean(widgetPath(data, spec.condition_key))));
      container.append(wrapper);
    }
    return container;
  }

  private render(wrapper: any, spec: SettingsDocument, key: string, position: string, target: string, passive: boolean, depth: number): void {
    const title = widgetText(spec.title ?? spec.label);
    switch (spec.type) {
      case "group":
        if (title) wrapper.append(label(title, "title-4"));
        if (spec.description) wrapper.append(label(widgetText(spec.description)));
        wrapper.append(this.tree(spec.components, position + ".components", passive ? target : "", passive, depth + 1, spec.layout, spec.columns));
        return;
      case "tabs": {
        const stack = new Gtk.Stack({ hhomogeneous: false, vhomogeneous: false });
        wrapper.append(new Gtk.StackSwitcher({ stack }));
        wrapper.append(stack);
        for (const [index, tab] of widgetRows(spec.tabs).entries()) {
          const child = this.tree(tab.components, `${position}.tabs.${index}.components`, passive ? target : "", passive, depth + 1);
          stack.add_titled(child, String(index), widgetText(tab.label ?? tab.title, `Вкладка ${index + 1}`));
        }
        return;
      }
      case "subscription":
        if (passive) return;
        this.session.subscribe(widgetText(spec.event || spec.message_type), target, () => wrapper.get_mapped());
        wrapper.append(this.tree(spec.render, position + ".render", target, true, depth + 1));
        return;
      case "stream": {
        if (passive) return;
        this.showStatus(wrapper, target, spec, title);
        const sync = this.session.stream(target, spec, () => wrapper.get_mapped());
        wrapper.connect("map", sync);
        wrapper.connect("unmap", sync);
        return;
      }
      case "action":
      case "form": {
        if (passive) return;
        const fields = widgetRows(spec.fields).map((field) => typeof field.name === "string" && field.type !== "password" && Object.hasOwn(this.input, field.name)
          ? { ...field, default: this.input[field.name] } : field);
        const status = label("", "dim-label");
        const mounted = mountComponents([{ ...spec, fields, condition_key: undefined, submit: { id: "widget" } }], {}, (control, values) => {
          void this.session.action(key, target, spec, values ?? object(spec.body), (value) => {
            control.widget.set_sensitive(!control.disabled && value.status !== "loading");
            status.set_label(value.message);
          });
        }, {});
        mounted.setActive(this.active);
        this.components.add(mounted);
        wrapper.append(mounted.widget);
        wrapper.append(status);
        return;
      }
      case "poll": {
        if (passive) return;
        const activate = () => this.session.poll(key, target, spec, ({ status }) => trigger.set_sensitive(status !== "loading"));
        const trigger = button(title || "Опросить шлюз", activate);
        wrapper.append(trigger);
        let started = false;
        const auto = () => {
          if (!started && spec.auto_start === true && wrapper.get_mapped()) { started = true; activate(); }
        };
        let enabled = false;
        this.session.onActivity((active) => { enabled = active; if (enabled) auto(); });
        wrapper.connect("map", () => { if (enabled) auto(); });
        return;
      }
      case "status":
        this.showStatus(wrapper, target, spec, title);
        return;
      case "progress":
        this.session.addProgressKey(widgetText(spec.path || spec.value_key));
        break;
      case "kanban":
        if (!passive && object(spec.on_move).route) {
          this.kanban(wrapper, spec, key, target);
          return;
        }
        break;
      case "map": {
        const view = new ComponentMap(spec.markers, spec.tiles_url, title || "Карта");
        this.maps.add(view); view.setActive(this.active); wrapper.append(view.widget);
        return;
      }
      case "image":
      case "audio":
      case "video":
      case "file": {
        const media = new WidgetMedia(this.gateway, this.tab.skill, spec);
        this.media.add(media);
        wrapper.append(media.widget);
        this.session.observe(target, ({ data }) => media.setData(data));
        return;
      }
      case "gallery": {
        const gallery = new ComponentGallery(this.gateway, this.tab.skill, spec);
        gallery.setActive(this.active); this.galleries.add(gallery); wrapper.append(gallery.widget);
        this.session.observe(target, ({ data }) => gallery.setData(data));
        return;
      }
    }
    let initialized = false;
    let previous: unknown;
    let mounted: ReturnType<typeof mountComponents> | undefined;
    this.session.observe(target, ({ data }) => {
      if (initialized && data === previous) return;
      initialized = true;
      previous = data;
      if (mounted) { mounted.close(); this.components.delete(mounted); }
      clear(wrapper);
      const display = { ...spec, target: "result", condition_key: undefined };
      mounted = mountComponents([display], data, () => {}, { base: this.gateway.base });
      mounted.setActive(this.active); this.components.add(mounted); wrapper.append(mounted.widget);
    });
  }

  private showStatus(wrapper: any, target: string, spec: SettingsDocument, title: string): void {
    const status = label("", "dim-label");
    wrapper.append(status);
    const defaultLabels = { idle: "Готово", loading: "Загрузка…", refreshing: "Обновление…", success: "Готово", error: "Ошибка" };
    this.session.observe(target, (value) => {
      status.set_label(widgetText(spec[value.status] ?? (value.status === "refreshing" ? spec.loading : undefined))
        || value.message || title || defaultLabels[value.status]);
    });
  }

  private kanban(wrapper: any, spec: SettingsDocument, key: string, target: string): void {
    const feedback = label("", "dim-label");
    const board = new ComponentKanban(spec.columns, [], (card, destination) => {
      const route = object(spec.on_move);
      void this.session.action(key, target, { ...route, method: route.method || "POST" },
        { card_id: card.id, column_id: destination }, (value: WidgetValue) => {
          feedback.set_label(value.message);
          board.setBusy(value.status === "loading");
        });
    });
    wrapper.append(board.widget); wrapper.append(feedback);
    let previous: unknown;
    let initialized = false;
    this.session.observe(target, ({ data }) => {
      const cards = spec.cards ?? widgetPath(data, spec.path);
      if (initialized && cards === previous) return;
      initialized = true; previous = cards;
      board.setCards(cards);
    });
  }
}
