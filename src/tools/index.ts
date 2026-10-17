import { z } from 'zod';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { query } from '../graph/db.js';
import { TRACE_FORWARD, COVERAGE_GAPS, SKU_RECIPIENTS, STORES, TRACE_BACKWARD, RAW_ON_HAND, FINISHED_ON_HAND, HOLD_RAW, HOLD_FINISHED, INCIDENT_CLASSIFY, FIND_COMMON_SOURCE, CLUSTER_CASES, CASES_EXIST, CASE_PATH, INCIDENT_SCOPED, CHOKEPOINTS, LOT_INFO, MEMORY_READ, MEMORY_CLEAR, MEMORY_WRITE } from '../graph/queries.js';
import type { Candidate, OutbreakResult } from '../contracts.js';

// --- Schemas (shared by the MCP server) ------------------------------------

const lot = z.string().describe('Ingredient lot code, e.g. L-204');
/** Models occasionally send an array argument as a JSON string, sometimes with a stray bracket; accept both. */
const list = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess((v) => {
    if (typeof v !== 'string') return v;
    const s = v.trim();
    for (const cand of [s, s.slice(s.indexOf('['), s.lastIndexOf(']') + 1)]) { try { return JSON.parse(cand); } catch { /* try the next form */ } }
    return v;
  }, z.array(item));
export const RECALL_CLASSES = ['I', 'II', 'III'] as const;
export const RECALL_DEPTHS = ['consumer', 'retail', 'wholesale'] as const;
export const schemas = {
  propose_classification: {
    lot,
    class: z.enum(RECALL_CLASSES).describe('I: reasonable probability of serious health consequences or death. II: temporary or medically reversible effects. III: not likely to cause harm.'),
    depth: z.enum(RECALL_DEPTHS).describe('consumer: product is on shelves and the public must be told. retail: stores pull it quietly. wholesale: still in distribution.'),
    rationale: z.string().max(400).describe('One sentence: why this class and depth for this hazard and product'),
  },
  place_hold: { lot },
  trace_forward: { lot },
  coverage_gaps: { lot },
  unaffected_stores: { lot },
  minimal_recall: {
    lot,
    add_gap_stores: z.boolean().default(true)
      .describe('true: add gap stores to the recall (cannot prove them safe). false: only flag them for the approver.'),
  },
  trace_backward: {
    product_lots: list(z.string()).pipe(z.array(z.string()).min(1).max(200)).describe('Product lot codes (traceability lot codes), e.g. TLC-06A'),
    lot: lot.optional().describe('If given, report whether each product lot contains this ingredient lot'),
  },
  find_common_source: {
    cluster: z.string().describe('Outbreak cluster id, e.g. OB-2026-10'),
  },
  case_path: {
    lot,
    cases: list(z.string()).pipe(z.array(z.string()).min(1).max(200)).describe('Case ids, e.g. ["C1", "C3"]'),
  },
  rank_chokepoints: { lot },
  recall_memory: { lot },
  record_lessons: {
    lot,
    lessons: list(z.object({
      about: z.string().describe('Id of the supplier, store, batch, plant or DC the lesson is about, e.g. S-03 or ST-013'),
      fact: z.string().max(300).describe('One sentence a future incident should know'),
    })).pipe(z.array(z.object({ about: z.string(), fact: z.string() })).min(1).max(8)).describe('A JSON array (not a string) of lessons'),
  },
  draft_recall_notice: {
    lot,
    notices: list(z.object({ store: z.string(), reason: z.string() })).describe('A JSON array (not a string) with one entry per store to notify'),
  },
};

// --- Handlers ----------------------------------------------------------------

export const incidentId = (lot: string, at = new Date()) => `INC-${at.toISOString().slice(0, 10).replace(/-/g, '')}-${lot.replace('-', '')}`;

