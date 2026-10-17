// All Cypher used by Recall Tracer. The README quotes this file.

// --- Tools ---------------------------------------------------------------

/** trace_forward: every store reached from the lot, with the full path. */
export const TRACE_FORWARD = `
MATCH path = (l:Lot {code: $lot})-[:USED_IN|REWORKED_INTO|PRODUCED|SHIPPED_TO*1..8]->(st:Store)
RETURN st.id AS store,
       [n IN nodes(path) | coalesce(n.code, n.id)] AS path,
       [n IN nodes(path) | labels(n)[0]] AS kinds,
       last(relationships(path)).units AS units`;

/** coverage_gaps: stores that got an affected SKU with no lot code recorded. */
export const COVERAGE_GAPS = `
MATCH (:Lot {code: $lot})-[:USED_IN|REWORKED_INTO|PRODUCED*1..6]->(pl:ProductLot)
WITH collect(DISTINCT pl.sku) AS skus
MATCH (p:Product)-[u:SHIPPED_UNTRACKED]->(st:Store)
WHERE p.sku IN skus
RETURN st.id AS store, p.sku AS sku, p.name AS product, u.units AS units, u.shipped_at AS shipped_at`;

/** unaffected_stores: every store that got any lot of an affected SKU, with the lots it got. */
export const SKU_RECIPIENTS = `
MATCH (:Lot {code: $lot})-[:USED_IN|REWORKED_INTO|PRODUCED*1..6]->(pl:ProductLot)
WITH collect(DISTINCT pl.sku) AS skus
MATCH (pl2:ProductLot)-[:SHIPPED_TO]->(st:Store)
WHERE pl2.sku IN skus
RETURN st.id AS store, collect(DISTINCT pl2.id) AS received_lots`;

/** FDA export: one row per shipment of an affected product lot. */
export const AFFECTED_SHIPMENTS = `
MATCH (:Lot {code: $lot})-[:USED_IN|REWORKED_INTO*1..4]->(b:Batch)-[:PRODUCED]->(pl:ProductLot)-[s:SHIPPED_TO]->(st:Store),
      (pl)-[:OF]->(p:Product)
RETURN DISTINCT pl.id AS tlc, p.name AS product, s.units AS units, s.shipped_at AS shipped_at,
       st.id AS store, st.name AS store_name, st.city AS city, st.region AS region, b.site AS site
ORDER BY tlc, store`;

export const LOT_EXISTS = `MATCH (l:Lot {code: $lot}) RETURN count(l) AS n`;

export const STORES = `MATCH (st:Store) WHERE st.id IN $ids RETURN st.id AS id, st.name AS name, st.city AS city, st.region AS region`;

// --- Loading -------------------------------------------------------------

export const INDEXES = [
  'CREATE INDEX FOR (l:Lot) ON (l.code)',
  'CREATE INDEX FOR (b:Batch) ON (b.id)',
  'CREATE INDEX FOR (pl:ProductLot) ON (pl.id)',
  'CREATE INDEX FOR (p:Product) ON (p.sku)',
  'CREATE INDEX FOR (st:Store) ON (st.id)',
  'CREATE INDEX FOR (s:Supplier) ON (s.id)',
];

export const LOAD = {
  suppliers: 'UNWIND $rows AS r CREATE (:Supplier {id: r.id, name: r.name})',
  lots: 'UNWIND $rows AS r CREATE (:Lot {code: r.code, ingredient: r.ingredient, received_at: r.received_at, supplier_id: r.supplier_id})',
  batches: 'UNWIND $rows AS r CREATE (:Batch {id: r.id, produced_at: r.produced_at, site: r.site})',
  products: 'UNWIND $rows AS r CREATE (:Product {sku: r.sku, name: r.name})',
  productLots: 'UNWIND $rows AS r CREATE (:ProductLot {id: r.id, sku: r.sku, produced_at: r.produced_at})',
  stores: 'UNWIND $rows AS r CREATE (:Store {id: r.id, name: r.name, city: r.city, region: r.region})',
  supplied: 'UNWIND $rows AS r MATCH (s:Supplier {id: r.from}), (l:Lot {code: r.to}) CREATE (s)-[:SUPPLIED]->(l)',
  usedIn: 'UNWIND $rows AS r MATCH (l:Lot {code: r.from}), (b:Batch {id: r.to}) CREATE (l)-[:USED_IN {qty_kg: r.qty_kg}]->(b)',
  reworked: 'UNWIND $rows AS r MATCH (a:Batch {id: r.from}), (b:Batch {id: r.to}) CREATE (a)-[:REWORKED_INTO {qty_kg: r.qty_kg}]->(b)',
  produced: 'UNWIND $rows AS r MATCH (b:Batch {id: r.from}), (pl:ProductLot {id: r.to}) CREATE (b)-[:PRODUCED {units: r.units}]->(pl)',
  of: 'UNWIND $rows AS r MATCH (pl:ProductLot {id: r.from}), (p:Product {sku: r.to}) CREATE (pl)-[:OF]->(p)',
  shippedTo: 'UNWIND $rows AS r MATCH (pl:ProductLot {id: r.from}), (st:Store {id: r.to}) CREATE (pl)-[:SHIPPED_TO {units: r.units, shipped_at: r.shipped_at}]->(st)',
  untracked: 'UNWIND $rows AS r MATCH (p:Product {sku: r.from}), (st:Store {id: r.to}) CREATE (p)-[:SHIPPED_UNTRACKED {units: r.units, shipped_at: r.shipped_at}]->(st)',
};

export const COUNT_NODES = 'MATCH (n) RETURN count(n) AS n';
export const COUNT_EDGES = 'MATCH ()-[r]->() RETURN count(r) AS n';
