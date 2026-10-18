import { config } from 'dotenv';
config({ path: ['.env.local', '.env'], quiet: true }); // stdout belongs to the MCP stdio transport
import { FalkorDB, type Graph } from 'falkordb';
import { AsyncLocalStorage } from 'node:async_hooks';

let db: Promise<FalkorDB> | undefined;

/** The app graph. Tests set RECALL_GRAPH so they never touch the demo graph. */
export async function graph(name = process.env.RECALL_GRAPH ?? 'recall'): Promise<Graph> {
  db ??= FalkorDB.connect({
    // Unset locally; FalkorDB Cloud needs them.
    username: process.env.FALKORDB_USERNAME || undefined,
    password: process.env.FALKORDB_PASSWORD || undefined,
    socket: {
      host: process.env.FALKORDB_HOST ?? 'localhost', port: Number(process.env.FALKORDB_PORT ?? 6380),
      ...(process.env.FALKORDB_TLS === 'true' ? { tls: true as const } : {}),
    },
  }).then((d) => {
    d.on('error', (e) => console.error('FalkorDB:', e.message)); // unhandled, this would crash the process; the client reconnects itself
    return d;
  }).catch((e) => {
    db = undefined; // don't cache a failed connect; retry on the next request
    throw e;
  });
  return (await db).selectGraph(name);
}

export async function query<T>(cypher: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const g = await graph();
  const res = await g.query<T>(cypher, { params: params as never });
  const t = timing.getStore();
  if (t) {
    t.queries++;
    t.db_ms += Number(res.metadata?.find((m) => m.startsWith('Query internal execution time'))?.match(/[\d.]+/)?.[0] ?? 0);
  }
  return res.data ?? [];
}

const timing = new AsyncLocalStorage<{ db_ms: number; queries: number }>();

/** Runs fn and reports FalkorDB's own execution time summed over every query it made. */
export async function measure<T>(fn: () => Promise<T>) {
  const t = { db_ms: 0, queries: 0 };
  const result = await timing.run(t, fn);
  return { result, db_ms: Math.round(t.db_ms * 100) / 100, queries: t.queries };
}

export async function close() {
  if (db) await (await db).close();
  db = undefined;
}
