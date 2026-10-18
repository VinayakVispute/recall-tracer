import Link from "next/link";
import type { RecordSources } from "@server/data/sources";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { api, ApiError } from "@/lib/api";
import { SourceMap } from "@/components/records/source-map";

export const metadata = { title: "Records", description: "Where the graph's records come from: real openFDA recalls and CDC outbreak data, and a demo company's lots, batches, product lots and stores." };

const fmt = (n: number) => n.toLocaleString("en-US");
// Rendered on the server: say the time zone rather than guess the reader's.
const when = (iso: string) => `${new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" })} UTC`;
const day = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** A small source card: one number, one line saying what it is, and a footer with when or what to do. */
function Source({ title, n, unit, line, warn, foot }: { title: string; n: number; unit: string; line: string; warn?: string; foot: React.ReactNode }) {
  return (
    <Card size="sm">
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-1">
        <p className="flex items-baseline gap-1.5"><span className="text-3xl font-semibold tabular-nums">{fmt(n)}</span><span className="text-sm text-muted-foreground">{unit}</span></p>
        <p className="text-xs text-muted-foreground">{line}</p>
        {warn && <p className="text-xs text-chart-1">{warn}</p>}
      </CardContent>
      <CardFooter className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">{foot}</CardFooter>
    </Card>
  );
}

/** Where the records the agent reasons over come from: three source cards and the source map. Read on the server. */
export default async function Page() {
  let s: RecordSources | null = null, error = "";
  try { s = await api<RecordSources>("/records"); } catch (e) { error = e instanceof ApiError ? e.message : "Cannot reach the Recall Tracer API. Check that it is running."; }
  if (!s) return <div className="mx-auto w-full max-w-5xl p-4"><p className="text-sm text-destructive" role="alert">{error}</p></div>;
  const { traceability: t, illness } = s;
  const records = Object.values(t.counts).reduce((a, b) => a + b, 0);
  const cases = illness.clusters.reduce((n, c) => n + c.cases, 0);
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Source title="Company records" n={records} unit="records" line="Lots, batches, product lots, stores and stock"
          warn={t.events.no_lot_code ? `${t.events.no_lot_code} deliveries have no lot code` : undefined}
          foot={t.seeded_at ? `Loaded ${when(t.seeded_at)}` : "Load time unknown"} />
        <Source title="Illness reports" n={cases} unit="cases" line={`In ${illness.clusters.length} ${illness.clusters.length === 1 ? "cluster" : "clusters"}`}
          foot={<><span>Pasted from the health department</span><Link href="/outbreak" className={buttonVariants({ size: "sm", variant: "outline" })}>Paste reports</Link></>} />
        <Source title="Public recall records" n={s.public?.recalls ?? 0} unit="FDA recalls" line={s.public ? `Plus ${s.public.outbreaks} CDC outbreak` : "Not loaded"}
          foot={<><span>{s.public?.fetched ? `Fetched ${day(s.public.fetched)}` : ""}</span><Badge variant="outline">Comparison only</Badge></>} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Where the data comes from</CardTitle>
          <CardDescription>Each source and the records it becomes. Public recall records and company records are separate graphs.</CardDescription>
        </CardHeader>
        <CardContent><SourceMap s={s} /></CardContent>
      </Card>
    </div>
  );
}
