"use client";

import { useState } from 'react';
import { ReferenceArea, ReferenceLine } from 'recharts';
import type { IncidentReport } from '@server/tools/incident';
import { EvilBarChart } from '@/components/evilcharts/charts/recharts-bar-chart';
import type { ChartConfig } from '@/components/evilcharts/ui/recharts-chart';
import { ChartTooltip, ChartTooltipContent } from '@/components/evilcharts/ui/recharts-tooltip';
import { cn } from '@/lib/utils';

const fmt = (n: number) => n.toLocaleString();
const shortDate = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const DAY = 864e5;
/** Evil Charts colours are per theme; the app's theme tokens already switch with it, so both themes use the token. */
const color = (token: string) => ({ light: [`var(${token})`], dark: [`var(${token})`] });

const stateConfig = {
  pull: { label: 'Pull', colors: color('--destructive') },
  gap: { label: 'No lot code', colors: color('--chart-1') },
  safe: { label: 'Cleared', colors: color('--muted-foreground') },
} satisfies ChartConfig;

export function StateBars({ r, active, onPick }: { r: IncidentReport; active?: string; onPick: (state?: string) => void }) {
  const by = new Map<string, { state: string; pull: number; gap: number; safe: number; pullU: number; gapU: number; safeU: number }>();
  for (const s of r.stores) {
    const row = by.get(s.region) ?? { state: s.region, pull: 0, gap: 0, safe: 0, pullU: 0, gapU: 0, safeU: 0 };
    const k = s.status === 'recall' ? 'pull' : s.status;
    row[k]++;
    row[`${k}U`] += s.status === 'safe' ? s.shipments.reduce((n, x) => n + x.units, 0) : s.units_at_risk;
    by.set(s.region, row);
  }
  const data = [...by.values()].sort((a, b) => b.pull + b.gap - (a.pull + a.gap) || b.pullU - a.pullU || a.state.localeCompare(b.state));
  const toggle = (st: string) => onPick(active === st ? undefined : st);

  return (
    <div style={{ height: data.length * 38 + 64 }}>
      <EvilBarChart data={data} config={stateConfig} layout="horizontal" stackType="stacked" barRadius={4} barCategoryGap={8} animationType="left-to-right"
        className="aspect-auto h-full w-full"
        chartProps={{ margin: { left: 0, right: 8, top: 0, bottom: 0 }, className: 'cursor-pointer', onClick: (s) => { if (s?.activeLabel) toggle(String(s.activeLabel)); } }}>
        <EvilBarChart.Grid />
        <EvilBarChart.XAxis allowDecimals={false} />
        <EvilBarChart.YAxis
          dataKey="state" width={44}
          tick={({ x, y, payload }) => (
            // A real control per state, so the filter works from the keyboard too.
            <g
              transform={`translate(${x},${y})`} role="button" tabIndex={0} className="cursor-pointer outline-none"
              aria-pressed={active === payload.value} aria-label={`Filter stores to ${payload.value}`}
              onClick={() => toggle(payload.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(payload.value); } }}
            >
              <text x={-4} dy={5} textAnchor="end" className={cn('fill-foreground text-sm font-bold', active === payload.value && 'fill-destructive')}>{payload.value}</text>
            </g>
          )}
        />
        <ChartTooltip cursor={{ fill: 'var(--muted)', opacity: 0.4 }} content={
          <ChartTooltipContent variant="frosted-glass" formatter={(value, name, item) => (
            <div className="flex flex-1 items-center justify-between gap-4 leading-none">
              <span className="text-muted-foreground">{stateConfig[name as keyof typeof stateConfig]?.label}</span>
              <span className="font-mono font-medium tabular-nums">{value} stores, {fmt(item.payload[`${name}U`])} units</span>
            </div>
          )} />
        } />
        <EvilBarChart.Legend variant="rounded-square" align="left" verticalAlign="bottom" />
        <EvilBarChart.Bar dataKey="pull" variant="hatched" glowing />
        <EvilBarChart.Bar dataKey="gap" variant="hatched" />
        <EvilBarChart.Bar dataKey="safe" variant="hatched" />
      </EvilBarChart>
    </div>
  );
}

const expConfig = {
  pull: { label: 'Contains the bad lot', colors: color('--destructive') },
  gap: { label: 'No lot code', colors: color('--chart-1') },
} satisfies ChartConfig;

