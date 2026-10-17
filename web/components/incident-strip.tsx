"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { IncidentSummary } from "@server/tools/incident";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const STATUS: Record<IncidentSummary["status"], string> = { open: "Tracing", scoped: "Scope decided, class to confirm", notices_approved: "Notices approved" };
const pad2 = (n: number) => String(n).padStart(2, "0");
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * The shell's incident strip: the newest incident in the graph, with the 24-hour clock from the supplier's notice.
 * Shown on every page except the incident's own dashboard, which has the full header. Read in the browser so the
 * clock runs in the coordinator's time and a slow API never blocks a page.
 */
export function IncidentStrip({ pathname }: { pathname: string }) {
  const [inc, setInc] = useState<IncidentSummary | null>(null);
  useEffect(() => {
    let live = true;
    api<IncidentSummary[]>("/incidents").then((list) => { if (live) setInc(list[0] ?? null); }).catch(() => { if (live) setInc(null); });
    return () => { live = false; };
  }, [pathname]); // a new incident or a confirmation lands on a navigation, so re-read then
  if (!inc || pathname.startsWith("/incident/")) return null;
  return (
    <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <Link href={`/incident/${inc.lot}`} className="font-medium text-foreground hover:underline">Lot {inc.lot}</Link>
      <span className="text-destructive">{inc.hazard}</span>
      <span className="hidden sm:inline">{inc.supplier} ({inc.supplier_id})</span>
      <span className="hidden sm:inline">notice {when(inc.reported_at)}</span>
      <Clock since={inc.reported_at} until={inc.scoped_at} />
      <Badge variant={inc.status === "open" ? "outline" : "secondary"} className="ml-auto">{STATUS[inc.status]}{inc.confirmed_class && ` · Class ${inc.confirmed_class}`}</Badge>
    </div>
  );
}

/** Time since the notice; stops at the scope decision. The FDA Reportable Food Registry report is due 24 h after the notice. */
function Clock({ since, until }: { since: string; until: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  const start = Date.parse(since);
  const a = Math.max(0, (until ? Date.parse(until) : now) - start);
  const h = Math.floor(a / 3.6e6), m = Math.floor((a % 3.6e6) / 6e4), s = Math.floor((a % 6e4) / 1000);
  return (
    <span className={cn("font-mono tabular-nums", !until && now > start + 86_400_000 && "text-destructive")} title={until ? "Scope decided this long after the notice" : "Since the notice; the 24-hour FDA clock"}>
      24 h clock {h}:{pad2(m)}:{pad2(s)}{until ? " · scope decided" : ""}
    </span>
  );
}
