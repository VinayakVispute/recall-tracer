"use client";

import { useState } from 'react';
import { Bar, BarChart, Cell, CartesianGrid, ReferenceArea, ReferenceLine, XAxis, YAxis } from 'recharts';
import type { IncidentReport } from '@server/tools/incident';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { cn } from '@/lib/utils';

const fmt = (n: number) => n.toLocaleString();
const shortDate = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const DAY = 864e5;

const stateConfig = {
  pull: { label: 'Pull', color: 'var(--destructive)' },
  gap: { label: 'No lot code', color: 'var(--chart-1)' },
  safe: { label: 'Cleared', color: 'var(--muted-foreground)' },
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
    <ChartContainer config={stateConfig} className="aspect-auto w-full" style={{ height: data.length * 34 + 56 }}>
      <BarChart data={data} layout="vertical" margin={{ left: 0, right: 8, top: 0, bottom: 0 }} barCategoryGap={6}>
        <CartesianGrid horizontal={false} />
        <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} />
        <YAxis
          type="category" dataKey="state" width={36} tickLine={false} axisLine={false}
          tick={({ x, y, payload }) => (
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
        <ChartTooltip
          cursor={{ fill: 'var(--muted)', opacity: 0.5 }}
          content={<ChartTooltipContent hideIndicator={false} formatter={(value, name, item) => (
            <div className="flex flex-1 items-center justify-between gap-4 leading-none">
              <span className="text-muted-foreground">{stateConfig[name as keyof typeof stateConfig]?.label}</span>
              <span className="font-mono font-medium tabular-nums">{value} stores, {fmt(item.payload[`${name}U`])} units</span>
            </div>
          )} />}
        />
        <ChartLegend content={<ChartLegendContent />} />
        {(['pull', 'gap', 'safe'] as const).map((k) => (
          <Bar key={k} dataKey={k} stackId="a" fill={`var(--color-${k})`} className="cursor-pointer" onClick={(d) => toggle((d as unknown as { state: string }).state)}>
            {data.map((d) => <Cell key={d.state} fillOpacity={active && active !== d.state ? 0.3 : 1} />)}
          </Bar>
        ))}
      </BarChart>
    </ChartContainer>
  );
}

const expConfig = {
  pull: { label: 'Contains the bad lot', color: 'var(--destructive)' },
  gap: { label: 'No lot code', color: 'var(--chart-1)' },
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
      <ChartContainer config={expConfig} className="aspect-auto h-52 w-full" role="img" aria-label={`Units delivered per day, ${shortDate(first)} to ${shortDate(last)}, with the shelf window and best-by date marked`}>
        <BarChart data={data} margin={{ left: 0, right: 8, top: 18, bottom: 0 }}>
          <CartesianGrid vertical={false} />
          <ReferenceArea x1={first} x2={shelfEnd} fill="var(--muted)" fillOpacity={0.5} ifOverflow="visible" label={{ value: 'On shelves', position: 'insideTopLeft', fontSize: 11, fill: 'var(--muted-foreground)' }} />
          {bb[0] >= first && bb[0] <= lastDay && <ReferenceLine x={bb[0]} stroke="var(--chart-2)" strokeDasharray="4 3" label={{ value: 'Best-by', position: 'insideTopRight', fontSize: 11, fill: 'var(--chart-2)' }} />}
          {today > first && today <= lastDay && <ReferenceLine x={today} stroke="var(--foreground)" strokeDasharray="2 3" label={{ value: 'Today', position: 'top', fontSize: 11, fill: 'var(--foreground)' }} />}
          <XAxis dataKey="date" tickLine={false} axisLine={false} tickFormatter={shortDate} minTickGap={16} />
          <YAxis width={36} tickLine={false} axisLine={false} allowDecimals={false} />
          <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, p) => shortDate(p[0].payload.date)} />} />
          <ChartLegend content={<ChartLegendContent />} />
          <Bar dataKey="pull" stackId="a" fill="var(--color-pull)" radius={[0, 0, 0, 0]} />
          <Bar dataKey="gap" stackId="a" fill="var(--color-gap)" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ChartContainer>
    </div>
  );
}
