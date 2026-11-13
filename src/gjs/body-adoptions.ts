import { Gtk } from "./gi.js";
import { column, label } from "./ui.js";

export interface BodyAdoption {
  adoption_id: string;
  outcome?: string;
  commit_sha?: string;
  previous_sha?: string;
  branch?: string;
  note?: string;
  settled_at?: string;
  revision?: number;
  commits?: string[];
  commits_complete?: boolean;
  commits_omitted?: number;
  official_relation?: { unknown?: string; tip?: string; checked_at?: string; channel?: string; only_here?: number; only_official?: number };
}

const outcomes: Record<string, string> = {
  adopted: "Изменения ядра применены", not_applied: "Изменения ядра не применены",
  superseded: "Изменения ядра заменены другой версией", unconfirmed: "Применение изменений ядра не подтверждено",
};
const officialGaps: Record<string, string> = {
  no_official_check: "Нет сохранённой проверки официальной версии",
  update_channel_changed: "Последняя проверка относилась к другому каналу обновлений",
  official_tip_unreadable: "Коммит из последней проверки недоступен",
};
const gitId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;

function revision(adoption: BodyAdoption): number { return Number.isSafeInteger(adoption.revision) ? adoption.revision! : 0; }

export function mergeBodyAdoptions(previous?: BodyAdoption[], incoming?: BodyAdoption[]): BodyAdoption[] {
  const byId = new Map<string, BodyAdoption>();
  for (const rows of [previous, incoming]) if (Array.isArray(rows)) for (const row of rows) {
    if (typeof row?.adoption_id !== "string" || !row.adoption_id) continue;
    const stored = byId.get(row.adoption_id);
    if (!stored || revision(stored) <= revision(row)) byId.set(row.adoption_id, row);
  }
  return [...byId.values()];
}

function fullCommit(value: unknown): string {
  return typeof value === "string" && gitId.test(value) ? value.toLowerCase() : "";
}

export function adoptionRelation(commit: string, rows: BodyAdoption[]): string {
  const sha = fullCommit(commit);
  if (!sha) return "";
  const settled = rows.filter((row) => row.outcome === "adopted" && fullCommit(row.commit_sha));
  const exact = settled.find((row) => fullCommit(row.commit_sha) === sha);
  if (exact) return "Этот коммит стал версией ядра после перезапуска.";
  const range = settled.find((row) => Array.isArray(row.commits) && row.commits.some((item) => fullCommit(item) === sha));
  if (range) return `Коммит вошёл в применённый диапазон до ${range.commit_sha}.`;
  if (settled.some((row) => row.commits_complete !== true)) return "Принадлежность коммита к применённым диапазонам не подтверждена.";
  return "";
}

function fact(content: any, title: string, value: unknown): void {
  if ((typeof value !== "string" && typeof value !== "number") || value === "") return;
  const field = label(title ? `${title} · ${value}` : String(value));
  field.set_selectable(true);
  content.append(field);
}

export function adoptionPanel(rows: BodyAdoption[]): any | undefined {
  if (!rows.length) return undefined;
  const content = column(6);
  for (const adoption of rows) {
    const detail = column(4);
    const outcome = adoption.outcome && Object.hasOwn(outcomes, adoption.outcome) ? outcomes[adoption.outcome] : adoption.outcome;
    const commit = typeof adoption.commit_sha === "string" ? adoption.commit_sha : "";
    content.append(new Gtk.Expander({ label: [outcome || "Применение изменений ядра", commit.slice(0, 12), adoption.settled_at]
      .filter(Boolean).join(" · "), child: detail }));
    fact(detail, "Коммит", commit);
    fact(detail, "Предыдущий коммит", adoption.previous_sha);
    fact(detail, "Ветка", adoption.branch);
    fact(detail, "Запись", adoption.adoption_id);
    fact(detail, "Ревизия записи", adoption.revision);
    fact(detail, "", adoption.note);
    const official = adoption.official_relation;
    if (official?.unknown) fact(detail, "Сравнение с официальной версией", officialGaps[official.unknown] ?? official.unknown);
    if (official?.tip) {
      fact(detail, "Официальный коммит на момент проверки", official.tip);
      fact(detail, "Канал обновлений", official.channel);
      fact(detail, "Последняя проверка", official.checked_at);
      fact(detail, "Коммитов только в этой версии", official.only_here);
      fact(detail, "Коммитов только в официальной версии", official.only_official);
    }
    if (adoption.outcome !== "adopted") continue;
    if (Array.isArray(adoption.commits) && adoption.commits.length) {
      const range = column(4);
      for (const sha of adoption.commits) fact(range, "", sha);
      detail.append(new Gtk.Expander({ label: "Коммиты применённого диапазона", child: range }));
    }
    if (typeof adoption.commits_omitted === "number" && adoption.commits_omitted > 0) {
      fact(detail, "Коммитов за пределами списка", adoption.commits_omitted);
    } else if (adoption.commits_complete === false) fact(detail, "", "Шлюз вернул неполный список коммитов диапазона.");
  }
  return new Gtk.Expander({ label: "Изменения ядра этой задачи", child: content });
}
