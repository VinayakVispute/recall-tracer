"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Candidate, OutbreakEvent, OutbreakResult } from "@server/contracts";
import type { IncidentReport } from "@server/tools/incident";
import { AgentTrace, shortDate, type Step } from "@/components/dashboard/panels";
import { StatTile } from "@/components/stat-tile";
import { EvilBarChart } from "@/components/evilcharts/charts/recharts-bar-chart";
import type { ChartConfig } from "@/components/evilcharts/ui/recharts-chart";
import { ChartTooltip, ChartTooltipContent } from "@/components/evilcharts/ui/recharts-tooltip";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export type CaseRow = {
  id: string; region: string; onset: string; reported_at: string; sku: string | null; product: string | null;
  store: string; store_name: string; city: string; bought_at: string;
};
export type ClusterDetail = { id: string; pathogen: string; opened_at: string; cases: CaseRow[] };

export function OutbreakView({ id, cluster, loadError }: { id: string; cluster: ClusterDetail | null; loadError: string }) {
  const [steps, setSteps] = useState<Step[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<OutbreakResult>();
  const [lot, setLot] = useState<string>();
  const [caseId, setCaseId] = useState<string>();
  const [detail, setDetail] = useState<IncidentReport>();
  const es = useRef<EventSource>(null);
  // Runs start from a click, never from an effect, so closing on unmount is safe here.
  useEffect(() => () => es.current?.close(), []);

  function find() {
    setSteps([]); setError(""); setResult(undefined); setLot(undefined); setCaseId(undefined); setDetail(undefined); setRunning(true);
    const source = new EventSource(`/api/outbreak/stream?cluster=${encodeURIComponent(id)}`);
    es.current = source;
    let finished = false;
    const on = <K extends OutbreakEvent["type"]>(type: K, fn: (ev: Extract<OutbreakEvent, { type: K }>) => void) =>
      source.addEventListener(type, (m) => fn(JSON.parse((m as MessageEvent).data)));
    on("note", (ev) => setSteps((s) => [...s, { kind: "note", text: ev.text }]));
    on("tool_start", (ev) => setSteps((s) => [...s, { kind: "tool", id: ev.id, name: ev.name, input: ev.input, running: true }]));
    on("tool_end", (ev) => setSteps((s) => s.map((x) => (x.kind === "tool" && x.id === ev.call.id ? { ...x, running: false, call: ev.call } : x))));
    on("done", (ev) => {
      finished = true; source.close(); setRunning(false);
      const r = ev.outbreak;
      setResult(r); setLot(r.candidates[0]?.lot); setCaseId(r.candidates[0]?.explained[0]);
      // Dates and quantities for the evidence chain come from the top lot's records (graph only, no Claude call).
      if (r.candidates[0]) api<IncidentReport>(`/incident/${r.candidates[0].lot}`).then(setDetail).catch(() => {});
    });
    source.addEventListener("error", (m) => {
      source.close(); // never let EventSource reconnect: a reconnect is a second agent run
      if (finished) return;
      const data = (m as MessageEvent).data;
      setError(data ? JSON.parse(data).message : "Lost connection to the agent. Check the API server and try again.");
      setRunning(false);
    });
  }

  if (!cluster) {
    return (
      <div className="mx-auto w-full max-w-none p-4">
        {loadError ? <Alert variant="destructive" role="alert"><AlertDescription>{loadError}</AlertDescription></Alert>
          : <Empty className="border"><EmptyDescription>No cases in cluster {id} yet. Paste the case reports above, or <Link href="/outbreak" className="underline">open another cluster</Link>.</EmptyDescription></Empty>}
      </div>
    );
  }

  const candidate = result?.candidates.find((c) => c.lot === lot);
  const explains = new Set(candidate?.explained ?? []);
  const states = new Set(cluster.cases.map((c) => c.region));

  const onsets = cluster.cases.map((c) => c.onset).sort();
  const unknown = cluster.cases.filter((c) => !c.sku).length;
  return (
    <div className="mx-auto flex w-full max-w-none flex-col gap-4 px-4 pb-4">
      {/* The cluster at a glance, in the same tiles as the incident dashboard. */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Cluster figures">
        <StatTile label="Cases" value={cluster.cases.length} unit={cluster.pathogen.split(" ")[0]} tone="text-destructive" foot={`Cluster ${cluster.id}, opened ${shortDate(cluster.opened_at)}`} />
        <StatTile label="States" value={states.size} unit="states" foot={[...states].sort().join(", ")} />
        <StatTile label="Stores" value={new Set(cluster.cases.map((c) => c.store)).size} unit="stores" foot="Where the sick people bought food" />
        <StatTile label="Illness onsets" value={onsets.length ? shortDate(onsets[0]) : "—"} unit={onsets.length > 1 ? `to ${shortDate(onsets.at(-1) ?? "")}` : undefined}
          foot={unknown ? `${unknown} ${unknown === 1 ? "case doesn't" : "cases don't"} name the product` : "Every case names the product"} />
      </section>
      <Card>
        <CardHeader>
          <CardTitle>Linked cluster {cluster.id}</CardTitle>
          <CardDescription>{cluster.pathogen} · {cluster.cases.length} cases · {states.size} states · opened {shortDate(cluster.opened_at)}</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow><TableHead>Case</TableHead><TableHead>State</TableHead><TableHead>Onset</TableHead><TableHead>Store</TableHead><TableHead>Bought</TableHead><TableHead>Product</TableHead></TableRow></TableHeader>
            <TableBody>
              {cluster.cases.map((c) => (
                <TableRow key={c.id} className={cn(explains.has(c.id) && "bg-destructive/10", caseId === c.id && "outline-2 -outline-offset-2 outline-primary")}>
                  <TableCell>
                    {result ? <Button variant="link" size="xs" className="px-0 font-mono" onClick={() => setCaseId(c.id)} aria-pressed={caseId === c.id}>{c.id}</Button> : <span className="font-mono text-xs">{c.id}</span>}
                  </TableCell>
                  <TableCell>{c.region}</TableCell>
                  <TableCell className="tabular-nums">{shortDate(c.onset)}</TableCell>
                  <TableCell>{c.store_name}, {c.city}<span className="block font-mono text-xs text-muted-foreground">{c.store}</span></TableCell>
                  <TableCell className="tabular-nums">{shortDate(c.bought_at)}</TableCell>
                  <TableCell>{c.product ?? <Badge variant="outline">unknown</Badge>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
        <CardFooter className="flex-wrap justify-between gap-3">
          <p className="text-xs text-muted-foreground">One graph query walks every case back to its ingredient lots; the agent then explains the ranking. About 20 seconds.</p>
          <Button onClick={find} disabled={running}>{running ? "Searching…" : "Find the source"}</Button>
        </CardFooter>
      </Card>

      {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card aria-busy={running}>
            <CardHeader>
              <CardTitle>Candidate lots</CardTitle>
              <CardDescription>Ranked by how many sick people each lot explains. Click a lot to see which cases.</CardDescription>
            </CardHeader>
            <CardContent>
              {result ? <Candidates r={result} selected={lot} onPick={setLot} />
                : <Empty><EmptyDescription>{running ? "Reading the graph…" : "Press Find the source. Each case is walked backward from its store to every ingredient lot that reached it before the purchase."}</EmptyDescription></Empty>}
            </CardContent>
          </Card>
          {result && caseId && <CaseEvidence r={result} c={cluster.cases.find((x) => x.id === caseId)} lot={lot} detail={detail} />}
        </div>
        <AgentTrace steps={steps} running={running} summary={result?.summary} empty="Press Find the source. Each step appears here as it happens." />
      </div>
    </div>
  );
}

const color = (token: string) => ({ light: [`var(${token})`], dark: [`var(${token})`] });
const explainedConfig = {
  source: { label: "Likely source", colors: color("--destructive") },
  other: { label: "Other lots", colors: color("--chart-3") },
} satisfies ChartConfig;

/** Cases each lot explains, out of the cluster: the likely source in red, other candidates and the ruled-out decoys (zero) below it. */
function ExplainedChart({ r, single }: { r: OutbreakResult; single: boolean }) {
  const rows = [
    ...r.candidates.slice(0, 5).map((c, i) => ({ lot: c.lot, source: i === 0 && single ? c.cases_explained : 0, other: i === 0 && single ? 0 : c.cases_explained, note: `${c.ingredient} · reached ${c.stores_reached} stores` })),
    ...(r.decoys ?? []).map((d) => ({ lot: d.lot, source: 0, other: 0, note: `${d.ingredient} · same supplier, no path to a case store` })),
  ];
  return (
    <div className="rounded-xl bg-muted/20 p-3 ring-1 ring-foreground/7">
      <p className="text-xs text-muted-foreground">Cases each lot explains, of {r.total_cases}</p>
      <div style={{ height: rows.length * 36 + 48 }}>
        <EvilBarChart data={rows} config={explainedConfig} layout="horizontal" stackType="stacked" barRadius={6} className="aspect-auto h-full w-full"
          chartProps={{ margin: { left: 0, right: 12, top: 6, bottom: 0 } }}>
          <EvilBarChart.Grid />
          <EvilBarChart.XAxis allowDecimals={false} domain={[0, r.total_cases]} />
          <EvilBarChart.YAxis dataKey="lot" width={56} className="font-mono" />
          <ChartTooltip cursor={{ fill: "var(--muted)", opacity: 0.4 }} content={
            <ChartTooltipContent variant="frosted-glass" hideIndicator labelFormatter={(lot, p) => `${p[0]?.payload.lot ?? lot} · ${p[0]?.payload.note ?? ""}`}
              formatter={(value) => (Number(value) > 0 ? <span className="font-mono tabular-nums">explains {String(value)} of {r.total_cases} cases</span> : null)} />
          } />
          <EvilBarChart.Bar dataKey="source" variant="hatched" glowing />
          <EvilBarChart.Bar dataKey="other" variant="hatched" />
        </EvilBarChart>
      </div>
    </div>
  );
}

function Candidates({ r, selected, onPick }: { r: OutbreakResult; selected?: string; onPick: (lot: string) => void }) {
  const single = r.candidates[0]?.cases_explained === r.total_cases;
  if (!r.candidates.length) return <Alert><AlertDescription>No ingredient lot reaches any case store before the purchase date.</AlertDescription></Alert>;
  return (
    <div className="flex flex-col gap-2">
      {!single && <Alert><AlertDescription>No single lot explains every case. The top two are shown; the coordinator decides whether to open an incident.</AlertDescription></Alert>}
      <ExplainedChart r={r} single={single} />
      <ol className="flex flex-col gap-2">
        {(single ? r.candidates : r.candidates.slice(0, 2)).map((c, i) => (
          <li key={c.lot} className={cn("rounded-lg border p-3 transition-colors", selected === c.lot && "border-primary", i === 0 && single && "bg-destructive/5")}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button type="button" onClick={() => onPick(c.lot)} aria-pressed={selected === c.lot} className="text-left text-sm font-medium hover:underline">
                <span className="font-mono text-destructive">{c.lot}</span> {c.ingredient} · {c.supplier_name} ({c.supplier})
                {i === 0 && single && <Badge variant="destructive" className="ml-2 align-middle">likely source</Badge>}
              </button>
              {selected === c.lot && <Handoff r={r} c={c} primary={i === 0 && single} />}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              explains <b className="text-foreground">{c.cases_explained} of {r.total_cases}</b>{c.explained.length < r.total_cases && ` (${c.explained.join(", ")})`} · reached {c.stores_reached} stores
            </p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <div className="h-full bg-destructive" style={{ width: `${(c.cases_explained / r.total_cases) * 100}%` }} />
            </div>
          </li>
        ))}
        {/* What a keyword search would also flag: the same ingredient from the same supplier, which reaches none of the case stores. */}
        {(r.decoys ?? []).map((d) => (
          <li key={d.lot} className="rounded-lg border border-dashed p-3 opacity-80">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium">
              <span><span className="font-mono text-muted-foreground line-through decoration-1">{d.lot}</span> {d.ingredient} · {d.supplier_name}</span>
              <Badge variant="outline">ruled out</Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              explains <b className="text-foreground">0 of {r.total_cases}</b> · the same {d.ingredient} from the same supplier as {r.candidates[0]?.lot}, but no delivery path reaches any case store
            </p>
            <div className="mt-2 h-1.5 rounded-full border border-dashed" aria-hidden="true" />
          </li>
        ))}
      </ol>
    </div>
  );
}

function Handoff({ r, c, primary }: { r: OutbreakResult; c: Candidate; primary: boolean }) {
  const q = new URLSearchParams({ lot: c.lot, cluster: r.cluster, explained: String(c.cases_explained), cases: String(r.total_cases) });
  return <Link href={`/notice?${q}`} className={buttonVariants({ size: "sm", variant: primary ? "default" : "outline" })}>Open incident on {c.lot}</Link>;
}

const KIND = (id: string) => (id.startsWith("ST-") ? "Store" : id.startsWith("TLC-") ? "Product lot" : id.startsWith("B-") ? "Batch" : "Ingredient lot");

/** One record on the evidence chain, with its dates and quantities once the top lot's records have loaded. */
function ChainRecord({ id, c, detail }: { id: string; c: CaseRow; detail?: IncidentReport }) {
  const ship = detail?.stores.find((s) => s.id === c.store)?.shipments.find((x) => x.lot === id);
  const batch = detail?.batches.find((b) => b.id === id);
  if (ship) return <><b className="font-mono">{id}</b> {ship.product} · delivered {ship.units} units on {shortDate(ship.shipped_at)}<span className="block text-xs text-muted-foreground">before the purchase date</span></>;
  if (batch) {
    const used = detail!.lineage.find((l) => l.target === id && l.type === "USED_IN");
    const rework = detail!.lineage.find((l) => l.target === id && l.type === "REWORKED_INTO");
    return <><b className="font-mono">{id}</b> {batch.site} · produced {shortDate(batch.produced_at)}
      <span className="block text-xs text-muted-foreground">{rework ? `reworked leftovers of ${rework.source}${rework.qty_kg ? `, ${rework.qty_kg} kg` : ""}` : used ? `used ${used.qty_kg} kg of ${used.source}` : ""}</span></>;
  }
  if (detail && id === detail.lot.code) return <><b className="font-mono">{id}</b> {detail.lot.ingredient} · {detail.lot.supplier} · received {shortDate(detail.lot.received_at)}</>;
  return <><b className="font-mono">{id}</b> <span className="text-muted-foreground">{KIND(id)}</span></>;
}

/** Paths come back for the top candidate only, from the lot down to the case; shown here from the case back up. */
function CaseEvidence({ r, c, lot, detail }: { r: OutbreakResult; c?: CaseRow; lot?: string; detail?: IncidentReport }) {
  if (!c) return null;
  const top = r.candidates[0]?.lot;
  // Lot ids from the top candidate's path, minus the case and its store (the first line already names both).
  const path = lot === top ? r.paths[c.id]?.[0]?.slice(0, -2).reverse() : undefined;
  const also = r.candidates.filter((x) => x.lot !== top && x.explained.includes(c.id)).map((x) => x.lot);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Case evidence</CardTitle>
        <CardDescription>{c.id} · {c.store_name}, {c.city}</CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-2 border-l-2 pl-4 text-sm">
          <li><b>{c.id}</b> bought {c.product ?? "an unknown product"} on {shortDate(c.bought_at)} at {c.store_name} <span className="font-mono text-xs text-muted-foreground">{c.store}</span><span className="block text-xs text-muted-foreground">onset {shortDate(c.onset)}, reported {shortDate(c.reported_at)}</span></li>
          {path ? path.map((id) => (
            <li key={id}>
              <ChainRecord id={id} c={c} detail={detail} />
              {id === top && <> <Badge variant="destructive">candidate</Badge>{also.map((o) => <Badge key={o} variant="outline" className="ml-1">{o} also possible</Badge>)}</>}
            </li>
          )) : <li className="text-muted-foreground">
            {lot !== top ? `Evidence paths are drawn for the top candidate, ${top}.` : `No path from ${c.store} back to ${top}: it does not explain ${c.id}.`}
          </li>}
        </ol>
      </CardContent>
    </Card>
  );
}
