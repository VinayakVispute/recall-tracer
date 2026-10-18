import Link from "next/link";
import { apiOrNull, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { CaseReportCard } from "./case-report";
import { OutbreakView, type ClusterDetail } from "./outbreak-view";
import { PasteCases } from "./paste-cases";

export const metadata = { title: "Find the source", description: "Upload illness cases and the agent walks each one back through the graph to the ingredient lot that explains them." };

// The seeded cluster. Kept here: a constant imported from a "use client" module is a client reference on the server, not a string.
const EXAMPLE_CLUSTER = "OB-2026-10";

/** The two kinds of illness report, named by what they contain, since that decides which records can be searched. */
const TABS = [
  { key: "store", title: "Store-level reports", sub: "Each case has a store and purchase date. Searches your company's lot records." },
  { key: "public", title: "State-level reports", sub: "States and illness dates, as CDC publishes them. Searches public FDA recalls." },
] as const;

function ReportTabs({ tab, cluster }: { tab: "store" | "public"; cluster: string | null }) {
  return (
    <nav aria-label="Illness reports" className="grid gap-1 rounded-2xl bg-card p-1.5 ring-1 ring-foreground/7 sm:grid-cols-2">
      {TABS.map((t) => (
        <Link key={t.key} href={t.key === "public" ? "/outbreak?report=public" : cluster ? `/outbreak?cluster=${encodeURIComponent(cluster)}` : "/outbreak"}
          aria-current={tab === t.key ? "page" : undefined}
          className={cn("flex flex-col gap-0.5 rounded-xl px-4 py-2.5 text-left transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            tab === t.key ? "bg-secondary ring-1 ring-foreground/10" : "text-muted-foreground hover:bg-secondary/50")}>
          <span className={cn("text-sm font-medium", tab === t.key && "text-foreground")}>{t.title}</span>
          <span className="text-xs text-muted-foreground">{t.sub}</span>
        </Link>
      ))}
    </nav>
  );
}

/**
 * Page 1. Two tabs, by what the illness reports contain. Store-level: the cluster lives in the URL and its cases are read
 * on the server, so the table is in the first paint. State-level (?report=public): a CDC report checked against public recalls.
 */
export default async function Page({ searchParams }: PageProps<"/outbreak">) {
  const sp = await searchParams;
  const tab = sp.report === "public" ? "public" : "store";
  const asked = typeof sp.cluster === "string" && sp.cluster.trim() ? sp.cluster.trim() : null;
  const top = <div className="mx-auto w-full max-w-none px-4 pt-4"><ReportTabs tab={tab} cluster={asked} /></div>;

  if (tab === "public") {
    return <>{top}<div className="mx-auto w-full max-w-none p-4"><CaseReportCard /></div></>;
  }

  // No cluster in the URL: the seeded example, so the page is one click from "Find the source".
  const id = asked ?? EXAMPLE_CLUSTER;
  let cluster: ClusterDetail | null = null, error = "";
  try {
    cluster = await apiOrNull<ClusterDetail>(`/clusters/${encodeURIComponent(id)}`);
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Cannot reach the Recall Tracer API. Check that it is running.";
  }
  return (
    <>
      {top}
      <div className="mx-auto w-full max-w-none p-4"><PasteCases id={id} example={EXAMPLE_CLUSTER} /></div>
      {/* A new cluster, or new cases in it, gets a fresh view: no result or selection carries over. */}
      <OutbreakView key={`${id}:${cluster?.cases.length ?? 0}`} id={id} cluster={cluster} loadError={error} />
    </>
  );
}
