import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { streamSSE } from 'hono/streaming';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { query } from '../graph/db.js';
import { AFFECTED_SHIPMENTS, STORES, LOT_EXISTS, INCIDENT_DELETE, INCIDENT_CREATE, INCIDENT_CONFIRM } from '../graph/queries.js';
import { traceForward, coverageGaps, unaffectedStores, traceBackward, readHold, readNotices, writeNotices, incidentId, RECALL_CLASSES, RECALL_DEPTHS } from '../tools/index.js';
import { runAgent, type RecallResult } from '../agent/run.js';
import { incidentReport, incidentStatus } from '../tools/incident.js';

const LOT_RE = /^L-\d{1,6}$/;
const LAST = process.env.NOTICES_FILE ? 'out/test-last-recall.json' : 'out/last-recall.json';

export const app = new Hono();

app.onError((err, c) => {
  console.error(err);
  const code = (err as { code?: string }).code;
  const message = code === 'ECONNREFUSED' ? 'Cannot reach FalkorDB. Is the database container running?' : err.message || 'Internal error';
  return c.json({ error: message }, 500);
});

/** Validates the lot and checks it exists, so bad input never spends a Claude call. Returns an error message or null. */
async function checkLot(lot?: string): Promise<[number, string] | null> {
  if (!lot || !LOT_RE.test(lot)) return [400, 'Enter a lot code like L-204.'];
  const [{ n }] = await query<{ n: number }>(LOT_EXISTS, { lot });
  return n ? null : [404, `No lot ${lot} in the traceability records. Check the code on the supplier's alert.`];
}
/** A new trace supersedes earlier drafts for the same lot, so stale notices never show as this run's. */
function clearDrafts(lot: string) {
  writeNotices(readNotices().filter((n) => n.lot !== lot));
}
/** Opens (or reopens) the incident in the graph: the supplier's hazard and the time the notice was logged. */
export async function openIncident(lot: string, hazard?: string) {
  const reported_at = new Date().toISOString();
  await query(INCIDENT_DELETE, { lot });
  await query(INCIDENT_CREATE, { lot, id: incidentId(lot), hazard: (hazard ?? '').trim().slice(0, 200) || 'Contamination, type not stated on the notice', reported_at });
  clearDrafts(lot);
}
function save(result: RecallResult) {
  mkdirSync('out', { recursive: true });
  writeFileSync(LAST, JSON.stringify(result));
}

app.post('/recall', async (c) => {
  const { lot, hazard } = await c.req.json<{ lot?: string; hazard?: string }>();
  const bad = await checkLot(lot);
  if (bad) return c.json({ error: bad[1] }, bad[0] as 400);
  await openIncident(lot!, hazard);
  const result = await runAgent(lot!);
  save(result);
  return c.json(result);
});

/** Same as POST /recall, but streams each agent step (Server-Sent Events) so the dashboard fills in live. */
app.get('/recall/stream', async (c) => {
  const lot = c.req.query('lot');
  const bad = await checkLot(lot);
  if (bad) return c.json({ error: bad[1] }, bad[0] as 400);
  return streamSSE(c, async (stream) => {
    let writes = Promise.resolve(); // keep events in order and flushed before the stream closes
    const send = (e: { type: string }) => (writes = writes.then(() => stream.writeSSE({ event: e.type, data: JSON.stringify(e) })));
    try {
      await openIncident(lot!, c.req.query('hazard'));
      const result = await runAgent(lot!, send);
      save(result);
      await writes;
    } catch (e) {
      await writes;
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ type: 'error', message: (e as Error).message }) });
    }
  });
});

/** Everything the dashboard draws, straight from the graph. No Claude call. */
app.get('/incident/:lot', async (c) => {
  const lot = c.req.param('lot');
  const bad = await checkLot(lot);
  if (bad) return c.json({ error: bad[1] }, bad[0] as 400);
  return c.json(await incidentReport(lot, c.req.query('gaps') !== 'flag'));
});

