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

/** trace_backward: every ingredient lot that went into each product lot, directly or through rework. */
export const TRACE_BACKWARD = `
MATCH (l:Lot)-[:USED_IN]->(:Batch)-[:REWORKED_INTO*0..3]->(:Batch)-[:PRODUCED]->(pl:ProductLot)
WHERE pl.id IN $product_lots
RETURN pl.id AS product_lot, collect(DISTINCT l.code) AS ingredient_lots`;

/** place_hold: what is left of the ingredient lot in the plant store room. */
export const RAW_ON_HAND = `
MATCH (l:Lot {code: $lot})-[s:STORED_AT]->(site:Site)
RETURN site.id AS id, site.name AS name, site.city AS city, site.region AS region, s.qty_kg AS qty_kg, l.received_kg AS received_kg`;

/** place_hold: unshipped units of every affected product lot, at plants and distribution centres. */
export const FINISHED_ON_HAND = `
MATCH (:Lot {code: $lot})-[:USED_IN|REWORKED_INTO|PRODUCED*1..6]->(pl:ProductLot)-[h:HELD_AT]->(loc)
WITH DISTINCT pl, h, loc
MATCH (pl)-[:OF]->(p:Product)
RETURN pl.id AS product_lot, p.name AS product, labels(loc)[0] AS kind, loc.id AS id, loc.name AS name,
       loc.city AS city, loc.region AS region, h.units AS units
ORDER BY kind, id, product_lot`;

/** place_hold: record the hold on the inventory edges themselves, so the graph is the audit trail. */
export const HOLD_RAW = `MATCH (:Lot {code: $lot})-[s:STORED_AT]->() SET s.held_for = $lot, s.held_at = $at`;
export const HOLD_FINISHED = `
MATCH (:Lot {code: $lot})-[:USED_IN|REWORKED_INTO|PRODUCED*1..6]->(:ProductLot)-[h:HELD_AT]->()
SET h.held_for = $lot, h.held_at = $at`;

// --- Incident (one node per lot: hazard, proposed and confirmed class, timestamps) ---

export const INCIDENT_DELETE = `MATCH (i:Incident {lot: $lot}) DELETE i`;
export const INCIDENT_CREATE = `
MATCH (l:Lot {code: $lot})
CREATE (:Incident {id: $id, lot: $lot, hazard: $hazard, reported_at: $reported_at})-[:CONCERNS]->(l)`;
/** propose_classification: the agent's proposal. Creates the incident if the tool is used outside the API. */
export const INCIDENT_CLASSIFY = `
MERGE (i:Incident {lot: $lot})
ON CREATE SET i.id = $id, i.reported_at = $at, i.hazard = 'not recorded'
SET i.class = $class, i.depth = $depth, i.rationale = $rationale, i.classified_at = $at
RETURN i.id AS id, i.hazard AS hazard`;
export const INCIDENT_CONFIRM = `
MATCH (i:Incident {lot: $lot})
SET i.confirmed_class = $class, i.confirmed_depth = $depth, i.confirmed_at = $at
RETURN i.id AS id`;
export const INCIDENT_GET = `
MATCH (i:Incident {lot: $lot})
RETURN i.id AS id, i.hazard AS hazard, i.reported_at AS reported_at, i.class AS class, i.depth AS depth, i.rationale AS rationale,
       i.classified_at AS classified_at, i.confirmed_class AS confirmed_class, i.confirmed_depth AS confirmed_depth, i.confirmed_at AS confirmed_at,
       i.scoped_at AS scoped_at`;

// --- Incident dashboard (read-only, no agent) -----------------------------

export const LOT_INFO = `
MATCH (s:Supplier)-[:SUPPLIED]->(l:Lot {code: $lot})
RETURN l.code AS code, l.ingredient AS ingredient, l.received_at AS received_at, l.received_kg AS received_kg, s.id AS supplier_id, s.name AS supplier`;

/** Every hop from the lot down to its product lots, with quantities. */
export const LINEAGE = `
MATCH p = (:Lot {code: $lot})-[:USED_IN|REWORKED_INTO|PRODUCED*1..6]->(:ProductLot)
UNWIND relationships(p) AS r
WITH DISTINCT r, startNode(r) AS a, endNode(r) AS b
RETURN coalesce(a.code, a.id) AS source, b.id AS target, type(r) AS type, r.qty_kg AS qty_kg, r.units AS units`;

