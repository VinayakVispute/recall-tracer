"use client";

import { useState } from "react";
import { Background, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { RecordSources } from "@server/data/sources";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

type Box = { title: string; sub?: string; count?: number; tone: "source" | "record" | "agent" | "gap"; href?: string };
const W = 190;
const fmt = (n: number) => n.toLocaleString("en-US");
const day = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "");

/** One box: a source the records come from (dashed), or a record type in the graph with its count. */
function BoxNode({ data }: NodeProps<Node<Box>>) {
  const body = (
    <>
      <span className="text-[10px] text-muted-foreground uppercase">{data.tone === "source" ? "Source" : data.tone === "agent" ? "Written by the agent" : "In the graph"}</span>
      <span className="text-sm leading-tight font-medium">{data.title}{data.count !== undefined && <span className="ml-1.5 font-mono text-xs font-normal text-muted-foreground tabular-nums">{fmt(data.count)}</span>}</span>
      {data.sub && <span className="text-[11px] leading-snug text-muted-foreground">{data.sub}</span>}
    </>
  );
  return (
    <div className={cn("flex flex-col gap-0.5 rounded-md border bg-card px-2.5 py-1.5 text-card-foreground shadow-xs",
      data.tone === "source" && "border-dashed border-foreground/40 bg-muted/40",
      data.tone === "record" && "border-l-4 border-l-chart-3",
      data.tone === "agent" && "border-l-4 border-l-chart-4",
      data.tone === "gap" && "border-l-4 border-l-chart-1")} style={{ width: W }}>
      <Handle type="target" position={Position.Left} className="opacity-0" />
      <Handle type="target" id="top" position={Position.Top} className="opacity-0" />
      {data.href ? <a href={data.href} target="_blank" rel="noreferrer" className="nodrag flex flex-col gap-0.5 hover:underline">{body}</a> : body}
      <Handle type="source" position={Position.Right} className="opacity-0" />
      <Handle type="source" id="bottom" position={Position.Bottom} className="opacity-0" />
      <Handle type="target" id="bottom-in" position={Position.Bottom} className="opacity-0" />
    </div>
  );
}
const nodeTypes = { box: BoxNode };

type Spec = { nodes: (Box & { id: string; x: number; y: number })[]; edges: { from: string; to: string; label: string; source?: boolean; dashed?: boolean; down?: boolean; up?: boolean }[] };

/** The public graph: openFDA reports and CDC pages, and what each becomes. */
function fdaSpec(s: RecordSources): Spec {
  const n = s.graphs.fda.nodes, e = s.graphs.fda.edges, p = s.public;
  return {
    nodes: [
      { id: "src-fda", x: 0, y: 0, tone: "source", title: "openFDA food enforcement API", sub: `Reports since ${day(p?.recalls_since ?? null)}`, href: "https://open.fda.gov/apis/food/enforcement/" },
      { id: "src-cdc", x: 0, y: 190, tone: "source", title: "CDC outbreak investigation", sub: "Cases by state", href: p?.cdc_sources[0] },
      { id: "src-notice", x: 0, y: 330, tone: "source", title: "CDC and FDA recall notices", sub: `${p?.inferred_links ?? 0} inferred supplier links` },
      { id: "Firm", x: 330, y: 150, tone: "record", title: "Firm", count: n.Firm },
      { id: "Recall", x: 620, y: 0, tone: "record", title: "Recall report", count: n.Recall },
      { id: "LotCode", x: 930, y: -200, tone: "record", title: "Lot code", count: n.LotCode, sub: "Read from each recall's code text" },
      { id: "Hazard", x: 930, y: -60, tone: "record", title: "Hazard", count: n.Hazard },
      { id: "State", x: 930, y: 150, tone: "record", title: "State", count: n.State },
      { id: "Outbreak", x: 620, y: 260, tone: "gap", title: "Outbreak", count: n.Outbreak },
    ],
    edges: [
      { from: "src-fda", to: "Recall", label: "each report", source: true },
      { from: "src-cdc", to: "Outbreak", label: "each investigation", source: true },
      { from: "src-notice", to: "Firm", label: "supplier links", source: true },
      { from: "Firm", to: "Recall", label: `recalled · ${fmt(e.RECALLED ?? 0)}` },
      { from: "Recall", to: "LotCode", label: `names lot · ${fmt(e.NAMES_LOT ?? 0)}` },
      { from: "Recall", to: "Hazard", label: `hazard · ${fmt(e.HAZARD ?? 0)}` },
      { from: "Recall", to: "State", label: `shipped to · ${fmt(e.DISTRIBUTED_TO ?? 0)}` },
      { from: "Firm", to: "Outbreak", label: `linked outbreak · ${fmt(e.LINKED_TO ?? 0)}` },
      { from: "Outbreak", to: "State", label: `cases in · ${fmt(e.CASES_IN ?? 0)}`, dashed: true },
    ],
  };
}

