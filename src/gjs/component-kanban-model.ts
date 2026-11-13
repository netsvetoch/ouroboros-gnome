export type KanbanRecord = Record<string, unknown>;
export interface KanbanCard { id: string; key: string; label: string; column: string; index: number }
export interface KanbanColumn { id: string; label: string; known: boolean; cards: KanbanCard[] }
const record = (value: unknown): KanbanRecord => value && typeof value === "object" && !Array.isArray(value) ? value as KanbanRecord : {};

/** Group before pagination: anonymous IDs use the position within the original column. */
export function kanbanColumns(columns: unknown, cards: unknown): KanbanColumn[] {
  const declared = (Array.isArray(columns) ? columns : []).map(value => {
    const column = record(value), id = String(column.id || column.label || "");
    return { id, label: String(column.label || id), known: true, cards: [] as KanbanCard[] };
  });
  const groups = new Map<string, KanbanCard[]>();
  for (const column of declared) if (!groups.has(column.id)) groups.set(column.id, []);
  for (const value of Array.isArray(cards) ? cards : []) {
    const card = record(value), column = String(card.column || card.col || declared[0]?.id || "");
    const group = groups.get(column) ?? [];
    const index = group.length, id = String(card.id || `${column}-${index}`);
    group.push({ id, column, index, label: String(card.label || card.title || "—"),
      key: column + "\0" + id + (card.id ? "" : "\0" + JSON.stringify(card)) });
    groups.set(column, group);
  }
  const known = new Set(declared.map(column => column.id));
  return [...declared.map(column => ({ ...column, cards: groups.get(column.id)! })),
    ...[...groups].filter(([id]) => !known.has(id)).map(([id, cards]) => ({ id, label: `Неизвестная колонка · ${id || "без имени"}`, known: false, cards }))];
}
