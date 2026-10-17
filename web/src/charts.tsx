import { useEffect, useMemo, useRef, useState } from 'react';
import cytoscape from 'cytoscape';
import type { IncidentReport } from '../../src/tools/incident';

type Report = IncidentReport;
const fmt = (n: number) => n.toLocaleString();
const shortDate = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** Tooltip shared by the charts: a fixed-position card that follows the pointer. */
export function useTip() {
  const [tip, setTip] = useState<{ x: number; y: number; body: React.ReactNode } | null>(null);
  const show = (e: React.MouseEvent, body: React.ReactNode) => setTip({ x: e.clientX, y: e.clientY, body });
  const el = tip && <div className="tip" style={{ left: tip.x + 14, top: tip.y + 14 }}>{tip.body}</div>;
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
    const reworkTargets = new Set(r.lineage.filter((e) => e.type === 'REWORKED_INTO').map((e) => e.target));
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
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H + 24}`} className="flow" role="img" aria-label={`Flow of units from ${r.lot.code} to states`}>
        <defs>
          <pattern id="hatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <rect width="6" height="6" fill="var(--gap)" opacity=".35" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--gap-ink)" strokeWidth="2" opacity=".55" />
          </pattern>
        </defs>
        {['Lot', 'Batches', 'Rework', 'Product lots', 'States'].map((t, c) => (
          <text key={t} x={X(c)} y={H + 20} className="axis-label">{t}</text>
        ))}
        {links.map((l, i) => {
          const s = nodes.find((n) => n.id === l.s)!, t = nodes.find((n) => n.id === l.t)!;
          const x0 = X(s.col) + NODE, x1 = X(t.col), xm = (x0 + x1) / 2, w = (l as FLink & { w: number }).w;
          const d = `M${x0},${l.sy} C${xm},${l.sy} ${xm},${l.ty} ${x1},${l.ty} L${x1},${l.ty + w} C${xm},${l.ty + w} ${xm},${l.sy + w} ${x0},${l.sy + w} Z`;
          return (
            <path key={i} d={d} className={`link ${l.kind}`} opacity={touches(l) ? 1 : 0.15}
              onMouseMove={(e) => show(e, <><b>{l.s === 'gap' ? 'No lot code' : l.s} → {l.t.replace('st:', '')}</b><br />{fmt(l.value)} units{l.note ? <><br />{l.note}</> : null}</>)}
              onMouseLeave={hide} />
          );
        })}
        {nodes.map((n) => (
          <g key={n.id} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => { setHover(undefined); hide(); }}
            onMouseMove={(e) => show(e, <><b>{n.label}</b>{n.sub ? ` · ${n.sub}` : ''}<br />{fmt(n.value)} units shipped downstream</>)}>
            <rect x={X(n.col)} y={n.y} width={NODE} height={n.h} rx={3} className={`node ${n.kind}`} />
            <text x={X(n.col) + NODE + 6} y={n.y + n.h / 2} dy="0.35em" className="node-label">
              {n.label}<tspan className="node-sub">{n.h > 14 && n.sub && n.kind !== 'pl' ? `  ${n.sub}` : ''}</tspan>
              {n.kind === 'state' && <tspan className="node-sub">{`  ${fmt(n.value)} u`}</tspan>}
            </text>
          </g>
        ))}
      </svg>
      {el}
    </div>
  );
}

// --- Where it went: state tile map ------------------------------------------

/** Stylised tile grid of the region (col,row). States without data are drawn as ghosts for orientation. */
const TILES: Record<string, [number, number]> = {
  WI: [1, 0], MI: [2, 0], NY: [4, 0],
  IL: [0, 1], IN: [1, 1], OH: [2, 1], PA: [3, 1], NJ: [4, 1],
  MO: [0, 2], KY: [1, 2], WV: [2, 2], VA: [3, 2], MD: [4, 2],
};

export function TileMap({ r, onPick }: { r: Report; onPick: (state: string) => void }) {
  const { show, hide, el } = useTip();
  const S = 86, G = 6;
  const by = (st: string) => r.stores.filter((s) => s.region === st);
  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${5 * (S + G)} ${3 * (S + G)}`} className="tiles" role="img" aria-label="Stores by state">
        {Object.entries(TILES).map(([st, [c, row]]) => {
          const list = by(st), x = c * (S + G), y = row * (S + G);
          if (!list.length) return (
            <g key={st}><rect x={x} y={y} width={S} height={S} rx={6} className="tile ghost" /><text x={x + 8} y={y + 18} className="tile-code ghost">{st}</text></g>
          );
          const n = { recall: 0, gap: 0, safe: 0 };
          list.forEach((s) => n[s.status]++);
          const units = list.reduce((a, s) => a + s.units_at_risk, 0);
          let bx = x + 8;
          return (
            <g key={st} className="tile-g" onClick={() => onPick(st)}
              onMouseMove={(e) => show(e, <><b>{st}</b>: {n.recall} to recall, {n.gap} gap, {n.safe} safe<br />{fmt(units)} units to pull<br />{[...new Set(list.map((s) => s.city))].join(', ')}</>)}
              onMouseLeave={hide}>
              <rect x={x} y={y} width={S} height={S} rx={6} className="tile" />
              <text x={x + 8} y={y + 18} className="tile-code">{st}</text>
              <text x={x + 8} y={y + 50} className="tile-num">{n.recall + n.gap}</text>
              <text x={x + 8} y={y + 64} className="tile-sub">of {list.length} stores</text>
              {(['recall', 'gap', 'safe'] as const).map((k) => {
                const w = ((S - 16) * n[k]) / list.length;
                const rect = <rect key={k} x={bx} y={y + S - 14} width={Math.max(0, w - 2)} height={6} rx={2} className={`bar ${k}`} />;
                bx += w;
                return rect;
              })}
            </g>
          );
        })}
      </svg>
      {el}
    </div>
  );
}

