export interface SenderFields {
  role?: unknown; source?: unknown; sender_label?: unknown; initiator?: unknown;
  system_type?: unknown; is_progress?: unknown;
}
export interface SenderCaption { english: string; russian: string; sender?: string }

/** A sender label is display metadata, never an owner identity or dispatch permission. */
export function chatSender(row: SenderFields, role: unknown = row.role): SenderCaption {
  if (role === "user") {
    if (typeof row.sender_label === "string" && row.sender_label.length)
      return { english: "{sender}", russian: row.sender_label, sender: row.sender_label };
    if (row.source === "telegram") return { english: "Telegram", russian: "Telegram" };
    return { english: "You", russian: "Вы" };
  }
  if (role === "system") {
    if (row.system_type === "task_summary") return { english: "Task Summary", russian: "Сводка задачи" };
    if (row.system_type === "skill_review") return { english: "Skill Review", russian: "Ревью навыка" };
    return { english: "System", russian: "Система" };
  }
  if (row.is_progress === true) return { english: "Thought", russian: "Ход работы" };
  if (row.initiator === "consciousness") return { english: "Ouroboros · Consciousness", russian: "Ouroboros · Сознание" };
  return { english: "Ouroboros", russian: "Ouroboros" };
}
