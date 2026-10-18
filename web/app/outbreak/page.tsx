import { apiOrNull, ApiError } from "@/lib/api";
import { OutbreakView, type ClusterDetail } from "./outbreak-view";
import { PasteCases } from "./paste-cases";
import { RealWorld } from "./real-world";

export const metadata = { title: "Find the source" };

// The seeded cluster. Kept here: a constant imported from a "use client" module is a client reference on the server, not a string.
const EXAMPLE_CLUSTER = "OB-2026-10";

/**
 * Page 1. The cluster lives in the URL; its cases are read on the server so the table is in the first paint.

 * Without one the example cluster loads; the Case reports card opens another cluster by id or pastes new reports.
 */
export default async function Page({ searchParams }: PageProps<"/outbreak">) {
  const sp = await searchParams;
  // No cluster in the URL: the seeded example, so the page is one click from "Find the source".
  const id = (typeof sp.cluster === "string" && sp.cluster.trim()) || EXAMPLE_CLUSTER;

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
      <div className="mx-auto w-full max-w-[1500px] px-4 pb-4"><RealWorld /></div>
    </>
  );
}
