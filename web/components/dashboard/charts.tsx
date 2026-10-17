"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import cytoscape from 'cytoscape';
import type { IncidentReport } from '@server/tools/incident';
import { cn } from '@/lib/utils';

type Report = IncidentReport;
const fmt = (n: number) => n.toLocaleString();
const shortDate = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** Resolves a theme CSS variable (oklch) to an rgba() string by painting it on a 1x1 canvas, so cytoscape can parse it. */
function themeColor(name: string): string {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgba(${r},${g},${b},${a / 255})`;
}

// Diagonal stripes for "no lot code" (gap) so it differs from affected by pattern, not only color.
const HATCH = 'repeating-linear-gradient(45deg, var(--chart-1) 0 3px, var(--muted-foreground) 3px 4px)';

/** Tooltip shared by the charts: a fixed-position card that follows the pointer. */
export function useTip() {
  const [tip, setTip] = useState<{ x: number; y: number; body: React.ReactNode } | null>(null);
  const show = (e: React.MouseEvent, body: React.ReactNode) => setTip({ x: e.clientX, y: e.clientY, body });
  const el = tip && (
    <div className="pointer-events-none fixed z-50 max-w-70 rounded-md border bg-popover px-2.5 py-2 text-xs/relaxed text-popover-foreground shadow-md" style={{ left: tip.x + 14, top: tip.y + 14 }}>{tip.body}</div>
  );
  return { show, hide: () => setTip(null), el };
}

// --- Flow: units from the lot through batches and rework to product lots and states ---------

type FNode = { id: string; col: number; kind: 'lot' | 'batch' | 'pl' | 'gap' | 'state'; label: string; sub?: string; value: number; y: number; h: number };
type FLink = { s: string; t: string; value: number; kind: 'flow' | 'gap'; note?: string; sy: number; ty: number };

export function FlowChart({ r, focus }: { r: Report; focus?: string }) {
  const W = 920, H = 380, NODE = 12, PAD = 8;
  const { show, hide, el } = useTip();
  const [hover, setHover] = useState<string>();

  const { nodes, links } = useMemo(() => {
    // Units each affected product lot shipped, per state.
    const plState = new Map<string, Map<string, number>>();
    const gapState = new Map<string, number>();
    for (const st of r.stores) {
      for (const s of st.shipments) if (s.affected) {
        const m = plState.get(s.lot) ?? new Map();
        m.set(st.region, (m.get(st.region) ?? 0) + s.units);
        plState.set(s.lot, m);
      }
      for (const u of st.untracked) gapState.set(st.region, (gapState.get(st.region) ?? 0) + u.units);
    }
    const shipped = (pl: string) => [...(plState.get(pl)?.values() ?? [])].reduce((a, b) => a + b, 0);
    const produced = r.lineage.filter((e) => e.type === 'PRODUCED');
    const batchValue = (b: string): number =>
      produced.filter((e) => e.source === b).reduce((n, e) => n + shipped(e.target), 0) +
      r.lineage.filter((e) => e.type === 'REWORKED_INTO' && e.source === b).reduce((n, e) => n + batchValue(e.target), 0);

    const N: FNode[] = [], L: Omit<FLink, 'sy' | 'ty'>[] = [];
    const batchInfo = new Map(r.batches.map((b) => [b.id, b]));
    const plInfo = new Map(r.product_lots.map((p) => [p.id, p]));
    N.push({ id: r.lot.code, col: 0, kind: 'lot', label: r.lot.code, sub: r.lot.ingredient, value: 0, y: 0, h: 0 });
    for (const e of r.lineage) {
      if (e.type === 'USED_IN') {
        N.push({ id: e.target, col: 1, kind: 'batch', label: e.target, sub: batchInfo.get(e.target)?.site.split(',')[0], value: batchValue(e.target), y: 0, h: 0 });
        L.push({ s: e.source, t: e.target, value: batchValue(e.target), kind: 'flow', note: `${e.qty_kg} kg of ${r.lot.code} used` });
      } else if (e.type === 'REWORKED_INTO') {
        N.push({ id: e.target, col: 2, kind: 'batch', label: e.target, sub: 'rework', value: batchValue(e.target), y: 0, h: 0 });
        L.push({ s: e.source, t: e.target, value: batchValue(e.target), kind: 'flow', note: `${e.qty_kg} kg of leftovers reworked` });
      } else {
        const p = plInfo.get(e.target);
        N.push({ id: e.target, col: 3, kind: 'pl', label: e.target, sub: p?.product, value: shipped(e.target), y: 0, h: 0 });
        L.push({ s: e.source, t: e.target, value: shipped(e.target), kind: 'flow', note: `${fmt(e.units ?? 0)} units produced, ${fmt(shipped(e.target))} shipped` });
      }
    }
    const gapTotal = [...gapState.values()].reduce((a, b) => a + b, 0);
    if (gapTotal) N.push({ id: 'gap', col: 3, kind: 'gap', label: 'No lot code', sub: [...new Set(r.stores.flatMap((s) => s.untracked.map((u) => u.sku)))].join(', '), value: gapTotal, y: 0, h: 0 });
    const states = new Map<string, number>();
    plState.forEach((m, pl) => m.forEach((v, st) => { states.set(st, (states.get(st) ?? 0) + v); L.push({ s: pl, t: `st:${st}`, value: v, kind: 'flow' }); }));
    gapState.forEach((v, st) => { states.set(st, (states.get(st) ?? 0) + v); L.push({ s: 'gap', t: `st:${st}`, value: v, kind: 'gap', note: 'shipped without a lot code' }); });
    [...states].sort((a, b) => b[1] - a[1]).forEach(([st, v]) => N.push({ id: `st:${st}`, col: 4, kind: 'state', label: st, sub: `${r.stores.filter((s) => s.region === st && s.status !== 'safe').length} stores`, value: v, y: 0, h: 0 }));
    N[0].value = N.filter((n) => n.col === 1).reduce((a, n) => a + n.value, 0);

    // Layout: stack each column, one shared units→pixels scale.
    const cols = [0, 1, 2, 3, 4].map((c) => N.filter((n) => n.col === c));
    const k = Math.min(...cols.filter((c) => c.length).map((c) => (H - PAD * (c.length - 1)) / c.reduce((a, n) => a + n.value, 0)));
    cols.forEach((c) => {
      const total = c.reduce((a, n) => a + n.value * k, 0) + PAD * (c.length - 1);
      let y = (H - total) / 2;
      c.forEach((n) => { n.h = Math.max(2, n.value * k); n.y = y; y += n.h + PAD; });
    });
    const byId = new Map(N.map((n) => [n.id, n]));
    const out = new Map<string, number>(), inn = new Map<string, number>();
    const links: FLink[] = L
      .sort((a, b) => byId.get(a.t)!.y - byId.get(b.t)!.y)
      .map((l) => {
        const sy = byId.get(l.s)!.y + (out.get(l.s) ?? 0);
        out.set(l.s, (out.get(l.s) ?? 0) + l.value * k);
        return { ...l, sy, ty: 0 };
      })
      .sort((a, b) => byId.get(a.s)!.y - byId.get(b.s)!.y)
      .map((l) => {
        const ty = byId.get(l.t)!.y + (inn.get(l.t) ?? 0);
        inn.set(l.t, (inn.get(l.t) ?? 0) + l.value * k);
        return { ...l, ty };
      });
    links.forEach((l) => ((l as FLink & { w: number }).w = l.value * k));
    return { nodes: N, links: links as (FLink & { w: number })[] };
  }, [r]);

  const X = (col: number) => [10, 190, 330, 520, 790][col]; // product-lot labels need the widest gap
  const lit = hover ?? focus;
  const touches = (l: FLink) => !lit || l.s === lit || l.t === lit;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H + 24}`} className="block h-auto w-full" role="img" aria-label={`Flow of units from ${r.lot.code} to states`}>
        <defs>
          <pattern id="hatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <rect width="6" height="6" fill="var(--chart-1)" opacity=".35" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--muted-foreground)" strokeWidth="2" opacity=".55" />
          </pattern>
        </defs>
        {['Bad lot', 'Batches made with it', 'Rework', 'Product lots', 'States (units delivered)'].map((t, c) => (
          <text key={t} x={X(c)} y={H + 20} className="fill-muted-foreground text-[11px] font-medium">{t}</text>
        ))}
        {links.map((l, i) => {
          const s = nodes.find((n) => n.id === l.s)!, t = nodes.find((n) => n.id === l.t)!;
          const x0 = X(s.col) + NODE, x1 = X(t.col), xm = (x0 + x1) / 2, w = (l as FLink & { w: number }).w;
          const d = `M${x0},${l.sy} C${xm},${l.sy} ${xm},${l.ty} ${x1},${l.ty} L${x1},${l.ty + w} C${xm},${l.ty + w} ${xm},${l.sy + w} ${x0},${l.sy + w} Z`;
          return (
            <path key={i} d={d} className={cn('transition-opacity',
                l.kind === 'flow' ? 'fill-destructive/30 hover:fill-destructive/50' : 'stroke-muted-foreground stroke-[0.6] [stroke-dasharray:3_2]')}
              style={l.kind === 'gap' ? { fill: 'url(#hatch)' } : undefined} opacity={touches(l) ? 1 : 0.15}
              onMouseMove={(e) => show(e, <><b>{l.s === 'gap' ? 'No lot code' : l.s} → {l.t.replace('st:', '')}</b><br />{fmt(l.value)} units{l.note ? <><br />{l.note}</> : null}</>)}
              onMouseLeave={hide} />
          );
        })}
        {nodes.map((n) => (
          <g key={n.id} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => { setHover(undefined); hide(); }}
            onMouseMove={(e) => show(e, <><b>{n.label}</b>{n.sub ? ` · ${n.sub}` : ''}<br />{fmt(n.value)} units shipped downstream</>)}>
            <rect x={X(n.col)} y={n.y} width={NODE} height={n.h} rx={3} className={cn(
              n.kind === 'state' ? 'fill-foreground' : n.kind === 'gap' ? 'fill-chart-1 stroke-muted-foreground [stroke-dasharray:3_2]' : 'fill-destructive')} />
            <text x={X(n.col) + NODE + 6} y={n.y + n.h / 2} dy="0.35em" className="fill-foreground stroke-card stroke-[3px] text-xs font-semibold [paint-order:stroke]">
              {n.label}<tspan className="fill-muted-foreground font-normal">{n.h > 14 && n.sub && n.kind !== 'pl' ? `  ${n.sub}` : ''}</tspan>
              {n.kind === 'state' && <tspan className="fill-muted-foreground font-normal">{`  ${fmt(n.value)} u`}</tspan>}
            </text>
          </g>
        ))}
      </svg>
      {el}
    </div>
  );
}

