import { type UpdateRange } from "./update-evidence.js";
import { Gtk } from "./gi.js";
import { column, label } from "./ui.js";

type UpdatePlan = UpdateRange & { merge_commit?: string };
type UpdateMode = "merge" | "replace";

interface EnginePin {
  version?: string;
  build_sha?: string;
}

interface EngineTransition {
  serving?: EnginePin | null;
  target?: EnginePin | null;
  source_sha?: string;
  action?: string;
  direction?: string;
  data_direction?: string;
  error?: string;
}

interface RuntimeVersions {
  python?: string | null;
  sqlite?: string | null;
}

export interface UpdateEffects {
  target_sha?: string;
  engine?: EngineTransition;
  replacement_engine?: EngineTransition;
  provisional?: boolean;
  active_work?: { status?: string; model?: number | null; non_model?: number | null };
  runtime?: {
    installed?: RuntimeVersions & { executable?: string };
    bundle?: RuntimeVersions & { source?: string };
    changed_by_apply?: boolean;
  };
}

function line(container: any, text: string, style?: string): void {
  const widget = label(text, style);
  widget.set_selectable(true);
  container.append(widget);
}

function pinText(pin?: EnginePin | null): string {
  return [pin?.version, pin?.build_sha].filter(Boolean).join(" · ") || "неизвестно";
}

function engineRows(container: any, engine: EngineTransition | undefined, provisional: boolean): void {
  line(container, `Запущенный Claudexor · ${pinText(engine?.serving)}`);
  line(container, `Claudexor в выбранном коммите · ${pinText(engine?.target)}`);
  if (engine?.action === "replace") {
    const transition = provisional
      ? "Если итоговый коммит закрепит эту сборку, при перезапуске шлюз заменит общий движок."
      : "При перезапуске шлюз заменит общий движок.";
    line(container, `${transition} При замене все активные операции движка прервутся, включая работу вне этого шлюза.`);
  } else if (engine?.action === "keep") {
    line(container, provisional
      ? "Если итоговый коммит закрепит эту сборку, перезапуск шлюза сохранит работающий движок."
      : "Перезапуск шлюза сохранит работающий движок.");
  } else {
    line(container, "Замена движка не подтверждена. Активные операции могут прерваться.");
  }
  if (engine?.data_direction === "forward_only") {
    const servingVersion = engine.serving?.version;
    line(container, engine.direction === "backward" && servingVersion
      ? `После остановки движка для холодного запуска с этими данными потребуется сборка Ouroboros с Claudexor ${servingVersion} или новее.`
      : "Данные Claudexor рассчитаны на переход к новым версиям движка. При откате кода данные останутся в текущем формате.");
  }
  if (provisional) line(container, "Целевая сборка движка может измениться при разрешении конфликтов.");
  if (engine?.error) line(container, engine.error, "dim-label");
}

function workCount(value?: number | null): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function versions(runtime?: RuntimeVersions): string {
  return `Python ${runtime?.python || "неизвестно"} · SQLite ${runtime?.sqlite || "неизвестно"}`;
}

export function updateEffects(plan: UpdatePlan, effects?: UpdateEffects | null, selected?: UpdateMode): any {
  const content = column(6);
  if (!plan.target_sha || effects?.target_sha !== plan.target_sha) {
    line(content, "Для целевого коммита нет сведений о последствиях. Состояние движка, активная работа и версии среды неизвестны.");
    return content;
  }
  const work = effects.active_work;
  line(content, work?.status === "known" && workCount(work.model) && workCount(work.non_model)
    ? `Активная работа на момент проверки · вызовы моделей ${work.model} · прочие операции ${work.non_model}`
    : "Активная работа движка на момент проверки неизвестна.");
  if (selected !== "replace") {
    line(content, "При слиянии", "heading");
    const source = plan.merge_commit || plan.target_sha;
    engineRows(content, effects.engine?.source_sha === source ? effects.engine : undefined, !plan.merge_commit && effects.provisional === true);
  }
  if (selected !== "merge") {
    line(content, "При замене официальной версией", "heading");
    engineRows(content, effects.replacement_engine?.source_sha === plan.target_sha ? effects.replacement_engine : undefined, false);
  }
  const runtime = effects.runtime;
  line(content, "Среда шлюза", "heading");
  line(content, `В установленной среде · ${versions(runtime?.installed)}`);
  if (runtime?.installed?.executable) line(content, `Интерпретатор · ${runtime.installed.executable}`, "dim-label");
  line(content, `В документации целевой версии · ${versions(runtime?.bundle)}`);
  if (runtime?.bundle?.source) line(content, runtime.bundle.source, "dim-label");
  if (runtime?.changed_by_apply === false) line(content, "Обновление сохранит установленные Python и SQLite.");
  if (!selected) {
    const raw = label(JSON.stringify(effects, null, 2));
    raw.set_selectable(true);
    content.append(new Gtk.Expander({ label: "Последствия в JSON", child: raw }));
  }
  return content;
}