export const BATCHES = `MATCH (b:Batch) WHERE b.id IN $ids RETURN b.id AS id, b.site AS site, b.produced_at AS produced_at`;

export const SKUS_OF = `MATCH (pl:ProductLot) WHERE pl.id IN $ids RETURN DISTINCT pl.sku AS sku`;

export const PRODUCT_LOTS = `
MATCH (b:Batch)-[r:PRODUCED]->(pl:ProductLot)-[:OF]->(p:Product) WHERE p.sku IN $skus
RETURN pl.id AS id, pl.sku AS sku, p.name AS product, p.upc AS upc, pl.produced_at AS produced_at, pl.best_by AS best_by, b.id AS batch, r.units AS units`;

/** All lot-coded shipments of the given SKUs, with store details. */
export const SKU_SHIPMENTS = `
MATCH (pl:ProductLot)-[s:SHIPPED_TO]->(st:Store) WHERE pl.sku IN $skus
RETURN pl.id AS lot, pl.sku AS sku, s.units AS units, s.shipped_at AS shipped_at,
       st.id AS store, st.name AS name, st.city AS city, st.region AS region`;

export const LOT_EXISTS = `MATCH (l:Lot {code: $lot}) RETURN count(l) AS n`;

/** Human names for the record network: stores, batches, product lots (via their product) and ingredient lots (via their supplier). */
export const GRAPH_LABELS = `
MATCH (n) WHERE (n:Store OR n:Batch OR n:ProductLot) AND n.id IN $ids OR n:Lot AND n.code IN $ids
OPTIONAL MATCH (n)-[:OF]->(p:Product)
OPTIONAL MATCH (s:Supplier)-[:SUPPLIED]->(n)
RETURN coalesce(n.id, n.code) AS id, n.name AS name, n.city AS city, n.region AS region, n.site AS site, p.name AS product, n.ingredient AS ingredient, s.name AS supplier`;
export const STORES = `MATCH (st:Store) WHERE st.id IN $ids RETURN st.id AS id, st.name AS name, st.city AS city, st.region AS region`;

// --- Loading -------------------------------------------------------------

export const INDEXES = [
  'CREATE INDEX FOR (l:Lot) ON (l.code)',
  'CREATE INDEX FOR (b:Batch) ON (b.id)',
  'CREATE INDEX FOR (pl:ProductLot) ON (pl.id)',
  'CREATE INDEX FOR (p:Product) ON (p.sku)',
  'CREATE INDEX FOR (st:Store) ON (st.id)',
  'CREATE INDEX FOR (s:Supplier) ON (s.id)',
  'CREATE INDEX FOR (s:Site) ON (s.id)',
  'CREATE INDEX FOR (d:DC) ON (d.id)',
  'CREATE INDEX FOR (i:Incident) ON (i.lot)',
  'CREATE INDEX FOR (c:Case) ON (c.id)',
  'CREATE INDEX FOR (cl:Cluster) ON (cl.id)',
];