/** The company graph: traceability records, illness reports and what the agent writes, in the FSMA 204 chain. */
function companySpec(s: RecordSources): Spec {
  const n = s.graphs.recall.nodes, e = s.graphs.recall.edges;
  return {
    nodes: [
      { id: "src-fsma", x: -40, y: 40, tone: "source", title: "Traceability records", sub: "FSMA 204 format" },
      { id: "src-cases", x: -40, y: 360, tone: "source", title: "Illness reports" },
      { id: "src-agent", x: -40, y: -170, tone: "source", title: "The agent" },
      { id: "Supplier", x: 280, y: 40, tone: "record", title: "Supplier", count: n.Supplier },
      { id: "Lot", x: 560, y: 40, tone: "record", title: "Ingredient lot", count: n.Lot, sub: "Receiving" },
      { id: "Batch", x: 840, y: 40, tone: "record", title: "Batch", count: n.Batch, sub: "Transformation" },
      { id: "ProductLot", x: 1120, y: 40, tone: "record", title: "Product lot", count: n.ProductLot },
      { id: "Store", x: 1400, y: 40, tone: "record", title: "Store", count: n.Store, sub: "Shipping" },
      { id: "Product", x: 1120, y: 210, tone: "gap", title: "Product", count: n.Product },
      { id: "Stock", x: 840, y: 210, tone: "record", title: "Plant or DC", count: (n.Site ?? 0) + (n.DC ?? 0) },
      { id: "Cluster", x: 840, y: 360, tone: "record", title: "Outbreak cluster", count: n.Cluster },
      { id: "Case", x: 1120, y: 360, tone: "record", title: "Case", count: n.Case },
      { id: "Incident", x: 560, y: -170, tone: "agent", title: "Incident", count: n.Incident ?? 0 },
      { id: "Memory", x: 280, y: -170, tone: "agent", title: "Lesson", count: n.Memory ?? 0 },
    ],
    edges: [
      { from: "src-fsma", to: "Supplier", label: "loads", source: true },
      { from: "src-cases", to: "Cluster", label: "pasted", source: true },
      { from: "src-agent", to: "Memory", label: "writes", source: true },
      { from: "Supplier", to: "Lot", label: `supplied · ${fmt(e.SUPPLIED ?? 0)}` },
      { from: "Lot", to: "Batch", label: `used in · ${fmt(e.USED_IN ?? 0)}` },
      { from: "Batch", to: "ProductLot", label: `produced · ${fmt(e.PRODUCED ?? 0)}` },
      { from: "ProductLot", to: "Store", label: `shipped to · ${fmt(e.SHIPPED_TO ?? 0)}` },
      { from: "ProductLot", to: "Product", label: "of", down: true },
      { from: "Product", to: "Store", label: `no lot code · ${fmt(e.SHIPPED_UNTRACKED ?? 0)}`, dashed: true },
      { from: "Batch", to: "Stock", label: `stock · ${fmt((e.STORED_AT ?? 0) + (e.HELD_AT ?? 0))}`, down: true },
      { from: "Cluster", to: "Case", label: `has case · ${fmt(e.HAS_CASE ?? 0)}` },
      { from: "Case", to: "Store", label: `bought at · ${fmt(e.BOUGHT_AT ?? 0)}`, up: true },
      { from: "Memory", to: "Incident", label: "learned in" },
      { from: "Incident", to: "Lot", label: "concerns", down: true },
    ],
  };
}

function toFlow({ nodes, edges }: Spec): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: nodes.map(({ id, x, y, ...data }) => ({ id, type: "box", position: { x, y }, data })),
    edges: edges.map((d, i) => ({
      id: `e${i}`, source: d.from, target: d.to, label: d.label,
      sourceHandle: d.down ? "bottom" : undefined, targetHandle: d.down ? "top" : d.up ? "bottom-in" : undefined,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      style: { strokeWidth: d.source ? 1.2 : 1.6, strokeDasharray: d.source || d.dashed ? "5 4" : undefined, stroke: d.source ? "var(--muted-foreground)" : "var(--foreground)" },
      labelStyle: { fontSize: 11, fill: "var(--foreground)" },
      labelBgStyle: { fill: "var(--background)" }, labelBgPadding: [4, 2] as [number, number], labelBgBorderRadius: 4,
    })),
  };
}

/** Where the records come from and what they become in the graph, as a map you can switch between the two graphs. */
export function SourceMap({ s }: { s: RecordSources }) {
  const [which, setWhich] = useState<"fda" | "company">("fda");
  const flow = toFlow(which === "fda" ? fdaSpec(s) : companySpec(s));
  return (
    <div className="flex flex-col gap-3">
      <ToggleGroup value={[which]} onValueChange={(v) => v[0] && setWhich(v[0] as typeof which)} variant="outline" size="sm" className="self-start" aria-label="Which records">
        <ToggleGroupItem value="fda">Public recall records</ToggleGroupItem>
        <ToggleGroupItem value="company">Company records</ToggleGroupItem>
      </ToggleGroup>
      <div className="h-110 overflow-hidden rounded-md border bg-muted/30" role="img"
        aria-label={which === "fda" ? "openFDA reports become recall records linked to firms, hazards and states; the CDC investigation becomes an outbreak linked to its firm and states." : "Traceability records become suppliers, ingredient lots, batches, product lots and stores; illness reports become cases; the agent writes incidents and lessons."}>
        <ReactFlow key={which} nodes={flow.nodes} edges={flow.edges} nodeTypes={nodeTypes} colorMode="system" fitView fitViewOptions={{ padding: 0.08 }}
          nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} zoomOnScroll={false} preventScrolling={false} panOnDrag minZoom={0.3}
          proOptions={{ hideAttribution: true }}>
          <Background gap={20} size={1} />
        </ReactFlow>
      </div>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span><i className="mr-1.5 inline-block h-0 w-5 border-t border-dashed border-muted-foreground align-middle" />source</span>
        <span><i className="mr-1.5 inline-block h-0 w-5 border-t-2 border-foreground align-middle" />link, with how many</span>
      </p>
    </div>
  );
}
