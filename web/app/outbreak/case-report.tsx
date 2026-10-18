"use client";

import { useRef, useState, useTransition } from "react";
import type { CaseReport, LotChain as Chain } from "@server/data/real";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { LotChain } from "./lot-chain";

const SAMPLE = "/samples/cdc-alfalfa-sprouts-2026.csv";
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** Case states by the recall that first reached them: the first recall's in one colour, later ones in the gap colour. */
function Coverage({ chain, n }: { chain: Chain; n: number }) {
  const first = chain.coverage[0];
  const late = chain.coverage.filter((s, i) => i > 0 && s.added.length);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        The first recall of the lot named <b>{first.reached.length} of {n}</b> case states.
        {late.length > 0 && <> The other {n - first.reached.length - chain.uncovered.length} were reached only by later recalls, up to <b>{days(first.date, late.at(-1)!.date)} days</b> later.</>}
        {chain.uncovered.length > 0 && <> No recall of the lot names {chain.uncovered.join(", ")}.</>}
      </p>
      <ol className="flex flex-col gap-2">
        {chain.coverage.map((s, i) => (
          <li key={s.recalls[0]} className="grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[11rem_1fr]">
            <span className="text-xs text-muted-foreground"><span className="tabular-nums">{day(s.date)}</span> · {s.firm}</span>
            <span className="flex flex-wrap items-center gap-1">
              {s.added.map((st) => (
                <Badge key={st} variant="outline" className={cn("font-mono", i === 0 ? "border-chart-2/60 bg-chart-2/15" : "border-destructive/50 bg-destructive/10 text-destructive")}>{st}</Badge>
              ))}
              <span className="text-xs text-muted-foreground">{s.added.length ? `${s.total} of ${n}` : `reaches ${s.reached.length} of ${n}, none new`}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Illness window and recall dates on one line, spaced by date. */
function Timeline({ report, chain }: { report: CaseReport; chain: Chain }) {
  const o = report.outbreak;
  const start = Date.parse(o.onset_from), end = Math.max(Date.parse(o.onset_to), ...chain.coverage.map((s) => Date.parse(s.date)));
  const at = (iso: string) => `${((Date.parse(iso) - start) / (end - start)) * 100}%`;
  const marks = [{ d: o.onset_from, label: "First illness" }, ...chain.coverage.map((s) => ({ d: s.date, label: s.firm.split(/[ ,]/)[0] }))];
  return (
    <div className="flex flex-col gap-1">
      <div className="relative mx-2 mt-1 h-14">
        <div className="absolute top-3 right-0 left-0 h-px bg-border" />
        <div className="absolute top-2 h-2 rounded-full bg-destructive/25" style={{ left: 0, width: at(o.onset_to) }} title="Illness onsets" />
        {marks.map((m, i) => (
          <div key={`${m.d}${i}`} className={cn("absolute top-1.5 flex -translate-x-1/2 flex-col items-center", i === 0 && "translate-x-0 items-start")} style={{ left: at(m.d) }}>
            <span className={cn("size-3 rounded-full border-2 border-background", i === 0 ? "bg-destructive" : "bg-chart-2")} />
            <span className={cn("mt-1 text-[11px] whitespace-nowrap text-muted-foreground tabular-nums", i > 1 && "hidden sm:block")}>{day(m.d)}</span>
            <span className="hidden text-[11px] whitespace-nowrap sm:block">{m.label}</span>
          </div>
        ))}
      </div>
      <p className="text-sm"><b>{chain.days_to_first} days</b> from the first illness to the first recall of the lot, and {chain.days_to_last} more until the last.</p>
    </div>
  );
}

function Result({ r }: { r: CaseReport }) {
  const o = r.outbreak, n = o.states.length;
  const everywhere = r.matching.top.filter((t) => t.reached.length === n).length;
  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm">
        <b>{o.id}</b> · {o.pathogen} · cases in {n} states · illnesses {day(o.onset_from)} to {day(o.onset_to)}
        {o.source && <> · <a href={o.source} target="_blank" rel="noreferrer" className="underline">source</a></>}
      </p>
      {r.rejected.length > 0 && (
        <Alert variant="destructive"><AlertDescription>{r.rejected.length} {r.rejected.length === 1 ? "row" : "rows"} not used: {r.rejected.map((x) => `row ${x.row}, ${x.reason}`).join("; ")}.</AlertDescription></Alert>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">1. {r.matching.recalls} recalls from {r.matching.firms} firms name these pathogens since the first illness</h3>
        <Collapsible>
          <p className="text-sm text-muted-foreground">
            {everywhere > 1 ? `${everywhere} firms' recalls reach all ${n} case states, so where a recall went can't single out a source. ` : ""}
            <CollapsibleTrigger className="underline underline-offset-2">Show the firms that reach the most case states</CollapsibleTrigger>
          </p>
          <CollapsibleContent>
            <ul className="mt-2 flex flex-col gap-1 text-sm">
              {r.matching.top.map((t) => (
                <li key={t.firm} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="w-12 text-right tabular-nums">{t.reached.length}/{n}</span>
                  <span>{t.firm}</span>
                  <span className="text-xs text-muted-foreground">{day(t.initiated)}{t.nationwide && " · nationwide"}</span>
                  {t.in_chain && <Badge variant="outline" className="border-chart-2/60 bg-chart-2/15">names the shared lot</Badge>}
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">
          2. {r.lots_read} lot codes in their records. {r.chains.length === 0 ? "None is named by more than one firm." : r.chains.length === 1 ? <>One is named by {r.chains[0].firms.length} different firms: <span className="font-mono">{r.chains[0].lot}</span></> : `${r.chains.length} are named by more than one firm.`}
        </h3>
        {r.chains.length === 0 && <p className="text-sm text-muted-foreground">No recall of these pathogens shares a lot code with another firm&apos;s. The public records don&apos;t connect these illnesses to one lot.</p>}
      </section>

      {r.chains.map((ch) => (
        <div key={ch.lot} className="flex flex-col gap-5">
          <LotChain report={r} chain={ch} />
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">3. Which case states each recall of <span className="font-mono">{ch.lot}</span> reached, and when</h3>
            <Coverage chain={ch} n={n} />
          </section>
          <Timeline report={r} chain={ch} />
        </div>
      ))}

      <Collapsible>
        <CollapsibleTrigger className="self-start text-xs text-muted-foreground underline underline-offset-2">Show the queries · {r.queries.length} FalkorDB queries, {r.db_ms} ms</CollapsibleTrigger>
        <CollapsibleContent className="mt-2 flex flex-col gap-3">
          {r.queries.map((q) => (
            <div key={q.title} className="flex flex-col gap-1">
              <p className="text-xs text-muted-foreground">{q.title} · {q.db_ms} ms</p>
              <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-relaxed">{q.cypher}</pre>
            </div>
          ))}
        </CollapsibleContent>
      </Collapsible>
      <p className="text-xs text-muted-foreground">Public records: openFDA food enforcement reports, and FDA recall notices not yet in openFDA. Lot codes are read from each recall&apos;s code text. The records show where each recall went, not which purchase made anyone sick.</p>
    </div>
  );
}

/** Upload a public case report (states and illness dates) and check it against the real recall graph. */
export function CaseReportCard() {
  const input = useRef<HTMLInputElement>(null);
  const [report, setReport] = useState<CaseReport>();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [over, setOver] = useState(false);
  const [pending, startTransition] = useTransition();

  function check(file: File | undefined) {
    if (!file) return;
    setError(""); setReport(undefined); setName(file.name);
    startTransition(async () => {
      try {
        setReport(await api<CaseReport>("/real/case-report", { text: await file.text() }));
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }

  const actions = (
    <>
      <a href={SAMPLE} download className="text-xs text-muted-foreground underline underline-offset-2">Sample: CDC sprout outbreak</a>
      <Button size="sm" variant="outline" onClick={() => input.current?.click()} disabled={pending}>{pending ? "Checking…" : "Upload report"}</Button>
    </>
  );
  return (
    <Card id="public-report" className={cn("scroll-mt-4", over && "ring-2 ring-chart-2")}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); check(e.dataTransfer.files[0]); }}>
      <CardHeader>
        <CardTitle>Public case report</CardTitle>
        <CardDescription>A CDC or health department report gives the states with cases and the illness dates. Drop it here to search the real FDA recalls for a lot they share.</CardDescription>
        <CardAction className="hidden flex-wrap items-center gap-2 sm:flex">{actions}</CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 sm:hidden">{actions}</div>
        <input ref={input} type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" className="sr-only" aria-label="Case report file" onChange={(e) => { check(e.target.files?.[0]); e.target.value = ""; }} />
        {!report && !error && !pending && (
          <button type="button" onClick={() => input.current?.click()}
            className={cn("rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground hover:bg-muted/40", over && "bg-muted/40")}>
            Drop a CSV here: outbreak, pathogen, state, onset_from, onset_to, source. One row per state with cases.
          </button>
        )}
        {pending && <p className="text-sm text-muted-foreground" role="status">Checking {name} against the recall graph…</p>}
        {error && <Alert variant="destructive" role="alert"><AlertDescription>{name}: {error}</AlertDescription></Alert>}
        {report && <Result r={report} />}
      </CardContent>
    </Card>
  );
}
