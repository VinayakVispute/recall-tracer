import type { DemoQueryResult, RealOutbreak } from "@server/data/real";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, ApiError } from "@/lib/api";
import { RealWorld } from "../outbreak/real-world";
import { RealGraphView } from "./real-graph";

const day = (iso: string) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
const cell = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v === null || v === undefined ? "—" : String(v));

/**
 * The real graph: a CDC outbreak and openFDA recalls loaded by `bun run real` into the separate "fda" graph.
 * No synthetic records here, and no agent: every number on this page is one Cypher query, shown with its time.
 */
export default async function Page() {
  let outbreaks: RealOutbreak[] = [], queries: DemoQueryResult[] = [], error = "";
  try {
    [outbreaks, queries] = await Promise.all([api<RealOutbreak[]>("/real/outbreaks"), api<DemoQueryResult[]>("/real/queries")]);
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Cannot reach the Recall Tracer API. Check that it is running.";
  }
  const total = queries.reduce((n, q) => n + q.db_ms, 0);

  if (error || !outbreaks.length) {
    return (
      <div className="mx-auto w-full max-w-3xl p-4">
        <Empty className="border">
          <EmptyDescription>{error || <>The real data is not loaded yet. Run <code>bun run real</code> on the API host to load the CDC outbreak and openFDA recalls into the &quot;fda&quot; graph.</>}</EmptyDescription>
        </Empty>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-4 p-4">
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_28rem]">
        <Card>
          <CardHeader>
            <CardTitle>Record network, real data</CardTitle>
            <CardDescription>
              Graph &quot;fda&quot;: the CDC outbreak, the firm it was linked to, that firm&apos;s openFDA recalls, their hazards, and the states they named.
              A state with a dashed ring had sick people and no recall. Click a record to keep what connects to it.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <RealGraphView />
            <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5"><i className="inline-block size-2.5 rounded-full bg-foreground" />Outbreak</span>
              <span className="inline-flex items-center gap-1.5"><i className="inline-block size-2.5 rounded-sm bg-chart-2" />Linked firm</span>
              <span className="inline-flex items-center gap-1.5"><i className="inline-block size-2.5 rounded-full bg-destructive" />Recall, and a state it named where people got sick</span>
              <span className="inline-flex items-center gap-1.5"><i className="inline-block size-2.5 rotate-45 bg-chart-1" />Hazard</span>
              <span className="inline-flex items-center gap-1.5"><i className="inline-block size-3 rounded-full border-2 border-dashed border-chart-1" />State with cases and no recall</span>
              <span className="inline-flex items-center gap-1.5"><i className="inline-block size-2.5 rounded-sm bg-chart-3" />Downstream firm</span>
            </p>
          </CardContent>
        </Card>
        <RealWorld showLink={false} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Questions asked of the real graph</CardTitle>
          <CardDescription>Run now, on this page load. {queries.length} queries, {total.toFixed(2)} ms in FalkorDB in total.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {queries.map((q) => (
            <section key={q.title} className="flex flex-col gap-2">
              <h3 className="flex flex-wrap items-baseline justify-between gap-2 text-sm font-medium">
                {q.title}
                <span className="font-mono text-xs font-normal text-muted-foreground tabular-nums">FalkorDB {q.db_ms} ms · {q.rows.length} {q.rows.length === 1 ? "row" : "rows"}</span>
              </h3>
              {q.rows.length ? (
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader><TableRow>{Object.keys(q.rows[0]).map((k) => <TableHead key={k}>{k}</TableHead>)}</TableRow></TableHeader>
                    <TableBody>{q.rows.map((r, i) => <TableRow key={i}>{Object.keys(q.rows[0]).map((k) => <TableCell key={k} className="max-w-96 whitespace-normal tabular-nums">{cell(r[k])}</TableCell>)}</TableRow>)}</TableBody>
                  </Table>
                </div>
              ) : <p className="text-sm text-muted-foreground">No rows.</p>}
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">Cypher</summary>
                <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-2 font-mono">{q.cypher}</pre>
              </details>
            </section>
          ))}
        </CardContent>
      </Card>

      {outbreaks.map((o) => (
        <Card key={o.id}>
          <CardHeader>
            <CardTitle>openFDA recalls by {o.firm.name}</CardTitle>
            <CardDescription>{o.recalls.length} enforcement reports. Distribution is the free text the firm filed; the state codes are parsed from it.</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow><TableHead>Recall</TableHead><TableHead>Class</TableHead><TableHead>Initiated</TableHead><TableHead>Product</TableHead><TableHead>States</TableHead></TableRow></TableHeader>
              <TableBody>
                {o.recalls.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">{r.id}</TableCell>
                    <TableCell><Badge variant={r.classification === "Class I" ? "destructive" : "secondary"}>{r.classification}</Badge></TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">{day(r.initiated)}</TableCell>
                    <TableCell className="max-w-xl whitespace-normal">{r.product}</TableCell>
                    <TableCell className="whitespace-nowrap">{r.states.join(", ") || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