/** The agent's hazard assessment. It is a proposal: the coordinator confirms or changes it in the dashboard. */
export async function proposeClassification({ lot, class: cls, depth, rationale }: { lot: string; class: string; depth: string; rationale: string }) {
  const at = new Date().toISOString();
  const [row] = await query<{ id: string; hazard: string }>(INCIDENT_CLASSIFY, { lot, class: cls, depth, rationale, at, id: incidentId(lot) });
  return { incident: row.id, lot, hazard: row.hazard, class: cls, depth, rationale, status: 'proposed', note: 'Awaiting confirmation by the recall coordinator.' };
}

export type HoldRow = { product_lot: string; product: string; kind: 'Site' | 'DC'; id: string; name: string; city: string; region: string; units: number };
/** Inventory that has not left the company: unused ingredient at the plant, unshipped product at plants and DCs. */
export async function readHold(lot: string) {
  const [raw, finished] = await Promise.all([
    query<{ id: string; name: string; city: string; region: string; qty_kg: number; received_kg: number }>(RAW_ON_HAND, { lot }),
    query<HoldRow>(FINISHED_ON_HAND, { lot }),
  ]);
  return {
    lot, raw, finished,
    totals: {
      raw_kg: raw.reduce((n, r) => n + r.qty_kg, 0),
      units: finished.reduce((n, r) => n + r.units, 0),
      locations: new Set([...raw.map((r) => r.id), ...finished.map((r) => r.id)]).size,
    },
  };
}
/** Records the hold on the inventory edges, so the graph itself carries the audit trail. Nothing physical moves. */
export async function placeHold({ lot }: { lot: string }) {
  const at = new Date().toISOString();
  await Promise.all([query(HOLD_RAW, { lot, at }), query(HOLD_FINISHED, { lot, at })]);
  const hold = await readHold(lot);
  return { ...hold, status: 'held', held_at: at, note: 'Held until QA releases it. Stores are handled by the recall, not the hold.' };
}

export async function traceForward({ lot }: { lot: string }) {
  const rows = await query<{ store: string; path: string[]; kinds: string[]; units: number }>(TRACE_FORWARD, { lot });
  const stores = new Map<string, { store: string; paths: string[][]; units: number }>();
  const batches = new Set<string>(), productLots = new Set<string>(), shipments = new Set<string>();
  for (const r of rows) {
    r.path.forEach((id, i) => {
      if (r.kinds[i] === 'Batch') batches.add(id);
      if (r.kinds[i] === 'ProductLot') productLots.add(id);
    });
    const s = stores.get(r.store) ?? { store: r.store, paths: [], units: 0 };
    s.paths.push(r.path);
    const key = `${r.path.at(-2)}>${r.store}`; // one shipment = product lot → store
    if (!shipments.has(key)) { shipments.add(key); s.units += r.units; }
    stores.set(r.store, s);
  }
  return {
    lot,
    batches: [...batches].sort(),
    product_lots: [...productLots].sort(),
    stores: [...stores.values()].sort((a, b) => a.store.localeCompare(b.store)),
    units: [...stores.values()].reduce((n, s) => n + s.units, 0),
  };
}

export async function coverageGaps({ lot }: { lot: string }) {
  const [rows, trace] = await Promise.all([
    query<{ store: string; sku: string; product: string; units: number; shipped_at: string }>(COVERAGE_GAPS, { lot }),
    traceForward({ lot }),
  ]);
  const affected = new Set(trace.stores.map((s) => s.store));
  return {
    lot,
    gaps: rows.filter((r) => !affected.has(r.store)).map((r) => ({
      ...r,
      reason: `Received ${r.units} units of ${r.sku} (${r.product}) on ${r.shipped_at} with no lot code recorded; ${r.sku} is made from ${lot}, so this store cannot be proven safe.`,
    })),
  };
}