// --- By state: stacked bars, click to filter the store table ----------------

type Store = Report['stores'][number];

export function StateBars({ r, active, onPick }: { r: Report; active?: string; onPick: (state?: string) => void }) {
  const by = new Map<string, Store[]>();
  r.stores.forEach((s) => by.set(s.region, [...(by.get(s.region) ?? []), s]));
  const rows = [...by].map(([st, list]) => ({
    st, list,
    n: { recall: list.filter((s) => s.status === 'recall').length, gap: list.filter((s) => s.status === 'gap').length, safe: list.filter((s) => s.status === 'safe').length },
    units: list.reduce((a, s) => a + s.units_at_risk, 0),
    cities: [...new Set(list.map((s) => s.city))].sort().join(', '),
  })).sort((a, b) => b.n.recall + b.n.gap - (a.n.recall + a.n.gap) || b.units - a.units);
  const max = Math.max(...rows.map((x) => x.list.length));
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {rows.map((x) => (
        <li key={x.st} className={cn('grid cursor-pointer grid-cols-[34px_minmax(0,1fr)_150px] items-center gap-2.5 rounded-md px-1 py-1.5 hover:bg-muted', active === x.st && 'bg-muted')} onClick={() => onPick(active === x.st ? undefined : x.st)} title={x.cities}>
          <span className={cn('text-base font-bold', active === x.st && 'text-destructive')}>{x.st}</span>
          <span className="block"><span className="flex h-4 gap-0.5" style={{ width: `${(100 * x.list.length) / max}%` }}>
            {(['recall', 'gap', 'safe'] as const).map((k) => x.n[k] ? (
              <i key={k} className={cn('block h-full rounded-xs', k === 'recall' && 'bg-destructive', k === 'safe' && 'bg-muted-foreground/50')}
                style={{ width: `${(100 * x.n[k]) / x.list.length}%`, ...(k === 'gap' ? { background: HATCH } : {}) }} />
            ) : null)}
          </span></span>
          <span className="text-xs/tight"><b>{x.n.recall + x.n.gap}</b> of {x.list.length} pull<span className="block truncate text-[11.5px] text-muted-foreground">{fmt(x.units)} units, {x.cities}</span></span>
        </li>
      ))}
    </ul>
  );
}

