import { readFileSync, statSync } from 'node:fs';
import { graph } from '../graph/db.js';

type Count = { kind: string; n: number };

/** Where each set of records came from, how many there are, and when they were loaded. Read-only; for the Records page. */
export type RecordSources = {
  traceability: {
    seeded_at: string | null;
    seed: number | null;
    counts: { suppliers: number; lots: number; batches: number; product_lots: number; products: number; stores: number; plants: number; dcs: number };
    events: { receiving: number; transformation: { used_in: number; reworked: number; produced: number }; shipping: number; no_lot_code: number; stock: number };
  };
  illness: { clusters: { id: string; pathogen: string; opened_at: string; cases: number }[] };
  agent: { incidents: number; lessons: number };
  public: { recalls: number; firms: number; outbreaks: number; recalls_since: string | null; fetched: string | null; outbreaks_checked: string | null; cdc_sources: string[]; inferred_links: number } | null;
  /** Every record and relationship type in each graph, with its count: what the Records page's source map draws. */
  graphs: Record<'recall' | 'fda', { nodes: Record<string, number>; edges: Record<string, number> }>;
};

const byKind = (rows: Count[]) => Object.fromEntries(rows.map((r) => [r.kind, r.n])) as Record<string, number>;
/** "20261017" or "2026-10-17" in a source note, as an ISO date. */
const isoIn = (s: string, re: RegExp) => {
  const m = re.exec(s)?.[1]?.replaceAll('-', '');
  return m && m.length === 8 ? `${m.slice(0, 4)}-${m.slice(4, 6)}-${m.slice(6)}` : null;
};
const note = (file: string) => { try { return (JSON.parse(readFileSync(file, 'utf8')) as { _source?: string })._source ?? ''; } catch { return ''; } };
type OutbreakFile = { outbreaks?: { sources?: string[] }[]; supplied?: { basis: string }[] };
const outbreakFile = (): OutbreakFile => { try { return JSON.parse(readFileSync('data/real/outbreaks.json', 'utf8')) as OutbreakFile; } catch { return {}; } };

export async function recordSources(): Promise<RecordSources> {
  const g = await graph('recall');
  const q = async <T>(cypher: string) => ((await g.query<T>(cypher)).data ?? []) as T[];
  const [nodes, edges, clusters] = await Promise.all([
    q<Count>('MATCH (n) RETURN labels(n)[0] AS kind, count(n) AS n'),
    q<Count>('MATCH ()-[r]->() RETURN type(r) AS kind, count(r) AS n'),
    q<{ id: string; pathogen: string; opened_at: string; cases: number }>(
      'MATCH (c:Cluster) OPTIONAL MATCH (c)-[:HAS_CASE]->(k:Case) RETURN c.id AS id, c.pathogen AS pathogen, c.opened_at AS opened_at, count(k) AS cases ORDER BY opened_at DESC, id'),
  ]);
  const n = byKind(nodes), e = byKind(edges);
  const at = (k: string) => n[k] ?? 0, rel = (k: string) => e[k] ?? 0;

  // The generator rewrites data/expected.json every time it loads the graph, so its time is the load time.
  let seeded_at: string | null = null, seed: number | null = null;
  try {
    seeded_at = statSync('data/expected.json').mtime.toISOString();
    seed = (JSON.parse(readFileSync('data/expected.json', 'utf8')) as { seed?: number }).seed ?? null;
  } catch { /* not seeded from this checkout */ }

  let pub: RecordSources['public'] = null;
  let fda = { nodes: {} as Record<string, number>, edges: {} as Record<string, number> };
  try {
    const f = await graph('fda');
    const fc = byKind(((await f.query<Count>('MATCH (n) RETURN labels(n)[0] AS kind, count(n) AS n')).data ?? []) as Count[]);
    fda = { nodes: fc, edges: byKind(((await f.query<Count>('MATCH ()-[r]->() RETURN type(r) AS kind, count(r) AS n')).data ?? []) as Count[]) };
    if (fc.Recall) {
      const recalls = note('data/real/openfda-food-recalls.json');
      pub = {
        recalls: fc.Recall, firms: fc.Firm ?? 0, outbreaks: fc.Outbreak ?? 0,
        recalls_since: isoIn(recalls, />=\s*(\d{8})/), fetched: isoIn(recalls, /fetched\s+(\d{8})/),
        outbreaks_checked: isoIn(note('data/real/outbreaks.json'), /(\d{4}-\d{2}-\d{2})/),
        cdc_sources: [...new Set((outbreakFile().outbreaks ?? []).flatMap((o) => o.sources ?? []))],
        inferred_links: (outbreakFile().supplied ?? []).filter((x) => x.basis === 'inferred').length,
      };
    }
  } catch { /* the public graph is optional */ }

  return {
    traceability: {
      seeded_at, seed,
      counts: { suppliers: at('Supplier'), lots: at('Lot'), batches: at('Batch'), product_lots: at('ProductLot'), products: at('Product'), stores: at('Store'), plants: at('Site'), dcs: at('DC') },
      events: {
        receiving: rel('SUPPLIED'),
        transformation: { used_in: rel('USED_IN'), reworked: rel('REWORKED_INTO'), produced: rel('PRODUCED') },
        shipping: rel('SHIPPED_TO'), no_lot_code: rel('SHIPPED_UNTRACKED'), stock: rel('HELD_AT') + rel('STORED_AT'),
      },
    },
    illness: { clusters },
    agent: { incidents: at('Incident'), lessons: at('Memory') },
    public: pub,
    graphs: { recall: { nodes: n, edges: e }, fda },
  };
}
