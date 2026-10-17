import { query } from '../graph/db.js';
import { LOT_INFO, LINEAGE, BATCHES, PRODUCT_LOTS, SKU_SHIPMENTS, STORES, SKUS_OF } from '../graph/queries.js';
import { minimalRecall, traceBackward } from './index.js';

export type StoreStatus = 'recall' | 'gap' | 'safe';
export type Shipment = { lot: string; sku: string; product: string; units: number; shipped_at: string; affected: boolean; origins: string[] };
export type Untracked = { sku: string; product: string; units: number; shipped_at: string; reason: string };

/**
 * Everything the dashboard shows, read straight from the graph (no agent).
 * Statuses come from minimal_recall, so the dashboard and the agent agree by construction.
 */
export async function incidentReport(lot: string, add_gap_stores = true) {
  const recall = await minimalRecall({ lot, add_gap_stores });
  const [info] = await query<{ code: string; ingredient: string; received_at: string; supplier_id: string; supplier: string }>(LOT_INFO, { lot });
  const lineage = await query<{ source: string; target: string; type: string; qty_kg: number | null; units: number | null }>(LINEAGE, { lot });

  const skus = (await query<{ sku: string }>(SKUS_OF, { ids: recall.product_lots })).map((r) => r.sku).sort();
  const productLots = await query<{ id: string; sku: string; product: string; produced_at: string; batch: string; units: number }>(PRODUCT_LOTS, { skus });
  const productName = new Map(productLots.map((p) => [p.sku, p.product]));

  const [batches, shipments, origins] = await Promise.all([
    query<{ id: string; site: string; produced_at: string }>(BATCHES, { ids: recall.batches }),
    query<{ lot: string; sku: string; units: number; shipped_at: string; store: string; name: string; city: string; region: string }>(SKU_SHIPMENTS, { skus }),
    traceBackward({ product_lots: productLots.map((p) => p.id), lot }),
  ]);
  const originsOf = new Map(origins.results.map((r) => [r.product_lot, r.ingredient_lots]));
  const bad = new Set(recall.product_lots);

  const status = new Map<string, StoreStatus>();
  recall.recall_stores.forEach((r) => status.set(r.store, r.kind === 'affected' ? 'recall' : 'gap'));
  recall.gaps.forEach((g) => status.set(g.store, 'gap'));
  recall.safe.forEach((s) => status.set(s.store, 'safe'));

  type Store = { id: string; name: string; city: string; region: string; status: StoreStatus; shipments: Shipment[]; untracked: Untracked[]; paths: string[][]; units_at_risk: number; last_shipped: string };
  const stores = new Map<string, Store>();
  const store = (id: string, name: string, city: string, region: string) => {
    if (!stores.has(id)) stores.set(id, { id, name, city, region, status: status.get(id) ?? 'safe', shipments: [], untracked: [], paths: [], units_at_risk: 0, last_shipped: '' });
    return stores.get(id)!;
  };
  for (const s of shipments) {
    const st = store(s.store, s.name, s.city, s.region);
    st.shipments.push({ lot: s.lot, sku: s.sku, product: productName.get(s.sku) ?? s.sku, units: s.units, shipped_at: s.shipped_at, affected: bad.has(s.lot), origins: originsOf.get(s.lot) ?? [] });
  }
  // Gap stores may have no lot-coded shipment of these SKUs at all.
  const gapInfo = await query<{ id: string; name: string; city: string; region: string }>(STORES, { ids: recall.gaps.map((g) => g.store) });
  for (const g of recall.gaps) {
    const i = gapInfo.find((x) => x.id === g.store)!;
    store(g.store, i.name, i.city, i.region).untracked.push({ sku: g.sku, product: g.product, units: g.units, shipped_at: g.shipped_at, reason: g.reason });
  }
  for (const r of recall.recall_stores) if (r.kind === 'affected') stores.get(r.store)!.paths = r.paths;
  for (const st of stores.values()) {
    st.units_at_risk = st.shipments.filter((s) => s.affected).reduce((n, s) => n + s.units, 0) + st.untracked.reduce((n, u) => n + u.units, 0);
    st.last_shipped = [...st.shipments.map((s) => s.shipped_at), ...st.untracked.map((u) => u.shipped_at)].sort().at(-1) ?? '';
    st.shipments.sort((a, b) => Number(b.affected) - Number(a.affected) || a.lot.localeCompare(b.lot));
  }

  const all = [...stores.values()];
  const rank: Record<StoreStatus, number> = { recall: 0, gap: 1, safe: 2 };
  all.sort((a, b) => rank[a.status] - rank[b.status] || b.units_at_risk - a.units_at_risk || a.id.localeCompare(b.id));
  const blanketUnits = shipments.reduce((n, s) => n + s.units, 0) + recall.gaps.reduce((n, g) => n + g.units, 0);

  return {
    lot: { ...info },
    lineage,
    batches,
    product_lots: productLots.map((p) => ({ ...p, affected: bad.has(p.id), origins: originsOf.get(p.id) ?? [] })),
    skus: skus.map((sku) => ({ sku, product: productName.get(sku) ?? sku })),
    stores: all,
    counts: { ...recall.counts, blanket_units: blanketUnits, units_to_pull: recall.units_to_pull, product_lots: recall.product_lots.length, batches: recall.batches.length },
    add_gap_stores,
  };
}
export type IncidentReport = Awaited<ReturnType<typeof incidentReport>>;