export const LOAD = {
  suppliers: 'UNWIND $rows AS r CREATE (:Supplier {id: r.id, name: r.name})',
  lots: 'UNWIND $rows AS r CREATE (:Lot {code: r.code, ingredient: r.ingredient, received_at: r.received_at, received_kg: r.received_kg, supplier_id: r.supplier_id})',
  batches: 'UNWIND $rows AS r CREATE (:Batch {id: r.id, produced_at: r.produced_at, site: r.site, site_id: r.site_id})',
  products: 'UNWIND $rows AS r CREATE (:Product {sku: r.sku, name: r.name, upc: r.upc})',
  productLots: 'UNWIND $rows AS r CREATE (:ProductLot {id: r.id, sku: r.sku, produced_at: r.produced_at, best_by: r.best_by})',
  stores: 'UNWIND $rows AS r CREATE (:Store {id: r.id, name: r.name, city: r.city, region: r.region})',
  sites: 'UNWIND $rows AS r CREATE (:Site {id: r.id, name: r.name, city: r.city, region: r.region})',
  dcs: 'UNWIND $rows AS r CREATE (:DC {id: r.id, name: r.name, city: r.city, region: r.region})',
  supplied: 'UNWIND $rows AS r MATCH (s:Supplier {id: r.from}), (l:Lot {code: r.to}) CREATE (s)-[:SUPPLIED]->(l)',
  usedIn: 'UNWIND $rows AS r MATCH (l:Lot {code: r.from}), (b:Batch {id: r.to}) CREATE (l)-[:USED_IN {qty_kg: r.qty_kg}]->(b)',
  storedAt: 'UNWIND $rows AS r MATCH (l:Lot {code: r.from}), (s:Site {id: r.to}) CREATE (l)-[:STORED_AT {qty_kg: r.qty_kg}]->(s)',
  reworked: 'UNWIND $rows AS r MATCH (a:Batch {id: r.from}), (b:Batch {id: r.to}) CREATE (a)-[:REWORKED_INTO {qty_kg: r.qty_kg}]->(b)',
  produced: 'UNWIND $rows AS r MATCH (b:Batch {id: r.from}), (pl:ProductLot {id: r.to}) CREATE (b)-[:PRODUCED {units: r.units}]->(pl)',
  of: 'UNWIND $rows AS r MATCH (pl:ProductLot {id: r.from}), (p:Product {sku: r.to}) CREATE (pl)-[:OF]->(p)',
  shippedTo: 'UNWIND $rows AS r MATCH (pl:ProductLot {id: r.from}), (st:Store {id: r.to}) CREATE (pl)-[:SHIPPED_TO {units: r.units, shipped_at: r.shipped_at}]->(st)',
  untracked: 'UNWIND $rows AS r MATCH (p:Product {sku: r.from}), (st:Store {id: r.to}) CREATE (p)-[:SHIPPED_UNTRACKED {units: r.units, shipped_at: r.shipped_at}]->(st)',
  clusters: 'UNWIND $rows AS r CREATE (:Cluster {id: r.id, pathogen: r.pathogen, opened_at: r.opened_at})',
  cases: 'UNWIND $rows AS r CREATE (:Case {id: r.id, region: r.region, onset: r.onset, reported_at: r.reported_at, sku: r.sku})',
  hasCase: 'UNWIND $rows AS r MATCH (cl:Cluster {id: r.from}), (c:Case {id: r.to}) CREATE (cl)-[:HAS_CASE]->(c)',
  boughtAt: 'UNWIND $rows AS r MATCH (c:Case {id: r.from}), (st:Store {id: r.to}) CREATE (c)-[:BOUGHT_AT {date: r.date}]->(st)',
  heldAt: 'UNWIND $rows AS r MATCH (pl:ProductLot {id: r.from}), (loc) WHERE loc.id = r.to AND (loc:Site OR loc:DC) CREATE (pl)-[:HELD_AT {units: r.units}]->(loc)',
};

export const COUNT_NODES = 'MATCH (n) RETURN count(n) AS n';
export const COUNT_EDGES = 'MATCH ()-[r]->() RETURN count(r) AS n';

// Outbreak: which ingredient lot reached every sick person's store before they bought the food.
// A case with no product named matches any product lot delivered to its store.
export const FIND_COMMON_SOURCE = `
MATCH (:Cluster {id: $cluster})-[:HAS_CASE]->(c:Case)-[b:BOUGHT_AT]->(st:Store)<-[s:SHIPPED_TO]-(pl:ProductLot)
      <-[:PRODUCED]-(:Batch)<-[:REWORKED_INTO*0..3]-(:Batch)<-[:USED_IN]-(l:Lot)
WHERE s.shipped_at <= b.date AND (c.sku IS NULL OR pl.sku = c.sku)
WITH l, collect(DISTINCT c.id) AS explained
MATCH (l)-[:USED_IN]->(:Batch)-[:REWORKED_INTO*0..3]->(:Batch)-[:PRODUCED]->(:ProductLot)-[:SHIPPED_TO]->(reach:Store)
WITH l, explained, count(DISTINCT reach) AS stores_reached
MATCH (sup:Supplier)-[:SUPPLIED]->(l)
RETURN l.code AS lot, l.ingredient AS ingredient, sup.id AS supplier, sup.name AS supplier_name,
       size(explained) AS cases_explained, explained, stores_reached,
       toFloat(size(explained)) / stores_reached AS specificity
ORDER BY cases_explained DESC, specificity DESC, lot ASC LIMIT 10`;

