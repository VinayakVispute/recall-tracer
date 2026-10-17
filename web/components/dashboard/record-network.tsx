"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, Handle, Panel, Position, ReactFlow, type Edge, type Node, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { CheckIcon, MailIcon } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

type Rec = { id: string; kind: string; stage: string; depth: number; label?: string; sub?: string };
type Link = { id: string; source: string; target: string; kind: string; stage: string; depth: number };
type Elements = { nodes: { data: Rec }[]; edges: { data: Link }[] };
/** What a revealed element shows: present, plus a mark the agent left on it. */
type Mark = "" | "noticed" | "verified" | "faded";
type CardData = Rec & { mark: Mark; dim: boolean; picked: boolean };

// One row per node kind: the word on the card and its colour. Colour is never the only cue, the word says it too.
const KIND: Record<string, { word: string; color: string }> = {
  lot: { word: "Ingredient lot", color: "var(--foreground)" },
  "lot-clean": { word: "Other ingredient lot", color: "var(--border)" },
  batch: { word: "Batch", color: "var(--destructive)" },
  "product-lot": { word: "Product lot", color: "var(--destructive)" },
  "product-lot-clean": { word: "Clean product lot", color: "var(--border)" },
  product: { word: "Product, no lot code", color: "var(--chart-1)" },
  site: { word: "Hold placed", color: "var(--chart-2)" },
  dc: { word: "Hold placed", color: "var(--chart-2)" },
  "store-affected": { word: "Pull", color: "var(--destructive)" },
  "store-gap": { word: "Pull, no record", color: "var(--chart-1)" },
  "store-safe": { word: "Cleared", color: "var(--muted-foreground)" },
};
const EDGE: Record<string, { color: string; dash?: string }> = {
  affected: { color: "var(--destructive)" }, untracked: { color: "var(--chart-1)", dash: "5 4" },
  clean: { color: "var(--border)" }, held: { color: "var(--chart-2)", dash: "2 3" }, origin: { color: "var(--chart-3)" },
};
const HOP_MS = 650;
const W = 180, H = 58, GAP = 12, COL = 250;

function RecordCard({ data }: NodeProps<Node<CardData>>) {
  const k = KIND[data.kind];
  return (
    <div
      className={cn(
        "flex animate-in flex-col gap-0.5 rounded-md border border-l-4 bg-card px-2 py-1 text-card-foreground shadow-xs transition-opacity duration-300 zoom-in-75 fade-in",
        data.mark === "noticed" && "ring-2 ring-foreground",
        data.mark === "verified" && "ring-2 ring-chart-3",
        (data.dim || data.mark === "faded") && "opacity-20",
        data.picked && "ring-2 ring-ring",
      )}
      style={{ width: W, height: H, borderLeftColor: k?.color }}
    >
      <Handle type="target" position={Position.Left} className="opacity-0" />
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground uppercase">
        <span className="truncate">{k?.word ?? data.kind}</span>
        {data.mark === "noticed" && <MailIcon className="ml-auto size-3 shrink-0" aria-label="Notice drafted" />}
        {data.mark === "verified" && <CheckIcon className="ml-auto size-3 shrink-0" aria-label="Verified clean" />}
      </div>
      <div className="truncate text-xs font-medium">{data.label ?? data.id}</div>
      {data.sub && <div className="truncate text-[11px] text-muted-foreground">{data.sub}</div>}
      <Handle type="source" position={Position.Right} className="opacity-0" />
    </div>
  );
}

function ColumnTitle({ data }: NodeProps<Node<{ text: string }>>) {
  return <div className="text-xs font-semibold text-muted-foreground">{data.text}</div>;
}
const nodeTypes = { record: RecordCard, title: ColumnTitle };

/**
 * Columns left to right follow the product: ingredient lot, batches, product lots, stores. Plants and DCs with a hold
 * sit under the product lots. Stores are grouped by decision (pull, no record, cleared) in a 4-wide grid.
 */
