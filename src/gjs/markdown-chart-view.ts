import { Gtk } from "./gi.js";
import { parseMarkdownChart, type ChartConfig } from "./markdown-chart.js";
import { NativeChart } from "./native-chart.js";
import { codeView } from "./code-view.js";
import { componentTable } from "./component-table.js";
import { column, errorText, label } from "./ui.js";

export function chartDataView(config: ChartConfig): any {
  const records = config.data.datasets.flatMap((dataset, series) => dataset.data.map((value, index) => ({
    series: String(dataset.label ?? `Ряд ${series + 1}`), label: String(config.data.labels?.[index] ?? index + 1),
    value: value == null ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value),
  })));
  return componentTable([{ label: "Ряд", path: "series" }, { label: "Метка / точка", path: "label" }, { label: "Значение", path: "value" }], records);
}

export function markdownChartView(source: string): any {
  const box = column(6);
  try {
    const config = parseMarkdownChart(source);
    box.append(new NativeChart(config).widget);
    const data = new Gtk.Expander({ label: "Таблица данных графика" });
    data.connect("notify::expanded", () => { if (data.expanded && !data.get_child()) data.set_child(chartDataView(config)); });
    box.append(data);
  } catch (error) { box.append(label("Не удалось построить график: " + errorText(error), "dim-label")); }
  const raw = new Gtk.Expander({ label: "Исходник графика" });
  raw.connect("notify::expanded", () => { if (raw.expanded && !raw.get_child()) raw.set_child(codeView(source, "json")); });
  box.append(raw);
  return box;
}
