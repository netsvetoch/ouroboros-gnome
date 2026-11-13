import { bindChrome, chromeText, watchNativeI18n } from "./native-i18n.js";
import { AccountLogin } from "./accounts-login.js";
import { type Gateway } from "./gateway.js";
import { Gtk, Pango } from "./gi.js";
import { ModelCatalog } from "./model-catalog.js";
import { type ModelWait, type OwnerAttention, type WaitAction, type WaitItem, waitKey } from "./owner-attention.js";
import { button, clear, column, label, row, sheet } from "./ui.js";
import { type WorkAction } from "./work-actions.js";

const reasons: Record<string, string> = {
  auth: "Требуется вход в аккаунт", quota: "Ожидание квоты", auth_quota: "Ожидание доступа к аккаунту",
  unavailable: "Нет доступного аккаунта для модели", connection_unavailable: "Подключение API недоступно",
};
const attentionReasons: Record<string, string> = {
  budget: "Достигнут лимит расходов. Проверьте лимит перед возобновлением.",
  restart: "После перезапуска требуется возобновление.", resume: "Задача ожидает возобновления.",
  model_access: "Требуется восстановить доступ к модели.",
};
const roles: Record<string, string> = {
  main: "Основная модель", light: "Лёгкая модель", vision: "Зрение", consciousness: "Фоновая работа",
  safety: "Надзор безопасности", deep_review: "Глубокая проверка", websearch: "Поиск в сети",
};

function roleName(role?: string): string {
  if (role?.startsWith("fallback:")) return `Резервная модель ${Number(role.slice(9)) + 1}`;
  if (role?.startsWith("reviewer:")) return `Рецензент · ${role.slice(9)}`;
  if (role?.startsWith("subagent:")) return `Субагент · ${role.slice(9)}`;
  return roles[role ?? ""] || role || "Модель";
}

export function waitDescription(wait: ModelWait): string {
  const status = wait.state === "resolved" ? "Ожидание завершено" : reasons[wait.reason ?? ""] || wait.reason || "Ожидание модели";
  return [roleName(wait.role), wait.model, status].filter(Boolean).join(" · ");
}

interface Scope { chatId?: number; taskId?: string }

export class OwnerAttentionView {
  readonly widget = new Gtk.Expander({ label: "Доступ к моделям и действия владельца" });
  private readonly rows = column(6);
  private readonly notice = label("", "dim-label");
  private readonly off: () => void;
  private readonly offLocale: () => void;
  private readonly unbind: () => void;
  private readonly dialogs = new Map<string, any>();
  private scope: Scope;
  private serial = 0;
  private signature = "";
  private closed = false;

  constructor(private readonly parent: any, private readonly gateway: Gateway, private readonly state: OwnerAttention,
    private readonly openTask?: (id: string) => void, private readonly openSettings?: () => void,
    private readonly compact = false, taskId?: string) {
    this.scope = { taskId };
    const content = column(5);
    const rows = compact ? new Gtk.ScrolledWindow({ child: this.rows, hscrollbar_policy: Gtk.PolicyType.NEVER,
      max_content_height: 185, propagate_natural_height: true }) : this.rows;
    content.append(rows);
    content.append(this.notice);
    this.widget.set_child(content);
    this.widget.set_expanded(!compact);
    this.unbind = bindChrome(this.widget, "label", "Model access and owner actions");
    this.offLocale = watchNativeI18n(() => { this.signature = "";this.render(); });
    this.off = state.subscribe(() => this.render());
    this.render();
  }

  setRoom(chatId: number): void {
    if (chatId === this.scope.chatId) return;
    this.leave();
    this.scope = { chatId };
    this.render();
  }

  leave(): void {
    this.serial++;
    this.notice.set_label("");
    for (const dialog of [...this.dialogs.values()]) dialog.force_close();
  }

  close(): void { if (this.closed) return; this.closed = true; this.leave(); this.off(); this.offLocale(); this.unbind(); }

  private matches(task: { id: string; chat_id?: number; attention: boolean }): boolean {
    if (this.scope.taskId) return this.scope.taskId === task.id;
    return this.scope.chatId === undefined || task.chat_id === this.scope.chatId || this.scope.chatId === 1 && task.attention;
  }

