import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { streamSSE } from 'hono/streaming';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { query } from '../graph/db.js';
import { AFFECTED_SHIPMENTS, STORES, LOT_EXISTS } from '../graph/queries.js';
import { traceForward, coverageGaps, unaffectedStores, readNotices, writeNotices } from '../tools/index.js';
import { runAgent, type RecallResult } from '../agent/run.js';
import { incidentReport } from '../tools/incident.js';

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
function save(result: RecallResult) {
  mkdirSync('out', { recursive: true });
  writeFileSync(LAST, JSON.stringify(result));
}

app.post('/recall', async (c) => {
  const { lot } = await c.req.json<{ lot?: string }>();
  const bad = await checkLot(lot);
  if (bad) return c.json({ error: bad[1] }, bad[0] as 400);
  clearDrafts(lot!);
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
      clearDrafts(lot!);
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

/** The recall decision currently under review, so a page reload doesn't rerun the agent. */
app.get('/recall/last', (c) => {
  try { return c.json(JSON.parse(readFileSync(LAST, 'utf8'))); } catch { return c.json({ error: 'No recall traced yet' }, 404); }
});

/** Cytoscape elements: affected paths, gap stores (via their SKU), safe stores (via the clean lots they got). */
app.get('/graph/:lot', async (c) => {
  const lot = c.req.param('lot');
  if (!LOT_RE.test(lot)) return c.json({ error: 'bad lot' }, 400);
  const [trace, gaps, safe] = await Promise.all([traceForward({ lot }), coverageGaps({ lot }), unaffectedStores({ lot })]);
  const nodes = new Map<string, { id: string; kind: string }>();
  const edges = new Map<string, { id: string; source: string; target: string; kind: string }>();
  const node = (id: string, kind: string) => { if (!nodes.has(id)) nodes.set(id, { id, kind }); };
  const edge = (source: string, target: string, kind: string) => edges.set(`${source}>${target}`, { id: `${source}>${target}`, source, target, kind });

  node(lot, 'lot');
  for (const s of trace.stores) {
    for (const p of s.paths) {
      p.slice(1).forEach((id, i) => node(id, i === p.length - 2 ? 'store-affected' : id.startsWith('B-') ? 'batch' : 'product-lot'));
      p.slice(1).forEach((id, i) => edge(p[i], id, 'affected'));
    }
  }
  for (const g of gaps.gaps) { node(g.sku, 'product'); node(g.store, 'store-gap'); edge(g.sku, g.store, 'untracked'); }
  for (const s of safe.stores) {
    node(s.store, 'store-safe');
    for (const l of s.received_lots) { node(l.lot, 'product-lot-clean'); edge(l.lot, s.store, 'clean'); }
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

// Production: serve the built page from the same port (`pnpm build` first).
app.use('/*', serveStatic({ root: './web/dist' }));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: app.fetch, port }, () => console.log(`API on http://localhost:${port}`));
}