function layout({ nodes, edges }: Elements, all: boolean) {
  const reworked = new Set(edges.filter((e) => e.data.source.startsWith("B-") && e.data.target.startsWith("B-")).map((e) => e.data.target));
  const by = (kinds: string[]) => nodes.map((n) => n.data).filter((n) => kinds.includes(n.kind) && (all || !n.kind.endsWith("clean") && n.kind !== "store-safe"))
    .sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || (a.sub ?? "").localeCompare(b.sub ?? "") || a.id.localeCompare(b.id));
  const pos = new Map<string, { x: number; y: number }>();
  const stack = (list: Rec[], x: number, y0 = 0) => list.forEach((n, i) => pos.set(n.id, { x, y: y0 + i * (H + GAP) }));
  stack(by(["lot", "lot-clean"]), 0);
  stack(by(["batch"]).filter((b) => !reworked.has(b.id)), COL);
  stack(by(["batch"]).filter((b) => reworked.has(b.id)), COL, (by(["batch"]).length - reworked.size) * (H + GAP) + 24);
  const lots = by(["product-lot", "product", "product-lot-clean"]);
  stack(lots, 2 * COL);
  stack(by(["site", "dc"]), 1.5 * COL, Math.max(lots.length, by(["batch"]).length + 1) * (H + GAP) + 48);
  const titles: { id: string; text: string; x: number; y: number }[] = [
    { id: "t-lot", text: "Ingredient lot", x: 0, y: -28 }, { id: "t-batch", text: "Batches it went into", x: COL, y: -28 },
    { id: "t-pl", text: "Product lots", x: 2 * COL, y: -28 },
  ];
  const holds = by(["site", "dc"])[0];
  if (holds) titles.push({ id: "t-hold", text: "Plants and DCs on hold", x: 1.5 * COL, y: pos.get(holds.id)!.y - 28 });
  let y = 0;
  for (const [kind, text] of [["store-affected", "Stores to pull"], ["store-gap", "Pull, shipped with no lot code"], ["store-safe", "Cleared stores"]]) {
    const list = by([kind]);
    if (!list.length) continue;
    titles.push({ id: `t-${kind}`, text: `${text} · ${list.length}`, x: 3 * COL, y: y - 28 });
    list.forEach((n, i) => pos.set(n.id, { x: 3 * COL + (i % 4) * (W + GAP), y: y + Math.floor(i / 4) * (H + GAP) }));
    y += Math.ceil(list.length / 4) * (H + GAP) + 48;
  }
  return { pos, titles };
}

/** Everything connected to `id`: what it came from and what it went to. */
function lineage(id: string, edges: Link[]) {
  const seen = new Set([id]);
  for (const dir of ["up", "down"] as const) {
    const todo = [id];
    while (todo.length) {
      const cur = todo.pop()!;
      for (const e of edges) {
        const next = dir === "up" ? (e.target === cur ? e.source : null) : e.source === cur ? e.target : null;
        if (next && !seen.has(next)) { seen.add(next); todo.push(next); }
      }
    }
  }
  return seen;
}

/**
 * `stages` is the ordered list of agent steps completed so far ('start' first). Records appear when their step
 * completes; the forward trace is staggered hop by hop so the spread is visible. Shrinking `stages` replays.
 */
