import { z } from 'zod';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { query } from '../graph/db.js';
import { TRACE_FORWARD, COVERAGE_GAPS, SKU_RECIPIENTS, STORES, TRACE_BACKWARD } from '../graph/queries.js';

// --- Schemas (shared by the MCP server) ------------------------------------

const lot = z.string().describe('Ingredient lot code, e.g. L-204');
/** Models occasionally send an array argument as a JSON string; accept both. */
const list = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess((v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } }, z.array(item));
export const schemas = {
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
  draft_recall_notice: {
    lot,
    notices: list(z.object({ store: z.string(), reason: z.string() })).describe('One entry per store to notify'),
  },
};

// --- Handlers ----------------------------------------------------------------

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
    handler: minimalRecall,
    description: 'Combine trace_forward, coverage_gaps and unaffected_stores into the targeted recall: stores to recall, units to pull, and blanket vs targeted vs safe counts. Set add_gap_stores to decide whether gap stores join the recall.',
  },
  trace_backward: {
    handler: traceBackward,
    description: 'Walk product lots backward to every ingredient lot in them (including through rework). Pass lot to check whether each product lot contains it. Use it to independently verify that the lots held by safe stores do not contain the bad lot.',
  },
  draft_recall_notice: {
    handler: draftRecallNotice,
    description: 'Save one draft recall notice per store with status pending_approval. Never sends anything; a human must approve.',
  },
} as const;