// --- Exposure window: when affected product reached shelves -------------------

export function ExposureStrip({ r }: { r: Report }) {
  const { show, hide, el } = useTip();
  const W = 460, ROW = 46, L = 132, R = 16;
  const pts = r.stores.flatMap((st) => [
    ...st.shipments.filter((s) => s.affected).map((s) => ({ st, sku: s.sku, date: s.shipped_at, units: s.units, lot: s.lot, gap: false })),
    ...st.untracked.map((u) => ({ st, sku: u.sku, date: u.shipped_at, units: u.units, lot: 'no lot code', gap: true })),
  ]);
  if (!pts.length) return null;
  const dates = pts.map((p) => p.date).sort();
  const t0 = Date.parse(dates[0]), t1 = Date.parse(dates.at(-1)!), span = Math.max(1, (t1 - t0) / 864e5);
  const x = (d: string) => L + ((Date.parse(d) - t0) / 864e5 / span) * (W - L - R);
  const stack = new Map<string, number>();
  const H = r.skus.length * ROW + 26;
  const days = Math.round((Date.now() - t0) / 864e5);
  return (
    <div className="chart-wrap">
      <p className="chart-note">First affected shipment {shortDate(dates[0])}, last {shortDate(dates.at(-1)!)}. The oldest product has been on shelves for {days} days.</p>
      <svg viewBox={`0 0 ${W} ${H}`} className="strip" role="img" aria-label="Affected shipments by date and product">
        {r.skus.map((s, i) => (
          <g key={s.sku}>
            <line x1={L} x2={W - R} y1={i * ROW + ROW / 2} y2={i * ROW + ROW / 2} className="grid" />
            <text x={0} y={i * ROW + ROW / 2} dy="0.35em" className="row-label">{s.product}</text>
          </g>
        ))}
        {pts.map((p, i) => {
          const row = r.skus.findIndex((s) => s.sku === p.sku), key = `${p.sku}${p.date}`, k = stack.get(key) ?? 0;
          stack.set(key, k + 1);
          const cy = row * ROW + ROW / 2 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 9;
          return (
            <circle key={i} cx={x(p.date)} cy={cy} r={4.5} className={p.gap ? 'dot gap' : 'dot recall'}
              onMouseMove={(e) => show(e, <><b>{p.st.name}</b> ({p.st.city}, {p.st.region})<br />{p.units} units of {p.lot} on {shortDate(p.date)}</>)} onMouseLeave={hide} />
          );
        })}
        {[...new Set(dates)].map((d) => <text key={d} x={x(d)} y={H - 4} className="axis-label" textAnchor="middle">{shortDate(d).replace(/^\w+ /, '')}</text>)}
      </svg>
      {el}
    </div>
  );
}

// --- Network: every record as a node, click to isolate what reaches it ------