export async function unaffectedStores({ lot }: { lot: string }) {
  const [rows, trace, gaps] = await Promise.all([
    query<{ store: string; received_lots: string[] }>(SKU_RECIPIENTS, { lot }),
    traceForward({ lot }),
    coverageGaps({ lot }),
  ]);
  const bad = new Set(trace.product_lots);
  const excluded = new Set([...trace.stores.map((s) => s.store), ...gaps.gaps.map((g) => g.store)]);
  const safe = rows
    .filter((r) => !excluded.has(r.store))
    .map((r) => ({
      store: r.store,
      received_lots: r.received_lots.sort().map((id) => ({ lot: id, reachable_from_bad_lot: bad.has(id) })),
    }))
    .sort((a, b) => a.store.localeCompare(b.store));
  // Proof check: a "safe" store must not hold any lot reachable from the bad lot.
  if (safe.some((s) => s.received_lots.some((l) => l.reachable_from_bad_lot))) throw new Error('safe store holds an affected lot');
  return { lot, stores: safe, blanket_stores: new Set([...rows.map((r) => r.store), ...excluded]).size };
}

export async function minimalRecall({ lot, add_gap_stores = true }: { lot: string; add_gap_stores?: boolean }) {
  const [trace, gaps, safe] = await Promise.all([traceForward({ lot }), coverageGaps({ lot }), unaffectedStores({ lot })]);
  const recall = [
    ...trace.stores.map((s) => ({ store: s.store, kind: 'affected' as const, paths: s.paths, units: s.units })),
    ...(add_gap_stores ? gaps.gaps.map((g) => ({ store: g.store, kind: 'gap' as const, reason: g.reason, units: g.units })) : []),
  ];
  return {
    lot,
    add_gap_stores,
    recall_stores: recall,
    gaps: gaps.gaps,
    safe: safe.stores,
    batches: trace.batches,
    product_lots: trace.product_lots,
    units_to_pull: recall.reduce((n, r) => n + r.units, 0),
    counts: {
      blanket: safe.blanket_stores,
      targeted: recall.length,
      safe: safe.stores.length,
      affected: trace.stores.length,
      gaps: gaps.gaps.length,
    },
  };
}

/** Independent check: walk each product lot back to every ingredient lot in it. */
export async function traceBackward({ product_lots, lot }: { product_lots: string[]; lot?: string }) {
  const rows = await query<{ product_lot: string; ingredient_lots: string[] }>(TRACE_BACKWARD, { product_lots });
  const byLot = new Map(rows.map((r) => [r.product_lot, r.ingredient_lots.sort()]));
  const results = product_lots.map((id) => ({
    product_lot: id,
    ingredient_lots: byLot.get(id) ?? [],
    ...(lot ? { contains_lot: (byLot.get(id) ?? []).includes(lot) } : {}),
  }));
  return { lot, results, ...(lot ? { containing: results.filter((r) => r.contains_lot).map((r) => r.product_lot) } : {}) };
}

/** The MCP minimal_recall: the recall plus the incident's scope time. Dashboard reads call minimalRecall and never stamp it. */
export async function scopeRecall(args: { lot: string; add_gap_stores?: boolean }) {
  const r = await minimalRecall(args);
  await query(INCIDENT_SCOPED, { lot: args.lot, at: new Date().toISOString(), stores: r.recall_stores.length });
  return r;
}

/** Each case's chain from the lot to the store where the person bought the food. Unknown case ids are an error, not an empty result. */
export async function casePath({ lot, cases }: { lot: string; cases: string[] }) {
  const known = new Set((await query<{ id: string }>(CASES_EXIST, { cases })).map((r) => r.id));
  const unknown = cases.filter((c) => !known.has(c));
  if (unknown.length) throw new Error(`unknown case ids: ${unknown.join(', ')}`);
  const rows = await query<{ case_id: string; path: string[] }>(CASE_PATH, { lot, cases });
  const paths: Record<string, string[][]> = Object.fromEntries(cases.map((c) => [c, []]));
  for (const r of rows) paths[r.case_id].push(r.path);
  return { lot, paths, unexplained: cases.filter((c) => !paths[c].length) };
}

