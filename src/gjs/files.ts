import { Gdk, Gio, GLib, Gtk } from "./gi.js";
import { type Gateway, HttpError, multipartFilename, query, UploadReceiptError, uploadProgressText } from "./gateway.js";
import { pdfPreview } from "./pdf-preview.js";
import { actionRow, alert, button, chooseFile, clear, column, confirm, errorText, label, row, sheet } from "./ui.js";

interface FileEntry {
  name: string;
  path: string;
  type: "dir" | "file";
  size?: number | null;
  is_symlink?: boolean;
}

interface Listing {
  root_path?: string;
  path: string;
  display_path: string;
  parent_path?: string | null;
  breadcrumb?: { path: string; name: string }[];
  entries: FileEntry[];
  truncated?: boolean;
}

interface FileInfo {
  root_path?: string;
  path: string;
  display_path: string;
  name: string;
  size: number;
  content: string;
  is_text: boolean;
  is_image: boolean;
  is_pdf: boolean;
  truncated: boolean;
  lossless?: boolean;
}

interface Change {
  ok: boolean;
  path: string;
  name?: string;
  size?: number;
}

type Transfer = { entry: FileEntry; mode: "copy" | "move"; root?: string };
interface TransferResult {
  transfer: Transfer;
  directory: string;
  root?: string;
  path: string;
  state: "pending" | "confirmed" | "conflict" | "refused" | "unknown";
  message: string;
  observation?: string;
}

const api = "/api/files/";
const maxUpload = 100 * 1024 * 1024;
const maxImage = 20 * 1024 * 1024;

