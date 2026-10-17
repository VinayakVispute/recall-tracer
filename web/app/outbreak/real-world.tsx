import type { RealOutbreak } from "@server/data/real";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";

const day = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/**
 * The same question asked of real public data: a CDC outbreak joined to its firm's openFDA recalls, from the
 * separate "fda" graph. Read on the server; renders nothing until `bun run real` has loaded it or if the API is down.
 */
export async function RealWorld({ showLink = true }: { showLink?: boolean } = {}) {
  let outbreaks: RealOutbreak[] = [];
  try { outbreaks = await api<RealOutbreak[]>("/real/outbreaks"); } catch { return null; }
  if (!outbreaks.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>The same question on real data</CardTitle>
        <CardDescription>A CDC outbreak joined to its firm&apos;s openFDA recalls in the graph. Public records, no synthetic data.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {outbreaks.map((o) => {
          const states = [...new Set([...Object.keys(o.cases_by_state), ...o.shipped])].sort();
          return (
            <div key={o.id} className="flex flex-col gap-3 text-sm">
              <p>
                <b>{o.pathogen}</b> in {o.food} · {o.cases} sick, {o.hospitalized} hospitalized, {o.deaths} {o.deaths === 1 ? "death" : "deaths"} · onsets {day(o.onset_from)} to {day(o.onset_to)} · <span className="capitalize">{o.status}</span>
              </p>
              <p className="text-muted-foreground">
                Linked to <b className="text-foreground">{o.firm.name}</b>, {o.firm.city}, {o.firm.state}: {o.recalls.length} openFDA {o.recalls.length === 1 ? "recall" : "recalls"}
                {o.recalls[0] && <>, {o.recalls[0].classification}, from {day(o.recalls[0].initiated)}</>}.
              </p>
              <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2">
                <dt className="text-xs text-muted-foreground">Where it shipped</dt>
                <dd className="flex flex-wrap gap-1">{o.shipped.map((s) => <Badge key={s} variant="secondary">{s}</Badge>)}</dd>
                <dt className="text-xs text-muted-foreground">Where people got sick</dt>
                <dd className="flex flex-wrap gap-1">
                  {states.filter((s) => o.cases_by_state[s]).map((s) => (
                    <Badge key={s} variant={o.gap.includes(s) ? "destructive" : "secondary"}>{s} · {o.cases_by_state[s]}</Badge>
                  ))}
                </dd>
              </dl>
              {o.gap.length > 0 && (
                <p className="rounded-md bg-destructive/10 px-3 py-2">
                  <b>Gap:</b> {o.gap.length === 1 ? "someone got sick in" : "people got sick in"} {o.gap.join(", ")} and no recall from this firm named {o.gap.length === 1 ? "that state" : "those states"}. The records do not say how the product got there.
                </p>
              )}
              {o.downstream.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Downstream: {o.downstream.map((d) => `${d.firm}${d.recalls.length ? ` (recall ${d.recalls.join(", ")})` : " (no openFDA recall yet)"}`).join(" · ")}. Link {o.downstream[0].basis} from CDC and FDA notices.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Sources: <a href={o.source} className="underline" target="_blank" rel="noreferrer">CDC investigation</a> · openFDA food enforcement reports.
                {showLink && <> · <Link href="/real" className="underline">See the whole graph and the queries</Link></>}
              </p>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