// --- Exposure: when affected product reached shelves, and how long it stays in date ---

export function Exposure({ r }: { r: Report }) {
  const [now] = useState(() => Date.now());
  const pts = r.stores.flatMap((st) => [
    ...st.shipments.filter((s) => s.affected).map((s) => ({ date: s.shipped_at, units: s.units })),
    ...st.untracked.map((u) => ({ date: u.shipped_at, units: u.units })),
  ]);
  if (!pts.length) return null;
  const dates = pts.map((p) => p.date).sort();
  const t0 = Date.parse(dates[0]), t1 = Date.parse(dates.at(-1)!);
  const days = Array.from({ length: Math.round((t1 - t0) / 864e5) + 1 }, (_, i) => new Date(t0 + i * 864e5).toISOString().slice(0, 10));
  const perDay = days.map((d) => pts.filter((p) => p.date === d).reduce((n, p) => n + p.units, 0));
  const max = Math.max(...perDay);
  const onShelf = Math.round((now - t0) / 864e5);
  const bb = r.product_lots.filter((p) => p.affected).map((p) => p.best_by).sort();
  const inDate = bb.filter((d) => Date.parse(d) >= now).length;
  return (
    <div>
      <dl className="mb-3 grid gap-2">
        <div className="grid grid-cols-[150px_1fr] items-baseline gap-2.5"><dt className="text-xs font-medium text-muted-foreground">Deliveries to stores</dt><dd className="m-0 text-base font-semibold">{shortDate(dates[0])} to {shortDate(dates.at(-1)!)}<span className="block text-xs font-normal text-muted-foreground">{pts.length} deliveries, {fmt(pts.reduce((n, p) => n + p.units, 0))} units</span></dd></div>
        <div className="grid grid-cols-[150px_1fr] items-baseline gap-2.5"><dt className="text-xs font-medium text-muted-foreground">Time on shelves</dt><dd className="m-0 text-base font-semibold">up to {onShelf} days<span className="block text-xs font-normal text-muted-foreground">product is sold and eaten daily</span></dd></div>
        <div className="grid grid-cols-[150px_1fr] items-baseline gap-2.5"><dt className="text-xs font-medium text-muted-foreground">Best-by dates</dt><dd className="m-0 text-base font-semibold">{shortDate(bb[0])} to {shortDate(bb.at(-1)!)}<span className="block text-xs font-normal text-muted-foreground">{inDate === bb.length ? 'all lots still within date' : `${inDate} of ${bb.length} lots still within date`}</span></dd></div>
      </dl>
      <div className="flex h-17.5 items-end gap-1 border-b pb-4" role="img" aria-label="Units delivered per day">
        {days.map((d, i) => (
          <div key={d} className="relative flex h-full flex-1 flex-col justify-end" title={`${shortDate(d)}: ${fmt(perDay[i])} units`}>
            <i className="block rounded-t-sm bg-destructive" style={{ height: `${perDay[i] ? Math.max(4, (100 * perDay[i]) / max) : 0}%` }} />
            <span className="absolute inset-x-0 -bottom-4 text-center text-[10.5px] text-muted-foreground">{shortDate(d).replace(/^\w+ /, '')}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Network: every record as a node, revealed step by step as the agent works --------

type Palette = Record<'destructive' | 'chart1' | 'chart2' | 'chart3' | 'fg' | 'muted' | 'border' | 'bg' | 'card', string>;
const readPalette = (): Palette => ({
  destructive: themeColor('--destructive'), chart1: themeColor('--chart-1'), chart2: themeColor('--chart-2'), chart3: themeColor('--chart-3'),
  fg: themeColor('--foreground'), muted: themeColor('--muted-foreground'), border: themeColor('--border'), bg: themeColor('--background'), card: themeColor('--card'),
});
const kindColor = (p: Palette): Record<string, string> => ({
  lot: p.destructive, batch: p.destructive, 'product-lot': p.destructive, 'store-affected': p.destructive,
  product: p.chart1, 'store-gap': p.chart1, 'store-safe': p.muted, 'product-lot-clean': p.border,
  site: p.chart2, dc: p.chart2, 'lot-clean': p.border,
});
const edgeStyle = (p: Palette): Record<string, { color: string; style?: string }> => ({
  affected: { color: p.destructive }, untracked: { color: p.chart1, style: 'dashed' }, clean: { color: p.border },
  held: { color: p.chart2, style: 'dotted' }, origin: { color: p.chart3 },
});
type Elements = { nodes: { data: { id: string; kind: string; stage: string; depth: number; label?: string } }[]; edges: { data: { id: string; source: string; target: string; kind: string; stage: string; depth: number } }[] };
const HOP_MS = 650;

/**
 * `stages` is the ordered list of agent steps completed so far ('start' first). Elements appear when their
 * stage completes; the forward trace is staggered hop by hop so the spread is visible. Shrinking `stages` replays.
 */
export function NetworkGraph({ lot, stages, animating, focus, onPick }: { lot: string; stages: string[]; animating: boolean; focus?: string; onPick: (store: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core>(null);
  const revealed = useRef(new Set<string>());
  const timers = useRef<number[]>([]);
  const [els, setEls] = useState<Elements>();
  useEffect(() => { fetch(`/graph/${lot}`).then((r) => r.json()).then(setEls); }, [lot]);

  useEffect(() => {
    if (!els || !ref.current) return;
    const pal = readPalette(), COLOR = kindColor(pal), EDGE = edgeStyle(pal);
    const font = getComputedStyle(document.body).fontFamily;
    const cy = cytoscape({
      container: ref.current,
      elements: [...els.nodes, ...els.edges],
      layout: { name: 'preset', positions: layered(els) as never },
      style: [
        { selector: 'node', style: { 'background-color': (n: cytoscape.NodeSingular) => COLOR[n.data('kind')] ?? pal.muted, width: 11, height: 11, label: (n: cytoscape.NodeSingular) => n.data('label') ?? n.data('id'), 'font-size': 8, 'font-family': font, color: pal.fg, 'text-valign': 'bottom', 'text-margin-y': 2, 'transition-property': 'opacity, width, height', 'transition-duration': 350 } },
        { selector: 'node[kind = "lot"]', style: { width: 22, height: 22, 'font-size': 11, 'font-weight': 600 } },
        { selector: 'node[kind = "site"], node[kind = "dc"]', style: { shape: 'round-rectangle', width: 16, height: 16 } },
        { selector: 'node[kind = "lot-clean"]', style: { width: 7, height: 7, 'font-size': 6 } },
        { selector: 'edge', style: { width: 1, 'line-color': (e: cytoscape.EdgeSingular) => EDGE[e.data('kind')]?.color ?? pal.border, 'target-arrow-color': (e: cytoscape.EdgeSingular) => EDGE[e.data('kind')]?.color ?? pal.border, 'line-style': ((e: cytoscape.EdgeSingular) => EDGE[e.data('kind')]?.style ?? 'solid') as never, 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'arrow-scale': 0.5, 'transition-property': 'opacity', 'transition-duration': 350 } },
        { selector: 'edge[kind = "affected"], edge[kind = "untracked"], edge[kind = "held"]', style: { width: 1.4 } },
        { selector: 'edge[kind = "origin"]', style: { width: 1.2, opacity: 0.9 } },
        { selector: '.flowing', style: { 'line-style': 'dashed', 'line-dash-pattern': [6, 4] } },
        { selector: '.verified', style: { 'border-width': 2, 'border-color': pal.chart1 } },
        { selector: '.noticed', style: { 'border-width': 2, 'border-color': pal.fg } },
        { selector: '.just', style: { width: 18, height: 18 } },
        { selector: '.hidden', style: { opacity: 0, events: 'no' } },
        { selector: '.faded', style: { opacity: 0.25 } },
        { selector: '.dim', style: { opacity: 0.1 } },
      ],
      userZoomingEnabled: false, // keep the mouse wheel for page scroll
    });
    cy.elements().addClass('hidden');
    revealed.current = new Set();
    if (process.env.NODE_ENV !== 'production') (window as unknown as { cy: typeof cy }).cy = cy; // lets the demo recorder click nodes
    cy.on('tap', (e) => {
      cy.elements().removeClass('dim');
      if (e.target === cy) return;
      cy.elements().not(e.target.predecessors().add(e.target)).not('.hidden').addClass('dim');
      if (String(e.target.data('kind')).startsWith('store')) onPick(e.target.id());
    });
    cyRef.current = cy;
    return () => { cy.destroy(); timers.current.forEach(clearTimeout); };
  }, [els]);

  // Reveal newly completed stages; a shrunk list (replay) hides everything again.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const want = new Set(stages);
    if ([...revealed.current].some((s) => !want.has(s))) {
      timers.current.forEach(clearTimeout); timers.current = [];
      cy.elements().addClass('hidden').removeClass('verified noticed faded flowing just');
      revealed.current = new Set();
    }
    const instant = revealed.current.size === 0 && stages.length > 2; // a saved run: show it all at once
    for (const stage of stages) {
      if (revealed.current.has(stage)) continue;
      revealed.current.add(stage);
      const show = (sel: string, delay: number, cls?: string) => {
        const t = window.setTimeout(() => {
          const e = cy.elements(sel);
          e.removeClass('hidden');
          if (cls) e.addClass(cls);
          e.nodes().addClass('just'); window.setTimeout(() => e.nodes().removeClass('just'), 500);
        }, instant ? 0 : delay);
        timers.current.push(t);
      };
      if (stage === 'draft_recall_notice') { show('node[kind = "store-affected"], node[kind = "store-gap"]', 0, 'noticed'); continue; }
      if (stage === 'trace_backward') {
        show('[stage = "trace_backward"]', 0);
        show('node[kind = "store-safe"]', 600, 'verified');
        timers.current.push(window.setTimeout(() => cy.elements('edge[kind = "origin"], node[kind = "lot-clean"]').addClass('faded'), instant ? 0 : 3200));
        continue;
      }
      const depths = [...new Set(cy.elements(`[stage = "${stage}"]`).map((e) => e.data('depth') as number))].sort((a, b) => a - b);
      depths.forEach((d, i) => show(`[stage = "${stage}"][depth = ${d}]`, i * HOP_MS, stage === 'trace_forward' ? 'flowing' : undefined));
    }
  }, [stages, els]);

  // While the agent works, the affected edges carry a moving dash so the flow reads as motion.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    if (!animating) { cy.edges().removeClass('flowing'); return; }
    let off = 0;
    const t = window.setInterval(() => { off -= 1; cy.edges('.flowing').style('line-dash-offset', off); }, 60);
    return () => clearInterval(t);
  }, [animating, els]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !focus) return;
    const n = cy.$id(focus);
    if (n.nonempty()) { cy.elements().removeClass('dim'); cy.elements().not(n.predecessors().add(n)).not('.hidden').addClass('dim'); }
  }, [focus, els]);
  return <div className="h-130" ref={ref} />;
}

const ROW = 30, COLW = 210;
/** Columns: ingredient lots → batches (rework one step right) → product lots → plants and DCs → stores in four sub-columns. */
function layered({ nodes, edges }: Elements) {
  const reworked = new Set(edges.filter((e) => e.data.source.startsWith('B-') && e.data.target.startsWith('B-')).map((e) => e.data.target));
  const order = ['store-affected', 'store-gap', 'store-safe'];
  const stores = nodes.filter((n) => n.data.kind.startsWith('store')).sort((a, b) => order.indexOf(a.data.kind) - order.indexOf(b.data.kind));
  const col = (kind: string, id: string) =>
    kind === 'lot' || kind === 'lot-clean' ? 0 : kind === 'batch' ? (reworked.has(id) ? 1.6 : 1) : kind.startsWith('product') ? 2.4 : kind === 'site' || kind === 'dc' ? 3.2 : 4.2;
  const rank = (kind: string) => (kind === 'lot' ? 0 : kind === 'product-lot' ? 0 : kind === 'product' ? 1 : 2);
  const pos: Record<string, { x: number; y: number }> = {};
  const rows: Record<number, number> = {};
  const fixed = nodes.filter((n) => !n.data.kind.startsWith('store')).sort((a, b) => rank(a.data.kind) - rank(b.data.kind) || a.data.id.localeCompare(b.data.id));
  for (const n of fixed) {
    const c = col(n.data.kind, n.data.id);
    rows[c] = (rows[c] ?? 0) + 1;
    pos[n.data.id] = { x: c * COLW, y: rows[c] * ROW * (c === 0 ? 0.8 : 1) };
  }
  const perCol = Math.ceil(stores.length / 4);
  stores.forEach((n, i) => { pos[n.data.id] = { x: 4.2 * COLW + Math.floor(i / perCol) * 110, y: (i % perCol + 1) * ROW }; });
  const height = Math.max(perCol, ...Object.values(rows)) * ROW;
  for (const n of fixed) {
    const c = col(n.data.kind, n.data.id);
    pos[n.data.id].y += (height - rows[c] * ROW * (c === 0 ? 0.8 : 1)) / 2;
  }
  return pos;
}
