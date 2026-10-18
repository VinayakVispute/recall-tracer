import Form from "next/form";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { IncidentSummary } from "@server/tools/incident";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, apiOrNull, ApiError, LOT_RE } from "@/lib/api";

export const metadata = { title: "Incidents", description: "Open a recall incident by lot code, or watch a recorded agent run trace lot L-204 to 33 of 71 stores." };

const STATUS: Record<IncidentSummary["status"], string> = { open: "Tracing", scoped: "Scope decided", notices_approved: "Notices approved" };
// Recorded runs in demo/, one per path the agent can take.
const REPLAYS = [["L-204", "(gaps, you decide)"], ["L-205", "(memory flags repeat gaps)"], ["L-143", "(one batch, no gaps)"], ["L-108", "(never used: hold only)"]] as const;
// The date part only, so a server in UTC and the coordinator agree on it.
const day = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const UNREACHABLE = "Cannot reach the Recall Tracer API. Check that it is running.";

/**
 * The Incident tab: the coordinator names the lot first. A known lot opens its incident; anything else is a sentence
 * next to the field. Incidents already in the graph are listed so one click reopens them.
 */
export default async function Page({ searchParams }: PageProps<"/incident">) {
  const sp = await searchParams;
  const lot = typeof sp.lot === "string" ? sp.lot.trim().toUpperCase() : "";
  let error = "";
  if (lot && !LOT_RE.test(lot)) error = "A lot code is L- followed by digits, like L-204.";
  else if (lot) {
    let known = false;
    try { known = !!(await apiOrNull(`/incident/${lot}/status`)); } catch (e) { error = e instanceof ApiError ? e.message : UNREACHABLE; }
    if (known) redirect(`/incident/${lot}`); // outside the try: redirect() works by throwing
    error ||= `No lot ${lot} in the traceability records. Check the code on the supplier's alert.`;
  }

  let incidents: IncidentSummary[] = [], listError = "";
  try { incidents = await api<IncidentSummary[]>("/incidents"); } catch (e) { listError = e instanceof ApiError ? e.message : UNREACHABLE; }

  return (
    <div className="mx-auto flex w-full max-w-none flex-col gap-4 p-4">
      <Card>
        <CardHeader>
          <CardTitle>Find an incident</CardTitle>
          <CardDescription>Enter the lot code to see its incident: the trace, the scope, the evidence for every store and the notices. Nothing here calls the agent.</CardDescription>
        </CardHeader>
        <CardContent>
          <Form action="/incident" className="flex flex-wrap items-end gap-3">
            <Field className="w-40">
              <FieldLabel htmlFor="lot">Lot code</FieldLabel>
              <Input id="lot" name="lot" defaultValue={lot} placeholder="L-204" required spellCheck={false} autoComplete="off"
                className="font-mono uppercase" aria-invalid={!!error} aria-describedby="lot-msg" />
            </Field>
            <Button type="submit">Show incident</Button>
          </Form>
          <FieldDescription id="lot-msg" className={error ? "mt-2 text-destructive" : "mt-2"} role={error ? "alert" : undefined}>
            {error || <>To start a new incident, use the <Link href="/notice" className="underline">supplier notice</Link>.</>}
          </FieldDescription>
          <p className="mt-3 text-sm text-muted-foreground">
            Watch the agent take a different path on each lot:{" "}
            {REPLAYS.map(([l, what], i) => <span key={l}>{i > 0 && " · "}<Link href={`/incident/${l}?replay=1`} className="underline"><span className="font-mono">{l}</span> {what}</Link></span>)}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Incidents in the graph</CardTitle>
          <CardDescription>Newest first. Click a lot to open its incident.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {listError ? <p className="text-sm text-destructive" role="alert">{listError}</p>
            : incidents.length ? (
              <Table>
                <TableHeader><TableRow><TableHead>Lot</TableHead><TableHead>Hazard</TableHead><TableHead>Opened</TableHead><TableHead className="text-right">Stores</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
                <TableBody>
                  {incidents.map((i) => (
                    <TableRow key={i.id}>
                      <TableCell><Link href={`/incident/${i.lot}`} className="font-mono underline">{i.lot}</Link></TableCell>
                      <TableCell className="max-w-72 whitespace-normal">{i.hazard}</TableCell>
                      <TableCell className="whitespace-nowrap">{day(i.reported_at)}</TableCell>
                      <TableCell className="text-right tabular-nums">{i.stores ?? "—"}</TableCell>
                      <TableCell><Badge variant={i.status === "open" ? "outline" : "secondary"}>{STATUS[i.status]}</Badge></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <Empty>
                <EmptyDescription>
                  No incidents yet. Start from an <Link href="/outbreak" className="underline">outbreak</Link> or a <Link href="/notice" className="underline">supplier notice</Link>.
                </EmptyDescription>
              </Empty>
            )}
        </CardContent>
      </Card>
    </div>
  );
}
