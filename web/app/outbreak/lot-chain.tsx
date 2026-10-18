"use client";

import { Handle, MarkerType, Position, ReactFlow, Background, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { CaseReport, LotChain as Chain } from "@server/data/real";
import { cn } from "@/lib/utils";

type Box = { kicker: string; title: string; lines: string[]; tone: "report" | "lot" | "firm" | "notice"; href?: string };
const W = 250;
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function BoxNode({ data }: NodeProps<Node<Box>>) {
  const body = (
    <>
      <span className="text-[10px] text-muted-foreground uppercase">{data.kicker}</span>
      <span className={cn("text-sm leading-tight font-medium", data.tone === "lot" && "font-mono")}>{data.title}</span>
      {data.lines.map((l) => <span key={l} className="text-[11px] leading-snug text-muted-foreground">{l}</span>)}
    </>
  );
  return (
    <div className={cn("flex flex-col gap-0.5 rounded-md border bg-card px-2.5 py-1.5 text-card-foreground shadow-xs",
      data.tone === "report" && "border-dashed border-foreground/40 bg-muted/40",
      data.tone === "lot" && "border-2 border-chart-2",
      data.tone === "firm" && "border-l-4 border-l-chart-3",
      data.tone === "notice" && "border-l-4 border-l-chart-3 border-dashed")} style={{ width: data.tone === "lot" ? 170 : W }}>
      <Handle type="target" position={Position.Left} className="opacity-0" />
      {data.href ? <a href={data.href} target="_blank" rel="noreferrer" className="nodrag flex flex-col gap-0.5 hover:underline">{body}</a> : body}
      <Handle type="source" position={Position.Right} className="opacity-0" />
    </div>
  );
}
const nodeTypes = { box: BoxNode };

/** Where a recall went, in a few words: "16 states + PR", "Nationwide". */
const reach = (r: Chain["recalls"][number]) => {
  if (r.nationwide) return "Nationwide";
  const other = r.states.filter((s) => s === "PR" || s === "DC"), n = r.states.length - other.length;
  return `${n} ${n === 1 ? "state" : "states"}${other.length ? ` + ${other.join(", ")}` : ""}`;
};

/** The case report, the shared lot code, and every firm whose recall names it, in date order. */
export function LotChain({ report, chain }: { report: CaseReport; chain: Chain }) {
  const o = report.outbreak;
  const ROW = 96, top = ((chain.coverage.length - 1) * ROW) / 2;
  const nodes: Node<Box>[] = [
    { id: "report", type: "box", position: { x: 0, y: top }, data: { tone: "report", kicker: "Uploaded case report", title: `${o.states.length} states with cases`, lines: [`Illnesses ${day(o.onset_from)} to ${day(o.onset_to)}`, o.hazards.join(" + ")] } },
    { id: "lot", type: "box", position: { x: 420, y: top + 8 }, data: { tone: "lot", kicker: "Lot code", title: chain.lot, lines: [`Named by ${chain.firms.length} firms`] } },
    ...chain.coverage.map((s, i): Node<Box> => {
      const rs = chain.recalls.filter((r) => s.recalls.includes(r.id));
      const notice = rs.find((r) => r.source);
      return { id: `f${i}`, type: "box", position: { x: 760, y: i * ROW }, data: {
        tone: notice ? "notice" : "firm", kicker: notice ? "FDA recall notice, not in openFDA yet" : "openFDA recall", title: s.firm, href: notice?.source ?? undefined,
        lines: [`${day(s.date)} · ${rs.map((r) => r.id).join(", ")}`, `${reach(rs[0])} · ${rs[0].quantity}`],
      } };
    }),
  ];
  const edge = (id: string, source: string, target: string, label: string, dashed = false): Edge => ({
    id, source, target, label, markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
    style: { strokeWidth: 1.6, strokeDasharray: dashed ? "5 4" : undefined, stroke: "var(--foreground)" },
    labelStyle: { fontSize: 11, fill: "var(--foreground)" }, labelBgStyle: { fill: "var(--background)" }, labelBgPadding: [4, 2], labelBgBorderRadius: 4,
  });
  const edges: Edge[] = [
    edge("e-report", "report", "lot", `${report.matching.recalls} recalls · ${report.lots_read} lot codes`, true),
    ...chain.coverage.map((s, i) => edge(`e${i}`, "lot", `f${i}`, s.added.length ? `+${s.added.length} case states` : "no new case states")),
  ];
  return (
    <div className="h-80 overflow-hidden rounded-md border bg-muted/30" role="img"
      aria-label={`The uploaded case report leads to lot ${chain.lot}, named in recalls by ${chain.firms.join(", ")}.`}>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} colorMode="system" fitView fitViewOptions={{ padding: 0.08 }}
        nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} zoomOnScroll={false} preventScrolling={false} panOnDrag minZoom={0.3}
        proOptions={{ hideAttribution: true }}>
        <Background gap={20} size={1} />
      </ReactFlow>
    </div>
  );
}