function record(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readListing(value: unknown): Listing {
  if (!record(value) || (value.root_path !== undefined && (typeof value.root_path !== "string" || !value.root_path))
    || typeof value.path !== "string" || !value.path || typeof value.display_path !== "string"
    || (value.parent_path != null && typeof value.parent_path !== "string")
    || (value.truncated !== undefined && typeof value.truncated !== "boolean")
    || !Array.isArray(value.entries) || value.entries.some(entry => !record(entry)
      || typeof entry.name !== "string" || !entry.name || typeof entry.path !== "string" || !entry.path
      || !["dir", "file"].includes(entry.type) || (entry.is_symlink !== undefined && typeof entry.is_symlink !== "boolean")
      || (entry.size != null && (!Number.isSafeInteger(entry.size) || entry.size < 0)))
    || (value.breadcrumb !== undefined && (!Array.isArray(value.breadcrumb) || value.breadcrumb.some(crumb =>
      !record(crumb) || typeof crumb.path !== "string" || !crumb.path || typeof crumb.name !== "string")))) {
    throw new Error("Шлюз вернул неполное содержимое папки.");
  }
  return value as unknown as Listing;
}

function readInfo(value: unknown): FileInfo {
  if (!record(value) || (value.root_path !== undefined && (typeof value.root_path !== "string" || !value.root_path))
    || [value.path, value.display_path, value.name, value.content].some(v => typeof v !== "string")
    || !value.path || !Number.isSafeInteger(value.size) || value.size < 0
    || [value.is_text, value.is_image, value.is_pdf, value.truncated].some(v => typeof v !== "boolean")) {
    throw new Error("Шлюз вернул неполные сведения о файле.");
  }
  return value as unknown as FileInfo;
}

function validRelative(path: string): boolean {
  return !path.startsWith("/") && !/[\\\x00-\x1f\x7f]/.test(path) && !path.split("/").includes("..");
}

function writablePath(path: string): string {
  if (!path || !validRelative(path) || path !== path.trim()) {
    throw new Error("Шлюз не может однозначно изменить этот путь.");
  }
  return path;
}

function nameInput(name: string): string {
  const value = name.trim();
  if (!value || value === "." || value === ".." || value.includes("/") || !validRelative(value)) {
    throw new Error("Введите имя без разделителей пути.");
  }
  return value;
}

async function readFile(gateway: Gateway, path: string, cancel?: any, root?: string, expectedPath?: string): Promise<FileInfo> {
  const info = readInfo(await gateway.json<unknown>("GET", api + "read" + query({ path }), undefined, undefined, false, cancel));
  // A symlink read returns its resolved target, not the requested lexical path.
  if (expectedPath !== undefined && info.path !== expectedPath) throw new Error("Шлюз вернул сведения о файле по другому пути.");
  if (root !== undefined && info.root_path !== root) throw new Error("Корень файлов на шлюзе изменился или не подтверждён. Перечитайте папку и откройте файл заново.");
  // The preview replaces invalid UTF-8. A literal U+FFFD is also valid text;
  // compare the complete bytes before allowing that preview to be written back.
  info.lossless = false;
  if (info.is_text && !info.truncated && typeof info.content === "string" && info.content.includes("�")
    && !info.content.includes("\0")) {
    const expected = new TextEncoder().encode(info.content);
    if (expected.length <= 1024 * 1024) {
      try {
        const bytes = await gateway.previewBytes(api + "content" + query({ path }), expected.length + 1, cancel ?? null);
        info.lossless = bytes.length === expected.length && bytes.every((byte, index) => byte === expected[index]);
      } catch (error) {
        if (cancel?.is_cancelled()) throw error;
        // An unavailable byte read leaves the preview readable, never editable.
      }
    }
  }
  return info;
}

function postChange(gateway: Gateway, route: string, body: object): Promise<Change> {
  return gateway.json<Change>("POST", api + route, body).then(requireChange);
}

function requireChange<T extends Change>(result: T): T {
  if (result?.ok !== true || typeof result.path !== "string" || !result.path) throw new Error("Шлюз не подтвердил изменение.");
  return result;
}

function launchFile(parent: any, file: any): Promise<void> {
  const launcher = Gtk.FileLauncher.new(file);
  return new Promise((resolve, reject) => {
    launcher.launch(parent, null, (_launcher: unknown, result: unknown) => {
      try { launcher.launch_finish(result); resolve(); } catch (error) { reject(error); }
    });
  });
}

export class FilesPage {
  readonly widget = column();
  private readonly path = new Gtk.Entry({ hexpand: true, placeholder_text: "Путь относительно корня" });
  private readonly breadcrumbs = row(4);
  private readonly status = label("", "dim-label");
  private readonly transferStatus = label("", "dim-label");
  private readonly transferOutcome = label("");
  private readonly transferBar = column(4);
  private readonly checkTransfer = button("Проверить обе папки", () => void this.verifyTransfer());
  private readonly clearTransfer = button("Отменить перенос", () => {
    this.transfer = this.transferResult = undefined;
    this.sync();
  });
  private readonly uploadBar = row();
  private readonly uploadStatus = label("", "dim-label");
  private readonly cancelUpload = button("Отменить загрузку", () => {
    this.fileUpload?.cancel.cancel();
    this.cancelUpload.set_sensitive(false);
    this.uploadStatus.set_label("Отменяю загрузку…");
  });
  private readonly list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.SINGLE, activate_on_single_click: false });
  private readonly entries = new Map<any, FileEntry>();
  private readonly up = button("Вверх", () => void this.navigate(this.listing?.parent_path ?? "."));
  private readonly newFolder = button("Новая папка", () => this.create("dir"));
  private readonly newFile = button("Новый файл", () => this.create("file"));
  private readonly upload = button("Загрузить", () => void this.uploadFile());
  private readonly paste = button("Вставить сюда", () => void this.pasteEntry());
  private readonly menu = new Gtk.MenuButton({ label: "Действия" });
  private readonly open = button("Открыть", () => this.openSelected());
  private readonly download = button("Скачать", () => {
    const entry = this.selected();
    if (entry?.type === "file") void this.save(entry, "download");
  });
  private readonly dialogs = new Set<any>();
  private readonly previews = new Set<FilePreview>();
  private listing?: Listing;
  private transfer?: Transfer;
  private transferResult?: TransferResult;
  private checkingTransfer?: TransferResult;
  private navigation = 0;
  private requestedPath = ".";
  private loading = false;
  private mutating = false;
  private disposed = false;
  private readonly lifetime = new Gio.Cancellable();
  private listingCancel?: any;
  private downloading = false;
  private fileUpload?: { cancel: any; name?: string };

  constructor(private readonly parent: any, private readonly gateway: Gateway) {
    this.path.set_text(".");
    this.path.connect("activate", () => void this.navigate(this.path.get_text()));
    const navigation = row();
    navigation.append(button("Корень", () => void this.navigate(".")));
    navigation.append(this.up);
    navigation.append(this.path);
    const tools = row();
    for (const widget of [this.newFolder, this.newFile, this.upload, this.open, this.menu]) tools.append(widget);
    const actions = column(4);
    const popover = new Gtk.Popover({ child: actions });
    const menuAction = (title: string, action: () => void) => button(title, () => { popover.popdown(); action(); });
    this.download.connect("clicked", () => popover.popdown());
    actions.append(this.download);
    actions.append(menuAction("Копировать…", () => this.queueTransfer("copy")));
    actions.append(menuAction("Переместить…", () => this.queueTransfer("move")));
    actions.append(menuAction("Удалить…", () => void this.remove()));
    this.menu.set_popover(popover);
    const transferActions = row();
    for (const widget of [this.paste, this.checkTransfer, this.clearTransfer]) transferActions.append(widget);
    this.transferOutcome.set_selectable(true);
    this.transferBar.append(this.transferStatus);
    this.transferBar.append(this.transferOutcome);
    this.transferBar.append(transferActions);
    this.uploadBar.append(this.uploadStatus);
    this.uploadBar.append(this.cancelUpload);
    for (const widget of [navigation, this.breadcrumbs, tools, this.transferBar, this.uploadBar, this.status]) this.widget.append(widget);
    this.list.add_css_class("boxed-list");
    this.widget.append(new Gtk.ScrolledWindow({ child: this.list, vexpand: true, hscrollbar_policy: Gtk.PolicyType.NEVER }));
    this.list.connect("row-selected", () => this.sync());
    this.list.connect("row-activated", (_list: unknown, item: any) => this.openEntry(this.entries.get(item)));
    this.sync();
  }

  close(): void {
    this.disposed = true;
    this.lifetime.cancel();
    this.listingCancel?.cancel();
    this.fileUpload?.cancel.cancel();
    for (const preview of this.previews) preview.close();
    for (const dialog of this.dialogs) if (dialog.get_mapped()) dialog.force_close();
    this.previews.clear();
    this.dialogs.clear();
    this.sync();
  }

  refresh(): Promise<boolean> {
    return this.navigate(this.listing?.path ?? ".", this.selected()?.path);
  }

  async navigate(path: string, selected?: string): Promise<boolean> {
    if (this.disposed) return false;
    if (!validRelative(path)) {
      this.status.set_label("Укажите путь внутри корня. Переход через «..» недоступен.");
      return false;
    }
    const request = ++this.navigation;
    this.listingCancel?.cancel();
    const cancel = new Gio.Cancellable();
    this.listingCancel = cancel;
    this.requestedPath = path || ".";
    this.loading = true;
    this.status.set_label("Читаю содержимое папки…");
    this.sync();
    try {
      const listing = readListing(await this.gateway.json<unknown>("GET", api + "list" + query({ path: this.requestedPath }), undefined, undefined, false, cancel));
      if (this.disposed || request !== this.navigation) return false;
      this.listing = listing;
      this.render(selected);
      this.status.set_label(listing.truncated ? `Показано ${listing.entries.length} элементов. Список неполный.`
        : listing.entries.length ? `Элементов: ${listing.entries.length}` : "Папка пуста.");
      return true;
    } catch (error) {
      if (!this.disposed && request === this.navigation) {
        this.path.set_text(this.listing?.path ?? ".");
        const message = errorText(error);
        this.status.set_label(error instanceof HttpError && error.status === 400 && message.includes("OUROBOROS_FILE_BROWSER_DEFAULT")
          ? "Файловый браузер недоступен. На шлюзе требуется настроить OUROBOROS_FILE_BROWSER_DEFAULT."
          : [message, this.listing ? "Показано последнее прочитанное содержимое папки." : ""].filter(Boolean).join("\n"));
      }
      return false;
    } finally {
      if (this.listingCancel === cancel) this.listingCancel = undefined;
      if (!this.disposed && request === this.navigation) {
        this.loading = false;
        this.sync();
      }
    }
  }

  private render(selected?: string): void {
    const listing = this.listing!;
    this.path.set_text(listing.path);
    this.path.set_tooltip_text(listing.display_path);
    clear(this.breadcrumbs);
    // The path field remains available for deeper ancestors on narrow windows.
    for (const crumb of listing.breadcrumb?.slice(-4) ?? []) {
      const widget = button(crumb.path === "." ? "Корень" : crumb.name, () => void this.navigate(crumb.path));
      widget.set_tooltip_text(crumb.name);
      widget.set_sensitive(crumb.path !== listing.path);
      this.breadcrumbs.append(widget);
    }
    clear(this.list);
    this.entries.clear();
    for (const entry of listing.entries) {
      const details = [
        entry.type === "dir" ? "Папка" : entry.size == null ? "Файл" : GLib.format_size(entry.size),
        entry.is_symlink ? "Символьная ссылка" : "",
      ].filter(Boolean).join(" · ");
      const item = actionRow({
        title: entry.name, subtitle: details, use_markup: false, activatable: true, title_lines: 1,
      });
      item.add_prefix(new Gtk.Image({ icon_name: entry.type === "dir" ? "folder-symbolic" : "text-x-generic-symbolic" }));
      this.entries.set(item, entry);
      this.list.append(item);
      if (entry.path === selected) this.list.select_row(item);
    }
  }

  private sync(): void {
    const ready = Boolean(!this.disposed && this.listing && !this.loading && !this.mutating);
    const entry = this.selected();
    for (const action of [this.newFolder, this.newFile, this.upload]) action.set_sensitive(ready);
    this.upload.set_sensitive(ready && !this.fileUpload);
    this.uploadBar.set_visible(Boolean(this.fileUpload?.name));
    this.list.set_sensitive(ready);
    this.up.set_sensitive(!this.disposed && Boolean(this.listing && this.listing.path !== "."));
    this.menu.set_sensitive(ready && Boolean(entry));
    this.open.set_sensitive(ready && Boolean(entry));
    this.download.set_sensitive(ready && !this.downloading && entry?.type === "file");
    const transfer = this.transfer;
    const result = this.transferResult;
    const unknown = result?.state === "unknown";
    this.transferBar.set_visible(Boolean(transfer || result));
    this.transferStatus.set_visible(Boolean(transfer) && !unknown && result?.state !== "pending");
    this.transferOutcome.set_visible(Boolean(result));
    this.transferOutcome.set_label(result ? [result.message, result.observation].filter(Boolean).join("\n") : "");
    this.paste.set_visible(Boolean(transfer) && !unknown);
    this.checkTransfer.set_visible(unknown);
    this.checkTransfer.set_sensitive(!this.disposed && Boolean(unknown) && this.checkingTransfer !== result && !this.mutating);
    this.clearTransfer.set_label(result && (!transfer || unknown) ? "Закрыть результат" : "Отменить перенос");
    this.clearTransfer.set_sensitive(!this.disposed && !this.mutating);
    if (transfer) {
      const label = transfer.mode === "copy" ? "Копировать" : "Переместить";
      this.transferStatus.set_label(`${label} «${transfer.entry.name}». Откройте папку назначения.`);
    }
    this.paste.set_sensitive(ready && Boolean(transfer) && !unknown);
  }

  private selected(): FileEntry | undefined {
    return this.entries.get(this.list.get_selected_row());
  }

  private openSelected(): void {
    this.openEntry(this.selected());
  }

  private openEntry(entry?: FileEntry): void {
    if (!entry || this.loading || this.mutating || this.disposed) return;
    if (entry.type === "dir") {
      void this.navigate(entry.path);
      return;
    }
    this.openPreview(entry);
  }

  private openPreview(entry: FileEntry, creating = false, context = { root: this.listing?.root_path }): void {
    if (this.disposed) return;
    const root = context.root;
    const preview = new FilePreview(this.parent, this.gateway, entry, (saved) => {
      if (saved) void this.refresh();
    }, (route, filename, launch) => this.save({ ...entry, name: filename }, route, launch, { root }), creating, root);
    this.previews.add(preview);
    preview.dialog.connect("closed", () => this.previews.delete(preview));
    this.present(preview.dialog);
    void preview.load();
  }

  private present(dialog: any): void {
    this.dialogs.add(dialog);
    dialog.connect("closed", () => this.dialogs.delete(dialog));
    dialog.present(this.parent);
  }

  private create(kind: FileEntry["type"]): void {
    const directory = this.listing?.path;
    const root = this.listing?.root_path;
    if (directory === undefined || this.disposed) return;
    const content = column();
    const title = kind === "dir" ? "Новая папка" : "Новый текстовый файл";
    const dialog = sheet(title, content);
    const name = new Gtk.Entry({ placeholder_text: "Имя" });
    const status = label("", "error");
    const submit = button(kind === "file" ? "Открыть редактор" : "Создать", () => {
      if (this.mutating || this.disposed || !this.dialogs.has(dialog)) return;
      let value: string;
      try {
        value = nameInput(name.get_text());
        writablePath(directory);
      } catch (error) {
        status.set_label(errorText(error));
        return;
      }
      if (kind === "file") {
        if (dialog.close()) this.openPreview({ name: value, path: directory === "." ? value : `${directory}/${value}`, type: "file" }, true, { root });
        return;
      }
      submit.set_sensitive(false);
      void this.mutate(() => this.rootedChange(root, directory, "mkdir", { path: directory, name: value }), "Папка создана.")
        .then((result) => {
          if (this.disposed || !this.dialogs.has(dialog)) return;
          if (result) dialog.close();
          else {
            status.set_label(this.status.get_label());
            submit.set_sensitive(true);
          }
        });
    });
    submit.add_css_class("suggested-action");
    content.append(label(directory, "dim-label"));
    content.append(name);
    content.append(status);
    content.append(submit);
    name.connect("activate", () => { if (submit.get_sensitive()) submit.emit("clicked"); });
    this.present(dialog);
  }

  private async uploadFile(): Promise<void> {
    const directory = this.listing?.path;
    const root = this.listing?.root_path;
    if (directory === undefined || this.disposed || this.mutating || this.fileUpload) return;
    const upload: NonNullable<FilesPage["fileUpload"]> = { cancel: new Gio.Cancellable() };
    this.fileUpload = upload;
    this.sync();
    try {
      const file = await chooseFile(this.parent, undefined, upload.cancel);
      if (!file || this.disposed) return;
      upload.name = file.get_basename() || "Файл";
      // The Files handler strips Python Unicode whitespace from the multipart filename.
      // This differs from JavaScript trim for U+0085 and U+FEFF.
      const name = multipartFilename(file.get_basename() || "file").replace(
        /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu, "");
      const destination = directory === "." ? name : `${directory}/${name}`;
      this.uploadStatus.set_label(`${upload.name} · ${directory}`);
      this.cancelUpload.set_sensitive(true);
      await this.mutate(async () => {
        await this.requireRoot(root, directory, upload.cancel);
        if (this.disposed || upload.cancel.is_cancelled()) throw new Error("Загрузка отменена до отправки.");
        return this.gateway.upload<Change>(api + "upload", file, {
          path: writablePath(directory),
        }, maxUpload, { cancel: upload.cancel, verifyReceipt: (receipt, sent) => {
          if (receipt?.ok !== true || receipt.path !== destination || receipt.name !== name
            || !Number.isSafeInteger(receipt.size) || receipt.size !== sent.size) {
            throw new UploadReceiptError("Шлюз не подтвердил имя, папку и точный размер файла. Обновите папку перед повторной загрузкой.");
          }
        }, progress: (progress) => {
          if (!this.disposed && !upload.cancel.is_cancelled()) {
            this.uploadStatus.set_label([upload.name, directory, uploadProgressText(progress)].join(" · "));
          }
        } }).then(requireChange).finally(() => { if (!this.disposed) this.cancelUpload.set_sensitive(false); });
      }, "Файл загружен.");
    } catch (error) {
      if (!this.disposed) this.status.set_label(errorText(error));
    } finally {
      this.fileUpload = undefined;
      if (!this.disposed) this.sync();
    }
  }

  private async save(entry: FileEntry, route: "download" | "content", launch = false, context = { root: this.listing?.root_path }): Promise<void> {
    if (this.disposed || this.downloading) return;
    this.downloading = true;
    this.sync();
    try {
      const filename = entry.name.split(/[\\/]/).pop() || "download";
      const file = await chooseFile(this.parent, filename, this.lifetime);
      if (!file || this.disposed) return;
      const directory = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : ".";
      await this.requireRoot(context.root, directory);
      if (this.disposed) return;
      this.status.set_label("Скачиваю файл…");
      await this.gateway.download(api + route + query({ path: entry.path }), file, true, this.lifetime);
      if (this.disposed) return;
      this.status.set_label("Файл сохранён.");
      if (launch) await launchFile(this.parent, file);
    } catch (error) {
      if (!this.disposed) alert(this.parent, "Ошибка скачивания", errorText(error));
    } finally {
      this.downloading = false;
      if (!this.disposed) this.sync();
    }
  }

  private queueTransfer(mode: Transfer["mode"]): void {
    if (this.disposed) return;
    const entry = this.selected();
    if (!entry || this.transferResult?.state === "unknown") return;
    this.transfer = { entry, mode, root: this.listing?.root_path };
    this.transferResult = undefined;
    this.sync();
  }

  private async pasteEntry(): Promise<void> {
    const transfer = this.transfer;
    const destination = this.listing?.path;
    const root = this.listing?.root_path;
    if (this.disposed || !transfer || destination === undefined || this.loading || this.mutating || this.transferResult?.state === "unknown") return;
    let source: string;
    try {
      source = writablePath(transfer.entry.path);
      writablePath(destination);
    } catch (error) {
      this.status.set_label(errorText(error));
      return;
    }
    const path = destination === "." ? transfer.entry.name : `${destination}/${transfer.entry.name}`;
    const success = transfer.mode === "copy" ? "Элемент скопирован." : "Элемент перемещён.";
    this.transferResult = { transfer, directory: destination, root, path, state: "pending", message: `Шлюз обрабатывает запрос · ${source} → ${path}` };
    await this.mutate(async () => {
      let sent = false;
      try {
        if (transfer.root !== root) throw new Error("Источник и папка назначения не имеют одного подтверждённого корня. Выберите источник заново.");
        await this.requireRoot(root, destination);
        if (this.disposed) throw new Error("Операция закрыта.");
        sent = true;
        const reply = requireChange(await this.gateway.json<Change & { mode?: string }>("POST", api + "transfer", {
          mode: transfer.mode, source_path: source, destination_dir: destination,
        }));
        if (reply.path !== path || reply.mode !== transfer.mode) {
          throw new Error("Шлюз вернул квитанцию с другим путём или действием.");
        }
        if (!this.disposed) {
          this.transfer = undefined;
          this.transferResult = { transfer, directory: destination, root, path, state: "confirmed", message: `${success} ${path}` };
        }
        return reply;
      } catch (error) {
        if (!this.disposed) {
          const conflict = sent && error instanceof HttpError && error.status === 409;
          const refused = !sent || error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 408;
          const state = conflict ? "conflict" : refused ? "refused" : "unknown";
          const message = conflict ? `В папке назначения уже есть «${transfer.entry.name}» · ${path}.`
            : refused ? errorText(error) : `Итог переноса неизвестен · ${source} → ${path}.\n${errorText(error)}`;
          this.transferResult = { transfer, directory: destination, root, path, state, message };
        }
        throw error;
      }
    });
    if (!this.disposed) this.sync();
  }

  private async verifyTransfer(): Promise<void> {
    const result = this.transferResult;
    if (!result || result.state !== "unknown" || this.checkingTransfer === result || this.disposed) return;
    this.checkingTransfer = result;
    result.observation = "Читаю обе папки…";
    this.sync();
    const source = result.transfer.entry.path;
    const index = source.lastIndexOf("/");
    const sourceDirectory = index < 0 ? "." : source.slice(0, index);
    const inspect = async (directory: string, path: string) => {
      try {
        const listing = readListing(await this.gateway.json<unknown>("GET", api + "list" + query({ path: directory }), undefined, undefined, false, this.lifetime));
        if (listing.root_path !== result.root) return "корень файлов изменился или не подтверждён";
        if (listing.path !== directory || !Array.isArray(listing.entries)) return "шлюз не подтвердил содержимое папки";
        if (listing.entries.some((entry) => entry.path === path)) return "элемент найден";
        return listing.truncated ? "список неполный, наличие неизвестно" : "элемент отсутствует в списке";
      } catch (error) {
        return errorText(error);
      }
    };
    const [from, to] = await Promise.all([inspect(sourceDirectory, source), inspect(result.directory, result.path)]);
    if (this.checkingTransfer === result) this.checkingTransfer = undefined;
    if (this.disposed || this.transferResult !== result) return;
    result.observation = `Исходный путь · ${from}\nНазначение · ${to}\nПоказано текущее состояние папок.`;
    this.sync();
  }

  private async remove(): Promise<void> {
    const entry = this.selected();
    const root = this.listing?.root_path;
    const directory = this.listing?.path;
    if (!entry || directory === undefined || this.disposed) return;
    const detail = entry.type === "dir" && !entry.is_symlink ? "Папка будет удалена со всем содержимым." : "Элемент будет удалён на шлюзе.";
    if (!await confirm(this.parent, `Удалить «${entry.name}»?`, detail, "Удалить", this.lifetime) || this.disposed) return;
    await this.mutate(() => this.rootedChange(root, directory, "delete", { path: writablePath(entry.path) }), "Элемент удалён.");
  }

  private async requireRoot(root: string | undefined, directory: string, cancel = this.lifetime): Promise<void> {
    if (this.disposed) throw new Error("Операция закрыта.");
    if (root === undefined) return; // Older gateways did not declare the browser root.
    const listing = readListing(await this.gateway.json("GET", api + "list" + query({ path: directory }), undefined, undefined, false, cancel));
    if (listing.root_path !== root || listing.path !== directory) {
      throw new Error("Корень файлов или папка на шлюзе изменились либо не подтверждены. Перечитайте папку перед действием.");
    }
  }

  private async rootedChange(root: string | undefined, directory: string, route: string, body: object): Promise<Change> {
    await this.requireRoot(root, directory);
    if (this.disposed) throw new Error("Операция закрыта.");
    return postChange(this.gateway, route, body);
  }

  private async mutate(operation: () => Promise<Change>, success?: string): Promise<Change | undefined> {
    if (this.disposed || this.mutating) return undefined;
    this.mutating = true;
    if (success) this.status.set_label("Выполняю операцию…");
    this.sync();
    try {
      const result = await operation();
      if (this.disposed) return undefined;
      const listed = await this.navigate(this.loading ? this.requestedPath : this.listing?.path ?? ".", result.path);
      if (!this.disposed && listed && success) this.status.set_label(this.listing?.truncated
        ? `${success} Список элементов неполный.` : success);
      return result;
    } catch (error) {
      if (!this.disposed && success) this.status.set_label(errorText(error));
      return undefined;
    } finally {
      this.mutating = false;
      if (!this.disposed) this.sync();
    }
  }
}

