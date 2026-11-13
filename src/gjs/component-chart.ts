import { Gtk } from "./gi.js";
import { NativeChart } from "./native-chart.js";
import { chartDataView } from "./markdown-chart-view.js";
import { type ChartConfig } from "./markdown-chart.js";
import { column, label } from "./ui.js";

interface ChartSeries { label: string; values: (number | null)[] }

export function componentChart(title: string, unit: string, bars: boolean, labels: string[], series: ChartSeries[]): any {
  const config: ChartConfig = {
    type: bars ? "bar" : "line",
    data: { labels, datasets: series.map(item => ({ label: item.label, data: item.values, spanGaps: false })) },
    options: { responsive: true, maintainAspectRatio: false,
      ...(unit ? { scales: { y: { title: { display: true, text: unit } } } } : {}) },
  };
  const content = column(4);
  if (title) content.append(label(title, "heading"));
  if (series.some(item => item.values.some(value => value !== null))) content.append(new NativeChart(config, title || "График", {}).widget);
  else content.append(label("Нет данных для графика.", "dim-label"));
  const data = new Gtk.Expander({ label: "Таблица данных графика" });
  data.connect("notify::expanded", () => { if (data.expanded && !data.get_child()) data.set_child(chartDataView(config)); });
  content.append(data);
  return content;
}
