import { ChatMedia } from "./chat-media.js";
import type { DownloadIdentity, Gateway } from "./gateway.js";
import { GLib, Pango } from "./gi.js";
import { chromeText, watchNativeI18n } from "./native-i18n.js";
import { button, clear, column, label } from "./ui.js";
import { exactWorkTarget } from "./work-actions.js";

interface Material extends DownloadIdentity { task: string; name: string; label: string; path: string }
function material(raw: unknown): Material | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const data = raw as Record<string, unknown>;
  if (!exactWorkTarget(data.task_id) || typeof data.name !== "string" || !data.name
    || data.name === "." || data.name === ".." || /[/\\\x00-\x1f\x7f]/u.test(data.name)
    || typeof data.size !== "number" || !Number.isSafeInteger(data.size) || data.size < 0
    || typeof data.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(data.sha256)
    || data.label !== undefined && typeof data.label !== "string") return;
  return { task: data.task_id, name: data.name, label: typeof data.label === "string" && data.label || data.name,
    size: data.size, sha256: data.sha256,
    path: `/api/tasks/${encodeURIComponent(data.task_id)}/artifacts/${encodeURIComponent(data.name)}` };
}

/** Question attachments are retained artifact references, never arbitrary supplied download URLs. */
export class QuestionMaterials {
  readonly widget = column(6);
  private readonly media: ChatMedia;
  private readonly unwatch: () => void;
  private signature?: string;
  private entries: Material[] = [];
  private incomplete = false;
  private generation = 0;
  private disposed = false;

  constructor(private readonly parent: any, gateway: Gateway) {
    this.media = new ChatMedia(gateway, (dialog, owner) => dialog.present(owner));
    this.unwatch = watchNativeI18n(() => this.paint());
    this.widget.set_visible(false);
  }

  update(raw: unknown): void {
    if (this.disposed) return;
    const signature = JSON.stringify(raw ?? null);
    if (signature === this.signature) return;
    this.signature = signature;
    this.generation++;
    this.media.close();
    const rows = Array.isArray(raw) ? raw : [];
    const parsed = rows.map(material);
    const unique = new Map<string, Material>(), conflicts = new Set<string>();
    for (const entry of parsed) if (entry) {
      const previous = unique.get(entry.path);
      if (previous && (previous.size !== entry.size || previous.sha256 !== entry.sha256)) conflicts.add(entry.path);
      else if (!previous) unique.set(entry.path, entry);
    }
    this.entries = [...unique.values()].filter((entry) => !conflicts.has(entry.path));
    this.incomplete = raw != null && !Array.isArray(raw) || parsed.some((entry) => !entry) || conflicts.size > 0;
    this.paint();
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;this.generation++;this.unwatch();this.media.close();
  }

  private paint(): void {
    if (this.disposed) return;
    clear(this.widget);
    this.widget.set_visible(this.entries.length > 0 || this.incomplete);
    if (!this.widget.visible) return;
    this.widget.append(label(chromeText("Question materials", undefined, "Материалы к вопросу"), "heading"));
    if (this.incomplete) this.widget.append(label(chromeText("Some question materials have no unambiguous recorded identity.", undefined,
      "Часть материалов вопроса не имеет однозначной сохранённой идентичности."), "warning"));
    const generation = this.generation;
    for (const entry of this.entries) {
      const description = label(`${entry.label}\n${entry.task} · ${entry.name}\n${GLib.format_size(entry.size)} · SHA-256 · ${entry.sha256}`);
      description.set_selectable(true);description.set_wrap_mode(Pango.WrapMode.WORD_CHAR);description.set_max_width_chars(64);
      this.widget.append(description);
      const open = button(chromeText("Open material…", undefined, "Открыть материал…"), () => {
        if (!this.disposed && generation === this.generation) this.media.openVerifiedArtifact(this.parent, entry.label, entry.path, entry, entry.name);
      });
      open.set_tooltip_text(entry.path);
      this.widget.append(open);
    }
  }
}
