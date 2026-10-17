"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RecallResult, TraceEvent } from "@server/agent/run";
import type { IncidentReport, Incident } from "@server/tools/incident";
import type { Notice } from "@server/tools/index";
import { FlowChart, StateBars, Exposure, NetworkGraph } from "@/components/dashboard/charts";
import {
  AgentTrace, StoreRegister, Evidence, Notices, Assessment, ScopeTable, ScopeStory, PublicNotice,
  fmt, shortDate, shortTime, type Filter,
} from "@/components/dashboard/panels";
import { ReplayBar, useReplay } from "@/components/dashboard/replay";
import { Drawer } from "@/components/dashboard/drawer";
import { completedOf, fromResult, loadRecorded, stepsOf, type Recording, type TimedEvent } from "@/lib/trace";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardAction } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

const HAZARDS = [
  "Listeria monocytogenes detected in supplier finished-product testing",
  "Salmonella detected in supplier testing",
  "Undeclared milk allergen: supplier labelling error",
  "Metal fragments found in supplier lot",
];
const DEMO_LOT = "L-204";
type Status = { incident: Incident | null; hold: IncidentReport["hold"] };
type View = "scope" | "flow" | "network";
type Gaps = "add" | "flag";

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}
const wantsStep = () => typeof location !== "undefined" && /^#step-\d+$/.test(location.hash);

