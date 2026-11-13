import { Adw, Gtk } from "./gi.js";
import { actionRow, button, column, label, sheet } from "./ui.js";

interface GitVersion {
  sha?: string;
  tag?: string;
  date?: string;
  message?: string;
}

export interface GitVersions {
  branch?: string;
  sha?: string;
  commits?: GitVersion[];
  tags?: GitVersion[];
}

export interface OfficialRelease {
  tag?: string;
  sha?: string;
}

export function commitSha(value?: string): string | undefined {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value) ? value.toLowerCase() : undefined;
}

export function officialReleases(releases?: OfficialRelease[]): any {
  const content = column(6);
  if (!releases?.length) content.append(label(releases
    ? "Шлюз не вернул официальных релизов при последней проверке."
    : "Чтобы запросить список релизов, проверьте обновления."));
  for (const release of releases ?? []) {
    const line = label([release.tag, release.sha].filter(Boolean).join(" · "));
    line.set_selectable(true);
    content.append(line);
  }
  return new Gtk.Expander({ label: "Официальные релизы", child: content });
}

export function restoreVersions(data: GitVersions, previous: string | undefined, choose: (sha: string, title?: string) => void,
  readError?: string): any {
  const content = column();
  const dialog = sheet("Выбрать коммит для восстановления", content);
  dialog.set_content_width(680);
  const exact = new Gtk.Entry({ placeholder_text: "Полный SHA коммита" });
  const feedback = label("", "error");
  let open = true, selecting = false;
  dialog.connect("closed", () => { open = false; });
  const select = (sha: string, title?: string) => {
    if (!open || selecting) return;
    selecting = true;
    if (dialog.close()) choose(sha, title);
    else selecting = false;
  };
  const input = () => {
    const sha = commitSha(exact.get_text().trim());
    if (sha) select(sha);
    else feedback.set_label("Введите полный SHA коммита.");
  };
  exact.connect("activate", input);
  content.append(exact);
  content.append(button("Продолжить по SHA…", input));
  content.append(feedback);
  if (readError) content.append(label(`Не удалось прочитать журнал Git. ${readError}`));

  const choices = new Map<string, { tags: Set<string>; date?: string; message?: string }>();
  if (previous) choices.set(previous, { tags: new Set() });
  for (const commit of data.commits ?? []) {
    const sha = commitSha(commit.sha);
    if (sha) choices.set(sha, { tags: new Set(), date: commit.date, message: commit.message });
  }
  for (const tag of data.tags ?? []) {
    const sha = commitSha(tag.sha);
    if (!sha || !tag.tag) continue;
    const choice = choices.get(sha) ?? { tags: new Set<string>(), date: tag.date, message: tag.message };
    choice.tags.add(tag.tag);
    choices.set(sha, choice);
  }
  const group = new Adw.PreferencesGroup({ title: "Локальные точки восстановления",
    description: [data.branch, data.sha].filter(Boolean).join(" · ") });
  for (const [sha, choice] of choices) {
    const titles = [...choice.tags];
    if (sha === previous) titles.unshift("Версия до обновления");
    const title = titles.join(", ") || sha.slice(0, 12);
    const item = actionRow({ title, use_markup: false, subtitle: [choice.date, choice.message].filter(Boolean).join(" · ") });
    const action = button("Выбрать…", () => select(sha, title));
    action.set_valign(Gtk.Align.CENTER);
    item.add_suffix(action);
    item.set_activatable_widget(action);
    group.add(item);
  }
  if (!choices.size) group.add(label("Шлюз не вернул локальных точек восстановления."));
  content.append(group);
  return dialog;
}
