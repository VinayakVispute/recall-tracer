"use client";

import type { RecordSources } from "@server/data/sources";
import { EvilPieChart } from "@/components/evilcharts/charts/recharts-pie-chart";
import type { ChartConfig } from "@/components/evilcharts/ui/recharts-chart";

const color = (token: string) => ({ light: [`var(${token})`], dark: [`var(${token})`] });

// One sector per record type, in the order a lot travels through the company.
const TYPES = [
  { key: "suppliers", label: "Suppliers", token: "--chart-5" },
  { key: "lots", label: "Ingredient lots", token: "--foreground" },
  { key: "batches", label: "Batches", token: "--destructive" },
  { key: "product_lots", label: "Product lots", token: "--chart-4" },
  { key: "products", label: "Products", token: "--chart-3" },
  { key: "plants", label: "Plants", token: "--chart-2" },
  { key: "dcs", label: "Distribution centres", token: "--chart-1" },
  { key: "stores", label: "Stores", token: "--muted-foreground" },
] as const;

const config = Object.fromEntries(TYPES.map((t) => [t.key, { label: t.label, colors: color(t.token) }])) satisfies ChartConfig;

/** What the company graph holds, by record type: the nodes the agent traces through. */
export function RecordsMix({ counts }: { counts: RecordSources["traceability"]["counts"] }) {
  const data = TYPES.map((t) => ({ type: t.key, records: counts[t.key] })).filter((d) => d.records > 0);
  const total = data.reduce((n, d) => n + d.records, 0);
  return (
    <div className="grid items-center gap-8 sm:grid-cols-[14rem_minmax(0,1fr)]">
      <div className="relative mx-auto size-56">
        <EvilPieChart data={data} dataKey="records" nameKey="type" config={config} className="aspect-square size-full">
          <EvilPieChart.Pie innerRadius="68%" outerRadius="100%" paddingAngle={2} cornerRadius={4} isClickable />
          <EvilPieChart.Tooltip variant="frosted-glass" />
        </EvilPieChart>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-medium tabular-nums">{total.toLocaleString("en-US")}</span>
          <span className="text-xs text-muted-foreground">records</span>
        </div>
      </div>
      <ul className="grid max-w-2xl gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
        {data.map((d) => {
          const t = TYPES.find((x) => x.key === d.type);
          return (
            <li key={d.type} className="flex items-center gap-2">
              <span className="size-2.5 shrink-0 rounded-sm" style={{ background: `var(${t?.token})` }} aria-hidden="true" />
              <span className="text-muted-foreground">{t?.label}</span>
              <span className="ml-auto font-medium tabular-nums">{d.records.toLocaleString("en-US")}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
