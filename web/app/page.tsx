"use client";

import { useEffect, useRef, useState } from "react";
import type { RecallResult, TraceEvent } from "@server/agent/run";
import type { IncidentReport, Incident } from "@server/tools/incident";
import type { Notice } from "@server/tools/index";
import { FlowChart, StateBars, Exposure, NetworkGraph } from "@/components/dashboard/charts";
import {
  AgentTrace, StoreRegister, Evidence, Notices, Assessment, ScopeTable, ScopeStory, PublicNotice,
  fmt, shortDate, shortTime, type Step,
} from "@/components/dashboard/panels";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardAction } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

const HAZARDS = [
  "Listeria monocytogenes detected in supplier finished-product testing",
  "Salmonella detected in supplier testing",
  "Undeclared milk allergen: supplier labelling error",
  "Metal fragments found in supplier lot",
];
type Status = { incident: Incident | null; hold: IncidentReport["hold"] };
type View = "scope" | "flow" | "network";

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

/** Rebuild the log from a saved run: each turn's notes, then its tool calls. */
function stepsFrom(r: RecallResult): Step[] {
  const notes = r.meta?.notes ?? [];
  const turns = [...new Set([...notes.map((n) => n.turn), ...r.tool_calls.map((c) => c.turn)])].sort((a, b) => a - b);
  return turns.flatMap((t) => [
    ...notes.filter((n) => n.turn === t).map((n) => ({ kind: "note" as const, text: n.text })),
    ...r.tool_calls.filter((c) => c.turn === t).map((c) => ({ kind: "tool" as const, id: c.id, name: c.name, input: c.input, running: false, call: c })),
  ]);
}

