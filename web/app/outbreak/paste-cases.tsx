"use client";

import { useState, useTransition } from "react";
import Form from "next/form";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";

type Ingested = { cluster: string; created: boolean; loaded: number; rejected: { row: number; line: string; reason: string }[] };

/** Lives outside the per-cluster view, so its report survives the navigation to the cluster it just loaded. */
export function PasteCases({ id, example }: { id: string; example: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [cluster, setCluster] = useState(id);
  const [pathogen, setPathogen] = useState("");
  const [text, setText] = useState("");
  const [report, setReport] = useState<Ingested>();
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(""); setReport(undefined);
    startTransition(async () => {
      try {
        const r = await api<Ingested>("/ingest/cases", { cluster: cluster.trim(), pathogen: pathogen.trim() || undefined, text });
        setReport(r);
        if (!r.loaded) return;
        if (r.cluster === id) router.refresh();
        else router.push(`/outbreak?cluster=${encodeURIComponent(r.cluster)}`);
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Case reports</CardTitle>
        <CardDescription>Illness reports from the health department, linked into one cluster. A case needs the state, the onset date, the store and the purchase date; the product is optional.</CardDescription>
        <CardAction className="hidden @md/card-header:flex flex-wrap items-center gap-2">
          <Form action="/outbreak" className="flex items-center gap-1">
            <Input name="cluster" aria-label="Open another cluster by id" placeholder="Cluster id" required pattern="[A-Za-z0-9\-]{1,40}" spellCheck={false} autoComplete="off" className="h-7 w-32 text-xs" />
            <Button type="submit" variant="outline" size="sm">Open</Button>
          </Form>
          <Button variant="outline" size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>Paste reports</Button>
          {id !== example && <Link href={`/outbreak?cluster=${example}`} className={buttonVariants({ variant: "outline", size: "sm" })}>Load example</Link>}
        </CardAction>
      </CardHeader>
      <div className="flex flex-wrap items-center gap-2 px-(--card-spacing) @md/card-header:hidden" data-slot="toolbar">
        <Form action="/outbreak" className="flex items-center gap-1">
          <Input name="cluster" aria-label="Open another cluster by id" placeholder="Cluster id" required pattern="[A-Za-z0-9\-]{1,40}" spellCheck={false} autoComplete="off" className="h-7 w-32 text-xs" />
          <Button type="submit" variant="outline" size="sm">Open</Button>
        </Form>
        <Button variant="outline" size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>Paste reports</Button>
        {id !== example && <Link href={`/outbreak?cluster=${example}`} className={buttonVariants({ variant: "outline", size: "sm" })}>Load example</Link>}
      </div>
      {(open || report || error) && (
        <CardContent className="flex flex-col gap-3">
          {open && (
            <form onSubmit={submit} className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-3">
                <Field className="w-44">
                  <FieldLabel htmlFor="cluster">Cluster id</FieldLabel>
                  <Input id="cluster" value={cluster} onChange={(e) => setCluster(e.target.value)} required pattern="[A-Za-z0-9\-]{1,40}" spellCheck={false} />
                </Field>
                <Field className="w-64">
                  <FieldLabel htmlFor="pathogen">Pathogen</FieldLabel>
                  <Input id="pathogen" value={pathogen} onChange={(e) => setPathogen(e.target.value)} placeholder="Needed for a new cluster" />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="paste">One case per line, CSV or tab-separated</FieldLabel>
                <Textarea id="paste" rows={6} className="font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} required
                  placeholder={"id,region,onset,reported_at,sku,store,bought_at\nC7,OH,2026-10-15,2026-10-16,,ST-029,2026-10-12"} />
                <FieldDescription>Columns: id, region, onset, reported_at, sku (blank if unknown), store id, bought_at. Dates as 2026-10-12. Re-pasting the same rows changes nothing.</FieldDescription>
              </Field>
              <Button type="submit" size="sm" className="self-end" disabled={pending}>{pending ? "Loading…" : "Load into cluster"}</Button>
            </form>
          )}
          {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
          {report && (
            <Alert variant={report.rejected.length ? "destructive" : "default"} role="status">
              <AlertDescription>
                <p>{report.loaded} {report.loaded === 1 ? "case" : "cases"} loaded into {report.cluster}{report.created && " (new cluster)"}.{report.rejected.length > 0 && ` ${report.rejected.length} not used:`}</p>
                {report.rejected.length > 0 && <ul className="list-disc pl-5">{report.rejected.map((r) => <li key={r.row}>Row {r.row}: {r.reason}. <code className="text-xs">{r.line}</code></li>)}</ul>}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      )}
    </Card>
  );
}
