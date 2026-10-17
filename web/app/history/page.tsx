import Link from "next/link";
import type { IncidentSummary } from "@server/tools/incident";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";

const STATUS: Record<IncidentSummary["status"], string> = { open: "Open", scoped: "Scoped", notices_approved: "Notices approved" };

/** Page 7. Every incident the graph remembers, newest first, read on the server. */
export default async function Page() {
  const incidents = await api<IncidentSummary[]>("/incidents");
  return (
    <div className="mx-auto w-full max-w-5xl p-4">
      <Card>
        <CardHeader>
          <CardTitle>Incident history</CardTitle>
          <CardDescription>Every incident is an Incident node in the graph, so the next notice on the same supplier knows about it.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {incidents.length ? (
            <Table>
              <TableHeader><TableRow><TableHead>Incident</TableHead><TableHead>Lot</TableHead><TableHead>Hazard</TableHead><TableHead>Class</TableHead><TableHead className="text-right">Stores</TableHead><TableHead className="text-right">Notice to scope</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
              <TableBody>
                {incidents.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="font-mono text-xs">{i.id}</TableCell>
                    <TableCell><Link href={`/incident/${i.lot}`} className="font-mono underline">{i.lot}</Link></TableCell>
                    <TableCell className="max-w-64 whitespace-normal">{i.hazard}</TableCell>
                    <TableCell>{i.confirmed_class ? `Class ${i.confirmed_class}` : i.class ? `Class ${i.class} (proposed)` : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{i.stores ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{i.minutes_to_scope === null ? "—" : `${i.minutes_to_scope} min`}</TableCell>
                    <TableCell><Badge variant={i.status === "open" ? "outline" : "secondary"}>{STATUS[i.status]}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : <Empty><EmptyDescription>No incidents yet. Open one from the <Link href="/notice" className="underline">supplier notice</Link>.</EmptyDescription></Empty>}
        </CardContent>
      </Card>
    </div>
  );
}