export default function Dashboard() {
  const [lot, setLot] = useState("L-204");
  const [hazard, setHazard] = useState(HAZARDS[0]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<RecallResult>();
  const [report, setReport] = useState<IncidentReport>();
  const [status, setStatus] = useState<Status>();
  const [notices, setNotices] = useState<Notice[]>([]);
  const [selected, setSelected] = useState<string>();
  const [stateFilter, setStateFilter] = useState<string>();
  const [view, setView] = useState<View>("scope");
  const [replay, setReplay] = useState<string[]>();
  const es = useRef<EventSource>(null);

  const loadNotices = async (l: string) => setNotices((await api<Notice[]>("/notices")).filter((n) => n.lot === l));
  const refreshStatus = (l: string) => api<Status>(`/incident/${l}/status`).then(setStatus).catch(() => {});

  useEffect(() => {
    api<RecallResult>("/recall/last").then(async (r) => {
      setLot(r.lot); setResult(r); setSteps(stepsFrom(r)); setView("scope");
      const rep = await api<IncidentReport>(`/incident/${r.lot}${r.add_gap_stores === false ? "?gaps=flag" : ""}`);
      setReport(rep); setStatus({ incident: rep.incident, hold: rep.hold });
      if (rep.incident?.hazard) setHazard(rep.incident.hazard);
      await loadNotices(r.lot);
    }).catch(() => {});
    return () => es.current?.close();
  }, []);

  async function trace(e: React.FormEvent) {
    e.preventDefault();
    setError(""); setResult(undefined); setReport(undefined); setStatus(undefined); setSteps([]); setNotices([]); setSelected(undefined); setStateFilter(undefined); setReplay(undefined); setView("network");
    try { await api(`/incident/${lot}/status`); } catch (err) { setError((err as Error).message); return; } // validates the lot without spending a Claude call
    setRunning(true);
    const source = new EventSource(`/recall/stream?lot=${encodeURIComponent(lot)}&hazard=${encodeURIComponent(hazard)}`);
    es.current = source;
    const on = <K extends TraceEvent["type"]>(type: K, fn: (ev: Extract<TraceEvent, { type: K }>) => void) =>
      source.addEventListener(type, (m) => fn(JSON.parse((m as MessageEvent).data)));
    on("start", () => refreshStatus(lot));
    on("note", (ev) => setSteps((s) => [...s, { kind: "note", text: ev.text }]));
    on("tool_start", (ev) => setSteps((s) => [...s, { kind: "tool", id: ev.id, name: ev.name, input: ev.input, running: true }]));
    on("tool_end", (ev) => {
      setSteps((s) => s.map((x) => (x.kind === "tool" && x.id === ev.call.id ? { ...x, running: false, call: ev.call } : x)));
      if (ev.call.error) return;
      if (ev.call.name === "propose_classification" || ev.call.name === "place_hold") refreshStatus(lot);
      // The scope appears once the agent has made its recall decision.
      if (ev.call.name === "minimal_recall")
        api<IncidentReport>(`/incident/${lot}${(ev.call.input as { add_gap_stores?: boolean })?.add_gap_stores === false ? "?gaps=flag" : ""}`).then(setReport);
    });
    on("done", (ev) => { setResult(ev.result); setRunning(false); source.close(); loadNotices(lot); });
    let finished = false;
    source.addEventListener("done", () => (finished = true));
    source.addEventListener("error", (m) => {
      if (finished) return;
      const data = (m as MessageEvent).data;
      setError(data ? JSON.parse(data).message : "Lost connection to the agent. Check the API server and try again.");
      setRunning(false); source.close();
    });
  }

  async function approve(stores: string[]) {
    await api("/notices/approve", { stores });
    await loadNotices(result?.lot ?? lot);
  }
  async function confirm(cls: string, depth: string) {
    const s = await api<Status>(`/incident/${result?.lot ?? lot}/confirm`, { class: cls, depth });
    setStatus(s);
    setReport((r) => (r ? { ...r, incident: s.incident } : r));
  }

  const completed = steps.flatMap((s) => (s.kind === "tool" && s.call && !s.call.error ? [s.name] : []));
  const graphStages = replay ?? ["start", ...completed];
  /** Plays the finished run back on the graph, one agent step every two seconds. */
  function startReplay() {
    setView("network"); setSelected(undefined);
    let i = 0;
    setReplay(["start"]);
    const t = setInterval(() => {
      i++;
      if (i > completed.length) { clearInterval(t); setTimeout(() => setReplay(undefined), 1500); return; }
      setReplay(["start", ...completed.slice(0, i)]);
    }, 2000);
  }
  const incident = report?.incident ?? status?.incident ?? null;
  const hold = report?.hold ?? status?.hold;
  const canApprove = !!incident?.confirmed_at;
  const done = (name: string) => steps.some((s) => s.kind === "tool" && s.name === name && s.call && !s.call.error);
  const approved = notices.filter((n) => n.status === "approved").length;
  const stages = [
    ["Assessed", done("propose_classification")],
    ["Held", done("place_hold")],
    ["Traced", done("trace_forward")],
    ["Scoped", done("minimal_recall")],
    ["Verified", done("trace_backward")],
    ["Drafted", done("draft_recall_notice")],
    ["Confirmed", canApprove],
    [notices.length ? `Approved ${approved}/${notices.length}` : "Approved", notices.length > 0 && approved === notices.length],
  ] as const;
  const store = report?.stores.find((s) => s.id === selected);
  const depth = incident?.confirmed_depth ?? incident?.depth;
  const scopedAfter = result?.finished_at && incident?.reported_at ? Math.round((Date.parse(result.finished_at) - Date.parse(incident.reported_at)) / 1000) : undefined;

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-4 p-4">
      <form onSubmit={trace} className="flex flex-wrap items-center gap-3">
        <label htmlFor="lot" className="text-sm text-muted-foreground">Supplier notice: lot</label>
        <Input id="lot" className="w-28 font-mono" value={lot} onChange={(e) => setLot(e.target.value.toUpperCase())} pattern="L-\d+" required spellCheck={false} />
        <Select value={hazard} onValueChange={(v) => v && setHazard(v)}>
          <SelectTrigger aria-label="Hazard" className="w-full max-w-md"><SelectValue /></SelectTrigger>
          <SelectContent>{HAZARDS.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}</SelectContent>
        </Select>
        <Button type="submit" disabled={running}>{running ? "Working…" : "Open incident"}</Button>
      </form>

      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 className="text-xl font-semibold">{report || status ? <>Lot {lot}{report ? `, ${report.lot.ingredient}` : ""}</> : running ? `Opening incident for ${lot}` : "No incident open"}</h2>
            {report && <p className="text-sm text-muted-foreground">
              {fmt(report.lot.received_kg)} kg from {report.lot.supplier} ({report.lot.supplier_id}), received {shortDate(report.lot.received_at)}.
              {incident && <> Incident {incident.id}.</>}
              {scopedAfter !== undefined && <> Scope decided {scopedAfter >= 60 ? `${Math.floor(scopedAfter / 60)} min ${scopedAfter % 60} s` : `${scopedAfter} s`} after the notice was logged.</>}
            </p>}
            {incident && <p className="text-sm"><b className="text-destructive">Hazard</b> {incident.hazard}. <span className="text-muted-foreground">Logged {shortDate(incident.reported_at)}, {shortTime(incident.reported_at)}.</span></p>}
          </div>
          {incident && <Clock since={incident.reported_at} />}
          <ol className="flex w-full flex-wrap gap-2" aria-label="Recall progress">
            {stages.map(([label, ok], i) => (
              <li key={i}>
                <Badge variant={ok ? "default" : "outline"} className={cn(!ok && running && (i === 0 || stages[i - 1][1]) && "animate-pulse border-primary")}>
                  <span aria-hidden="true">{ok ? "✓" : "○"}</span>{label}
                </Badge>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      {error && !running && !steps.length && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}

      {incident && <Assessment incident={incident} running={running} onConfirm={confirm} />}
      {(hold || report) && <Kpis r={report} hold={hold} lot={lot} />}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <main className="flex min-w-0 flex-col gap-4">
          {report || running || replay ? <>
            <Card>
              <CardHeader>
                <CardTitle>{report ? "What left the plant" : "Live trace"}</CardTitle>
                <CardAction>
                  <Tabs value={view} onValueChange={(v) => setView(v as View)}>
                    <TabsList>
                      <TabsTrigger value="scope" disabled={!report}>Scope table</TabsTrigger>
                      <TabsTrigger value="flow" disabled={!report}>Units flow</TabsTrigger>
                      <TabsTrigger value="network">Record network</TabsTrigger>
                    </TabsList>
                  </Tabs>
                </CardAction>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {report && view !== "network" && <ScopeStory r={report} />}
                {view === "scope" && report && <ScopeTable r={report} />}
                {view === "flow" && report && <>
                  <FlowChart r={report} />
                  <Legend items={[["lot", "Bad lot"], ["recall", `Contains ${report.lot.code}`], ["gap", "Delivered with no lot code"]]} note="Band width is units delivered to stores; held units are not shown." />
                </>}
                {view === "network" && <>
                  <NetworkGraph lot={lot} stages={graphStages} animating={running || !!replay} focus={selected} onPick={setSelected} />
                  <Legend
                    items={[["lot", "Ingredient lot"], ["recall", `Contains ${lot}`], ["hold", "Held at plant or DC"], ["gap", "No lot code"], ["safe", "Cleared"], ["verified", "Backward check"]]}
                    note={running ? "Each record lights up as the agent reaches it." : "Click a store to keep only the records that reach it."}>
                    {!running && completed.length > 0 && <Button variant="link" size="sm" onClick={startReplay} disabled={!!replay}>{replay ? "Replaying…" : "Replay the trace"}</Button>}
                  </Legend>
                </>}
              </CardContent>
            </Card>
            {report && <>
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader><CardTitle>Where it went</CardTitle><CardDescription>Stores by state. Click to filter the table</CardDescription></CardHeader>
                  <CardContent><StateBars r={report} active={stateFilter} onPick={setStateFilter} /></CardContent>
                </Card>
                <Card>
                  <CardHeader><CardTitle>Exposure</CardTitle></CardHeader>
                  <CardContent><Exposure r={report} /></CardContent>
                </Card>
              </div>
              {depth === "consumer" && <PublicNotice r={report} />}
              <StoreRegister r={report} notices={notices} onPick={setSelected} selected={selected} stateFilter={stateFilter} clearState={() => setStateFilter(undefined)} />
            </>}
          </> : (
            <Empty className="border">
              <EmptyHeader>
                <EmptyTitle>No incident open</EmptyTitle>
                <EmptyDescription>Enter the lot code and hazard from the supplier&apos;s notice and open the incident. The agent works the recall from the FalkorDB traceability graph and builds it here for you to confirm.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </main>
        <div className="flex min-w-0 flex-col gap-4">
          <AgentTrace steps={steps} running={running} error={running || steps.length ? error : undefined} summary={result?.summary} meta={result?.meta} />
          {result && <Notices lot={result.lot} notices={notices} canApprove={canApprove} onApprove={approve} onPick={setSelected} />}
        </div>
      </div>

      {report && store && <Evidence r={report} store={store} notice={notices.find((n) => n.store === store.id)} canApprove={canApprove} onClose={() => setSelected(undefined)} onApprove={(id) => approve([id])} />}
    </div>
  );
}

/** Swatches use theme tokens and a distinct shape per meaning, so colour is never the only cue. */
const SWATCH: Record<string, string> = {
  lot: "bg-foreground",
  recall: "bg-destructive",
  hold: "bg-chart-2 rounded-none",
  gap: "bg-chart-1 border border-dashed border-foreground",
  safe: "bg-muted-foreground rounded-full",
  verified: "bg-transparent border-2 border-chart-3 rounded-full",
};
function Legend({ items, note, children }: { items: [string, string][]; note: string; children?: React.ReactNode }) {
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map(([k, label]) => (
        <span key={k} className="inline-flex items-center gap-1.5"><i className={cn("inline-block size-2.5 rounded-sm", SWATCH[k])} />{label}</span>
      ))}
      <span>{note}</span>
      {children}
    </p>
  );
}

const pad2 = (n: number) => String(n).padStart(2, "0");
/** The 24-hour window that starts when the notice is logged. */
function Clock({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now()); // only mounted after an incident loads, so no SSR mismatch
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = Date.parse(since) + 86_400_000 - now;
  const a = Math.abs(left);
  const h = Math.floor(a / 3.6e6), m = Math.floor((a % 3.6e6) / 6e4), s = Math.floor((a % 6e4) / 1000);
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-xs text-muted-foreground">24 h reporting window</p>
      <p className={cn("font-mono text-2xl font-semibold tabular-nums", left < 0 && "text-destructive")}>{left < 0 ? "Overdue " : ""}{h}:{pad2(m)}:{pad2(s)}</p>
      <p className="text-xs text-muted-foreground">FDA Reportable Food Registry and FSMA 204 records request</p>
    </div>
  );
}

function Kpi({ label, foot, tone, children }: { label: string; foot: string; tone?: string; children: React.ReactNode }) {
  return (
    <Card size="sm" className={cn("border-t-2", tone ?? "border-t-border")}>
      <CardContent className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="flex items-baseline gap-1.5 text-3xl font-semibold tabular-nums">{children}</p>
        <p className="text-xs text-muted-foreground">{foot}</p>
      </CardContent>
    </Card>
  );
}
const Of = ({ children }: { children: React.ReactNode }) => <span className="text-sm font-normal text-muted-foreground">{children}</span>;

function Kpis({ r, hold, lot }: { r?: IncidentReport; hold?: IncidentReport["hold"]; lot: string }) {
  const c = r?.counts;
  const saved = c ? 1 - c.units_to_pull / c.blanket_units : 0;
  const wait = <Skeleton className="h-8 w-16" />;
  return (
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" aria-label="Key figures">
      <Kpi tone="border-t-destructive" label="Stores that must pull product"
        foot={c ? `${c.blanket} stores stocked the ${r!.skus.length} affected products. The records clear ${c.safe} of them; a blanket recall would hit all ${c.blanket}.` : "Tracing deliveries store by store."}>
        {c ? <>{c.targeted}<Of>of {c.blanket}</Of></> : wait}
      </Kpi>
      <Kpi label="Units to pull from stores"
        foot={c ? `A blanket recall of these products would pull ${fmt(c.blanket_units)}. Targeting saves ${Math.round(saved * 100)}%.` : "Counted from delivery records."}>
        {c ? fmt(c.units_to_pull) : wait}
      </Kpi>
      <Kpi tone="border-t-chart-2" label="Held before it left"
        foot={hold ? `Unshipped product at ${hold.totals.locations} plants and DCs, plus ${hold.totals.raw_kg} kg of unused ${lot}. On hold until QA releases it.` : "Placing the hold."}>
        {hold ? <>{fmt(hold.totals.units)}<Of>units</Of></> : wait}
      </Kpi>
      <Kpi tone="border-t-chart-1" label="Can't be cleared"
        foot={r ? `Got ${[...new Set(r.stores.flatMap((s) => s.untracked.map((u) => u.product)))].join(", ") || "affected product"} with no lot code on the delivery record. ${r.add_gap_stores ? "Pulled to be safe." : "Flagged for review."}` : "Checking delivery records."}>
        {c ? <>{c.gaps}<Of>stores</Of></> : wait}
      </Kpi>
      <Kpi tone="border-t-muted-foreground" label="Cleared by the records"
        foot={`Every lot they received was traced back to its ingredients. None contains ${lot}.`}>
        {c ? <>{c.safe}<Of>stores</Of></> : wait}
      </Kpi>
    </section>
  );
}
