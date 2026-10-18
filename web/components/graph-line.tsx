import { api } from "@/lib/api";

type Stats = { graph: string; nodes: number; edges: number; last_run: { lot: string; queries: number; avg_db_ms: number } | null };

/** The shell's footer, read on the server. The layout streams it in, so a slow or absent API never blocks a page. */
export async function GraphLine() {
  try {
    const s = await api<Stats>("/stats");
    return (
      <span className="flex flex-col gap-0.5">
        <span>Connected to FalkorDB · {s.nodes.toLocaleString()} records</span>
        {s.last_run && <span>Last run: {s.last_run.queries} queries, {s.last_run.avg_db_ms} ms each on average</span>}
        <span>Demo company with synthetic records</span>
      </span>
    );
  } catch {
    return <span>FalkorDB is not reachable. Check that the API is running.</span>;
  }
}

export function GraphLineFallback() {
  return <span>Connecting to FalkorDB…</span>;
}
