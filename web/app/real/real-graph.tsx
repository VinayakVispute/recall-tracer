"use client";

import { useEffect, useRef, useState } from "react";
import cytoscape from "cytoscape";
import type { RealGraph } from "@server/data/real";
import { readPalette } from "@/components/dashboard/charts";
import { cn } from "@/lib/utils";

// Left to right: the outbreak, the firm, its recalls, then where they went and what was in them.
const COLUMN: Record<string, number> = { outbreak: 0, firm: 1, "firm-downstream": 1, recall: 2, "recall-downstream": 2, hazard: 3, state: 4, "state-shipped": 4, "state-both": 4, "state-gap": 4 };

/** The real outbreak's record network, drawn once from GET /real/graph. Click a node to keep what connects to it. */
export function RealGraphView({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [els, setEls] = useState<RealGraph>();
  const [error, setError] = useState("");
  useEffect(() => { fetch("/api/real/graph").then((r) => r.json()).then(setEls).catch(() => setError("Cannot load the graph.")); }, []);

  useEffect(() => {
    if (!els || !ref.current) return;
    const p = readPalette();
    const font = getComputedStyle(document.body).fontFamily;
    const COLOR: Record<string, string> = {
      outbreak: p.fg, firm: p.chart2, "firm-downstream": p.chart3, recall: p.destructive, "recall-downstream": p.chart3,
      hazard: p.chart1, state: p.muted, "state-shipped": p.muted, "state-both": p.destructive, "state-gap": p.chart1,
    };
    const EDGE: Record<string, { color: string; style?: string }> = {
      linked: { color: p.fg }, cases: { color: p.chart1, style: "dashed" }, recalled: { color: p.destructive }, distributed: { color: p.destructive },
      hazard: { color: p.chart1, style: "dotted" }, supplied: { color: p.chart3, style: "dashed" },
    };
    // Column layout: x by kind, y spread evenly inside the column so 18 recalls stay readable.
    const cols = new Map<number, string[]>();
    for (const n of els.nodes) { const c = COLUMN[n.data.kind] ?? 2; cols.set(c, [...(cols.get(c) ?? []), n.data.id]); }
    const H = 520, W = 900, positions: Record<string, { x: number; y: number }> = {};
    for (const [c, ids] of cols) ids.forEach((id, i) => { positions[id] = { x: 60 + c * (W / 4.5), y: ((i + 1) * H) / (ids.length + 1) }; });

    const cy = cytoscape({
      container: ref.current,
      elements: [...els.nodes, ...els.edges],
      layout: { name: "preset", positions: positions as never, fit: true, padding: 24 },
      style: [
        { selector: "node", style: { "background-color": (n: cytoscape.NodeSingular) => COLOR[n.data("kind")] ?? p.muted, width: 12, height: 12, label: "data(label)", "font-size": 8, "font-family": font, color: p.fg, "text-valign": "bottom", "text-margin-y": 3, "text-max-width": "110px", "text-wrap": "ellipsis" } },
        { selector: 'node[kind = "outbreak"]', style: { width: 24, height: 24, "font-size": 10, "font-weight": 600, "text-wrap": "wrap" } },
        { selector: 'node[kind = "firm"], node[kind = "firm-downstream"]', style: { shape: "round-rectangle", width: 18, height: 18, "font-size": 9, "text-wrap": "wrap" } },
        { selector: 'node[kind ^= "state"]', style: { width: 20, height: 20, "font-size": 10, "font-weight": 600, "text-valign": "center", color: p.bg } },
        { selector: 'node[kind = "state-gap"]', style: { "border-width": 2, "border-color": p.chart1, "border-style": "dashed", width: 26, height: 26 } },
        { selector: 'node[kind = "hazard"]', style: { shape: "diamond", width: 14, height: 14 } },
        { selector: "edge", style: { width: 1, "line-color": (e: cytoscape.EdgeSingular) => EDGE[e.data("kind")]?.color ?? p.border, "target-arrow-color": (e: cytoscape.EdgeSingular) => EDGE[e.data("kind")]?.color ?? p.border, "line-style": ((e: cytoscape.EdgeSingular) => EDGE[e.data("kind")]?.style ?? "solid") as never, "curve-style": "bezier", "target-arrow-shape": "triangle", "arrow-scale": 0.5, opacity: 0.8 } },
        { selector: 'edge[kind = "cases"], edge[kind = "linked"], edge[kind = "supplied"]', style: { width: 1.6, label: "data(label)", "font-size": 7, "font-family": font, color: p.muted, "text-rotation": "autorotate", "text-margin-y": -6 } },
        { selector: ".dim", style: { opacity: 0.08 } },
      ],
      userZoomingEnabled: false,
    });
    cy.on("tap", (e) => {
      cy.elements().removeClass("dim");
      if (e.target === cy) return;
      cy.elements().not(e.target.neighborhood().add(e.target)).addClass("dim");
    });
    return () => { cy.destroy(); };
  }, [els]);

  if (error) return <p className="text-sm text-destructive" role="alert">{error}</p>;
  return <div ref={ref} className={cn("h-[520px] w-full", className)} aria-label="Record network of the real outbreak" role="img" />;
}