class FilePreview {
  readonly dialog: any;
  private readonly previewCancel = new Gio.Cancellable();
  private readonly content = column();
  private readonly description = label("", "dim-label");
  private readonly status = label("");
  private readonly body = column();
  private readonly comparison = column();
  private readonly edit = button("Редактировать", () => this.setEditing(true));
  private readonly save = button("Сохранить на шлюзе", () => void this.saveEdit());
  private readonly verify = button("Проверить содержимое на шлюзе", () => void this.verifyEdit());
  private readonly download: any;
  private readonly text = new Gtk.TextView({
    editable: false, monospace: true, wrap_mode: Gtk.WrapMode.WORD_CHAR,
    left_margin: 6, right_margin: 6, top_margin: 6, bottom_margin: 6,
  });
  private readonly buffer = this.text.get_buffer();
  private baseline?: FileInfo;
  private editing = false;
  private blocked = false;
  private busy = false;
  private disposed = false;

  constructor(
    private readonly parent: any,
    private readonly gateway: Gateway,
    private readonly entry: FileEntry,
    private readonly changed: (saved: boolean) => void,
    save: (route: "download" | "content", filename: string, launch?: boolean) => Promise<void>, private creating = false, private root?: string,
  ) {
    this.download = button("Скачать", () => { if (!this.disposed) void save("download", entry.name); });
    this.dialog = sheet(entry.name, this.content);
    this.dialog.set_content_width(760);
    this.dialog.set_content_height(600);
    const actions = row();
    for (const widget of [this.edit, this.save, this.verify, this.download]) actions.append(widget);
    for (const widget of [this.description, actions, this.status, this.comparison, this.body]) this.content.append(widget);
    this.save.add_css_class("suggested-action");
    this.dialog.connect("closed", () => this.close());
    this.dialog.connect("close-attempt", () => {
      if (this.busy) return;
      void confirm(this.parent, "Закрыть файл?", "Черновик из этого окна будет закрыт.", "Закрыть редактор")
        .then((allowed) => { if (allowed && !this.disposed) this.dialog.force_close(); });
    });
    this.buffer.connect("modified-changed", () => this.sync());
    this.openPdf = (filename) => { if (!this.disposed) void save("content", filename, true); };
    this.sync();
  }