  private items(): WaitItem[] { return this.state.waits().filter(({ task }) => this.matches(task)); }

  showWait(taskId: string, waitId: string): boolean {
    const wait = this.items().find((item) => item.taskId === taskId && item.row.wait_id === waitId);
    if (this.closed) return false;
    if (wait) this.show(wait);
    else {
      const scope = this.serial;
      this.notice.set_label("Проверяю ожидание модели…");
      void this.state.discover(taskId, waitId).then((found) => {
        if (this.closed || this.serial !== scope) return;
        const current = found && this.items().find((item) => item.taskId === taskId && item.row.wait_id === waitId);
        if (current) {
          this.notice.set_label("");
          this.show(current);
        } else this.openTask?.(taskId);
      });
    }
    return true;
  }

  private render(): void {
    if (this.closed) return;
    const tasks = this.state.tasks().filter((task) => this.matches(task));
    const waits = this.items();
    const gaps = this.state.gaps.filter(gap => this.scope.taskId ? gap.task_id === this.scope.taskId
      : this.scope.chatId === undefined || this.scope.chatId === 1 || this.state.gapInRoom(gap.task_id, this.scope.chatId));
    this.widget.set_visible(this.state.loaded && Boolean(tasks.length || waits.length || gaps.length || !this.state.complete && !this.scope.taskId));
    const signature = JSON.stringify([tasks.map((task) => [task, this.state.busy(task.id)]), waits, this.state.waitsComplete(), gaps, this.state.gapsUnavailable, this.scope]);
    if (signature === this.signature) return;
    this.signature = signature;
    clear(this.rows);
    if (!this.state.waitsComplete() && !this.scope.taskId) this.rows.append(label("Список ожиданий подтверждён частично.", "dim-label"));
    const diagnostic = (source: string, params?: Record<string, string>) => {
      const item = label(chromeText(source, params), "dim-label");item.set_selectable(true);item.set_max_width_chars(64);item.set_wrap_mode(Pango.WrapMode.WORD_CHAR);this.rows.append(item);
    };
    if (this.state.gapsUnavailable && (!this.scope.taskId || gaps.length)) diagnostic("Owner-action gap details are unavailable. Previous details may be stale.");
    if (gaps.length) {
      diagnostic("Gateway owner-action gaps");
      for (const gap of gaps) {
        if (gap.reason === "model_wait_action_unknown") diagnostic("The gateway could not confirm the action for this model wait.");
        diagnostic("Gap reason · {value}", { value: gap.reason });
        if (gap.task_id !== undefined) diagnostic("Related task · {value}", { value: gap.task_id });
        if (gap.wait_id !== undefined) diagnostic("Related model wait · {value}", { value: gap.wait_id });
      }
    }
    const ids = new Set([...tasks.map(({ id }) => id), ...waits.map(({ taskId }) => taskId)]);
    for (const id of ids) {
      const attention = tasks.find((task) => task.id === id);
      const waitsForTask = waits.filter(({ taskId }) => taskId === id);
      const task = attention ?? waitsForTask[0].task;
      const card = column(4);
      card.append(label([task.task_name || task.title || task.id, task.project_name].filter(Boolean).join(" · "), "heading"));
      if (attention?.attention_reason) card.append(label(attentionReasons[attention.attention_reason] ?? attention.attention_reason, "dim-label"));
      if (attention && !attention.confirmed) card.append(label("Действия больше не подтверждены шлюзом.", "dim-label"));
      for (const wait of waitsForTask) {
        card.append(label(waitDescription(wait.row), "dim-label"));
        const open = button("Открыть ожидание модели…", () => this.showWait(wait.taskId, wait.row.wait_id));
        open.set_halign(Gtk.Align.START);
        card.append(open);
      }
      const actions = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, column_spacing: 6, row_spacing: 6, halign: Gtk.Align.START });
      if (attention) {
        const run = (action: WorkAction, caption: string) => {
          const control = button(caption, () => {
            const serial = this.serial;
            const inScope = () => !this.closed && this.serial === serial;
            void this.state.runTask(this.parent, attention, action, inScope).then((outcome) => {
              if (inScope()) this.notice.set_label(outcome);
            });
          });
          control.set_sensitive(attention.confirmed && !this.state.busy(id));
          actions.append(control);
        };
        if (attention.can_resume && attention.pause_cause !== "owner") run("resume", "Возобновить");
        if (attention.cancelable) {
          run("stop", "Остановить работу…");
          run("wrap_up", "Завершить с частичным результатом…");
        }
      }
      if (this.openTask) actions.append(button("Открыть задачу", () => this.openTask?.(id)));
      if (actions.get_first_child()) card.append(actions);
      this.rows.append(card);
    }
  }

  private show(initial: WaitItem): void {
    const key = waitKey(initial);
    if (this.dialogs.has(key)) return;
    const scope = this.serial;
    const content = column();
    const dialog = sheet("Ожидание модели", content);
    this.dialogs.set(key, dialog);
    const children = new Set<any>();
    const present = (child: any, parent?: any) => {
      children.add(child);
      child.connect("closed", () => children.delete(child));
      child.present(parent ?? dialog);
    };
    const catalog = new ModelCatalog(this.gateway, present);
    const login = new AccountLogin(this.gateway, present, () => void this.state.refresh());
    const active = () => !this.closed && this.serial === scope && this.dialogs.get(key) === dialog;
    const current = () => this.items().find((item) => waitKey(item) === key);
    const send = (action?: WaitAction) => {
      const item = current();
      if (item && active()) void this.state.submit(item, action, active);
    };
    const title = label("", "title-3");
    const detail = label("", "dim-label");
    const notice = label("", "dim-label");
    const model = new Gtk.Entry({ text: (initial.row.model ?? "").replace(/ \(local\)$/u, ""), placeholder_text: "Маршрут модели", hexpand: true });
    const profile = new Gtk.Entry({ text: initial.row.credential_profile_id ?? "", placeholder_text: "Пусто для автоматического выбора" });
    const local = new Gtk.CheckButton({ label: "Использовать локальную модель", active: initial.row.model?.endsWith(" (local)") ?? false });
    const persist = new Gtk.CheckButton({ label: "Сохранить выбор для этой роли в настройках шлюза" });
    const picker = column(6);
    const pick = button("Из каталога…", () => catalog.pick(dialog, (item) => {
      if (!active()) return;
      model.set_text(item.value.replace(/ \(local\)$/u, ""));
      local.set_active(item.value.endsWith(" (local)") || item.provider_id === "local");
      profile.set_text(local.get_active() ? "" : item.credential_profile_id ?? "");
    }));
    const modelRow = row();
    modelRow.append(model);
    modelRow.append(pick);
    let draftRevision: number | undefined;
    const apply = button("Применить к ожидающей задаче", () => {
      const value = model.get_text().trim();
      if (value && draftRevision === current()?.row.revision) send({ action: "switch", model: value, use_local: local.get_active(),
        credential_profile_id: local.get_active() ? "" : profile.get_text().trim(), persist_role: persist.get_active() });
    });
    apply.add_css_class("suggested-action");
    const fallback = label("Для резервной роли сохранение возможно с общим режимом локального запуска резервных моделей.", "dim-label");
    fallback.set_visible(initial.row.role?.startsWith("fallback:") ?? false);
    for (const widget of [modelRow, label("Профиль аккаунта"), profile, local, persist, fallback, apply]) picker.append(widget);
    const editor = new Gtk.Expander({ label: "Сменить модель или аккаунт", child: picker });
    const retry = button("Проверить доступ ещё раз", () => send({ action: "retry" }));
    const repeat = button("Повторить прежний запрос", () => send());
    const recheck = button("Обновить состояние", () => void this.state.refresh());
    const automatic = button("", () => {
      const item = current();
      if (item) send({ action: "auto_continue", auto_continue: item.row.auto_continue === false });
    });
    const signIn = button("Войти заново…", () => {
      const item = current();
      if (item && active()) login.show(dialog, item.row.credential_harness, item.row.credential_profile_id);
    });
    for (const widget of [title, detail, notice, recheck, retry, repeat, automatic, signIn]) content.append(widget);
    if (this.openSettings) content.append(button("Настройки шлюза…", () => this.openSettings?.()));
    content.append(editor);

    const sync = () => {
      const item = current();
      const wait = item?.row ?? this.state.latest(initial);
      const receipt = this.state.receipt(initial);
      const sendable = Boolean(item && !receipt.sending && this.state.canSend(item, false));
      const repeated = Boolean(item && this.state.canSend(item, true));
      const reset = wait.reset_at ? new Date(wait.reset_at) : undefined;
      const observation = wait.availability_observation !== "unavailable";
      const timed = observation && ["quota", "auth_quota", "unavailable"].includes(wait.reason ?? "");
      title.set_label(waitDescription(wait));
      detail.set_label([initial.task.task_name || initial.task.title || initial.taskId, initial.task.project_name,
        `Попытка · ${wait.task_attempt}`, wait.credential_profile_id ? `Аккаунт · ${wait.credential_profile_id}` : "Автоматический выбор аккаунта",
        !observation && "Автоматическая проверка доступа недоступна.", reset && !Number.isNaN(reset.valueOf()) && `Прогноз доступности · ${reset.toLocaleString()}`,
        wait.worker_slot_held && "Задача сохраняет рабочий слот.", wait.review_operation && "Решение относится к этой операции проверки."].filter(Boolean).join("\n"));
      const applied = receipt.sent && (wait.applied_request_id === receipt.sent || receipt.applied === receipt.sent);
      const application = applied ? "Задача применила решение." : "";
      const pending = wait.pending_action?.request_id && wait.pending_action.request_id !== wait.applied_request_id;
      const saved = receipt.saveRequest && (wait.saved_request_id === receipt.saveRequest || receipt.saved === true ? "Настройки шлюза сохранены."
        : receipt.saved === null ? "Сохранение настроек не подтверждено." : "Настройки шлюза не сохранены.");
      const staleDraft = item && draftRevision !== undefined && draftRevision !== wait.revision && editor.get_expanded();
      notice.set_label([item?.confirmed ? "" : wait.state === "resolved" ? "Ожидание завершено." : "Шлюз пока не подтвердил текущее ожидание.",
        application, receipt.message || (!applied && (pending || receipt.accepted) && "Шлюз принял решение. Задача ещё подтверждает применение."), saved,
        staleDraft && "Состояние ожидания изменилось. Сверните и снова откройте выбор модели."].filter(Boolean).join("\n"));
      retry.set_sensitive(sendable);
      repeat.set_visible(repeated);
      repeat.set_sensitive(!receipt.sending);
      automatic.set_label(wait.auto_continue === false ? "Включить автоматическое возобновление" : "Выключить автоматическое возобновление");
      automatic.set_visible(timed);
      automatic.set_sensitive(sendable);
      signIn.set_visible(wait.reason === "auth" && observation && Boolean(wait.credential_harness));
      signIn.set_sensitive(Boolean(item?.confirmed));
      picker.set_sensitive(sendable);
      profile.set_sensitive(!local.get_active());
      apply.set_sensitive(draftRevision === wait.revision && Boolean(model.get_text().trim()));
    };
    const off = this.state.subscribe(sync);
    model.connect("changed", sync);
    local.connect("toggled", sync);
    editor.connect("notify::expanded", () => {
      if (!editor.get_expanded()) return;
      const wait = current()?.row;
      if (!wait || draftRevision === wait.revision) return;
      draftRevision = wait.revision;
      model.set_text((wait.model ?? "").replace(/ \(local\)$/u, ""));
      local.set_active(wait.model?.endsWith(" (local)") ?? false);
      profile.set_text(wait.credential_profile_id ?? "");
      persist.set_active(false);
      sync();
    });
    dialog.connect("closed", () => {
      this.dialogs.delete(key);
      off();
      for (const child of [...children].reverse()) child.force_close();
    });
    sync();
    dialog.present(this.parent);
  }
}
