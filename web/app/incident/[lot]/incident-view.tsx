"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { RecallResult, TraceEvent } from "@server/agent/run";
import type { IncidentReport, Incident } from "@server/tools/incident";
import type { Notice } from "@server/tools/index";
import { FlowChart, StateBars, Exposure, NetworkGraph } from "@/components/dashboard/charts";
import { Play } from "lucide-react";
import {
  AgentTrace, StoreRegister, Evidence, Notices, Assessment, ScopeTable, ScopeStory, PublicNotice,
  fmt, shortDate, shortTime, type Filter,
} from "@/components/dashboard/panels";
import { ReplayBar, useReplay } from "@/components/dashboard/replay";
import { Drawer } from "@/components/dashboard/drawer";
import { completedOf, fromResult, loadRecorded, stepsOf, type Recording, type TimedEvent } from "@/lib/trace";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardAction } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export type Status = { incident: Incident | null; hold: IncidentReport["hold"] };
/** What the server page read from the API, so the first paint already has the incident. */
export type Initial = { run: RecallResult | null; report: IncidentReport | null; status: Status | null; notices: Notice[] };
type View = "scope" | "flow" | "network";
type Gaps = "add" | "flag";

const wantsStep = () => typeof location !== "undefined" && /^#step-\d+$/.test(location.hash);

/**
 * The incident dashboard for one lot. `autostart` (from the supplier notice) runs the agent once; `playback` plays
 * the recorded run on the replay timeline instead. Either way the URL then drops the flag, so a reload never reruns.
 */
