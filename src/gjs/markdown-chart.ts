export const markdownChartTypes = ["bar", "line", "pie", "doughnut", "polarArea", "radar", "scatter", "bubble"] as const;
export interface ChartConfig { type: string; data: { labels?: unknown[]; datasets: (Record<string, unknown> & { data: unknown[] })[] }; options: Record<string, any> }
const object = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value));

/** Same configuration boundary as the pinned gateway's parseChartConfig. */
export function parseMarkdownChart(source: string): ChartConfig {
  if (source.length > 32768) throw new Error("Исходник графика превышает предел 32768 символов.");
  const parsed = JSON.parse(source);
  if (!object(parsed)) throw new Error("Конфигурация графика должна быть объектом.");
  if (!(markdownChartTypes as readonly unknown[]).includes(parsed.type)) throw new Error("Неподдерживаемый тип графика.");
  if (!object(parsed.data)) throw new Error("Данные графика должны быть объектом.");
  if (!Array.isArray(parsed.data.datasets)) throw new Error("Нужен массив рядов графика.");
  if (parsed.data.datasets.length > 24) throw new Error("В графике допустимо до 24 рядов.");
  const datasets = parsed.data.datasets.map((dataset: unknown) => {
    if (!object(dataset) || !Array.isArray(dataset.data)) throw new Error("Каждый ряд должен содержать массив data.");
    if (dataset.data.length > 500) throw new Error("В ряду допустимо до 500 точек.");
    const safe: Record<string, any> & { data: unknown[] } = { data: [...dataset.data] };
    for (const key of ["label", "backgroundColor", "borderColor", "borderWidth", "fill", "tension"]) {
      if (Object.hasOwn(dataset, key)) safe[key] = dataset[key];
    }
    return safe;
  });
  if (parsed.data.labels !== undefined && !Array.isArray(parsed.data.labels)) throw new Error("Метки графика должны быть массивом.");
  if (parsed.data.labels?.length > 500) throw new Error("В графике допустимо до 500 меток.");
  return { type: parsed.type, data: { datasets, ...(parsed.data.labels === undefined ? {} : { labels: [...parsed.data.labels] }) },
    options: { ...(object(parsed.options) ? parsed.options : {}), responsive: true, maintainAspectRatio: false } };
}
