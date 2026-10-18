import Link from "next/link";
import type { RecordSources } from "@server/data/sources";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, ApiError } from "@/lib/api";

export const metadata = { title: "Records" };

const fmt = (n: number) => n.toLocaleString("en-US");
// Rendered on the server: say the time zone rather than guess the reader's.
const when = (iso: string) => `${new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" })} UTC`;
const day = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** One figure in a source card: the number, then what it counts. */
function Figure({ n, label }: { n: number; label: string }) {
  return <div className="flex flex-col"><span className="text-2xl font-semibold tabular-nums">{fmt(n)}</span><span className="text-xs text-muted-foreground">{label}</span></div>;
}

/** Where every record the agent reasons over came from, how many there are, and when they were loaded. Read on the server. */
export default async function Page() {
  let s: RecordSources | null = null, error = "";
  try { s = await api<RecordSources>("/records"); } catch (e) { error = e instanceof ApiError ? e.message : "Cannot reach the Recall Tracer API. Check that it is running."; }
  if (!s) return <div className="mx-auto w-full max-w-5xl p-4"><p className="text-sm text-destructive" role="alert">{error}</p></div>;
  const { traceability: t, illness, agent } = s;
  const cases = illness.clusters.reduce((n, c) => n + c.cases, 0);
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4">
      <p className="max-w-3xl text-sm text-muted-foreground">Every record the agent reasons over, where it came from and when it was loaded. The agent reads these records through its graph tools; it never decides a store&apos;s status from anything else.</p>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Traceability records</CardTitle>
            <CardDescription>Northfield Foods&apos; ingredient lots, batches and deliveries, kept in the FDA&apos;s FSMA 204 record structure.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
              <Figure n={t.counts.lots} label="ingredient lots" />
              <Figure n={t.counts.batches} label="batches" />
              <Figure n={t.counts.product_lots} label="product lots" />
              <Figure n={t.counts.stores} label="stores" />
              <Figure n={t.events.shipping + t.events.no_lot_code} label="deliveries" />
            </div>
            {t.events.no_lot_code > 0 && (
              <p className="rounded-md border border-chart-1/50 px-3 py-2 text-sm">
                <b className="text-chart-1">{t.events.no_lot_code} deliveries have no lot code.</b> If their product is ever recalled, those stores can&apos;t be cleared and have to pull it.
              </p>
            )}
          </CardContent>
          <CardFooter className="text-xs text-muted-foreground">
            {t.seeded_at ? <>Loaded {when(t.seeded_at)} · generated demo records{t.seed !== null && <>, seed {t.seed}</>}</> : "Load time unknown"}
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Illness reports</CardTitle>
            <CardDescription>Cases from the health department, linked into clusters. Each case gives the state, onset date, store and purchase date.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="grid grid-cols-3 gap-3"><Figure n={illness.clusters.length} label={illness.clusters.length === 1 ? "cluster" : "clusters"} /><Figure n={cases} label="cases" /></div>
            {illness.clusters.length > 0 && (
              <ul className="flex flex-col gap-1 text-sm">
                {illness.clusters.slice(0, 4).map((c) => (
                  <li key={c.id} className="flex flex-wrap items-baseline gap-x-2"><span className="font-mono">{c.id}</span><span className="text-muted-foreground">{c.pathogen} · {c.cases} cases · opened {day(c.opened_at)}</span></li>
                ))}
              </ul>
            )}
          </CardContent>
          <CardFooter className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>Pasted as CSV or from a spreadsheet. Rows with a problem are rejected with the reason.</span>
            <Link href="/outbreak" className={buttonVariants({ size: "sm", variant: "outline" })}>Paste reports</Link>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Written by the agent</CardTitle>
            <CardDescription>Each incident, and the lessons it saves about suppliers and stores, are kept with the records. The next incident from the same supplier starts with them.</CardDescription>
          </CardHeader>
          <CardContent><div className="grid grid-cols-3 gap-3"><Figure n={agent.incidents} label={agent.incidents === 1 ? "incident" : "incidents"} /><Figure n={agent.lessons} label={agent.lessons === 1 ? "lesson saved" : "lessons saved"} /></div></CardContent>
          <CardFooter className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{agent.incidents ? "Written as each incident runs." : "Nothing yet: open an incident from a supplier notice."}</span>
            <Link href="/history" className={buttonVariants({ size: "sm", variant: "outline" })}>See history</Link>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Public recall records</CardTitle>
            <CardDescription>Real FDA enforcement reports and a CDC outbreak investigation, kept apart from the company&apos;s records.</CardDescription>
          </CardHeader>
          <CardContent>
            {s.public ? (
              <div className="grid grid-cols-3 gap-3">
                <Figure n={s.public.recalls} label={`openFDA recalls${s.public.recalls_since ? ` since ${day(s.public.recalls_since)}` : ""}`} />
                <Figure n={s.public.firms} label="firms" />
                <Figure n={s.public.outbreaks} label="CDC outbreak" />
              </div>
            ) : <p className="text-sm text-muted-foreground">Not loaded.</p>}
          </CardContent>
          <CardFooter className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">Comparison only</Badge>
            <span>{s.public?.fetched ? `Fetched ${day(s.public.fetched)}. ` : ""}Never used to decide which stores pull.</span>
          </CardFooter>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>How the records map to the FDA&apos;s traceability format</CardTitle>
          <CardDescription>FSMA 204 asks firms to keep these records and hand them to the FDA within 24 hours. The agent&apos;s trace follows the same chain.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow><TableHead>Record type</TableHead><TableHead>What it records</TableHead><TableHead>Here now</TableHead></TableRow></TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="font-medium">Receiving</TableCell>
                <TableCell className="whitespace-normal text-muted-foreground">An ingredient lot arrives from a supplier: lot code, quantity and date</TableCell>
                <TableCell className="whitespace-normal tabular-nums">{fmt(t.events.receiving)} ingredient lots from {fmt(t.counts.suppliers)} suppliers</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Transformation</TableCell>
                <TableCell className="whitespace-normal text-muted-foreground">Ingredient lots go into batches, leftovers are reworked into later batches, batches become product lots</TableCell>
                <TableCell className="whitespace-normal tabular-nums">{fmt(t.events.transformation.used_in)} lots used in batches · {fmt(t.events.transformation.reworked)} reworks · {fmt(t.events.transformation.produced)} product lots</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Shipping</TableCell>
                <TableCell className="whitespace-normal text-muted-foreground">A product lot is delivered to a store, with its lot code on the delivery record</TableCell>
                <TableCell className="whitespace-normal tabular-nums">{fmt(t.events.shipping)} deliveries with a lot code · <span className="text-chart-1">{fmt(t.events.no_lot_code)} without</span></TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Stock <span className="block text-xs font-normal text-muted-foreground">not an FSMA 204 event</span></TableCell>
                <TableCell className="whitespace-normal text-muted-foreground">Unused ingredient and unshipped product at plants and distribution centres: what a hold can stop</TableCell>
                <TableCell className="whitespace-normal tabular-nums">{fmt(t.events.stock)} stock records at {fmt(t.counts.plants)} plants and {fmt(t.counts.dcs)} DCs</TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <p className="mt-3 text-xs text-muted-foreground">A company&apos;s own FSMA 204 spreadsheets would load into the same records. Importing them directly is the next step.</p>
        </CardContent>
      </Card>
    </div>
  );
}