/** Incident node plus the hold: light enough to refresh while the agent runs. */
app.get('/incident/:lot/status', async (c) => {
  const lot = c.req.param('lot');
  const bad = await checkLot(lot);
  if (bad) return c.json({ error: bad[1] }, bad[0] as 400);
  return c.json(await incidentStatus(lot));
});

/** The coordinator confirms (or changes) the agent's proposed class and depth. Notices can be approved only after this. */
app.post('/incident/:lot/confirm', async (c) => {
  const lot = c.req.param('lot');
  const bad = await checkLot(lot);
  if (bad) return c.json({ error: bad[1] }, bad[0] as 400);
  const { class: cls, depth } = await c.req.json<{ class?: string; depth?: string }>();
  if (!RECALL_CLASSES.includes(cls as never) || !RECALL_DEPTHS.includes(depth as never)) return c.json({ error: 'class must be I, II or III and depth consumer, retail or wholesale' }, 400);
  const [row] = await query<{ id: string }>(INCIDENT_CONFIRM, { lot, class: cls, depth, at: new Date().toISOString() });
  if (!row) return c.json({ error: 'No open incident for this lot' }, 404);
  return c.json(await incidentStatus(lot));
});

/** The recall decision currently under review, so a page reload doesn't rerun the agent. */
app.get('/recall/last', (c) => {
  try { return c.json(JSON.parse(readFileSync(LAST, 'utf8'))); } catch { return c.json({ error: 'No recall traced yet' }, 404); }
});

/**
 * Cytoscape elements for the live trace. Each element carries the agent step that reveals it
 * (`stage`) and, for the forward trace, its hop count from the lot (`depth`) so the page can animate the spread.
 */
app.get('/graph/:lot', async (c) => {
  const lot = c.req.param('lot');
  if (!LOT_RE.test(lot)) return c.json({ error: 'bad lot' }, 400);
  const [trace, gaps, safe, hold] = await Promise.all([traceForward({ lot }), coverageGaps({ lot }), unaffectedStores({ lot }), readHold(lot)]);
  type N = { id: string; kind: string; stage: string; depth: number; label?: string };
  const nodes = new Map<string, N>();
  const edges = new Map<string, { id: string; source: string; target: string; kind: string; stage: string; depth: number }>();
  const node = (id: string, kind: string, stage: string, depth = 0, label?: string) => {
    const n = nodes.get(id);
    if (!n) nodes.set(id, { id, kind, stage, depth, label });
    else if (depth < n.depth) n.depth = depth;
  };
  const edge = (source: string, target: string, kind: string, stage: string, depth = 0) =>
    edges.set(`${source}>${target}`, { id: `${source}>${target}`, source, target, kind, stage, depth });

  node(lot, 'lot', 'start');
  for (const r of hold.raw) node(r.id, 'site', 'place_hold', 1, r.name), edge(lot, r.id, 'held', 'place_hold', 1);
  for (const h of hold.finished) {
    node(h.product_lot, 'product-lot', 'trace_forward', 3);
    node(h.id, h.kind === 'DC' ? 'dc' : 'site', 'place_hold', 1, h.name);
    edge(h.product_lot, h.id, 'held', 'place_hold', 1);
  }
  for (const s of trace.stores) {
    for (const p of s.paths) {
      p.slice(1).forEach((id, i) => node(id, i === p.length - 2 ? 'store-affected' : id.startsWith('B-') ? 'batch' : 'product-lot', 'trace_forward', i + 1));
      p.slice(1).forEach((id, i) => edge(p[i], id, 'affected', 'trace_forward', i + 1));
    }
  }
  for (const g of gaps.gaps) { node(g.sku, 'product', 'coverage_gaps', 3, g.product); node(g.store, 'store-gap', 'coverage_gaps', 4); edge(g.sku, g.store, 'untracked', 'coverage_gaps', 4); }
  const cleanLots = new Set<string>();
  for (const s of safe.stores) {
    node(s.store, 'store-safe', 'minimal_recall', 4);
    for (const l of s.received_lots) { cleanLots.add(l.lot); node(l.lot, 'product-lot-clean', 'minimal_recall', 3); edge(l.lot, s.store, 'clean', 'minimal_recall', 4); }
  }
  // Backward check: the ingredient lots behind every lot a cleared store holds (batches skipped to keep the picture readable).
  const back = await traceBackward({ product_lots: [...cleanLots], lot });
  for (const r of back.results) for (const l of r.ingredient_lots) {
    node(l, l === lot ? 'lot' : 'lot-clean', 'trace_backward', 0);
    edge(l, r.product_lot, 'origin', 'trace_backward', 1);
  }
  return c.json({
    nodes: [...nodes.values()].map((data) => ({ data })),
    edges: [...edges.values()].map((data) => ({ data })),
  });
});

