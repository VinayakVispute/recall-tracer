"use client";

import { useMemo, useState } from "react";
import type { IncidentReport } from "@server/tools/incident";
import { cn } from "@/lib/utils";

const fmt = (n: number) => n.toLocaleString();

type Node = { id: string; col: 0 | 1 | 2; label: string; sub?: string; value: number; y: number; h: number };
type Link = { s: string; t: string; value: number; gap: boolean; note: string; sy: number; ty: number };

const W = 880, NODE = 12, PAD = 12, SLOT = 34, TOP = 22;
const X = [8, 300, 640];

/** Sankey of units: bad lot -> product lots (+ "no lot code") -> states. All numbers come from the report. */
const storesN = (n: number) => `${n} store${n === 1 ? "" : "s"}`;

export function UnitsFlow({ r, focus }: { r: IncidentReport; focus?: string }) {
  const [hover, setHover] = useState<string>();
  const [tip, setTip] = useState<{ x: number; y: number; body: React.ReactNode }>();

  const { nodes, links, H, held, heldLots, k: scale } = useMemo(() => {
    const plState = new Map<string, Map<string, number>>();
    const gapState = new Map<string, number>();
    const gapSkus = new Set<string>();
    const stores = new Map<string, Set<string>>();
    for (const st of r.stores) {
      const add = (k: string) => stores.set(k, (stores.get(k) ?? new Set()).add(st.id));
      for (const s of st.shipments) if (s.affected) {
        const m = plState.get(s.lot) ?? new Map<string, number>();
        m.set(st.region, (m.get(st.region) ?? 0) + s.units);
        plState.set(s.lot, m);
        add(`${s.lot}>${st.region}`); add(st.region);
      }
      for (const u of st.untracked) {
        gapState.set(st.region, (gapState.get(st.region) ?? 0) + u.units);
        gapSkus.add(u.product); add(`gap>${st.region}`); add(st.region);
      }
    }
    const plInfo = new Map(r.product_lots.map((p) => [p.id, p]));
    const sum = (m?: Map<string, number>) => [...(m?.values() ?? [])].reduce((a, b) => a + b, 0);
    const gapTotal = sum(gapState);

    const N: Node[] = [];
    // Group lots by product so same-product lots sit together.
    const lots = [...plState.keys()].sort((a, b) => (plInfo.get(a)?.product ?? "").localeCompare(plInfo.get(b)?.product ?? "") || a.localeCompare(b));
    const L: Omit<Link, "sy" | "ty">[] = [];
    lots.forEach((id) => {
      const v = sum(plState.get(id));
      N.push({ id, col: 1, label: id, sub: plInfo.get(id)?.product, value: v, y: 0, h: 0 });
      L.push({ s: r.lot.code, t: id, value: v, gap: false, note: `${plInfo.get(id)?.product ?? "Product"} lot made with ${r.lot.code}` });
    });
    if (gapTotal) {
      N.push({ id: "gap", col: 1, label: "No lot code", sub: [...gapSkus].join(", "), value: gapTotal, y: 0, h: 0 });
      L.push({ s: r.lot.code, t: "gap", value: gapTotal, gap: true, note: "Lot unknown, so it cannot be ruled out" });
    }
    const states = new Map<string, number>();
    plState.forEach((m, pl) => m.forEach((v, st) => {
      states.set(st, (states.get(st) ?? 0) + v);
      L.push({ s: pl, t: `st:${st}`, value: v, gap: false, note: storesN(stores.get(`${pl}>${st}`)?.size ?? 0) });
    }));
    gapState.forEach((v, st) => {
      states.set(st, (states.get(st) ?? 0) + v);
      L.push({ s: "gap", t: `st:${st}`, value: v, gap: true, note: `${storesN(stores.get(`gap>${st}`)?.size ?? 0)}, no lot code recorded` });
    });
    [...states].sort((a, b) => b[1] - a[1]).forEach(([st, v]) =>
      N.push({ id: `st:${st}`, col: 2, label: st, sub: storesN(stores.get(st)?.size ?? 0), value: v, y: 0, h: 0 }));
    N.unshift({ id: r.lot.code, col: 0, label: r.lot.code, sub: r.lot.ingredient, value: lots.reduce((a, id) => a + sum(plState.get(id)), 0) + gapTotal, y: 0, h: 0 });

    // One units->pixels scale; each node gets at least SLOT of vertical room so two-line labels never collide.
    const cols = [0, 1, 2].map((c) => N.filter((n) => n.col === c));
    const k = 300 / Math.max(...cols.map((c) => c.reduce((a, n) => a + n.value, 0)));
    const colH = (c: Node[]) => c.reduce((a, n) => a + Math.max(SLOT, n.value * k), 0) + PAD * (c.length - 1);
    const H = Math.max(...cols.map(colH)) + TOP;
    cols.forEach((c) => {
      let y = TOP + (H - TOP - colH(c)) / 2;
      c.forEach((n) => {
        n.h = Math.max(2, n.value * k);
        const slot = Math.max(SLOT, n.h);
        n.y = y + (slot - n.h) / 2;
        y += slot + PAD;
      });
    });
    const byId = new Map(N.map((n) => [n.id, n]));
    const out = new Map<string, number>(), inn = new Map<string, number>();
    const links: Link[] = L
      .sort((a, b) => byId.get(a.t)!.y - byId.get(b.t)!.y)
      .map((l) => { const sy = byId.get(l.s)!.y + (out.get(l.s) ?? 0); out.set(l.s, (out.get(l.s) ?? 0) + l.value * k); return { ...l, sy, ty: 0 }; })
      .sort((a, b) => byId.get(a.s)!.y - byId.get(b.s)!.y)
      .map((l) => { const ty = byId.get(l.t)!.y + (inn.get(l.t) ?? 0); inn.set(l.t, (inn.get(l.t) ?? 0) + l.value * k); return { ...l, ty }; });
    const affected = r.product_lots.filter((p) => p.affected);
    return { nodes: N, links, H, held: affected.reduce((a, p) => a + p.held, 0), heldLots: affected.filter((p) => p.held > 0).length, k };
  }, [r]);

  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Lit links: a node/link lights its own path only (upstream + downstream), never its siblings.
  const lit = useMemo(() => {
    const seed: number[] = [];
    const key = hover ?? focus;
    if (!key) return null;
    const store = r.stores.find((s) => s.id === key);
    if (store) {
      const lots = new Set(store.shipments.filter((s) => s.affected).map((s) => s.lot));
      if (store.untracked.length) lots.add("gap");
      links.forEach((l, i) => { if (l.t === `st:${store.region}` && lots.has(l.s)) seed.push(i); });
    } else if (key.startsWith("link:")) seed.push(Number(key.slice(5)));
    else {
      const id = byId.has(key) ? key : `st:${key}`;
      links.forEach((l, i) => { if (l.s === id || l.t === id) seed.push(i); });
    }
    const set = new Set(seed);
    seed.forEach((i) => links.forEach((l, j) => { if (l.t === links[i].s) set.add(j); }));
    if (!set.size) return null;
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hover, focus, links, r.stores]);

  const litNode = (id: string) => !lit || links.some((l, i) => lit.has(i) && (l.s === id || l.t === id));
  const show = (e: React.MouseEvent, body: React.ReactNode) => {
    const box = e.currentTarget.closest("[data-flow]")!.getBoundingClientRect();
    setTip({ x: e.clientX - box.left + 14, y: e.clientY - box.top + 14, body });
  };
  const hide = () => { setHover(undefined); setTip(undefined); };
  const total = nodes[0].value;
  const heads = ["Bad lot", "Product lots (units delivered)", "States"];

  return (
    <div>
      <div className="overflow-x-auto">
        <div data-flow className="relative min-w-[720px]">
          <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={`Units from lot ${r.lot.code} by product lot to states`}>
            <defs>
              <pattern id="uf-hatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
                <rect width="6" height="6" fill="var(--chart-1)" opacity=".4" />
                <line x1="0" y1="0" x2="0" y2="6" stroke="var(--chart-1)" strokeWidth="2.5" />
              </pattern>
            </defs>
            {heads.map((t, c) => (
              <text key={t} x={X[c]} y={10} className="fill-muted-foreground text-[11px] font-medium">{t}</text>
            ))}
            {links.map((l, i) => {
              const s = byId.get(l.s)!, t = byId.get(l.t)!;
              const w = l.value * scale;
              const x0 = X[s.col] + NODE, x1 = X[t.col], xm = (x0 + x1) / 2;
              const d = `M${x0},${l.sy} C${xm},${l.sy} ${xm},${l.ty} ${x1},${l.ty} L${x1},${l.ty + w} C${xm},${l.ty + w} ${xm},${l.sy + w} ${x0},${l.sy + w} Z`;
              const on = !lit || lit.has(i);
              return (
                <path key={i} d={d} fillOpacity={on ? 1 : 0.1}
                  className={cn("transition-[fill-opacity]", l.gap ? "stroke-chart-1 stroke-[0.6] [stroke-dasharray:3_2]" : "fill-destructive/35")}
                  style={l.gap ? { fill: "url(#uf-hatch)" } : undefined}
                  onMouseEnter={() => setHover(`link:${i}`)} onMouseLeave={hide}
                  onMouseMove={(e) => show(e, <><b>{s.label} to {t.label}</b><br />{fmt(l.value)} units<br /><span className="text-muted-foreground">{l.note}</span></>)} />
              );
            })}
            {nodes.map((n) => {
              const gap = n.id === "gap";
              const on = litNode(n.id);
              const cx = X[n.col];
              return (
                <g key={n.id} opacity={on ? 1 : 0.3} className="cursor-default transition-opacity"
                  onMouseEnter={() => setHover(n.id)} onMouseLeave={hide} onClick={() => setHover(hover === n.id ? undefined : n.id)}
                  onMouseMove={(e) => show(e, <><b>{n.label}</b>{n.sub ? ` · ${n.sub}` : ""}<br />{fmt(n.value)} units{n.col === 0 ? " delivered to stores" : n.col === 1 ? " delivered" : " delivered in this state"}</>)}>
                  <rect x={cx} y={n.y} width={NODE} height={n.h} rx={3}
                    className={cn(n.col === 0 ? "fill-foreground" : gap ? "stroke-chart-1 [stroke-dasharray:3_2]" : "fill-destructive")}
                    style={gap ? { fill: "url(#uf-hatch)" } : undefined} />
                  <text x={cx + NODE + 6} y={n.y + n.h / 2 - 6} dy="0.35em" className="fill-foreground stroke-card stroke-[3px] text-xs font-semibold [paint-order:stroke]">
                    {n.label}{n.col > 0 && <tspan className="fill-muted-foreground font-normal">{`  ${fmt(n.value)} u`}</tspan>}
                  </text>
                  {n.sub && (
                    <text x={cx + NODE + 6} y={n.y + n.h / 2 + 9} className="fill-muted-foreground stroke-card stroke-[3px] text-[10.5px] [paint-order:stroke]">{n.sub}</text>
                  )}
                </g>
              );
            })}
          </svg>
          {tip && (
            <div className="pointer-events-none absolute z-50 max-w-64 rounded-md border bg-popover px-2.5 py-2 text-xs/relaxed text-popover-foreground shadow-md" style={{ left: tip.x, top: tip.y }}>{tip.body}</div>
          )}
        </div>
      </div>
      <ul className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        <li className="flex items-center gap-1.5"><i className="size-2.5 rounded-sm bg-foreground" />Bad lot {r.lot.code}</li>
        <li className="flex items-center gap-1.5"><i className="size-2.5 rounded-sm bg-destructive" />Contains {r.lot.code}</li>
        <li className="flex items-center gap-1.5"><i className="size-2.5 rounded-sm border border-dashed border-chart-1 bg-chart-1/50" />Delivered with no lot code</li>
        {held > 0 && <li className="flex items-center gap-1.5"><i className="size-2.5 rounded-sm bg-chart-2" />{fmt(held)} more units held across {heldLots} lots (not in the flow)</li>}
      </ul>
      <p className="mt-1 text-xs text-muted-foreground">Band width is units delivered to stores ({fmt(total)} in all). Hover a band or node to trace its path.</p>
    </div>
  );
}
