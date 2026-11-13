import { GLib, Gtk } from "./gi.js";
import { column, label } from "./ui.js";

type Fields = Record<string, unknown>;

export interface UpdateRange {
  base_sha?: string;
  target_sha?: string;
}

export interface UpdateEvidence extends UpdateRange {
  commits?: {
    sha: string;
    subject?: string;
    body_read?: boolean;
    receipt?: {
      checks?: { name: string; status: string; source?: string; detail?: string }[];
      review?: Fields;
    } | null;
  }[];
  github?: {
    status?: string;
    reason?: string;
    missing_shas?: string[];
    runs?: { sha: string; status?: string; conclusion?: string; url?: string; covered_shas?: string[] }[];
  };
}

const resultNames: Record<string, string> = {
  passed: "пройдена", failed: "провалена", not_run: "не запускалась", unknown: "результат неизвестен",
  completed: "завершён", in_progress: "выполняется", queued: "в очереди", success: "успешно",
  failure: "ошибка", cancelled: "отменён", skipped: "пропущен", timed_out: "превышено время ожидания",
  observed: "результаты прочитаны", partial: "прочитана часть результатов", unavailable: "результаты недоступны",
};
const sourceNames: Record<string, string> = {
  author_declared: "по заявлению автора", missing: "без сведений о запуске",
};

function describe(value: string | undefined, names: Record<string, string>, fallback: string): string {
  return value ? Object.hasOwn(names, value) ? names[value] : value : fallback;
}

function line(target: any, text: string, style?: string): void {
  const widget = label(text, style);
  widget.set_selectable(true);
  target.append(widget);
}

function display(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}

function runLink(target: any, uri?: string): void {
  if (!uri) return;
  try {
    const url = GLib.Uri.parse(uri, GLib.UriFlags.NONE);
    if (url.get_scheme() === "https" && url.get_host() === "github.com" && !url.get_userinfo()) {
      target.append(new Gtk.LinkButton({ label: "Открыть запуск в GitHub", uri, halign: Gtk.Align.START }));
    }
  } catch { /* The full record retains the original URL. */ }
}

export function updateEvidence(plan: UpdateRange, evidence?: UpdateEvidence | null, title = "Проверки диапазона обновления"): any {
  const body = column(6);
  if (!plan.base_sha || !plan.target_sha || evidence?.base_sha !== plan.base_sha || evidence?.target_sha !== plan.target_sha) {
    line(body, "Для этого диапазона нет подтверждённых сведений о проверках.", "dim-label");
  } else {
    line(body, `Исходный коммит · ${plan.base_sha}`, "dim-label");
    line(body, `Целевой коммит · ${plan.target_sha}`, "dim-label");
    for (const commit of evidence.commits ?? []) {
      line(body, commit.subject || commit.sha, "heading");
      if (commit.subject) line(body, commit.sha, "dim-label");
      if (!commit.receipt) {
        line(body, commit.body_read === false ? "Текст коммита не прочитан." : "У коммита нет квитанции проверок.", "dim-label");
        continue;
      }
      for (const check of commit.receipt.checks ?? []) {
        const status = describe(check.status, resultNames, "результат неизвестен");
        const source = describe(check.source, sourceNames, "источник неизвестен");
        line(body, `${check.name} · ${status} · ${source}${check.detail ? `\n${check.detail}` : ""}`);
      }
      const { observed, declared, state, relation, ...additional } = commit.receipt.review ?? {};
      line(body, `Ревью · наблюдаемый вердикт ${display(observed ?? "неизвестен")} · заявление автора ${display(declared ?? "отсутствует")}`);
      line(body, `Состояние записи · ${display(state ?? "не записано")}\nСвязь ревью с коммитом при запросе слияния · ${display(relation ?? "не записана")}`);
      for (const [key, value] of Object.entries(additional)) line(body, `${key} · ${display(value)}`);
    }
    const github = evidence.github;
    line(body, "Проверки GitHub после слияния", "heading");
    line(body, describe(github?.status, resultNames, "Результаты неизвестны"));
    if (github?.reason) line(body, github.reason, "dim-label");
    for (const run of github?.runs ?? []) {
      const status = describe(run.status, resultNames, "состояние неизвестно");
      const conclusion = describe(run.conclusion, resultNames, "результат неизвестен");
      line(body, `${run.sha} · ${status} · ${conclusion}`);
      if (run.covered_shas?.length) line(body, `Этот запуск также охватывает\n${run.covered_shas.join("\n")}`);
      runLink(body, run.url);
    }
    if (github?.missing_shas?.length) line(body, `Запуск не найден для коммитов\n${github.missing_shas.join("\n")}`);
    const raw = new Gtk.Expander({ label: "Полная запись JSON", child: label(JSON.stringify(evidence, null, 2)) });
    raw.get_child().set_selectable(true);
    body.append(raw);
  }
  return new Gtk.Expander({ label: title, child: body });
}
