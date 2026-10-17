import { config } from 'dotenv';
config({ quiet: true }); // stdout belongs to the MCP stdio transport
import { FalkorDB, type Graph } from 'falkordb';

let db: Promise<FalkorDB> | undefined;

export async function graph(name = 'recall'): Promise<Graph> {
  db ??= FalkorDB.connect({
    socket: { host: process.env.FALKORDB_HOST ?? 'localhost', port: Number(process.env.FALKORDB_PORT ?? 6380) },
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
  return res.data ?? [];
}

export async function close() {
  if (db) await (await db).close();
  db = undefined;
}
