import { query } from '../graph/db.js';
import { LOT_INFO, LINEAGE, BATCHES, PRODUCT_LOTS, SKU_SHIPMENTS, STORES, SKUS_OF, INCIDENT_GET, INCIDENTS, SUPPLIER_GET } from '../graph/queries.js';
import { minimalRecall, traceBackward, readHold, readNotices } from './index.js';

export type StoreStatus = 'recall' | 'gap' | 'safe';
export type Shipment = { lot: string; sku: string; product: string; units: number; shipped_at: string; affected: boolean; origins: string[] };
export type Untracked = { sku: string; product: string; units: number; shipped_at: string; reason: string };
export type Incident = {
  id: string; hazard: string; reported_at: string;
  class: string | null; depth: string | null; rationale: string | null; classified_at: string | null;
  confirmed_class: string | null; confirmed_depth: string | null; confirmed_at: string | null;
  /** When the agent first decided the scope; freezes the shell's clock. */
  scoped_at: string | null;
};

/** The incident node and the hold, cheap enough to poll while the agent runs. */
export async function incidentStatus(lot: string) {
  const [[incident], hold] = await Promise.all([query<Incident>(INCIDENT_GET, { lot }), readHold(lot)]);
  return { incident: (incident ?? null) as Incident | null, hold };
}

/**
 * Everything the dashboard shows, read straight from the graph (no agent).
 * Statuses come from minimal_recall, so the dashboard and the agent agree by construction.
 */
export async function incidentReport(lot: string, add_gap_stores = true) {
  const [recall, status] = await Promise.all([minimalRecall({ lot, add_gap_stores }), incidentStatus(lot)]);
  const [info] = await query<{ code: string; ingredient: string; received_at: string; received_kg: number; supplier_id: string; supplier: string }>(LOT_INFO, { lot });
  const lineage = await query<{ source: string; target: string; type: string; qty_kg: number | null; units: number | null }>(LINEAGE, { lot });

  const skus = (await query<{ sku: string }>(SKUS_OF, { ids: recall.product_lots })).map((r) => r.sku).sort();
  const productLots = await query<{ id: string; sku: string; product: string; upc: string; produced_at: string; best_by: string; batch: string; units: number }>(PRODUCT_LOTS, { skus });
  const productName = new Map(productLots.map((p) => [p.sku, p.product]));

  const [batches, shipments, origins] = await Promise.all([
    query<{ id: string; site: string; produced_at: string }>(BATCHES, { ids: recall.batches }),
    query<{ lot: string; sku: string; units: number; shipped_at: string; store: string; name: string; city: string; region: string }>(SKU_SHIPMENTS, { skus }),
    traceBackward({ product_lots: productLots.map((p) => p.id), lot }),
  ]);
  const originsOf = new Map(origins.results.map((r) => [r.product_lot, r.ingredient_lots]));
  const bad = new Set(recall.product_lots);

  const statusOf = new Map<string, StoreStatus>();
  recall.recall_stores.forEach((r) => statusOf.set(r.store, r.kind === 'affected' ? 'recall' : 'gap'));
  recall.gaps.forEach((g) => statusOf.set(g.store, 'gap'));
  recall.safe.forEach((s) => statusOf.set(s.store, 'safe'));

  type Store = { id: string; name: string; city: string; region: string; status: StoreStatus; shipments: Shipment[]; untracked: Untracked[]; paths: string[][]; units_at_risk: number; last_shipped: string };
  const stores = new Map<string, Store>();
  const store = (id: string, name: string, city: string, region: string) => {
    if (!stores.has(id)) stores.set(id, { id, name, city, region, status: statusOf.get(id) ?? 'safe', shipments: [], untracked: [], paths: [], units_at_risk: 0, last_shipped: '' });
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
  const shippedOf = (id: string) => shipments.filter((s) => s.lot === id);
  const heldOf = (id: string) => status.hold.finished.filter((h) => h.product_lot === id).reduce((n, h) => n + h.units, 0);

  return {
    lot: { ...info },
    incident: status.incident,
    hold: status.hold,
    lineage,
    batches,
    product_lots: productLots.map((p) => ({
      ...p, affected: bad.has(p.id), origins: originsOf.get(p.id) ?? [],
      shipped: shippedOf(p.id).reduce((n, s) => n + s.units, 0), stores: shippedOf(p.id).length, held: heldOf(p.id),
    })),
    skus: skus.map((sku) => ({ sku, product: productName.get(sku) ?? sku, upc: productLots.find((p) => p.sku === sku)?.upc ?? '' })),
    stores: all,
    counts: { ...recall.counts, blanket_units: blanketUnits, units_to_pull: recall.units_to_pull, product_lots: recall.product_lots.length, batches: recall.batches.length },
    add_gap_stores,
  };
}
export type IncidentReport = Awaited<ReturnType<typeof incidentReport>>;

type IncidentRow = { id: string; lot: string; hazard: string; reported_at: string; class: string | null; confirmed_class: string | null; scoped_at: string | null; stores: number | null };
export type IncidentSummary = IncidentRow & {
  /** scoped_at minus reported_at, in minutes. null until the agent's first minimal_recall. */
  minutes_to_scope: number | null;
  status: 'open' | 'scoped' | 'notices_approved';
};

/** Pure: status and time-to-scope are derived on read, never stored. */
export function summarizeIncident(row: IncidentRow, approvedLots: ReadonlySet<string>): IncidentSummary {
  const minutes_to_scope = row.scoped_at ? Math.round((Date.parse(row.scoped_at) - Date.parse(row.reported_at)) / 6_000) / 10 : null;
  const status = approvedLots.has(row.lot) ? 'notices_approved' : row.scoped_at ? 'scoped' : 'open';
  return { ...row, minutes_to_scope, status };
}

/** Every incident, newest first, or one supplier's. */
export async function listIncidents(supplier?: string) {
  const rows = await query<IncidentRow>(INCIDENTS, { supplier: supplier ?? null });
  const approved = new Set(readNotices().filter((n) => n.status === 'approved').map((n) => n.lot));
  return rows.map((r) => summarizeIncident(r, approved));
}

/** null for an unknown supplier (404). A known supplier with no incidents gets an empty list. */
export async function supplierIncidents(id: string) {
  const [s] = await query<{ id: string; name: string }>(SUPPLIER_GET, { id });
  return s ? { supplier: s.id, name: s.name, incidents: await listIncidents(id) } : null;
}
