import { Gio, Gtk } from "./gi.js";
import { type Gateway, query } from "./gateway.js";
import { button, clear, column, errorText, label, row, sheet } from "./ui.js";

interface DirectoryList {
  path: string;
  parent: string;
  dirs: { name: string; path: string; is_git?: boolean }[];
  truncated?: boolean;
}

function readDirectories(value: any): DirectoryList {
  const object = (v: any) => Boolean(v && typeof v === "object" && !Array.isArray(v));
  if (!object(value) || typeof value.path !== "string" || !value.path || typeof value.parent !== "string"
    || (value.truncated !== undefined && typeof value.truncated !== "boolean") || !Array.isArray(value.dirs)
    || value.dirs.some((dir: any) => !object(dir) || typeof dir.name !== "string" || !dir.name
      || typeof dir.path !== "string" || !dir.path || (dir.is_git !== undefined && typeof dir.is_git !== "boolean"))) {
    throw new Error("Шлюз вернул неполный список папок.");
  }
  return value;
}

export function directoryPicker(gateway: Gateway, initial: string, select: (directory: string) => void, owner?: any): any {
  const content = column();
  const dialog = sheet("Папка на шлюзе", content);
  const current = label("", "heading");
  current.set_selectable(true);
  const address = new Gtk.Entry({ text: initial, hexpand: true, placeholder_text: "Абсолютный путь на шлюзе" });
  const status = label("", "dim-label");
  const list = column(4);
  let listing: DirectoryList | undefined;
  let generation = 0, loading = false, fresh = false, closed = false, applying = false;
  let cancel: any;
  let ownerClosed: number | undefined;
  const sync = () => {
    list.set_sensitive(!closed && !loading && fresh);
    choose.set_sensitive(!closed && !loading && fresh);
    up.set_sensitive(!closed && !loading && Boolean(listing?.parent));
    reload.set_sensitive(!closed && !loading);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    cancel?.cancel();
    if (ownerClosed !== undefined) { owner.disconnect(ownerClosed); ownerClosed = undefined; }
    sync();
  };
  dialog.connect("closed", close);
  if (owner) ownerClosed = owner.connect("closed", () => {
    close();
    if (dialog.get_mapped()) dialog.force_close();
  });
  const load = async (path?: string) => {
    if (closed) return;
    const request = ++generation;
    cancel?.cancel();
    const pending = new Gio.Cancellable();
    cancel = pending;
    loading = true;
    fresh = false;
    status.set_label("Читаю папки…");
    sync();
    try {
      const result = readDirectories(await gateway.json<unknown>("GET", "/api/fs/dirs" + query({ path }), undefined, undefined, false, pending));
      if (closed || request !== generation) return;
      listing = result;
      fresh = true;
      current.set_label(result.path);
      applying = true;
      address.set_text(result.path);
      applying = false;
      clear(list);
      for (const dir of result.dirs) {
        const item = button(dir.is_git ? `${dir.name} · Git` : dir.name, () => {
          if (listing === result && fresh && !loading) void load(dir.path);
        });
        item.set_halign(Gtk.Align.FILL);
        list.append(item);
      }
      status.set_label(result.truncated ? "Шлюз показал только первые 500 папок. Другой путь можно ввести выше."
        : result.dirs.length ? "" : "Вложенных папок нет.");
    } catch (error) {
      if (!closed && request === generation) status.set_label([errorText(error), listing
        ? "Показан последний прочитанный список. Перечитайте папку перед выбором." : ""].filter(Boolean).join("\n"));
    } finally {
      if (cancel === pending) cancel = undefined;
      if (!closed && request === generation) { loading = false; sync(); }
    }
  };
  address.connect("activate", () => void load(address.get_text().trim() || undefined));
  address.connect("changed", () => {
    if (closed || applying) return;
    ++generation;
    cancel?.cancel();
    cancel = undefined;
    loading = fresh = false;
    status.set_label("Нажмите Enter или «Перечитать», чтобы открыть указанный путь.");
    sync();
  });
  const navigation = row();
  const up = button("Вверх", () => { if (!loading && listing?.parent) void load(listing.parent); });
  const reload = button("Перечитать", () => void load(address.get_text().trim() || undefined));
  const choose = button("Выбрать эту папку", () => {
    if (!listing || closed || loading || !fresh) return;
    close();
    select(listing.path);
    dialog.close();
  });
  choose.add_css_class("suggested-action");
  navigation.append(button("Домашняя папка", () => void load()));
  for (const item of [up, reload, choose]) navigation.append(item);
  for (const widget of [current, address, navigation, status, list]) content.append(widget);
  void load(initial || undefined);
  return dialog;
}
