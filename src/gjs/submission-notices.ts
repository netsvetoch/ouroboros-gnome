export const notStarted = "Задача не запущена";

/** api_command's visible row may carry the caller's correlation key, not a router task ID. */
export function taskReferencePending(row: { system_type?: unknown; task_id_pending?: unknown }): boolean {
  return row.system_type === "skill_repair" || row.task_id_pending === true;
}

const labels: Record<string, string> = {
  task_not_started: notStarted,
  task_start_unconfirmed: "Запуск задачи не подтверждён",
  steer_not_delivered: "Уточнение не доставлено",
};

export function submissionNotice(type?: string): string | undefined {
  return type && Object.hasOwn(labels, type) ? labels[type] : undefined;
}

export function originAddressed(type?: string): boolean {
  return type === "relay_reply" || Boolean(submissionNotice(type));
}
