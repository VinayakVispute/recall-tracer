import { api } from "@/lib/api";

type Stats = { graph: string; nodes: number; edges: number; last_run: { lot: string; queries: number; db_ms?: number; avg_db_ms: number } | null };

const ms = (n: number) => `${n < 10 ? n : Math.round(n)} ms`;

/** The shell's footer, read on the server. The layout streams it in, so a slow or absent API never blocks a page. */
export async function GraphLine() {
  try {
    const s = await api<Stats>("/stats");
    return (
      <span className="flex flex-col gap-0.5">
        <span>Connected to FalkorDB · {s.nodes.toLocaleString()} records</span>
        {/* The total, matching the investigation log; an API without db_ms yet falls back to the average. */}
        {s.last_run && <span>Last recall ({s.last_run.lot}): {s.last_run.queries} graph queries, {s.last_run.db_ms !== undefined ? `${ms(s.last_run.db_ms)} in FalkorDB` : `${s.last_run.avg_db_ms} ms each`}</span>}
      </span>
    );
  } catch {
    return <span>FalkorDB is not reachable. Check that the API is running.</span>;
  }
}

export function GraphLineFallback() {
  return <span>Connecting to FalkorDB…</span>;
}