export function Exposure({ r }: { r: IncidentReport }) {
  const [now] = useState(() => Date.now());
  const perDay = new Map<string, { pull: number; gap: number }>();
  let deliveries = 0;
  const add = (date: string, k: 'pull' | 'gap', units: number) => {
    const d = perDay.get(date) ?? { pull: 0, gap: 0 };
    d[k] += units; perDay.set(date, d); deliveries++;
  };
  for (const st of r.stores) {
    st.shipments.filter((s) => s.affected).forEach((s) => add(s.shipped_at, 'pull', s.units));
    st.untracked.forEach((u) => add(u.shipped_at, 'gap', u.units));
  }
  if (!perDay.size) return null;

  const sent = [...perDay.keys()].sort();
  const first = sent[0], last = sent.at(-1)!;
  const total = [...perDay.values()].reduce((n, d) => n + d.pull + d.gap, 0);
  const today = new Date(now).toISOString().slice(0, 10);
  const bb = r.product_lots.filter((p) => p.affected).map((p) => p.best_by).sort();
  const inDate = bb.filter((d) => Date.parse(d) >= now).length;
  const onShelf = Math.round((now - Date.parse(first)) / DAY);

  // Axis runs to the earliest best-by (capped) so the end of the shelf window is visible.
  const end = [last, today, bb[0] ?? last].reduce((a, b) => (a > b ? a : b));
  const span = Math.min(Math.round((Date.parse(end) - Date.parse(first)) / DAY), 30);
  const days = Array.from({ length: span + 1 }, (_, i) => new Date(Date.parse(first) + i * DAY).toISOString().slice(0, 10));
  const data = days.map((date) => ({ date, pull: perDay.get(date)?.pull ?? 0, gap: perDay.get(date)?.gap ?? 0 }));
  const lastDay = days.at(-1)!;
  const shelfEnd = today < lastDay ? today : lastDay;

  const stats = [
    { k: 'Deliveries to stores', v: `${shortDate(first)} to ${shortDate(last)}`, s: `${deliveries} deliveries, ${fmt(total)} units` },
    { k: 'Time on shelves', v: `up to ${onShelf} days`, s: 'product is sold and eaten daily' },
    bb.length ? { k: 'Best-by dates', v: `${shortDate(bb[0])} to ${shortDate(bb.at(-1)!)}`, s: inDate === bb.length ? 'all lots still within date' : `${inDate} of ${bb.length} lots still within date` } : null,
  ].filter((x) => x !== null);

  return (
    <div>
      <dl className="mb-3 grid gap-2 sm:grid-cols-3">
        {stats.map((x) => (
          <div key={x.k}>
            <dt className="text-xs font-medium text-muted-foreground">{x.k}</dt>
            <dd className="m-0 text-sm font-semibold">{x.v}<span className="block text-xs font-normal text-muted-foreground">{x.s}</span></dd>
          </div>
        ))}
      </dl>
      <div className="h-60" role="img" aria-label={`Units delivered per day, ${shortDate(first)} to ${shortDate(last)}, with the shelf window and best-by date marked`}>
        <EvilBarChart data={data} config={expConfig} stackType="stacked" barRadius={4} className="aspect-auto h-full w-full"
          chartProps={{ margin: { left: 0, right: 8, top: 18, bottom: 0 } }}>
          <ReferenceArea x1={first} x2={shelfEnd} fill="var(--muted)" fillOpacity={0.35} ifOverflow="visible" label={{ value: 'On shelves', position: 'insideTopLeft', fontSize: 11, fill: 'var(--muted-foreground)' }} />
          {bb[0] >= first && bb[0] <= lastDay && <ReferenceLine x={bb[0]} stroke="var(--chart-2)" strokeDasharray="4 3" label={{ value: 'Best-by', position: 'insideTopRight', fontSize: 11, fill: 'var(--chart-2)' }} />}
          {today > first && today <= lastDay && <ReferenceLine x={today} stroke="var(--foreground)" strokeDasharray="2 3" label={{ value: 'Today', position: 'top', fontSize: 11, fill: 'var(--foreground)' }} />}
          <EvilBarChart.Grid />
          <EvilBarChart.XAxis dataKey="date" tickFormatter={shortDate} minTickGap={16} />
          <EvilBarChart.YAxis width={36} allowDecimals={false} />
          <ChartTooltip cursor={{ fill: 'var(--muted)', opacity: 0.4 }} content={
            <ChartTooltipContent variant="frosted-glass" labelFormatter={(_, p) => `${shortDate(p[0].payload.date)} · units delivered`} />
          } />
          <EvilBarChart.Legend variant="rounded-square" align="left" verticalAlign="bottom" />
          <EvilBarChart.Bar dataKey="pull" variant="gradient" glowing />
          <EvilBarChart.Bar dataKey="gap" variant="gradient" />
        </EvilBarChart>
      </div>
    </div>
  );
}
