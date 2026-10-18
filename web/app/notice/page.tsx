import type { IncidentReport, IncidentSummary } from "@server/tools/incident";
import { api, apiOrNull, ApiError, LOT_RE } from "@/lib/api";
import { NoticeForm, type Epi, type LotFacts } from "./notice-form";

export const metadata = { title: "Supplier notice" };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

/** Page 2. The lot code lives in the URL, so a reload or a handoff from the outbreak page lands on the same facts. */
export default async function Page({ searchParams }: PageProps<"/notice">) {
  const sp = await searchParams;
  const lot = (one(sp.lot) ?? "").toUpperCase();
  const cluster = one(sp.cluster);
  const epi: Epi | undefined = cluster ? { cluster, explained: Number(one(sp.explained)), cases: Number(one(sp.cases)) } : undefined;
  // Not awaited: the form renders at once and the facts stream in under their own Suspense boundary.
  const facts = LOT_RE.test(lot) ? lotFacts(lot) : null;
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4">
      <NoticeForm lot={lot} epi={epi} facts={facts} />
    </div>
  );
}

/** Read from the graph, never from Claude. Failures come back as a sentence, since production hides thrown server errors. */
async function lotFacts(lot: string): Promise<LotFacts> {
  try {
    const r = await api<IncidentReport>(`/incident/${lot}`);
    // Needs the supplier id from the lot, so it follows rather than runs alongside.
    const history = await apiOrNull<{ incidents: IncidentSummary[] }>(`/incidents/supplier/${r.lot.supplier_id}`);
    const prior = (history?.incidents ?? []).filter((i) => i.lot !== lot).map((i) => ({ id: i.id, lot: i.lot, hazard: i.hazard }));
    return { ok: true, lot: r.lot, unused_kg: r.hold.totals.raw_kg, unused_at: r.hold.raw.map((h) => h.name), incident: r.incident && { id: r.incident.id }, prior };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Cannot reach the Recall Tracer API. Check that it is running." };
  }
}
