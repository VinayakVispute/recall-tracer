import seedrandom from 'seedrandom';
import { writeFileSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { graph, query, close } from '../graph/db.js';
import { INDEXES, LOAD, COUNT_NODES, COUNT_EDGES } from '../graph/queries.js';

type Edge = { from: string; to: string } & Record<string, unknown>;

const BAD_LOT = 'L-204';
const LOT_CODES = ['L-101', 'L-108', 'L-117', 'L-122', 'L-131', 'L-143', 'L-156', 'L-162', 'L-178', 'L-189',
  'L-204', 'L-205', 'L-211', 'L-219', 'L-226', 'L-233', 'L-247', 'L-252', 'L-268', 'L-275'];
const INGREDIENTS = ['red lentils', 'tomato paste', 'yellow onion', 'celery', 'garlic', 'spinach', 'mushroom',
  'sweet corn', 'green peas', 'beetroot', 'basil', 'potato', 'chickpeas', 'ricotta', 'vegetable stock'];
const SUPPLIER_NAMES = ['Harlow Farms', 'Brookfield Produce', 'Valley Root Co.', 'Greenmeadow Growers',
  'Cedar Hill Dairy', 'Sunfield Grains', 'Riverbend Herbs', 'Oakline Foods'];
const PRODUCTS = ['Carrot & Lentil Soup', 'Garden Vegetable Stew', 'Carrot Baby Puree', 'Tomato Basil Sauce',
  'Mushroom Risotto Kit', 'Pea & Mint Soup', 'Spinach Ricotta Ravioli', 'Sweet Corn Chowder', 'Beet Hummus', 'Onion Relish'];
const SITES = [
  { id: 'PL-1', name: 'Northfield Plant 1', city: 'Columbus', region: 'OH' },
  { id: 'PL-2', name: 'Northfield Plant 2', city: 'Dayton', region: 'OH' },
];
const DCS = [
  { id: 'DC-01', name: 'Columbus DC', city: 'Columbus', region: 'OH' },
  { id: 'DC-02', name: 'Pittsburgh DC', city: 'Pittsburgh', region: 'PA' },
  { id: 'DC-03', name: 'Detroit DC', city: 'Detroit', region: 'MI' },
];
const CITIES: [string, string][] = [['Columbus', 'OH'], ['Cleveland', 'OH'], ['Cincinnati', 'OH'], ['Toledo', 'OH'],
  ['Pittsburgh', 'PA'], ['Erie', 'PA'], ['Detroit', 'MI'], ['Grand Rapids', 'MI'], ['Indianapolis', 'IN'], ['Louisville', 'KY']];
const CHAINS = ['FreshMart', 'GreenBasket', 'DailyGrocer'];
const SHELF_LIFE_DAYS = 21; // chilled ready-to-eat soups and sauces

// Planted case: which SKUs each affected batch produces (7 product lots).
const AFFECTED_OUTPUT: Record<string, string[]> = {
  'B-03': ['P-01', 'P-02'], 'B-05': ['P-01', 'P-03'], 'B-07': ['P-02', 'P-03'], 'B-09': ['P-01'],
};
// Clean batches that also make the affected SKUs (supply the safe stores).
const CLEAN_SAME_SKU: Record<string, string[]> = {
  'B-04': ['P-01', 'P-03'], 'B-06': ['P-02', 'P-01'], 'B-08': ['P-03', 'P-02'], 'B-10': ['P-01', 'P-02'],
};
const AFFECTED_SKUS = ['P-01', 'P-02', 'P-03'];
const GAP_SKU = 'P-02';

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const day = (base: string, add: number) => new Date(Date.parse(base) + add * 86_400_000).toISOString().slice(0, 10);
/** UPC-A: company prefix 041234, item number, check digit. */
const upc = (item: number) => {
  const d = `041234${pad(item, 5)}`.split('').map(Number);
  const sum = d.reduce((n, x, i) => n + x * (i % 2 ? 1 : 3), 0);
  return d.join('') + ((10 - (sum % 10)) % 10);
};

/** Pure: same seed → same graph. */
export function build(seed = 42) {
  const rng = seedrandom(String(seed));
  const int = (a: number, b: number) => a + Math.floor(rng() * (b - a + 1));
  const pick = <T>(xs: T[]) => xs[Math.floor(rng() * xs.length)];
  const shuffle = <T>(xs: T[]) => {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };

  const suppliers = SUPPLIER_NAMES.map((name, i) => ({ id: `S-${pad(i + 1)}`, name }));
  const lots = LOT_CODES.map((code) => {
    const carrot = code === 'L-204' || code === 'L-205';
    return {
      code,
      ingredient: carrot ? 'diced carrot' : pick(INGREDIENTS),
      received_at: day('2026-09-10', int(0, 18)),
      supplier_id: carrot ? 'S-03' : pick(suppliers).id,
      received_kg: 0, // set below: everything used plus what is still in the store room
    };
  });
  const batches = Array.from({ length: 15 }, (_, i) => {
    const s = pick(SITES);
    return { id: `B-${pad(i + 1)}`, produced_at: day('2026-10-01', Math.floor(i / 2)), site: `${s.name}, ${s.city} ${s.region}`, site_id: s.id };
  });
  const products = PRODUCTS.map((name, i) => ({ sku: `P-${pad(i + 1)}`, name, upc: upc(i + 1) }));
  const stores = Array.from({ length: 75 }, (_, i) => {
    const [city, region] = pick(CITIES);
    return { id: `ST-${pad(i + 1, 3)}`, name: `${pick(CHAINS)} #${pad(i + 1, 3)}`, city, region };
  });

  const supplied: Edge[] = lots.map((l) => ({ from: l.supplier_id, to: l.code }));

  // USED_IN: planted edges, then fill each batch to 2–3 lots with clean lots.
  const usedIn: Edge[] = [];
  const use = (lot: string, batch: string) => usedIn.push({ from: lot, to: batch, qty_kg: int(50, 400) });
  ['B-03', 'B-05', 'B-07'].forEach((b) => use(BAD_LOT, b));
  use('L-117', 'B-03'); // blend
  ['B-04', 'B-06'].forEach((b) => use('L-205', b)); // decoy
  const cleanLots = LOT_CODES.filter((c) => c !== 'L-204' && c !== 'L-205');
  for (const b of batches) {
    const want = int(2, 3);
    while (usedIn.filter((e) => e.to === b.id).length < want) {
      const lot = pick(cleanLots);
      if (!usedIn.some((e) => e.from === lot && e.to === b.id)) use(lot, b.id);
    }
  }
  // What is left of each lot sits in the store room of the plant that used it (hold target).
  const storedAt: Edge[] = lots.map((l) => {
    const used = usedIn.filter((e) => e.from === l.code).reduce((n, e) => n + (e.qty_kg as number), 0);
    const left = int(40, 250);
    l.received_kg = used + left;
    const site = batches.find((b) => usedIn.some((e) => e.from === l.code && e.to === b.id))?.site_id ?? 'PL-1';
    return { from: l.code, to: site, qty_kg: left };
  });

  const reworked: Edge[] = [
    { from: 'B-03', to: 'B-09', qty_kg: 40 }, // planted rework
    { from: 'B-02', to: 'B-12', qty_kg: 30 }, // clean rework, should not matter
  ];

  // Product lots
  const productLots: { id: string; sku: string; produced_at: string; best_by: string }[] = [];
  const produced: Edge[] = [];
  const of: Edge[] = [];
  const otherSkus = products.map((p) => p.sku).filter((s) => !AFFECTED_SKUS.includes(s));
  for (const b of batches) {
    const skus = AFFECTED_OUTPUT[b.id] ?? CLEAN_SAME_SKU[b.id] ?? shuffle(otherSkus).slice(0, b.id === 'B-15' ? 3 : 2);
    skus.forEach((sku, k) => {
      const id = `TLC-${b.id.slice(2)}${'ABC'[k]}`;
      productLots.push({ id, sku, produced_at: b.produced_at, best_by: day(b.produced_at, SHELF_LIFE_DAYS) });
      produced.push({ from: b.id, to: id, units: 0 }); // set below: shipped + still on hand
      of.push({ from: id, to: sku });
    });
  }
  const affectedLots = productLots.filter((pl) => produced.some((e) => e.to === pl.id && e.from in AFFECTED_OUTPUT)).map((pl) => pl.id);
  const cleanSameSku = productLots.filter((pl) => AFFECTED_SKUS.includes(pl.sku) && !affectedLots.includes(pl.id)).map((pl) => pl.id);
  const otherLots = productLots.filter((pl) => !AFFECTED_SKUS.includes(pl.sku)).map((pl) => pl.id);

  // Stores split into the planted groups.
  const order = shuffle(stores.map((s) => s.id));
  const affected = order.slice(0, 31), gaps = order.slice(31, 33), safe = order.slice(33, 71), untouched = order.slice(71);

  const shippedTo: Edge[] = [];
  const ship = (pl: string, st: string) => {
    if (!shippedTo.some((e) => e.from === pl && e.to === st))
      shippedTo.push({ from: pl, to: st, units: int(12, 120), shipped_at: day('2026-10-05', int(0, 9)) });
  };
  affected.forEach((st, i) => {
    ship(affectedLots[i % affectedLots.length], st);
    if (rng() < 0.25) ship(pick(affectedLots), st);
    if (rng() < 0.5) ship(pick(cleanSameSku), st);
  });
  safe.forEach((st) => { for (let k = int(1, 2); k > 0; k--) ship(pick(cleanSameSku), st); });
  order.forEach((st) => { for (let k = int(1, 2); k > 0; k--) ship(pick(otherLots), st); });

  const untracked: Edge[] = gaps.map((st) => ({ from: GAP_SKU, to: st, units: int(24, 96), shipped_at: day('2026-10-05', int(0, 9)) }));

  // Unshipped product sits at the plant that made it and at one DC; units made = shipped + on hand.
  const heldAt: Edge[] = [];
  for (const e of produced) {
    const shipped = shippedTo.filter((s) => s.from === e.to).reduce((n, s) => n + (s.units as number), 0);
    const plant = int(60, 240), dc = int(120, 420);
    e.units = shipped + plant + dc;
    heldAt.push({ from: e.to, to: batches.find((b) => b.id === e.from)!.site_id, units: plant });
    heldAt.push({ from: e.to, to: pick(DCS).id, units: dc });
  }

  const sort = (xs: string[]) => [...xs].sort();
  const affectedShipments = shippedTo.filter((e) => affectedLots.includes(e.from));
  const sum = (es: Edge[], k = 'units') => es.reduce((n, e) => n + (e[k] as number), 0);
  const nodes = suppliers.length + lots.length + batches.length + products.length + productLots.length + stores.length + SITES.length + DCS.length;
  const edges = [supplied, usedIn, storedAt, reworked, produced, of, shippedTo, untracked, heldAt].reduce((n, es) => n + es.length, 0);

  const expected = {
    seed, lot: BAD_LOT,
    batches: Object.keys(AFFECTED_OUTPUT).sort(),
    product_lots: sort(affectedLots),
    affected_stores: sort(affected), gap_stores: sort(gaps), safe_stores: sort(safe), untouched_stores: sort(untouched),
    counts: { batches: 4, product_lots: affectedLots.length, affected: 31, gaps: 2, safe: 38, blanket: 71, targeted: 33 },
    affected_shipments: affectedShipments.length,
    units_to_pull: sum(affectedShipments) + sum(untracked),
    hold: {
      raw_kg: storedAt.find((e) => e.from === BAD_LOT)!.qty_kg as number,
      units: sum(heldAt.filter((e) => affectedLots.includes(e.from))),
      locations: new Set([...heldAt.filter((e) => affectedLots.includes(e.from)).map((e) => e.to), storedAt.find((e) => e.from === BAD_LOT)!.to]).size,
    },
    nodes, edges,
  };

  return {
    nodes: { suppliers, lots, batches, products, productLots, stores, sites: SITES, dcs: DCS },
    edges: { supplied, usedIn, storedAt, reworked, produced, of, shippedTo, untracked, heldAt },
    expected,
  };
}

export async function load(data: ReturnType<typeof build>, reset = true) {
  const g = await graph();
  if (reset) await g.delete().catch(() => {}); // fails only if the graph does not exist yet
  for (const q of INDEXES) await g.query(q);
  const { nodes: n, edges: e } = data;
  const steps: [string, unknown[]][] = [
    [LOAD.suppliers, n.suppliers], [LOAD.lots, n.lots], [LOAD.batches, n.batches], [LOAD.products, n.products],
    [LOAD.productLots, n.productLots], [LOAD.stores, n.stores], [LOAD.sites, n.sites], [LOAD.dcs, n.dcs],
    [LOAD.supplied, e.supplied], [LOAD.usedIn, e.usedIn], [LOAD.storedAt, e.storedAt], [LOAD.reworked, e.reworked],
    [LOAD.produced, e.produced], [LOAD.of, e.of], [LOAD.shippedTo, e.shippedTo], [LOAD.untracked, e.untracked], [LOAD.heldAt, e.heldAt],
  ];
  for (const [q, rows] of steps) await g.query(q, { params: { rows } as never });
  const [{ n: nodeCount }] = await query<{ n: number }>(COUNT_NODES);
  const [{ n: edgeCount }] = await query<{ n: number }>(COUNT_EDGES);
  return { nodes: nodeCount, edges: edgeCount };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { seed: { type: 'string', default: '42' }, reset: { type: 'boolean', default: false } } });
  const data = build(Number(values.seed));
  const counts = await load(data, values.reset);
  mkdirSync('data', { recursive: true });
  writeFileSync('data/expected.json', JSON.stringify(data.expected, null, 2) + '\n');
  console.log(`Loaded graph "recall": ${counts.nodes} nodes, ${counts.edges} edges (expected ${data.expected.nodes}/${data.expected.edges})`);
  await close();
}