export function NetworkGraph({ lot, stages, animating, focus, onPick }: { lot: string; stages: string[]; animating: boolean; focus?: string; onPick: (store: string) => void }) {
  const [els, setEls] = useState<Elements>();
  const [marks, setMarks] = useState<Map<string, Mark>>(new Map());
  const [all, setAll] = useState(false);
  const [picked, setPicked] = useState<string>();
  const flow = useRef<ReactFlowInstance<Node, Edge>>(null);
  const revealed = useRef(new Set<string>());
  const timers = useRef<number[]>([]);
  useEffect(() => { fetch(`/api/graph/${lot}`).then((r) => r.json()).then(setEls); }, [lot]);
  useEffect(() => { if (focus) setPicked(focus); }, [focus]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // Reveal newly completed stages; a shrunk list (replay) hides everything again.
  useEffect(() => {
    if (!els) return;
    const want = new Set(stages);
    if ([...revealed.current].some((s) => !want.has(s))) {
      timers.current.forEach(clearTimeout); timers.current = [];
      revealed.current = new Set();
      setMarks(new Map());
    }
    const instant = revealed.current.size === 0 && stages.length > 2; // a saved run: show it all at once
    const items = [...els.nodes, ...els.edges].map((e) => e.data);
    const later = (ms: number, f: () => void) => timers.current.push(window.setTimeout(f, instant ? 0 : ms));
    const set = (ids: string[], mark: Mark) => setMarks((m) => { const n = new Map(m); ids.forEach((id) => n.set(id, mark)); return n; });
    for (const stage of stages) {
      if (revealed.current.has(stage)) continue;
      revealed.current.add(stage);
      const ids = (f: (d: Rec | Link) => boolean) => items.filter(f).map((d) => d.id);
      if (stage === "draft_recall_notice") { later(0, () => set(ids((d) => d.kind === "store-affected" || d.kind === "store-gap"), "noticed")); continue; }
      if (stage === "trace_backward") {
        if (animating) setAll(true); // while playing, show the backward check land; a saved run opens on the readable recall path
        later(0, () => set(ids((d) => d.stage === stage), ""));
        later(600, () => set(ids((d) => d.kind === "store-safe"), "verified"));
        later(3200, () => set(ids((d) => d.kind === "origin" || d.kind === "lot-clean"), "faded"));
        continue;
      }
      const mine = items.filter((d) => d.stage === stage);
      [...new Set(mine.map((d) => d.depth))].sort((a, b) => a - b)
        .forEach((d, i) => later(i * HOP_MS, () => set(mine.filter((x) => x.depth === d).map((x) => x.id), "")));
    }
  }, [stages, els]);

  const { nodes, edges } = useMemo(() => {
    if (!els) return { nodes: [], edges: [] };
    const { pos, titles } = layout(els, all);
    const live = els.edges.map((e) => e.data).filter((e) => marks.has(e.id) && pos.has(e.source) && pos.has(e.target));
    const near = picked ? lineage(picked, live) : null;
    const nodes: Node[] = [
      ...titles.map((t) => ({ id: t.id, type: "title", position: { x: t.x, y: t.y }, data: { text: t.text }, selectable: false, hidden: !marks.size })),
      ...els.nodes.filter((n) => pos.has(n.data.id)).map((n) => ({
        id: n.data.id, type: "record", position: pos.get(n.data.id)!, hidden: !marks.has(n.data.id),
        data: { ...n.data, mark: marks.get(n.data.id) ?? "", dim: !!near && !near.has(n.data.id), picked: picked === n.data.id },
      })),
    ];
    const edges: Edge[] = live.map((e) => ({
      id: e.id, source: e.source, target: e.target,
      animated: animating && e.kind === "affected",
      style: {
        stroke: EDGE[e.kind]?.color, strokeDasharray: EDGE[e.kind]?.dash, strokeWidth: e.kind === "clean" ? 1 : 1.6,
        opacity: (near && !(near.has(e.source) && near.has(e.target))) || marks.get(e.id) === "faded" ? 0.1 : 1,
        transition: "opacity 300ms",
      },
    }));
    return { nodes, edges };
  }, [els, all, marks, picked, animating]);

  // Keep the whole picture in frame as it grows or the view changes.
  const shown = nodes.filter((n) => !n.hidden).length;
  useEffect(() => { const t = window.setTimeout(() => flow.current?.fitView({ duration: 400, padding: { top: "56px", right: "16px", bottom: "16px", left: "16px" } }), 50); return () => clearTimeout(t); }, [shown, all]);

  const pickedRec = picked ? els?.nodes.find((n) => n.data.id === picked)?.data : undefined;
  const downstream = pickedRec && els ? [...lineage(pickedRec.id, els.edges.map((e) => e.data).filter((e) => marks.has(e.id)))].filter((id) => id.startsWith("ST-") && id !== pickedRec.id).length : 0;

  return (
    <div className="h-140 overflow-hidden rounded-md border bg-muted/30">
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={nodeTypes} colorMode="system"
        onInit={(i) => { flow.current = i; }}
        onNodeClick={(_, n) => {
          if (n.type !== "record") return;
          setPicked((p) => (p === n.id ? undefined : n.id));
          if (n.id.startsWith("ST-")) onPick(n.id);
        }}
        onPaneClick={() => setPicked(undefined)}
        nodesDraggable={false} nodesConnectable={false} edgesFocusable={false}
        zoomOnScroll={false} preventScrolling={false} minZoom={0.2}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} />
        <Controls showInteractive={false} position="bottom-left" />
        <Panel position="top-left">
          <ToggleGroup value={[all ? "all" : "path"]} onValueChange={(v) => v[0] && setAll(v[0] === "all")} variant="outline" size="sm" className="bg-background">
            <ToggleGroupItem value="path">Recall path</ToggleGroupItem>
            <ToggleGroupItem value="all">All records</ToggleGroupItem>
          </ToggleGroup>
        </Panel>
        <Panel position="bottom-right" className="max-w-60 rounded-md border bg-background px-3 py-2 text-xs shadow-xs">
          {pickedRec ? (
            <div className="flex flex-col gap-0.5">
              <span className="text-muted-foreground uppercase">{KIND[pickedRec.kind]?.word}</span>
              <span className="font-medium">{pickedRec.label ?? pickedRec.id}</span>
              <span className="text-muted-foreground">{[pickedRec.sub, pickedRec.label && pickedRec.id !== pickedRec.sub ? pickedRec.id : null].filter(Boolean).join(" · ")}</span>
              {!pickedRec.id.startsWith("ST-") && <span>{downstream} store{downstream === 1 ? "" : "s"} downstream</span>}
            </div>
          ) : (
            <span className="text-muted-foreground">Click any record to trace where it came from and where it went.</span>
          )}
        </Panel>
      </ReactFlow>
    </div>
  );
}
