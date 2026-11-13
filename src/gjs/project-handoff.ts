import { object } from "./settings-write.js";

export interface ProjectTarget { id: string; chatId?: number; name?: string }

export function projectTarget(id: unknown, chat: unknown, name?: unknown): ProjectTarget | undefined {
  if (typeof id !== "string" || !/^[a-z0-9_.-]{1,64}$/u.test(id) || id === "." || id === "..") return undefined;
  if (chat !== undefined && (typeof chat !== "number" || !Number.isSafeInteger(chat) || chat <= 1)) return undefined;
  return { id, chatId: chat, name: typeof name === "string" && name.trim() ? name : undefined };
}

export function projectBinding(value: unknown): ProjectTarget | undefined {
  const row = object(value);
  return projectTarget(row.project_id, row.chat_id, row.project_name);
}

export function confirmedProjectBinding(value: unknown, task: string): ProjectTarget | undefined {
  const state = object(value);
  const bindings = object(state.task_bindings);
  if (bindings !== state.task_bindings || typeof state.task_bindings_revision !== "string" || !state.task_bindings_revision.trim()) {
    throw new Error("Шлюз не подтвердил полный снимок привязок задач.");
  }
  if (!Object.hasOwn(bindings, task)) return undefined;
  const target = projectBinding(bindings[task]);
  if (!target?.chatId) throw new Error("Шлюз вернул неполную привязку выбранной задачи.");
  return target;
}

export function projectMarker(value: unknown): ProjectTarget | undefined {
  const row = object(value);
  if (row.role !== "system" || !["project_started", "project_handoff", "project_completion_summary"].includes(String(row.system_type))) {
    return undefined;
  }
  const meta = object(row.progress_meta);
  return projectTarget(row.project_id ?? meta.project_id, undefined, row.project_name ?? meta.project_name);
}

export function projectNotice(value: unknown): string | undefined {
  switch (value) {
    case "durable": return "Шлюз сохранил квитанцию для доставки в Main.";
    case "already_delivered": return "Квитанция уже доставлена в Main.";
    case "unregistered": return "Квитанция отправлена в Main без гарантии доставки после перезапуска.";
    case "unavailable": return "Шлюз не смог отправить квитанцию в Main.";
    case "origin_unproven": return "Квитанция не записана. Для задачи нет подтверждённого исходного сообщения в Main.";
    case "unbound": return "При подготовке квитанции шлюз не подтвердил привязку.";
    case "not_routable": return "При подготовке квитанции комната проекта была недоступна.";
    default: return undefined;
  }
}

export function projectHandoff(value: unknown, task: string): { target: ProjectTarget; receipt: unknown } | undefined {
  const result = object(value);
  const project = object(result.project);
  const binding = object(result.binding);
  const target = projectTarget(project.id, project.chat_id, project.name);
  if (result.status !== "delivered" || !target?.chatId || binding.task_id !== task || binding.project_id !== target.id
    || binding.project_chat_id !== target.chatId || result.project_id !== target.id || result.chat_id !== target.chatId) return undefined;
  return { target, receipt: result.handoff_receipt };
}
