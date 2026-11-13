import { usd } from "./cost-view.js";
import { type Gateway, query } from "./gateway.js";
import { Gio, Gtk } from "./gi.js";
import { markdownView } from "./markdown-view.js";
import { object } from "./settings-write.js";
import { artifactStateName } from "./task-materials.js";
import { button, clear, column, errorText, label, row, sheet } from "./ui.js";
import { exactWorkTarget } from "./work-actions.js";

type Data = Record<string, unknown>;
type Save = (name: string, selector: { wrap_up: string }) => void;

export const savedWorkTitle = "Работа, сохранённая при остановке";

export function isRetainedWork(value: unknown): boolean {
  const row = object(value);
  return row.role === "system" && row.system_type === "custody_notice" && (row.terminal_receipt === "retained_work"
    || (row.card_row === "timeline" && typeof row.card_row_id === "string" && row.card_row_id.endsWith(":retained_work")));
}

const outputs: Record<string, string> = {
  retained_complete: "Вывод сохранён полностью", retained_partial: "Вывод сохранён частично",
  retained_earlier_observation: "Сохранён вывод из более раннего наблюдения",
  observation_only: "Сохранён отчёт движка", none_reported: "Движок не сообщил вывод",
  not_captured: "Вывод не сохранён", unknown: "Состояние вывода неизвестно",
};
const childTexts: Record<string, string> = {
  answer: "Ответ дочерней задачи", salvaged_text: "Сохранённое промежуточное сообщение",
  host_note: "Сообщение шлюза", unattributed_text: "Сохранённый текст без сведений об авторе",
  no_text_recorded: "Текст не записан", unknown: "Состояние текста неизвестно",
};
const dispositions: Record<string, string> = {
  applied: "Применены", rejected: "Отклонены", superseded: "Заменены результатом более позднего запуска",
  not_recorded: "Решение не записано",
};

const text = (value: unknown) => typeof value === "string" && value.trim() ? value : "";
const strings = (value: unknown) => Array.isArray(value) ? value.map(text).filter(Boolean) : [];
const records = (value: unknown) => Array.isArray(value) ? value.map(object).filter(item => Object.keys(item).length) : [];
const nameOf = (names: Record<string, string>, value: unknown) => {
  const key = text(value);
  return Object.hasOwn(names, key) ? names[key] : key;
};

function fact(target: any, title: string, value?: unknown): void {
  if (value !== undefined && typeof value !== "number" && !text(value)) return;
  const widget = label(value === undefined ? title : `${title} · ${value}`);
  widget.set_selectable(true);
  target.append(widget);
}

function section(target: any, title: string): any {
  const body = column(5);
  target.append(new Gtk.Expander({ label: title, child: body }));
  return body;
}

const reports = new WeakMap<object, { path: string; close: () => void }>();
const offers = new WeakMap<object, string>();

function preview(parent: any, gateway: Gateway, path: string, save: () => void, current: () => boolean): void {
  if (!current()) return;
  const previous = reports.get(parent);
  if (previous?.path === path) return;
  previous?.close();
  const content = column();
  const dialog = sheet(savedWorkTitle, content);
  dialog.set_content_width(740);
  const cancel = new Gio.Cancellable();
  const status = label("Читаю отчёт со шлюза…");
  const body = column();
  let open = true, busy = false, loaded = false;
  let signal = 0;
  const dispose = () => {
    if (!open) return;
    open = false;
    cancel.cancel();
    if (reports.get(parent) === report) reports.delete(parent);
    if (signal) { parent.disconnect(signal); signal = 0; }
  };
  const report = { path, close: () => { dispose(); if (dialog.get_mapped()) dialog.force_close(); } };
  reports.set(parent, report);
  signal = parent.connect("closed", report.close);
  content.append(button("Скачать отчёт…", () => { if (open && current()) save(); }));
  const reread = button("Перечитать отчёт", () => void read());
  content.append(reread);
  content.append(label("Шлюз формирует документ заново при каждом чтении из сохранённой квитанции и указанных в ней источников.", "dim-label"));
  content.append(status);
  content.append(body);
  dialog.connect("closed", dispose);
  dialog.present(parent);
  async function read(): Promise<void> {
    if (!open || !current() || busy) return;
    busy = true;
    reread.set_sensitive(false);
    status.set_label("Читаю отчёт со шлюза…");
    try {
      const bytes = await gateway.previewBytes(path, 1024 * 1024, cancel);
      if (!open || !current()) return;
      const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      clear(body);
      body.append(markdownView(source, gateway.base));
      loaded = true;
      status.set_label("");
    } catch (error) {
      if (open && current()) status.set_label([loaded ? "Показан последний прочитанный отчёт." : "", errorText(error)].filter(Boolean).join(" "));
    } finally {
      busy = false;
      if (open) reread.set_sensitive(true);
    }
  }
  void read();
}