  private readonly openPdf: (filename: string) => void;

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.previewCancel.cancel();
    this.sync();
    if (this.dialog.get_mapped()) this.dialog.force_close();
  }

  async load(): Promise<void> {
    if (this.disposed) return;
    if (this.creating) {
      this.description.set_label(this.entry.path);
      this.status.set_label("Файл будет создан при сохранении.");
      this.showEditor();
      this.setEditing(true);
      return;
    }
    this.status.set_label("Читаю сведения о файле…");
    try {
      const info = await readFile(this.gateway, this.entry.path, this.previewCancel, this.root);
      if (this.disposed) return;
      this.baseline = info;
      this.root = info.root_path;
      this.description.set_label(`${info.display_path} · ${GLib.format_size(info.size)}`);
      this.status.set_label("");
      if (info.is_text) {
        this.buffer.set_text(info.content.replaceAll("\0", "�"), -1);
        this.buffer.set_modified(false);
        this.showEditor();
        if (info.truncated) this.status.set_label("Показана только часть файла. Полный файл можно скачать.");
        else if (!this.canEdit()) this.status.set_label(info.content.includes("�") && !info.lossless
          ? "Не удалось подтвердить точный текст по исходным байтам. Файл доступен только для просмотра."
          : "Файл доступен только для просмотра.");
      } else if (info.is_image && info.size <= maxImage) {
        const bytes = await this.gateway.previewBytes(api + "content" + query({ path: this.entry.path }), maxImage, this.previewCancel);
        if (this.disposed) return;
        const image = Gdk.Texture.new_from_bytes(GLib.Bytes.new(bytes));
        const picture = new Gtk.Picture({ paintable: image, can_shrink: true, alternative_text: info.name });
        picture.set_size_request(-1, Math.min(420, image.get_height()));
        this.body.append(picture);
      } else if (info.is_pdf) {
        this.body.append(button("Сохранить PDF и открыть", () => this.openPdf(info.name)));
        this.body.append(pdfPreview(info.name, info.size, (limit) =>
          this.gateway.previewBytes(api + "content" + query({ path: this.entry.path }), limit, this.previewCancel), this.previewCancel));
      } else {
        this.status.set_label(info.is_image ? "Изображение слишком большое для предпросмотра." : "Для этого формата доступно скачивание.");
      }
    } catch (error) {
      if (!this.disposed) this.status.set_label(errorText(error));
    } finally {
      if (!this.disposed) this.sync();
    }
  }

  private canEdit(): boolean {
    return Boolean((this.creating || this.editable(this.baseline)) && validRelative(this.entry.path)
      && this.entry.path === this.entry.path.trim());
  }

  private editable(file?: FileInfo): file is FileInfo {
    return Boolean(file?.path && validRelative(file.path) && file.is_text && !file.truncated
      && typeof file.content === "string" && !file.content.includes("\0")
      && (!file.content.includes("�") || file.lossless === true));
  }

  private sameFile(file: FileInfo): boolean {
    return (this.root === undefined || file.root_path === this.root) && (this.creating || this.baseline?.path === file.path);
  }

  private showEditor(): void {
    const scroll = new Gtk.ScrolledWindow({ child: this.text, min_content_height: 340, vexpand: true });
    scroll.add_css_class("card");
    this.body.append(scroll);
  }

  private setEditing(editing: boolean): void {
    if (this.disposed) return;
    this.editing = editing;
    this.text.set_editable(editing);
    if (editing) this.text.grab_focus();
    this.sync();
  }

  private sync(): void {
    this.edit.set_visible(!this.disposed && !this.editing && this.canEdit());
    this.save.set_visible(this.editing);
    this.save.set_sensitive(!this.disposed && this.editing && !this.busy && !this.blocked && (this.creating || this.buffer.get_modified()));
    this.verify.set_visible(this.editing && this.blocked);
    this.verify.set_sensitive(!this.disposed && !this.busy);
    this.download.set_sensitive(!this.disposed);
    this.download.set_visible(!this.creating);
    this.comparison.set_sensitive(!this.busy);
    this.text.set_editable(!this.disposed && this.editing && !this.busy);
    this.dialog.set_can_close(!this.busy && !this.buffer.get_modified() && !this.blocked);
  }

  private async saveEdit(): Promise<void> {
    if (this.disposed || this.busy || this.blocked || !this.editing || !this.canEdit()) return;
    const content = this.draft();
    this.busy = true;
    let sent = false;
    this.sync();
    try {
      const current = await this.readCurrent();
      if (this.disposed) return;
      if (this.editable(current) && this.sameFile(current) && current.content === content) {
        this.acceptEdit(current, "На шлюзе уже находится текст из редактора.");
        return;
      }
      if (this.creating ? Boolean(current) : !this.editable(current) || !this.sameFile(current) || current.content !== this.baseline?.content) {
        this.conflict(current);
        return;
      }
      sent = true;
      const reply = await postChange(this.gateway, "write", { path: writablePath(this.entry.path), content, create: this.creating });
      if (this.disposed) return;
      if (reply.path !== this.entry.path) throw new Error("Шлюз подтвердил запись по другому пути.");
      const expectedSize = new TextEncoder().encode(content).byteLength;
      if (!Number.isSafeInteger(reply.size) || reply.size !== expectedSize) {
        throw new Error("Шлюз не подтвердил точный размер записанного текста.");
      }
      this.acceptEdit({ root_path: this.root, path: current?.path ?? this.entry.path, display_path: current?.display_path ?? this.entry.path, name: this.entry.name,
        size: expectedSize, is_text: true, is_image: false, is_pdf: false,
        content, truncated: false, lossless: true }, "Шлюз подтвердил запись.");
    } catch (error) {
      if (!this.disposed) {
        this.blocked = sent && (!(error instanceof HttpError) || error.status === 408 || error.status >= 500);
        this.status.set_label(this.blocked ? `Итог записи неизвестен. Черновик сохранён в редакторе.\n${errorText(error)}` : errorText(error));
      }
    } finally {
      this.busy = false;
      if (!this.disposed) this.sync();
    }
  }

  private draft(): string {
    return this.buffer.get_text(this.buffer.get_start_iter(), this.buffer.get_end_iter(), true);
  }

  private async readCurrent(): Promise<FileInfo | undefined> {
    if (this.creating) {
      const parent = this.entry.path.includes("/") ? this.entry.path.slice(0, this.entry.path.lastIndexOf("/")) : ".";
      const listing = readListing(await this.gateway.json("GET", api + "list" + query({ path: parent }), undefined, undefined, false, this.previewCancel));
      if (this.root !== undefined && listing.root_path !== this.root) throw new Error("Корень файлов на шлюзе изменился или не подтверждён. Перечитайте папку и откройте файл заново.");
      this.root = listing.root_path;
    }
    try { return await readFile(this.gateway, this.entry.path, this.previewCancel, this.root, this.baseline?.path); }
    catch (error) {
      if (error instanceof HttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  private async verifyEdit(): Promise<void> {
    if (this.disposed || this.busy || !this.blocked) return;
    this.busy = true;
    this.sync();
    try {
      const current = await this.readCurrent();
      if (this.disposed) return;
      if (this.editable(current) && this.sameFile(current) && current.content === this.draft()) {
        this.acceptEdit(current, "Содержимое на шлюзе совпадает с черновиком.");
      } else if (this.creating ? !current : this.editable(current) && this.sameFile(current) && current.content === this.baseline?.content) {
        clear(this.comparison);
        this.blocked = false;
        this.status.set_label("На шлюзе нет изменений этого черновика. Можно повторить сохранение.");
      } else this.conflict(current);
    } catch (error) {
      if (!this.disposed) this.status.set_label(`Не удалось проверить файл. ${errorText(error)}`);
    } finally {
      this.busy = false;
      if (!this.disposed) this.sync();
    }
  }

  private conflict(current?: FileInfo): void {
    this.blocked = true;
    clear(this.comparison);
    this.status.set_label(current ? "Содержимое файла на шлюзе изменилось. Черновик сохранён в редакторе."
      : "Файл по этому пути отсутствует. Черновик сохранён в редакторе.");
    if (!this.editable(current)) {
      if (current) this.comparison.append(label("Полную текстовую версию по этому пути прочитать не удалось.", "dim-label"));
      return;
    }
    const view = new Gtk.TextView({ editable: false, monospace: true, wrap_mode: Gtk.WrapMode.WORD_CHAR });
    view.get_buffer().set_text(current.content, -1);
    const address = label(current.display_path, "dim-label");
    address.set_selectable(true);
    this.comparison.append(address);
    const details = new Gtk.Expander({ label: "Текущая версия на шлюзе", child: new Gtk.ScrolledWindow({ child: view, min_content_height: 140 }) });
    this.comparison.append(details);
    this.comparison.append(button("Разрешить запись поверх этой версии…", () => {
      void (async () => {
        if (!await confirm(this.dialog, "Использовать текущую версию как основу?",
          "Черновик останется в редакторе. При следующем сохранении он заменит показанную версию, если она ещё совпадает с прочитанной.",
          "Использовать как основу") || this.disposed || this.busy) return;
        this.baseline = current;
        this.creating = false;
        this.blocked = false;
        clear(this.comparison);
        this.status.set_label("Текущая версия выбрана как основа для сохранения.");
        this.buffer.set_modified(true);
        this.sync();
      })();
    }));
  }

  private acceptEdit(file: FileInfo, message: string): void {
    this.baseline = file;
    this.creating = this.blocked = false;
    clear(this.comparison);
    this.description.set_label(`${file.display_path} · ${GLib.format_size(file.size)}`);
    this.buffer.set_modified(false);
    this.setEditing(false);
    this.status.set_label(message);
    this.changed(true);
  }
}