export default function Dashboard() {
  const [lot, setLot] = useState(DEMO_LOT);
  const [hazard, setHazard] = useState(HAZARDS[0]);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<RecallResult>();
  const [report, setReport] = useState<IncidentReport>();
  const [status, setStatus] = useState<Status>();
  const [notices, setNotices] = useState<Notice[]>([]);
  const [selected, setSelected] = useState<string>();
  const [stateFilter, setStateFilter] = useState<string>();
  const [storeFilter, setStoreFilter] = useState<Filter>("all");
  const [gaps, setGaps] = useState<Gaps>("add");
  const [view, setView] = useState<View>("scope");
  const [rec, setRec] = useState<Recording>();
  const [lastLive, setLastLive] = useState<Recording>();
  const es = useRef<EventSource>(null);
  const replay = useReplay(rec);

  const loadNotices = async (l: string) => setNotices((await api<Notice[]>("/notices")).filter((n) => n.lot === l));
  const refreshStatus = (l: string) => api<Status>(`/incident/${l}/status`).then(setStatus).catch(() => {});
  const loadReport = async (l: string, mode: Gaps) => {
    const rep = await api<IncidentReport>(`/incident/${l}${mode === "flag" ? "?gaps=flag" : ""}`);
    setReport(rep); setStatus({ incident: rep.incident, hold: rep.hold }); setGaps(mode);
    return rep;
  };

  /** Plays a run back: this session's live run, else the recorded demo run, else the saved run with estimated timing. */
  async function startReplay(l = lot, saved = result) {
    setError(""); setSelected(undefined); setView("network");
    const source = (lastLive?.lot === l ? lastLive : undefined) ?? (await loadRecorded(l)) ?? (saved?.lot === l ? fromResult(saved) : undefined);
    if (!source) { setError(`No recorded run for ${l} yet. Open the incident to record one.`); return; }
    if (report?.lot.code !== l) {
      try { await loadReport(l, "add"); } catch (e) { setError((e as Error).message); return; }
      await loadNotices(l).catch(() => {});
    }
    setLot(l); setRec(source);
  }
  function exitReplay() {
    setRec(undefined);
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  }

  useEffect(() => {
    api<RecallResult>("/recall/last").then(async (r) => {
      setLot(r.lot); setResult(r); setEvents(fromResult(r).events); setView("scope");
      const rep = await loadReport(r.lot, r.add_gap_stores === false ? "flag" : "add");
      if (rep.incident?.hazard) setHazard(rep.incident.hazard);
      await loadNotices(r.lot);
      if (wantsStep()) startReplay(r.lot, r); // a shared link to one step of the run
    }).catch(() => { if (wantsStep()) startReplay(DEMO_LOT, undefined); });
    return () => es.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run() {
    exitReplay();
    setError(""); setResult(undefined); setReport(undefined); setStatus(undefined); setEvents([]); setNotices([]); setSelected(undefined); setStateFilter(undefined); setStoreFilter("all"); setView("network");
    try { await api(`/incident/${lot}/status`); } catch (err) { setError((err as Error).message); return; } // validates the lot without spending a Claude call
    setRunning(true);
    const source = new EventSource(`/recall/stream?lot=${encodeURIComponent(lot)}&hazard=${encodeURIComponent(hazard)}`);
    es.current = source;
    const t0 = Date.now();
    const timed: TimedEvent[] = [];
    const on = <K extends TraceEvent["type"]>(type: K, fn: (ev: Extract<TraceEvent, { type: K }>) => void) =>
      source.addEventListener(type, (m) => {
        const ev = JSON.parse((m as MessageEvent).data) as Extract<TraceEvent, { type: K }>;
        timed.push({ ...ev, at: Date.now() - t0 } as TimedEvent); // kept so the run can be replayed with its real timing
        if (ev.type !== "done") setEvents((s) => [...s, ev]);
        fn(ev);
      });
    on("start", () => refreshStatus(lot));
    on("note", () => {});
    on("tool_start", () => {});
    on("tool_end", (ev) => {
      if (ev.call.error) return;
      if (ev.call.name === "propose_classification" || ev.call.name === "place_hold") refreshStatus(lot);
      // The scope appears once the agent has made its recall decision.
      if (ev.call.name === "minimal_recall")
        loadReport(lot, (ev.call.input as { add_gap_stores?: boolean })?.add_gap_stores === false ? "flag" : "add");
    });
    let finished = false;
    on("done", (ev) => {
      finished = true;
      setResult(ev.result); setRunning(false); source.close(); loadNotices(lot);
      setLastLive({ lot, recorded_at: new Date(t0).toISOString(), events: timed, source: "live" });
    });
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
  /** The headline tiles jump to the store table, filtered to what the tile counts. */
  function showStores(f: Filter) {
    setStoreFilter(f); setStateFilter(undefined);
    document.getElementById("store-decisions")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  const closeDrawer = useCallback(() => setSelected(undefined), []);

  // Live and replay share one path: events in, investigation log and graph state out.
  const replaying = !!rec;
  const steps = stepsOf(replaying ? replay.visible : events);
  const completed = completedOf(steps);
  const graphStages = ["start", ...completed];
  const doneEv = replaying ? replay.visible.find((e) => e.type === "done") : undefined;
  const shown = replaying ? (doneEv?.type === "done" ? doneEv.result : undefined) : result;
  const lastEnd = replaying ? replay.visible.findLast((e) => e.type === "tool_end") : undefined;
  const currentId = lastEnd?.type === "tool_end" ? lastEnd.call.id : undefined;
  const scoped = !replaying || completed.includes("minimal_recall");
  const showReport = scoped ? report : undefined;

  const incident = report?.incident ?? status?.incident ?? null;
  const hold = report?.hold ?? status?.hold;
  const canApprove = !!incident?.confirmed_at;
  const done = (name: string) => completed.includes(name);
  const approved = notices.filter((n) => n.status === "approved").length;
  const stages = [
    ["Assessed", done("propose_classification")],
    ["Held", done("place_hold")],
    ["Traced", done("trace_forward")],
    ["Scoped", done("minimal_recall")],
    ["Verified", done("trace_backward")],
    ["Drafted", done("draft_recall_notice")],
    ["Confirmed", canApprove && (!replaying || !!shown)],
    [notices.length ? `Approved ${approved}/${notices.length}` : "Approved", notices.length > 0 && approved === notices.length && (!replaying || !!shown)],
  ] as const;
  const active = running || (replaying && replay.playing);
  const store = showReport?.stores.find((s) => s.id === selected);
  const depth = incident?.confirmed_depth ?? incident?.depth;
  const scopedAfter = result?.finished_at && incident?.reported_at ? Math.round((Date.parse(result.finished_at) - Date.parse(incident.reported_at)) / 1000) : undefined;

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-4 p-4">
      <form onSubmit={(e) => { e.preventDefault(); run(); }} className="flex flex-wrap items-center gap-3">
        <label htmlFor="lot" className="text-sm text-muted-foreground">Supplier notice: lot</label>
        <Input id="lot" className="w-28 font-mono" value={lot} onChange={(e) => setLot(e.target.value.toUpperCase())} pattern="L-\d+" required spellCheck={false} />
        <Select value={hazard} onValueChange={(v) => v && setHazard(v)}>
          <SelectTrigger aria-label="Hazard" className="w-full max-w-md"><SelectValue /></SelectTrigger>
          <SelectContent>{HAZARDS.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}</SelectContent>
        </Select>
        <Button type="submit" disabled={running}>{running ? "Working…" : "Open incident"}</Button>
        <Button type="button" variant="outline" disabled={running || replaying} onClick={() => startReplay()}>Replay the trace</Button>
      </form>

      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
              {report || status ? <>Lot {lot}{report ? `, ${report.lot.ingredient}` : ""}</> : running ? `Opening incident for ${lot}` : "No incident open"}
              {replaying && <Badge variant="outline">Replay</Badge>}
            </h2>
            {report && <p className="text-sm text-muted-foreground">
              {fmt(report.lot.received_kg)} kg from {report.lot.supplier} ({report.lot.supplier_id}), received {shortDate(report.lot.received_at)}.
              {incident && <> Incident {incident.id}.</>}
              {scopedAfter !== undefined && !replaying && <> Scope decided {scopedAfter >= 60 ? `${Math.floor(scopedAfter / 60)} min ${scopedAfter % 60} s` : `${scopedAfter} s`} after the notice was logged.</>}
            </p>}
            {incident && <p className="text-sm"><b className="text-destructive">Hazard</b> {incident.hazard}. <span className="text-muted-foreground">Logged {shortDate(incident.reported_at)}, {shortTime(incident.reported_at)}.</span></p>}
          </div>
          {incident && <Clock since={incident.reported_at} />}
          <ol className="flex w-full flex-wrap gap-2" aria-label="Recall progress">
            {stages.map(([label, ok], i) => (
              <li key={i}>
                <Badge variant={ok ? "default" : "outline"} className={cn(!ok && active && (i === 0 || stages[i - 1][1]) && "animate-pulse border-primary")}>
                  <span aria-hidden="true">{ok ? "✓" : "○"}</span>{label}
                </Badge>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      {error && !running && !events.length && !replaying && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}

      {incident && (!replaying || done("propose_classification")) && <Assessment incident={incident} running={running} onConfirm={confirm} />}
      {(hold || report) && (!replaying || done("place_hold")) && <Kpis r={showReport} hold={hold} lot={lot} gaps={gaps} onGaps={(m) => loadReport(lot, m)} onShow={showStores} canPreview={!replaying} />}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <main className="flex min-w-0 flex-col gap-4">
          {report || running || replaying ? <>
            <Card>
              <CardHeader>
                <CardTitle>{showReport ? "What left the plant" : replaying ? "Replay of the trace" : "Live trace"}</CardTitle>
                <CardAction>
                  <Tabs value={view} onValueChange={(v) => setView(v as View)}>
                    <TabsList>
                      <TabsTrigger value="scope" disabled={!showReport}>Scope table</TabsTrigger>
                      <TabsTrigger value="flow" disabled={!showReport}>Units flow</TabsTrigger>
                      <TabsTrigger value="network">Record network</TabsTrigger>
                    </TabsList>
                  </Tabs>
                </CardAction>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {showReport && view !== "network" && <ScopeStory r={showReport} />}
                {view === "scope" && showReport && <ScopeTable r={showReport} />}
                {view === "flow" && showReport && <>
                  <FlowChart r={showReport} />
                  <Legend items={[["lot", "Bad lot"], ["recall", `Contains ${showReport.lot.code}`], ["gap", "Delivered with no lot code"]]} note="Band width is units delivered to stores; held units are not shown." />
                </>}
                {view === "network" && <>
                  <NetworkGraph lot={lot} stages={graphStages} animating={active} focus={selected} onPick={setSelected} />
                  <Legend
                    items={[["lot", "Ingredient lot"], ["recall", `Contains ${lot}`], ["hold", "Held at plant or DC"], ["gap", "No lot code"], ["safe", "Cleared"], ["verified", "Backward check"]]}
                    note={running ? "Each record lights up as the agent reaches it." : replaying ? "The graph shows what the agent had reached at the playhead." : "Click a store to keep only the records that reach it."} />
                </>}
                {rec && <ReplayBar rec={rec} r={replay} onExit={exitReplay} />}
              </CardContent>
            </Card>
            {showReport && <>
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader><CardTitle>Where it went</CardTitle><CardDescription>Stores by state. Click to filter the table</CardDescription></CardHeader>
                  <CardContent><StateBars r={showReport} active={stateFilter} onPick={setStateFilter} /></CardContent>
                </Card>
                <Card>
                  <CardHeader><CardTitle>Exposure</CardTitle></CardHeader>
                  <CardContent><Exposure r={showReport} /></CardContent>
                </Card>
              </div>
              {depth === "consumer" && <PublicNotice r={showReport} />}
              <StoreRegister r={showReport} notices={notices} onPick={setSelected} selected={selected} stateFilter={stateFilter} clearState={() => setStateFilter(undefined)} filter={storeFilter} onFilter={setStoreFilter} />
            </>}
          </> : (
            <Empty className="border">
              <EmptyHeader>
                <EmptyTitle>No incident open</EmptyTitle>
                <EmptyDescription>Enter the lot code and hazard from the supplier&apos;s notice and open the incident. The agent works the recall from the FalkorDB traceability graph and builds it here for you to confirm.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" onClick={() => startReplay(DEMO_LOT, undefined)}>Watch the recorded {DEMO_LOT} run</Button>
                <p className="text-xs text-muted-foreground">Plays a real run step by step. No API key needed.</p>
              </EmptyContent>
            </Empty>
          )}
        </main>
        <div className="flex min-w-0 flex-col gap-4">
          <AgentTrace steps={steps} running={running} replaying={replaying} current={currentId} error={running || events.length ? error : undefined} onRetry={run} summary={shown?.summary} meta={shown?.meta} />
          {shown && <Notices lot={shown.lot} notices={notices} canApprove={canApprove} onApprove={approve} onPick={setSelected} />}
        </div>
      </div>

      {showReport && store && (
        <Drawer label={`Evidence for ${store.name}`} onClose={closeDrawer}>
          <Evidence r={showReport} store={store} notice={notices.find((n) => n.store === store.id)} canApprove={canApprove} onClose={closeDrawer} onApprove={(id) => approve([id])} />
        </Drawer>
      )}
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

function Kpi({ label, foot, tone, onClick, action, children }: { label: string; foot: string; tone?: string; onClick?: () => void; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card size="sm" className={cn("border-t-2", tone ?? "border-t-border", onClick && "transition-colors hover:bg-muted/40")}>
      <CardContent className="flex flex-col gap-1">
        {onClick
          ? <button type="button" onClick={onClick} className="flex flex-col gap-1 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50" title="Show these stores in the table">
              <span className="text-sm text-muted-foreground">{label} <span aria-hidden="true">→</span></span>
              <span className="flex items-baseline gap-1.5 text-3xl font-semibold tabular-nums">{children}</span>
            </button>
          : <>
              <p className="text-sm text-muted-foreground">{label}</p>
              <div className="flex items-baseline gap-1.5 text-3xl font-semibold tabular-nums">{children}</div>
            </>}
        <p className="text-xs text-muted-foreground">{foot}</p>
        {action}
      </CardContent>
    </Card>
  );
}
const Of = ({ children }: { children: React.ReactNode }) => <span className="text-sm font-normal text-muted-foreground">{children}</span>;

function Kpis({ r, hold, lot, gaps, onGaps, onShow, canPreview }: {
  r?: IncidentReport; hold?: IncidentReport["hold"]; lot: string; gaps: Gaps; onGaps: (m: Gaps) => void; onShow: (f: Filter) => void; canPreview: boolean;
}) {
  const c = r?.counts;
  const saved = c ? 1 - c.units_to_pull / c.blanket_units : 0;
  const wait = <span data-slot="skeleton" className="inline-block h-8 w-16 animate-pulse rounded-md bg-muted" />;
  const show = (f: Filter) => (c ? () => onShow(f) : undefined);
  return (
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" aria-label="Key figures">
      <Kpi tone="border-t-destructive" label="Stores that must pull product" onClick={show("recall")}
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
      <Kpi tone="border-t-chart-1" label="Can't be cleared" onClick={show("gap")}
        foot={r ? `Got ${[...new Set(r.stores.flatMap((s) => s.untracked.map((u) => u.product)))].join(", ") || "affected product"} with no lot code on the delivery record. ${gaps === "add" ? "Pulled to be safe." : "Flag-only preview: not counted in the recall above."}` : "Checking delivery records."}
        action={c && c.gaps > 0 && canPreview ? (
          <Button size="xs" variant="link" className="self-start px-0" onClick={() => onGaps(gaps === "add" ? "flag" : "add")}>
            {gaps === "add" ? "Preview flag-only instead" : "Back to the agent's decision"}
          </Button>
        ) : undefined}>
        {c ? <>{c.gaps}<Of>stores</Of></> : wait}
      </Kpi>
      <Kpi tone="border-t-muted-foreground" label="Cleared by the records" onClick={show("safe")}
        foot={`Every lot they received was traced back to its ingredients. None contains ${lot}.`}>
        {c ? <>{c.safe}<Of>stores</Of></> : wait}
      </Kpi>
    </section>
  );
}