const COLOR: Record<string, string> = {
  lot: '#8f1d1d', batch: '#c4471b', 'product-lot': '#c4471b', 'store-affected': '#c4471b',
  product: '#e5b021', 'store-gap': '#e5b021', 'store-safe': '#a9b1ae', 'product-lot-clean': '#c9cfcc',
};
type Elements = { nodes: { data: { id: string; kind: string } }[]; edges: { data: { id: string; source: string; target: string; kind: string } }[] };

export function NetworkGraph({ lot, focus, onPick }: { lot: string; focus?: string; onPick: (store: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core>(null);
  const [els, setEls] = useState<Elements>();
  useEffect(() => { fetch(`/graph/${lot}`).then((r) => r.json()).then(setEls); }, [lot]);
  useEffect(() => {
    if (!els || !ref.current) return;
    const cy = cytoscape({
      container: ref.current,
      elements: [...els.nodes, ...els.edges],
      layout: { name: 'preset', positions: layered(els) as never },
      style: [
        { selector: 'node', style: { 'background-color': (n: any) => COLOR[n.data('kind')] ?? '#888', width: 11, height: 11, label: 'data(id)', 'font-size': 8, 'font-family': 'IBM Plex Sans', color: '#3a4441', 'text-valign': 'bottom', 'text-margin-y': 2 } },
        { selector: 'node[kind = "lot"]', style: { width: 22, height: 22, 'font-size': 11, 'font-weight': 600 } },
        { selector: 'edge', style: { width: 1, 'line-color': '#d4d9d6', 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'target-arrow-color': '#d4d9d6', 'arrow-scale': 0.5 } },
        { selector: 'edge[kind = "affected"]', style: { 'line-color': '#c4471b', 'target-arrow-color': '#c4471b', width: 1.4 } },
        { selector: 'edge[kind = "untracked"]', style: { 'line-color': '#c99a12', 'target-arrow-color': '#c99a12', 'line-style': 'dashed', width: 1.4 } },
        { selector: '.dim', style: { opacity: 0.1 } },
      ],
      userZoomingEnabled: false, // keep the mouse wheel for page scroll
    });
    if (import.meta.env.DEV) (window as unknown as { cy: typeof cy }).cy = cy; // lets the demo recorder click nodes
    cy.on('tap', (e) => {
      cy.elements().removeClass('dim');
      if (e.target === cy) return;
      cy.elements().not(e.target.predecessors().add(e.target)).addClass('dim');
      if (String(e.target.data('kind')).startsWith('store')) onPick(e.target.id());
    });
    cyRef.current = cy;
    return () => cy.destroy();
  }, [els]);
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !focus) return;
    const n = cy.$id(focus);
    if (n.nonempty()) { cy.elements().removeClass('dim'); cy.elements().not(n.predecessors().add(n)).addClass('dim'); }
  }, [focus, els]);
  return <div className="network" ref={ref} />;
}

const ROW = 30, COLW = 230;
/** Columns: lot → batches (rework one step right) → product lots → stores in four sub-columns. */
function layered({ nodes, edges }: Elements) {
  const reworked = new Set(edges.filter((e) => e.data.source.startsWith('B-') && e.data.target.startsWith('B-')).map((e) => e.data.target));
  const order = ['store-affected', 'store-gap', 'store-safe'];
  const stores = nodes.filter((n) => n.data.kind.startsWith('store')).sort((a, b) => order.indexOf(a.data.kind) - order.indexOf(b.data.kind));
  const col = (kind: string, id: string) =>
    kind === 'lot' ? 0 : kind === 'batch' ? (reworked.has(id) ? 1.6 : 1) : kind.startsWith('product') ? 2.4 : 3.4;
  const pos: Record<string, { x: number; y: number }> = {};
  const rows: Record<number, number> = {};
  for (const n of nodes.filter((n) => !n.data.kind.startsWith('store'))) {
    const c = col(n.data.kind, n.data.id);
    rows[c] = (rows[c] ?? 0) + 1;
    pos[n.data.id] = { x: c * COLW, y: rows[c] * ROW };
  }
  const perCol = Math.ceil(stores.length / 4);
  stores.forEach((n, i) => { pos[n.data.id] = { x: 3.4 * COLW + Math.floor(i / perCol) * 110, y: (i % perCol + 1) * ROW }; });
  const height = Math.max(perCol, ...Object.values(rows)) * ROW;
  for (const n of nodes.filter((n) => !n.data.kind.startsWith('store'))) {
    const c = col(n.data.kind, n.data.id);
    pos[n.data.id].y += (height - rows[c] * ROW) / 2;
  }
  return pos;
}
