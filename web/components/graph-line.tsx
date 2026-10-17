import { api } from "@/lib/api";

type Stats = { graph: string; nodes: number; edges: number; last_run: { lot: string; queries: number; avg_db_ms: number } | null };

const BASE = "Northfield Foods";
const TAIL = "synthetic demo data";

/** The shell's graph line, read on the server. The layout streams it in, so a slow or absent API never blocks a page. */
export async function GraphLine() {
  try {
    const s = await api<Stats>("/stats");
    return (
      <span>
        {BASE} · graph &quot;{s.graph}&quot; · {s.nodes.toLocaleString()} records
        {s.last_run && <> · FalkorDB avg {s.last_run.avg_db_ms} ms over {s.last_run.queries} queries</>} · {TAIL}
      </span>
    );
  } catch {
    return <span>{BASE} · FalkorDB not reachable · {TAIL}</span>;
  }
}

export function GraphLineFallback() {
  return <span>{BASE} · graph &quot;recall&quot; on FalkorDB · {TAIL}</span>;
}