/** Ranks ingredient lots by how many of the cluster's cases they explain, then by how few stores they reached. */
export async function findCommonSource({ cluster }: { cluster: string }): Promise<OutbreakResult> {
  const cases = (await query<{ id: string }>(CLUSTER_CASES, { cluster })).map((r) => r.id);
  if (!cases.length) throw new Error(`no cases in cluster ${cluster}`);
  const candidates = (await query<Candidate>(FIND_COMMON_SOURCE, { cluster })).map((c) => ({ ...c, explained: c.explained.sort() }));
  const [top, next] = candidates;
  const { paths } = top ? await casePath({ lot: top.lot, cases: top.explained }) : { paths: {} };
  const all = top?.cases_explained === cases.length;
  const summary = !top ? `No lot explains any of the ${cases.length} cases.`
    : `${top.lot} (${top.ingredient}, ${top.supplier_name}) explains ${top.cases_explained} of ${cases.length} cases and reached ${top.stores_reached} stores.`
      + (next ? ` Runner-up ${next.lot} explains ${next.cases_explained}.` : '')
      + (all ? '' : ' No lot explains every case.');
  return { cluster, total_cases: cases.length, candidates, paths, summary };
}

/** Graph algorithm: the batches and product lots most supply paths run through, among those this lot reached. */
export async function rankChokepoints({ lot }: { lot: string }) {
  const nodes = await query<{ kind: 'Batch' | 'ProductLot'; id: string; score: number; stores: number }>(CHOKEPOINTS, { lot });
  return { lot, algorithm: 'betweenness centrality', nodes: nodes.map((n) => ({ ...n, score: Math.round(n.score * 10) / 10 })) };
}

/** Lessons earlier incidents left about this lot's supplier or the stores its products reach. */
export async function recallMemory({ lot }: { lot: string }) {
  const [[info], lessons] = await Promise.all([
    query<{ supplier_id: string; supplier: string }>(LOT_INFO, { lot }),
    query<{ from_lot: string; at: string; kind: string; about: string; fact: string }>(MEMORY_READ, { lot }),
  ]);
  if (!info) throw new Error(`unknown lot ${lot}`);
  return { lot, supplier: { id: info.supplier_id, name: info.supplier }, lessons };
}

/** Writes this incident's lessons as Memory nodes linked to what they are about. Ids that are not in the graph are dropped. */
export async function recordLessons({ lot, lessons }: { lot: string; lessons: { about: string; fact: string }[] }) {
  await query(MEMORY_CLEAR, { lot });
  const saved = await query<{ kind: string; about: string; fact: string }>(MEMORY_WRITE, { lot, lessons, at: new Date().toISOString() });
  const known = new Set(saved.map((r) => r.about));
  return { lot, saved, unknown: [...new Set(lessons.map((l) => l.about).filter((id) => !known.has(id)))] };
}

export const NOTICES_FILE = process.env.NOTICES_FILE ?? 'out/notices.json'; // tests use their own file
export type Notice = { lot: string; store: string; name: string; city: string; reason: string; status: 'pending_approval' | 'approved'; drafted_at: string; text: string };

export function readNotices(): Notice[] {
  try { return JSON.parse(readFileSync(NOTICES_FILE, 'utf8')); } catch { return []; }
}
export function writeNotices(notices: Notice[]) {
  mkdirSync('out', { recursive: true });
  writeFileSync(NOTICES_FILE, JSON.stringify(notices, null, 2));
}

