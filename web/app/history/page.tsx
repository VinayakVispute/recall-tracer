import Link from "next/link";
import type { IncidentSummary } from "@server/tools/incident";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, ApiError } from "@/lib/api";

export const metadata = { title: "History" };

const STATUS: Record<IncidentSummary["status"], string> = { open: "Tracing", scoped: "Scope decided", notices_approved: "Notices approved" };
// The date part only: a server in UTC and a coordinator elsewhere agree on it. (panels.tsx is a client module, so its helpers are not callable here.)
const scopeIn = (m: number) => (m < 1 ? `${Math.round(m * 60)} s` : m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`);
const day = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** Page 7. Every incident the graph remembers, newest first, read on the server. */
export default async function Page() {
  let incidents: IncidentSummary[] = [], error = "";
  try { incidents = await api<IncidentSummary[]>("/incidents"); } catch (e) { error = e instanceof ApiError ? e.message : "Cannot reach the Recall Tracer API. Check that it is running."; }
  // Incidents per supplier, from the same rows: the "prior incidents on this supplier" line on the notice page reads the same graph edge.
  const bySupplier = [...Map.groupBy(incidents, (i) => i.supplier_id)].map(([id, list]) => ({ id, name: list[0].supplier, n: list.length })).sort((a, b) => b.n - a.n);
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4">
      <Card>
        <CardHeader>
          <CardTitle>Incident history</CardTitle>
          <CardDescription>Every incident is saved, so the next notice from the same supplier starts with what this one learned.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : incidents.length ? (
            <Table>
              <TableHeader><TableRow><TableHead>Incident</TableHead><TableHead>Lot</TableHead><TableHead>Hazard</TableHead><TableHead>Supplier</TableHead><TableHead>Opened</TableHead><TableHead>Proposed</TableHead><TableHead>Confirmed</TableHead><TableHead className="text-right">Stores</TableHead><TableHead className="text-right">Notice to scope</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
              <TableBody>
                {incidents.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="font-mono text-xs">{i.id}</TableCell>
                    <TableCell><Link href={`/incident/${i.lot}`} className="font-mono underline">{i.lot}</Link></TableCell>
                    <TableCell className="max-w-64 whitespace-normal">{i.hazard}</TableCell>
                    <TableCell className="whitespace-nowrap">{i.supplier} <span className="font-mono text-xs text-muted-foreground">{i.supplier_id}</span></TableCell>
                    <TableCell className="whitespace-nowrap">{day(i.reported_at)}</TableCell>
                    <TableCell>{i.class ? `Class ${i.class}` : "—"}</TableCell>
                    <TableCell>{i.confirmed_class ? `Class ${i.confirmed_class}` : "not yet"}</TableCell>
                    <TableCell className="text-right tabular-nums">{i.stores ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{i.minutes_to_scope === null ? "—" : scopeIn(i.minutes_to_scope)}</TableCell>
                    <TableCell><Badge variant={i.status === "open" ? "outline" : "secondary"}>{STATUS[i.status]}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : <Empty><EmptyDescription>No incidents yet. Open one from the <Link href="/notice" className="underline">supplier notice</Link>.</EmptyDescription></Empty>}
        </CardContent>
      </Card>
      {bySupplier.length > 0 && (
        <Card size="sm">
          <CardHeader>
            <CardTitle>By supplier</CardTitle>
            <CardDescription>How many incidents each supplier has had. The supplier notice shows this when the same supplier comes up again.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-wrap gap-2">
              {bySupplier.map((s) => (
                <li key={s.id} className="rounded-md border px-3 py-1.5 text-sm">
                  {s.name} <span className="font-mono text-xs text-muted-foreground">{s.id}</span> · <b className="tabular-nums">{s.n}</b> {s.n === 1 ? "incident" : "incidents"}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