app.get('/notices', (c) => c.json(readNotices()));

app.post('/notices/approve', async (c) => {
  const { stores } = await c.req.json<{ stores?: string[] }>();
  if (!Array.isArray(stores)) return c.json({ error: 'stores must be an array' }, 400);
  const pick = new Set(stores);
  const notices = readNotices().map((n) => (pick.has(n.store) ? { ...n, status: 'approved' as const } : n));
  writeNotices(notices); // approval is a status change only; nothing is sent
  return c.json({ approved: notices.filter((n) => pick.has(n.store)).length });
});

const COLUMNS = [
  'Traceability Lot Code', 'Quantity', 'Unit of Measure', 'Product Description (Product Name)',
  'Location Description for the Immediate Subsequent Recipient (Business Name)',
  'Location Description for the Immediate Subsequent Recipient (City)',
  'Location Description for the Immediate Subsequent Recipient (State or Region)',
  'Location Description for the Location from which you Shipped the Food',
  'Shipping Date (mm/dd/yyyy)',
  'Location Description for the Traceability Lot Code Source (Business Name)',
  'Reference Document Type', 'Reference Document Number',
];
const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const usDate = (iso: string) => { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; };

export async function exportCsv(lot: string) {
  type Row = { tlc: string; product: string; units: number; shipped_at: string; store: string; store_name: string; city: string; region: string; site: string };
  const [rows, gaps] = await Promise.all([query<Row>(AFFECTED_SHIPMENTS, { lot }), coverageGaps({ lot })]);
  const stores = await query<{ id: string; name: string; city: string; region: string }>(STORES, { ids: gaps.gaps.map((g) => g.store) });
  const names = new Map(stores.map((s) => [s.id, s]));
  const lines = [
    ...rows.map((r) => [r.tlc, r.units, 'cases', r.product, r.store_name, r.city, r.region, r.site, usDate(r.shipped_at), r.site, 'Bill of Lading', `BOL-${r.tlc}-${r.store}`]),
    ...gaps.gaps.map((g) => {
      const s = names.get(g.store);
      return ['', g.units, 'cases', g.product, s?.name ?? g.store, s?.city, s?.region, 'Unknown: lot code not recorded', usDate(g.shipped_at), 'Not recorded', 'Bill of Lading', `BOL-UNTRACKED-${g.sku}-${g.store}`];
    }),
  ];
  return [COLUMNS, ...lines].map((l) => l.map(csvCell).join(',')).join('\n') + '\n';
}

app.get('/export/:file', async (c) => {
  const lot = c.req.param('file').replace(/\.csv$/, '');
  if (!LOT_RE.test(lot)) return c.json({ error: 'bad lot' }, 400);
  c.header('Content-Type', 'text/csv');
  c.header('Content-Disposition', `attachment; filename="recall-${lot}-shipping.csv"`);
  return c.body(await exportCsv(lot));
});

// Production: serve the built page from the same port (`bun run build` first).
app.use('/*', serveStatic({ root: './web/dist' }));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: app.fetch, port }, () => console.log(`API on http://localhost:${port}`));
}