/** Saves drafts only. Never sends anything. */
export async function draftRecallNotice({ lot, notices }: { lot: string; notices: { store: string; reason: string }[] }) {
  const info = await query<{ id: string; name: string; city: string; region: string }>(STORES, { ids: notices.map((n) => n.store) });
  const byId = new Map(info.map((s) => [s.id, s]));
  const drafts: Notice[] = notices.map(({ store, reason }) => {
    const s = byId.get(store);
    return {
      lot, store, reason,
      name: s?.name ?? store,
      city: s ? `${s.city}, ${s.region}` : '',
      status: 'pending_approval',
      drafted_at: new Date().toISOString(),
      text: `RECALL NOTICE: ${s?.name ?? store}${s ? ` (${s.city}, ${s.region})` : ''}\n` +
        `Ingredient lot ${lot} is contaminated. Remove the products below from sale and hold them for collection.\n` +
        `Reason: ${reason}`,
    };
  });
  // Replace earlier drafts for the same lot so reruns don't pile up.
  writeNotices([...readNotices().filter((n) => n.lot !== lot), ...drafts]);
  return { lot, drafted: drafts.length, status: 'pending_approval', file: NOTICES_FILE };
}

export const tools = {
  propose_classification: {
    handler: proposeClassification,
    description: 'Record the proposed recall class (I, II, III) and depth (consumer, retail, wholesale) for the incident, with a one-sentence rationale. A proposal only: the recall coordinator confirms or changes it.',
  },
  place_hold: {
    handler: placeHold,
    description: 'Place a hold on everything that has not left the company: the unused remainder of the ingredient lot at the plant, and every unshipped unit of affected product at plants and distribution centres. Returns the locations and quantities held.',
  },
  trace_forward: {
    handler: traceForward,
    description: 'Follow a contaminated ingredient lot forward through batches, rework and product lots to every store that received it. Returns each store with its full path(s), plus affected batches and product lots.',
  },
  coverage_gaps: {
    handler: coverageGaps,
    description: 'Find stores that received an affected SKU through a shipment with no lot code recorded. These cannot be proven safe. Excludes stores already found by trace_forward.',
  },
  unaffected_stores: {
    handler: unaffectedStores,
    description: 'Stores that received an affected SKU but only from lots that do not trace to the bad lot, each with the lots it received as proof. Excludes affected and gap stores.',
  },
  minimal_recall: {
    handler: scopeRecall,
    description: 'Combine trace_forward, coverage_gaps and unaffected_stores into the targeted recall: stores to recall, units to pull, and blanket vs targeted vs safe counts. Set add_gap_stores to decide whether gap stores join the recall.',
  },
  trace_backward: {
    handler: traceBackward,
    description: 'Walk product lots backward to every ingredient lot in them (including through rework). Pass lot to check whether each product lot contains it. Use it to independently verify that the lots held by safe stores do not contain the bad lot.',
  },
  find_common_source: {
    handler: findCommonSource,
    description: 'Outbreak source finder. For a cluster of illness cases, rank ingredient lots by how many cases they explain (the lot reached the store where the person bought the food before they bought it), then by specificity (fewer stores reached for the same cases). Returns the ranking and each explained case\'s path for the top lot.',
  },
  case_path: {
    handler: casePath,
    description: 'For one ingredient lot and some case ids, return each case\'s path from the lot through batches and product lots to the store where the case bought the food. Cases the lot cannot reach come back in unexplained.',
  },
  rank_chokepoints: {
    handler: rankChokepoints,
    description: 'Graph algorithm: run betweenness centrality over the supply chain (lots, batches, product lots, stores) and return the batches and product lots this lot reached that the most supply paths run through, each with how many stores lie downstream. The top one is where the spread concentrated, e.g. a batch whose leftovers were reworked.',
  },
  recall_memory: {
    handler: recallMemory,
    description: 'Read lessons that earlier incidents recorded about this lot\'s supplier or about stores that receive its products, e.g. a store that took deliveries with no lot code. Empty when nothing is known yet.',
  },
  record_lessons: {
    handler: recordLessons,
    description: 'Save lessons from this incident for future ones, each about one supplier, store, batch, plant or DC id taken from tool results. Replaces lessons this incident saved before.',
  },
  draft_recall_notice: {
    handler: draftRecallNotice,
    description: 'Save one draft recall notice per store with status pending_approval. Never sends anything; a human must approve.',
  },
} as const;
