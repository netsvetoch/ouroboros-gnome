import { ChatMedia } from "./chat-media.js";
import { type DownloadIdentity, type Gateway, query } from "./gateway.js";
import { bindChrome, chromeText } from "./native-i18n.js";
import { button } from "./ui.js";

const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
interface Source extends DownloadIdentity { path: string; task: string; direct?: string; complete?: boolean }
function read(raw: unknown): Source | undefined {
  if (!object(raw) || raw.kind !== "task_source" || raw.root !== "artifact_store"
    || typeof raw.path !== "string" || !/^source_handles\/tool_results\/[A-Za-z0-9][A-Za-z0-9_.-]*\.json$/u.test(raw.path)
    || typeof raw.size !== "number" || !Number.isSafeInteger(raw.size) || raw.size < 0
    || typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(raw.sha256)
    || !raw.path.endsWith(`-${raw.sha256}.json`) || typeof raw.task_id !== "string" || !raw.task_id
    || raw.complete !== undefined && typeof raw.complete !== "boolean") return;
  const reader = object(raw.direct_read) ? raw.direct_read : object(raw.read) && raw.read.tool === "read_file" ? raw.read : undefined;
  const args = reader?.tool === "read_file" && object(reader.arguments) ? reader.arguments : undefined;
  let direct: string | undefined;
  if (args && (args.root === undefined || args.root === "artifact_store") && typeof args.path === "string") {
    const path = remotePath(args.path);
    if (path && path.endsWith("/" + raw.path)) direct = path;
  }
  return { path: raw.path, task: raw.task_id, size: raw.size, sha256: raw.sha256, direct, complete: raw.complete as boolean | undefined };
}
function remotePath(raw: string): string | undefined {
  if (!raw || /[\x00-\x1f\x7f]/u.test(raw)) return;
  const path = raw.replace(/\\/gu, "/");
  if (!(path.startsWith("/") || /^[A-Za-z]:\//u.test(path))) return;
  const body = path.replace(/^[A-Za-z]:/u, "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (body && body.split("/").some(part => !part || part === "." || part === "..")) return;
  return /^[A-Za-z]:\/$/u.test(path) ? path : path.replace(/\/+$/, "") || "/";
}
const comparison = (path: string): string => /^[A-Za-z]:\//u.test(path) || path.startsWith("//") ? path.toLowerCase() : path;
function boundFileRoute(gateway: Gateway, source: Source): (cancel: any) => Promise<string> {
  let captured: string | undefined;
  return async cancel => {
    const raw = await gateway.json<unknown>("GET", "/api/files/list?path=.", undefined, undefined, false, cancel);
    const root = object(raw) && typeof raw.root_path === "string" ? remotePath(raw.root_path) : undefined;
    if (!root) throw new Error(chromeText("The gateway did not publish a readable Files root.", undefined, "Шлюз не указал читаемый корень Files."));
    if (captured !== undefined && comparison(root) !== comparison(captured)) throw new Error(chromeText("The Files root changed. Reopen this retained output before reading it again.", undefined,
      "Корень Files изменился. Откройте сохранённый ответ заново перед следующим чтением."));
    const prefix = root.endsWith("/") ? root : root + "/", path = source.direct!;
    if (!comparison(path).startsWith(comparison(prefix))) throw new Error(chromeText("This retained output is outside the current Files root.", undefined,
      "Сохранённый ответ находится вне текущего корня Files."));
    captured ??= root;
    return "/api/files/download" + query({ path: path.slice(prefix.length) });
  };
}

type Append = (english: string, russian: string, params?: Record<string, string | number>, css?: string, target?: any) => void;
/** Reads an explicit owner-file address only; never creates a delegated consumption/patch receipt. */
export class RetainedOutputReaders {
  private readonly viewers = new Map<string, ChatMedia>();
  private readonly current = new Set<string>();
  private generation = 0;
  private readonly bindings: (() => void)[] = [];
  private closed = false;
  constructor(private readonly parent: any, private readonly gateway: Gateway) {}
  begin(): void { if (this.closed) return;this.generation++;this.current.clear();for (const release of this.bindings.splice(0)) release(); }
  append(target: any, raw: unknown, observation: boolean, append: Append): void {
    if (this.closed) return;
    append(observation ? "Retained terminal observation" : "Retained delegated output", observation ? "Сохранённое итоговое наблюдение" : "Сохранённый ответ делегированного запуска", undefined, "heading", target);
    const source = read(raw);
    if (!source) { append("The retained source identity could not be read.", "Идентичность сохранённого источника прочитать не удалось.", undefined, "warning", target);return; }
    append("Staging task · {value}", `Задача, сохранившая источник · ${source.task}`, { value: source.task }, undefined, target);
    append("Retained source · {value}", `Сохранённый источник · ${source.path}`, { value: source.path }, undefined, target);
    append("Source bytes · {n}", `Байты источника · ${source.size}`, { n: source.size }, undefined, target);
    append("Source SHA-256 · {value}", `SHA-256 источника · ${source.sha256}`, { value: source.sha256 }, undefined, target);
    if (observation) append("A complete terminal observation does not establish that the full output was collected.", "Полное итоговое наблюдение не подтверждает сбор всего ответа.", undefined, "dim-label", target);
    else if (source.complete === true) append("The receipt marks the retained output complete.", "Квитанция помечает сохранённый ответ полным.", undefined, undefined, target);
    else append(source.complete === false ? "The retained output is partial." : "Retained output completeness is not stated.", source.complete === false ? "Сохранённый ответ частичный." : "Полнота сохранённого ответа не указана.", undefined, "warning", target);
    if (!source.direct) { append("No explicit absolute file-reader address is published for this source.", "Для источника не опубликован явный абсолютный адрес файлового чтения.", undefined, "dim-label", target);return; }
    const key = JSON.stringify([observation, source.path, source.sha256, source.size, source.direct]);
    this.current.add(key);
    const generation = this.generation;
    const open = button(chromeText("Open retained source through Files…", undefined, "Открыть сохранённый источник через Files…"), () => {
      if (this.closed || generation !== this.generation || !this.current.has(key)) return;
      let media = this.viewers.get(key);
      if (!media) { media = new ChatMedia(this.gateway);this.viewers.set(key, media); }
      media.openVerifiedArtifact(this.parent, source.path.split("/").at(-1)!, boundFileRoute(this.gateway, source), source);
    });
    target.append(open);this.bindings.push(bindChrome(open, "label", "Open retained source through Files…"));
  }
  finish(): void { if (this.closed) return;for (const [key, media] of this.viewers) if (!this.current.has(key)) { media.close();this.viewers.delete(key); } }
  close(): void { if (this.closed) return;this.closed = true;this.generation++;for (const media of this.viewers.values()) media.close();this.viewers.clear();this.current.clear();for (const release of this.bindings.splice(0)) release(); }
}
