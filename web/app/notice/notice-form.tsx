"use client";

import { Suspense, use, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { IncidentReport } from "@server/tools/incident";
import { fmt, shortDate } from "@/components/dashboard/panels";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { LOT_RE } from "@/lib/api";
import { cn } from "@/lib/utils";

export type Epi = { cluster: string; explained: number; cases: number };
export type LotFacts =
  | { ok: true; lot: IncidentReport["lot"]; unused_kg: number; unused_at: string[]; incident: { id: string } | null; prior: { id: string; lot: string; hazard: string }[] }
  | { ok: false; error: string };

// The common recall reasons; "Other" takes the wording from the supplier's notice.
const HAZARDS = ["Listeria monocytogenes", "Salmonella", "E. coli O121", "Undeclared allergen", "Foreign material", "Other"];

export function NoticeForm({ lot, epi, facts }: { lot: string; epi?: Epi; facts: Promise<LotFacts> | null }) {
  const router = useRouter();
  const [code, setCode] = useState(lot);
  const [hazard, setHazard] = useState(HAZARDS[0]);
  const [other, setOther] = useState("");
  const [pending, startTransition] = useTransition();
  const valid = LOT_RE.test(code);

  // A valid code goes into the URL; the server reads the lot's facts. The epidemiology link belongs to the handed-off lot only.
  useEffect(() => {
    if (!valid || code === lot) return;
    const t = setTimeout(() => startTransition(() => router.replace(`/notice?lot=${code}`, { scroll: false })), 250);
    return () => clearTimeout(t);
  }, [code, lot, valid, router]);

  const hazardText = hazard === "Other" ? other.trim() : hazard;
  const open = () => router.push(`/incident/${lot}?${new URLSearchParams({ hazard: hazardText, start: "1" })}`);

  return (
    <Card>
      <form onSubmit={(e) => { e.preventDefault(); open(); }} className="contents">
        <CardHeader>
          <CardTitle>Supplier notice</CardTitle>
          <CardDescription>The lot code and hazard from the supplier&apos;s alert. Nothing reaches the agent until the lot is found in the records.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="lot">Lot code</FieldLabel>
            <Input id="lot" className="max-w-40 font-mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase().trim())}
              placeholder="L-204" spellCheck={false} autoComplete="off" aria-invalid={code !== "" && !valid} aria-describedby="lot-hint" />
            <FieldDescription id="lot-hint">{code !== "" && !valid ? "A lot code is L- followed by digits, like L-204." : "As printed on the supplier's alert."}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="hazard">Hazard</FieldLabel>
            <Select value={hazard} onValueChange={(v) => v && setHazard(v)}>
              <SelectTrigger id="hazard" className="w-full max-w-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{HAZARDS.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}</SelectContent>
            </Select>
            {hazard === "Other" && <Input aria-label="Hazard, as worded on the notice" value={other} onChange={(e) => setOther(e.target.value)} placeholder="As worded on the notice" maxLength={200} />}
          </Field>
          {facts && (
            <div className={cn("flex flex-col gap-2 transition-opacity", pending && "opacity-50")} aria-busy={pending}>
              <Suspense fallback={<Skeleton className="h-16 w-full" />}>
                <Facts facts={facts} epi={epi} />
              </Suspense>
            </div>
          )}
        </CardContent>
        <CardFooter className="flex flex-col items-stretch gap-2">
          {facts && valid && code === lot && !pending
            ? <Suspense fallback={<Button disabled className="self-end">Open incident</Button>}><OpenButton facts={facts} disabled={!hazardText} /></Suspense>
            : <Button disabled className="self-end">Open incident</Button>}
          <p className="text-xs text-muted-foreground">Opening the incident writes an Incident record to the graph and starts the 24-hour clock for the FDA Reportable Food Registry and the FSMA 204 records request.</p>
        </CardFooter>
      </form>
    </Card>
  );
}

function Facts({ facts, epi }: { facts: Promise<LotFacts>; epi?: Epi }) {
  const f = use(facts);
  if (!f.ok) return <Alert variant="destructive" role="alert"><AlertDescription>{f.error}</AlertDescription></Alert>;
  const { lot } = f;
  return (
    <>
      <p className="rounded-md bg-muted px-3 py-2 text-sm">
        {lot.supplier} ({lot.supplier_id}) · {lot.ingredient} · received {shortDate(lot.received_at)} · {fmt(lot.received_kg)} kg received · {fmt(f.unused_kg)} kg unused{f.unused_at.length ? ` at ${f.unused_at.join(", ")}` : ""}
      </p>
      {epi && (
        <p className="rounded-md bg-primary/10 px-3 py-2 text-sm">
          ✓ Epidemiology agrees: {lot.code} explains {epi.explained} of {epi.cases} cases in cluster {epi.cluster}
        </p>
      )}
      <p className="px-3 text-sm text-muted-foreground">
        {f.prior.length ? <>Prior incidents on {lot.supplier}: {f.prior.map((i) => `${i.lot} (${i.hazard})`).join(", ")}</> : <>Prior incidents on {lot.supplier}: none in the graph</>}
      </p>
      {f.incident && (
        <Alert role="status">
          <AlertDescription>Incident {f.incident.id} is already open on {lot.code}. Reopening restarts the 24-hour clock and replaces its draft notices.</AlertDescription>
        </Alert>
      )}
    </>
  );
}

function OpenButton({ facts, disabled }: { facts: Promise<LotFacts>; disabled: boolean }) {
  const f = use(facts);
  return <Button type="submit" className="self-end" disabled={!f.ok || disabled}>{f.ok && f.incident ? "Reopen incident" : "Open incident"}</Button>;
}