export const CLUSTER_CASES = 'MATCH (:Cluster {id: $cluster})-[:HAS_CASE]->(c:Case) RETURN c.id AS id ORDER BY id';
/** Page 1's case table: each case with where and when it was bought, and the product if the person remembers it. */
export const CLUSTER_DETAIL = `
MATCH (cl:Cluster {id: $cluster})-[:HAS_CASE]->(c:Case)-[b:BOUGHT_AT]->(st:Store)
OPTIONAL MATCH (p:Product {sku: c.sku})
RETURN cl.pathogen AS pathogen, cl.opened_at AS opened_at, c.id AS id, c.region AS region, c.onset AS onset, c.reported_at AS reported_at,
       c.sku AS sku, p.name AS product, st.id AS store, st.name AS store_name, st.city AS city, b.date AS bought_at
ORDER BY id`;
export const CASES_EXIST = 'MATCH (c:Case) WHERE c.id IN $cases RETURN c.id AS id';

/** Each case's evidence chain: lot, batches, product lot, store, case. */
export const CASE_PATH = `
MATCH (c:Case) WHERE c.id IN $cases
MATCH p = (:Lot {code: $lot})-[:USED_IN]->(:Batch)-[:REWORKED_INTO*0..3]->(:Batch)-[:PRODUCED]->(pl:ProductLot)
          -[s:SHIPPED_TO]->(:Store)<-[b:BOUGHT_AT]-(c)
WHERE s.shipped_at <= b.date AND (c.sku IS NULL OR pl.sku = c.sku)
RETURN c.id AS case_id, [n IN nodes(p) | coalesce(n.code, n.id)] AS path
ORDER BY case_id`; // not `case`: a reserved word in FalkorDB 6

// --- Case ingest (A6): additive, idempotent upserts into one cluster ---

export const ALL_STORES = 'MATCH (st:Store) RETURN st.id AS id, st.name AS name, st.city AS city';
export const CASE_CLUSTERS = 'MATCH (cl:Cluster)-[:HAS_CASE]->(c:Case) WHERE c.id IN $ids RETURN c.id AS id, cl.id AS cluster';
export const CLUSTER_GET = 'MATCH (cl:Cluster {id: $id}) RETURN cl.id AS id';
export const CLUSTER_MERGE = `
MERGE (cl:Cluster {id: $id})
ON CREATE SET cl.pathogen = $pathogen, cl.opened_at = $opened_at`;
/** A null sku removes the property, so `c.sku IS NULL` still means "any product". BOUGHT_AT is replaced, not added. */
export const CASES_UPSERT = `
UNWIND $rows AS r
MATCH (cl:Cluster {id: $cluster}), (st:Store {id: r.store})
MERGE (c:Case {id: r.id})
SET c.region = r.region, c.onset = r.onset, c.reported_at = r.reported_at, c.sku = r.sku
MERGE (cl)-[:HAS_CASE]->(c)
WITH c, r, st
OPTIONAL MATCH (c)-[old:BOUGHT_AT]->()
DELETE old
WITH DISTINCT c, r, st
CREATE (c)-[:BOUGHT_AT {date: r.bought_at}]->(st)`;

/** Same supplier and ingredient as the top lot but not among the ranked lots: the decoy the outbreak summary names. */
export const SAME_SOURCE_LOTS = `
MATCH (s:Supplier)-[:SUPPLIED]->(top:Lot {code: $lot}), (s)-[:SUPPLIED]->(l:Lot)
WHERE l.ingredient = top.ingredient AND l.code <> $lot AND NOT l.code IN $ranked
RETURN l.code AS lot ORDER BY lot`;

// --- Incident history (B5) ---

/** The first successful minimal_recall stamps scoped_at; reruns keep it. stores is the latest scope. */
export const INCIDENT_SCOPED = `
MATCH (i:Incident {lot: $lot})
SET i.scoped_at = coalesce(i.scoped_at, $at), i.stores = $stores`;
export const INCIDENTS = `
MATCH (i:Incident)-[:CONCERNS]->(l:Lot)<-[:SUPPLIED]-(s:Supplier)
WHERE $supplier IS NULL OR s.id = $supplier
RETURN i.id AS id, i.lot AS lot, i.hazard AS hazard, i.reported_at AS reported_at, i.class AS class,
       i.confirmed_class AS confirmed_class, i.scoped_at AS scoped_at, i.stores AS stores, s.id AS supplier_id, s.name AS supplier
ORDER BY reported_at DESC`;
export const SUPPLIER_GET = 'MATCH (s:Supplier {id: $id}) RETURN s.id AS id, s.name AS name';