function renderRun(target: any, run: Data): void {
  const body = section(target, [text(run.run_id) || "Запуск без ID", text(run.state)].filter(Boolean).join(" · "));
  fact(body, "Задача запуска", text(run.owner_task_id));
  fact(body, "Маршрут", text(run.route_id));
  fact(body, "Причина", text(run.reason));
  fact(body, "Вывод", nameOf(outputs, run.output_state) || "Состояние вывода неизвестно");
  fact(body, "Фрагмент отчёта движка", text(run.answer_preview));
  if (typeof run.answer_preview_omitted_chars === "number" && run.answer_preview_omitted_chars > 0) {
    fact(body, "Символов вне фрагмента", run.answer_preview_omitted_chars);
  }
  const patch = object(run.patch);
  const capture = object(patch.capture);
  const captureStatus = text(capture.status);
  if (captureStatus) fact(body, "Снимок изменений", artifactStateName(captureStatus));
  else if (patch.captured === true) fact(body, "Изменения файлов сохранены");
  if (capture.result_lost === true) fact(body, "Шлюз сообщил о потере части изменений");
  if (typeof capture.file_output_count === "number") fact(body, "Сохранено изменений файлов", capture.file_output_count);
  fact(body, "Решение об изменениях", nameOf(dispositions, patch.disposition));
  fact(body, "Решение записано задачей", text(capture.disposed_by));
  if (patch.apply_pending === true) fact(body, "Итог применения изменений не подтверждён");
  const money = object(run.accounting);
  fact(body, money.cost_final === false && typeof money.cost_usd === "number" ? "Предварительная стоимость" : "Стоимость", usd(money.cost_usd));
  if (money.settled === false) fact(body, "Учёт расходов ещё не завершён");
  const carriers = strings(object(object(run.engine_continuity).resumable).carriers);
  if (carriers.length) fact(body, "Возможности продолжения по данным движка", carriers.join(", "));
  for (const gap of strings(run.gaps)) fact(body, "Пробел в данных", gap);
}

function renderCustody(target: any, custody: Data, terminal: Data[]): void {
  if (text(custody.audit_status) && custody.audit_status !== "ok") fact(target, "Проверка делегированных запусков не подтверждена");
  const ended = new Set(terminal.map(run => text(run.run_id)));
  for (const id of strings(custody.open_run_ids)) if (!ended.has(id)) fact(target, "Завершение запуска не подтверждено", id);
  for (const id of strings(custody.pending_invocation_ids)) fact(target, "Запуск не подтверждён", id);
}

function renderChild(target: any, child: Data, open: (id: string) => void): void {
  const id = child.task_id;
  const body = section(target, [`Дочерняя задача ${text(id) || "без ID"}`, text(child.status)].filter(Boolean).join(" · "));
  if (exactWorkTarget(id)) body.append(button("Открыть дочернюю задачу", () => open(id)));
  fact(body, "Сохранённый текст", nameOf(childTexts, child.result_state) || "Состояние текста неизвестно");
  if (text(child.result_preview)) fact(body, "Фрагмент", child.result_preview);
  if (typeof child.result_preview_omitted_chars === "number" && child.result_preview_omitted_chars > 0) {
    fact(body, "Символов вне фрагмента", child.result_preview_omitted_chars);
  }
  fact(body, "Примечание шлюза", text(child.terminal_host_notice));
  fact(body, "Примечание провайдера", text(child.terminal_provider_notice));
  fact(body, "Пробел в данных", text(child.gap));
  const custody = object(child.custody);
  const terminal = records(custody.terminal_runs);
  renderCustody(body, custody, terminal);
  for (const run of terminal) renderRun(body, run);
}

export function renderWrapUp(target: any, parent: any, gateway: Gateway, taskId: string, raw: unknown,
  open: (id: string) => void, download: Save, alive: () => boolean = () => true): void {
  const task = object(raw);
  const audit = object(task.delegate_terminal_reconciliation);
  const receipt = object(audit.owner_stop_children);
  const document = object(task.wrap_up_document);
  const key = JSON.stringify([taskId, document.name, document.request_id]);
  offers.set(parent, key);
  const current = () => alive() && offers.get(parent) === key;
  const path = document.name ? `/api/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(String(document.name))}${query({ wrap_up: String(document.request_id ?? "") })}` : "";
  if (reports.get(parent)?.path !== path) reports.get(parent)?.close();
  if (!Object.keys(receipt).length && !Object.keys(document).length) return;
  const body = section(target, savedWorkTitle);
  const stop = object(receipt.stop);
  fact(body, "Задача, для которой сохранена работа", text(receipt.task_id));
  fact(body, "Запрос остановки", text(stop.request_id));
  fact(body, "Пробел в данных", text(receipt.gap));
  if (receipt.publication_gap) fact(body, "Сохранение полной квитанции не подтверждено", text(receipt.publication_gap));
  const terminal = records(receipt.runs);
  renderCustody(body, audit, terminal);
  for (const run of terminal) renderRun(body, run);
  for (const child of records(receipt.children)) renderChild(body, child, id => { if (current()) open(id); });
  const name = text(document.name);
  if (/^work-saved-at-wrap-up-[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.md$/u.test(name) && typeof document.request_id === "string") {
    const selector = { wrap_up: document.request_id };
    const save = () => { if (current()) download(name, selector); };
    const actions = row();
    actions.append(button("Открыть отчёт об остановке…", () => preview(parent, gateway, path, save, current)));
    actions.append(button(`Скачать отчёт об остановке · ${name}`, save));
    body.append(actions);
  }
}
