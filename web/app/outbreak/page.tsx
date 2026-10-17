import Form from "next/form";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { apiOrNull, ApiError } from "@/lib/api";
import { OutbreakView, type ClusterDetail } from "./outbreak-view";
import { PasteCases } from "./paste-cases";

// The seeded cluster. Kept here: a constant imported from a "use client" module is a client reference on the server, not a string.
const EXAMPLE_CLUSTER = "OB-2026-10";

/**
 * Page 1. The cluster lives in the URL; its cases are read on the server so the table is in the first paint.
 * With no cluster yet, the coordinator chooses one: open it by id, paste the reports, or load the example.
 */
export default async function Page({ searchParams }: PageProps<"/outbreak">) {
  const sp = await searchParams;
  const id = typeof sp.cluster === "string" ? sp.cluster.trim() : "";
  if (!id) return <Start />;

  let cluster: ClusterDetail | null = null, error = "";
  try {
    cluster = await apiOrNull<ClusterDetail>(`/clusters/${encodeURIComponent(id)}`);
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Cannot reach the Recall Tracer API. Check that it is running.";
  }
  return (
    <>
      <div className="mx-auto w-full max-w-[1500px] p-4"><PasteCases id={id} example={EXAMPLE_CLUSTER} /></div>
      {/* A new cluster, or new cases in it, gets a fresh view: no result or selection carries over. */}
      <OutbreakView key={`${id}:${cluster?.cases.length ?? 0}`} id={id} cluster={cluster} loadError={error} />
    </>
  );
}

function Start() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
      <Card>
        <CardHeader>
          <CardTitle>Find the source of an outbreak</CardTitle>
          <CardDescription>
            Start from a linked cluster of illness cases. The agent walks each case back from the store where the person bought
            the food to every ingredient lot that could have reached it, and ranks the lots by how many cases they explain.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Form action="/outbreak" className="flex flex-wrap items-end gap-3">
            <Field className="w-48">
              <FieldLabel htmlFor="cluster-id">Cluster id</FieldLabel>
              <Input id="cluster-id" name="cluster" placeholder={EXAMPLE_CLUSTER} required pattern="[A-Za-z0-9\-]{1,40}" spellCheck={false} autoComplete="off" />
            </Field>
            <Button type="submit">Open cluster</Button>
            <Link href={`/outbreak?cluster=${EXAMPLE_CLUSTER}`} className={buttonVariants({ variant: "outline" })}>Load the example cluster</Link>
          </Form>
          <p className="text-xs text-muted-foreground">New cluster? Paste its case reports below. No outbreak, just a supplier&apos;s alert? Go to the <Link href="/notice" className="underline">supplier notice</Link>.</p>
        </CardContent>
      </Card>
      <PasteCases id="" example={EXAMPLE_CLUSTER} />
    </div>
  );
}