export function IncidentView({ lot, hazard, autostart, playback, initial }: { lot: string; hazard?: string; autostart: boolean; playback: boolean; initial: Initial }) {
  const router = useRouter();
  const [events, setEvents] = useState<TraceEvent[]>(() => (initial.run ? fromResult(initial.run).events : []));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<RecallResult | undefined>(initial.run ?? undefined);
  const [report, setReport] = useState<IncidentReport | undefined>(initial.report ?? undefined);
  const [status, setStatus] = useState<Status | undefined>(initial.status ?? undefined);
  const [notices, setNotices] = useState<Notice[]>(initial.notices);
  const [selected, setSelected] = useState<string>();
  const [stateFilter, setStateFilter] = useState<string>();
  const [storeFilter, setStoreFilter] = useState<Filter>("all");
  const [gaps, setGaps] = useState<Gaps>(initial.run?.add_gap_stores === false ? "flag" : "add");
  const [view, setView] = useState<View>("scope");
  const [rec, setRec] = useState<Recording>();
  const [lastLive, setLastLive] = useState<Recording>();
  const es = useRef<EventSource>(null);
  const started = useRef(false);
  const replay = useReplay(rec);

  const loadNotices = async (l: string) => setNotices((await api<Notice[]>("/notices")).filter((n) => n.lot === l));
  const refreshStatus = (l: string) => api<Status>(`/incident/${l}/status`).then(setStatus).catch(() => {});
  const loadReport = async (l: string, mode: Gaps) => {
    const rep = await api<IncidentReport>(`/incident/${l}${mode === "flag" ? "?gaps=flag" : ""}`);
    setReport(rep); setStatus({ incident: rep.incident, hold: rep.hold }); setGaps(mode);
    return rep;
  };

  /** Plays a run back: this session's live run, else the recorded demo run, else the saved run with estimated timing. */
  async function startReplay(saved = result) {
    setError(""); setSelected(undefined); setView("network");
    const source = (lastLive?.lot === lot ? lastLive : undefined) ?? (await loadRecorded(lot)) ?? (saved?.lot === lot ? fromResult(saved) : undefined);
    if (!source) { setError(`No recorded run for ${lot} yet. Open the incident to record one.`); return; }
    if (report?.lot.code !== lot) {
      try { await loadReport(lot, "add"); } catch (e) { setError((e as Error).message); return; }
      await loadNotices(lot).catch(() => {});
    }
    setRec(source);
  }
  function exitReplay() {
    setRec(undefined);
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  }

  async function run() {
    exitReplay();
    setError(""); setResult(undefined); setReport(undefined); setStatus(undefined); setEvents([]); setNotices([]); setSelected(undefined); setStateFilter(undefined); setStoreFilter("all"); setView("network");
    try { await api(`/incident/${lot}/status`); } catch (err) { setError((err as Error).message); return; } // validates the lot without spending a Claude call
    setRunning(true);
    const source = new EventSource(`/api/recall/stream?lot=${encodeURIComponent(lot)}&hazard=${encodeURIComponent(hazard ?? "")}`);
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
      router.refresh(); // the shell's graph line shows this run's FalkorDB times
    });
    source.addEventListener("error", (m) => {
      if (finished) return;
      const data = (m as MessageEvent).data;
      setError(data ? JSON.parse(data).message : "Lost connection to the agent. Check the API server and try again.");
      setRunning(false); source.close();
    });
  }

  useEffect(() => {
    // The ref survives StrictMode's double effect, so one notice is one agent run. No close on cleanup: StrictMode's
    // fake unmount would kill the run it just started. The stream closes itself on done and on error (so it never reconnects).
    if (started.current) return;
    started.current = true;
    if (autostart || playback) window.history.replaceState(null, "", `/incident/${lot}${location.hash}`);
    // Starting the agent stream on mount is the point of ?start=1; the ref above makes it happen once.
    if (autostart) run(); // eslint-disable-line react-hooks/set-state-in-effect
    else if (playback || wantsStep()) startReplay(); // the demo link, or a shared link to one step of the run
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
  /** A failed tool call's one-line error, so its stage can turn red and say why. */
  const failed = (name: string) => {
    const s = steps.findLast((x) => x.kind === "tool" && x.name === name && x.call?.error);
    return s?.kind === "tool" ? s.call?.summary : undefined;
  };
  // The plan's eight stages: one per agent step, plus Approved.
  const stages: [label: string, ok: boolean, error?: string][] = ([
    ["Hazard", "propose_classification"], ["Hold", "place_hold"], ["Forward trace", "trace_forward"], ["Records", "coverage_gaps"],
    ["Scope", "minimal_recall"], ["Backward", "trace_backward"], ["Notices", "draft_recall_notice"],
  ] as const).map(([label, tool]) => [label, done(tool), done(tool) ? undefined : failed(tool)]);
  stages.push([notices.length ? `Approved ${approved}/${notices.length}` : "Approved", notices.length > 0 && approved === notices.length && (!replaying || !!shown)]);
  const active = running || (replaying && replay.playing);
  const store = showReport?.stores.find((s) => s.id === selected);
  const depth = incident?.confirmed_depth ?? incident?.depth;
  // Same moment the clock stops at: the first scope decision (finished_at for runs from before scoped_at existed).
  const scopedAt = incident?.scoped_at ?? result?.finished_at;
  const scopedAfter = scopedAt && incident?.reported_at ? Math.floor((Date.parse(scopedAt) - Date.parse(incident.reported_at)) / 1000) : undefined;

  // A lot with no incident yet: one clear next step, not empty tiles. Hold figures here would be stock on hand, not a hold.
  if (!incident && !result && !running && !replaying && !playback && !events.length) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
        {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No incident open on {lot}</EmptyTitle>
            <EmptyDescription>The lot is in the traceability records, but nobody has opened an incident on it. Open one from the supplier notice: the agent then traces it through the graph and builds the recall here for you to confirm.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex-row justify-center gap-2">
            <Link href={`/notice?lot=${lot}`} className={buttonVariants()}>Open an incident on {lot}</Link>
            <Link href="/incident" className={buttonVariants({ variant: "outline" })}>Find another lot</Link>
          </EmptyContent>
        </Empty>
      </div>
    );
  }
  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-4 p-4">
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
              {report || status?.incident ? <>Lot {lot}{report ? `, ${report.lot.ingredient}` : ""}</> : running ? `Opening incident for ${lot}` : `No incident open on ${lot}`}
              {replaying && <Badge variant="outline">Replay</Badge>}
              {!replaying && !running && (incident || result) && <Button size="sm" variant="outline" className="ml-auto" onClick={() => startReplay()}>Replay the trace</Button>}
            </h2>
            {report && <p className="text-sm text-muted-foreground">
              {fmt(report.lot.received_kg)} kg from {report.lot.supplier} ({report.lot.supplier_id}), received {shortDate(report.lot.received_at)}.
              {incident && <> Incident {incident.id}.</>}
              {scopedAfter !== undefined && !replaying && <> Scope decided {scopedAfter >= 60 ? `${Math.floor(scopedAfter / 60)} min ${scopedAfter % 60} s` : `${scopedAfter} s`} after the notice was logged.</>}
            </p>}
            {incident && <p className="text-sm"><b className="text-destructive">Hazard</b> {incident.hazard}. <span className="text-muted-foreground">Logged {shortDate(incident.reported_at)}, {shortTime(incident.reported_at)}.{incident.confirmed_at && <> Class {incident.confirmed_class}, {incident.confirmed_depth} level, confirmed {shortDate(incident.confirmed_at)}, {shortTime(incident.confirmed_at)}.</>}</span></p>}
          </div>
          {incident && <Clock since={incident.reported_at} until={incident.scoped_at} />}
          <ol className="flex w-full flex-wrap gap-2" aria-label="Recall progress">
            {stages.map(([label, ok, error], i) => (
              <li key={i}>
                <Badge variant={ok ? "default" : error ? "destructive" : "outline"} title={error}
                  className={cn(!ok && !error && active && (i === 0 || stages[i - 1][1]) && "animate-pulse border-primary")}>
                  <span aria-hidden="true">{ok ? "✓" : error ? "✕" : "○"}</span>{label}{error && <span className="sr-only">: failed, {error}</span>}
                </Badge>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      {error && !running && !events.length && !replaying && <Alert variant="destructive" role="alert"><AlertDescription>{error} <Link href={`/notice?lot=${lot}`} className="underline">Back to the supplier notice</Link></AlertDescription></Alert>}

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
                {rec ? <ReplayBar rec={rec} r={replay} onExit={exitReplay} />
                  : view === "network" && !running && (incident || result) && (
                    // The replay is always one click away under the graph, not only from the header button.
                    <div className="flex items-center gap-3 rounded-lg border p-3">
                      <Button size="icon-lg" className="size-10 shrink-0 rounded-full" onClick={() => startReplay()} aria-label="Play the trace"><Play className="ml-0.5 size-4 fill-current" /></Button>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">Play the trace</p>
                        <p className="text-xs text-muted-foreground">The agent&apos;s steps light up this graph again with their real timing. Pause, step or jump to any step. No Claude call.</p>
                      </div>
                    </div>
                  )}
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
                <EmptyTitle>{status?.incident ? "Not traced yet" : "No incident open"}</EmptyTitle>
                <EmptyDescription>Open the incident from the <Link href={`/notice?lot=${lot}`} className="underline">supplier notice</Link>. The agent works the recall from the FalkorDB traceability graph and builds it here for you to confirm.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" onClick={() => startReplay()}>Watch the recorded {lot} run</Button>
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
/** Time since the supplier's notice, stopped when the agent decides the scope. The FDA report is due 24 h after the notice. */
function Clock({ since, until }: { since: string; until: string | null }) {
  const [now, setNow] = useState(() => Date.now()); // the view renders in the browser only, so no SSR mismatch
  useEffect(() => {
    if (until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  const start = Date.parse(since), due = new Date(start + 86_400_000).toISOString();
  const a = Math.max(0, (until ? Date.parse(until) : now) - start);
  const h = Math.floor(a / 3.6e6), m = Math.floor((a % 3.6e6) / 6e4), s = Math.floor((a % 6e4) / 1000);
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-xs text-muted-foreground">{until ? "Scope decided after the notice" : "Since the notice · running"}</p>
      <p className={cn("font-mono text-2xl font-semibold tabular-nums", !until && now > start + 86_400_000 && "text-destructive")}>{h}:{pad2(m)}:{pad2(s)}</p>
      <p className="text-xs text-muted-foreground">FDA Reportable Food Registry report due {shortDate(due)}, {shortTime(due)}</p>
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
