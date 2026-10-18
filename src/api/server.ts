import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createMcpHandler } from 'mcp-handler';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import type { Context } from 'hono';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { query } from '../graph/db.js';
import { AFFECTED_SHIPMENTS, STORES, LOT_EXISTS, INCIDENT_DELETE, INCIDENT_CREATE, INCIDENT_CONFIRM, CLUSTER_CASES, CLUSTER_DETAIL, COUNT_NODES, COUNT_EDGES, GRAPH_LABELS } from '../graph/queries.js';
import { traceForward, coverageGaps, unaffectedStores, traceBackward, readHold, readNotices, clearNotices, approveNotices, incidentId, RECALL_CLASSES, RECALL_DEPTHS } from '../tools/index.js';
import { createAgentUIStreamResponse, type UIMessage } from 'ai';
import { getRecallAgent, runAgent, runOutbreak } from '../agent/ai-agent.js';
import type { RecallResult, TraceEvent } from '../agent/run.js';
import { answer, listen, unlisten } from '../agent/questions.js';
import { incidentReport, incidentStatus, listIncidents, supplierIncidents } from '../tools/incident.js';
import { ingestCases, CASE_ID } from '../data/cases.js';
import { realOutbreaks, realGraph, runDemoQueries, checkCaseReport } from '../data/real.js';
import { recordSources } from '../data/sources.js';
import { registerTools } from '../mcp/tools.js';

const LOT_RE = /^L-\d{1,6}$/;
const LAST = process.env.RECALL_GRAPH ? 'out/test-last-recall.json' : 'out/last-recall.json';

export const app = new Hono();

app.onError((err, c) => {
  console.error(err);
  const code = (err as { code?: string }).code;
  const message = code === 'ECONNREFUSED' ? 'Cannot reach FalkorDB. Is the database container running?' : err.message || 'Internal error';
  return c.json({ error: message }, 500);
});

/**
 * Caps live agent runs, since every one spends Claude credits on a public URL: a few per visitor per hour and a total
 * per day. Over the cap the route answers with a message pointing at the recorded run, which never calls Claude.
 */
const PER_IP_HOUR = Number(process.env.AGENT_RUNS_PER_IP_HOUR ?? 10);
const PER_DAY = Number(process.env.AGENT_RUNS_PER_DAY ?? 100);
export const LIMITED = 'Demo limit reached for live agent runs. Watch the recorded run instead: /incident/L-204?replay=1';
const runs = new Map<string, number[]>();
let today = '', todayCount = 0;
// ponytail: in-memory, so it resets on restart and only covers one instance; the header can be spoofed, the daily cap can't.
export function overLimit(c: Context) {
  const ip = (c.req.header('x-forwarded-for') ?? '').split(',')[0].trim() || 'local';
  const now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
  if (day !== today) { today = day; todayCount = 0; runs.clear(); }
  const recent = (runs.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= PER_IP_HOUR || todayCount >= PER_DAY) return true;
  runs.set(ip, [...recent, now]); todayCount++;
  return false;
}
/** The limit as the stream's error event, so the page shows the message instead of "lost connection". */
const limitedSSE = (c: Context) => streamSSE(c, (s) => s.writeSSE({ event: 'error', data: JSON.stringify({ type: 'error', message: LIMITED }) }));

/** Validates the lot and checks it exists, so bad input never spends a Claude call. Returns an error message or null. */
async function checkLot(lot?: string): Promise<[number, string] | null> {
  if (!lot || !LOT_RE.test(lot)) return [400, 'Enter a lot code like L-204.'];
  const [{ n }] = await query<{ n: number }>(LOT_EXISTS, { lot });
  return n ? null : [404, `No lot ${lot} in the traceability records. Check the code on the supplier's alert.`];
}
/** A new trace supersedes earlier drafts for the same lot, so stale notices never show as this run's. */
const clearDrafts = clearNotices;
/** Opens (or reopens) the incident in the graph: the supplier's hazard and the time the notice was logged. */
export async function openIncident(lot: string, hazard?: string) {
  const reported_at = new Date().toISOString();
  await query(INCIDENT_DELETE, { lot });
  await query(INCIDENT_CREATE, { lot, id: incidentId(lot), hazard: (hazard ?? '').trim().slice(0, 200) || 'Contamination, type not stated on the notice', reported_at });
  await clearDrafts(lot);
}
function save(result: RecallResult) {
  mkdirSync('out', { recursive: true });
  writeFileSync(LAST, JSON.stringify(result));
}

app.post('/recall', async (c) => {
  const { lot, hazard } = await c.req.json<{ lot?: string; hazard?: string }>();
  const bad = await checkLot(lot);
  if (bad) return c.json({ error: bad[1] }, bad[0] as 400);
  if (overLimit(c)) return c.json({ error: LIMITED }, 429);
  await openIncident(lot!, hazard);
  const result = await runAgent(lot!);
  save(result);
  return c.json(result);
});

/**
 * Streams one agent run as Server-Sent Events: `event: <type>`, `data: JSON(event)`, in order.
 * A thrown error becomes a final `error` event after every queued write.
 */
function traceSSE(c: Context, run: (send: (e: { type: string }) => void, stream: SSEStreamingApi) => Promise<void>) {
  return streamSSE(c, async (stream) => {
    let writes = Promise.resolve(); // keep events in order and flushed before the stream closes
    const send = (e: { type: string }) => (writes = writes.then(() => stream.writeSSE({ event: e.type, data: JSON.stringify(e) })));
    try {
      await run(send, stream);
      await writes;
    } catch (e) {
      await writes;
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ type: 'error', message: (e as Error).message }) });
    }
  });
}

/** B2. A recorded run: t_ms is time since the start event. Only complete runs (start ... done) are written. */
type Recording = { lot: string; recorded_at: string; events: { t_ms: number; event: TraceEvent }[] };
const runFile = (dir: string, lot: string) => `${dir}/run-${lot}.json`;

function record(lot: string, events: Recording['events']) {
  mkdirSync('out', { recursive: true });
  const file = runFile('out', lot);
  writeFileSync(`${file}.tmp`, JSON.stringify({ lot, recorded_at: new Date().toISOString(), events } satisfies Recording));
  renameSync(`${file}.tmp`, file); // a concurrent replay never reads half a file
}
/** Curated demo/ recordings win over the latest live run in out/. A file that isn't a complete, ordered run is skipped. */
function readRecording(lot: string): Recording | null {
  for (const dir of ['demo', 'out']) {
    try {
      const r = JSON.parse(readFileSync(runFile(dir, lot), 'utf8')) as Recording;
      const ev = r.events;
      if (ev[0]?.event.type === 'start' && ev.at(-1)?.event.type === 'done' && ev.every((e, i) => !i || e.t_ms >= ev[i - 1].t_ms)) return r;
    } catch { /* missing or unreadable: try the next dir */ }
  }
  return null;
}

/** Same as POST /recall, but streams each agent step so the dashboard fills in live. Also records the run for replay. */
app.get('/recall/stream', async (c) => {
  const lot = c.req.query('lot');
  const bad = await checkLot(lot);
  if (bad) return c.json({ error: bad[1] }, bad[0] as 400);
  if (overLimit(c)) return limitedSSE(c);
  return traceSSE(c, async (send) => {
    const t0 = Date.now(), events: Recording['events'] = [];
    await openIncident(lot!, c.req.query('hazard'));
    listen(lot!); // the coordinator is watching this run, so ask_coordinator waits for their answer
    const result = await runAgent(lot!, (e) => { events.push({ t_ms: Date.now() - t0, event: e }); send(e); }).finally(() => unlisten(lot!));
    save(result);
    record(lot!, events);
  });
});

/**
 * Replays a recorded run with its original timing (divided by speed). No Claude key and no database needed.
 * `format=json` returns the whole recording at once instead, for the dashboard's replay timeline (Dev D).
 */
app.get('/recall/replay', async (c) => {
  const lot = c.req.query('lot'), speed = Number(c.req.query('speed') ?? 1);
  if (!lot || !LOT_RE.test(lot)) return c.json({ error: 'Enter a lot code like L-204.' }, 400);
  const rec = readRecording(lot);
  if (c.req.query('format') === 'json') return rec ? c.json(rec) : c.json({ error: `No recorded run for ${lot}` }, 404);
  if (!(speed > 0 && speed <= 20)) return c.json({ error: 'speed must be above 0 and at most 20' }, 400);
  if (!rec) return c.json({ error: `No recorded run for ${lot}` }, 404);
  return traceSSE(c, async (send, stream) => {
    for (const [i, { t_ms, event }] of rec.events.entries()) {
      if (stream.aborted) return;
      if (i) await stream.sleep((t_ms - rec.events[i - 1].t_ms) / speed);
      send(event);
    }
  });
});

/** checkLot's sibling for outbreak clusters: 400 bad id, 404 no cases. */
async function checkCluster(cluster?: string): Promise<[number, string] | null> {
  if (!cluster || !CASE_ID.test(cluster)) return [400, 'Enter a cluster id like OB-2026-10.'];
  const cases = await query(CLUSTER_CASES, { cluster });
  return cases.length ? null : [404, `No cases in cluster ${cluster}. Paste the case list first.`];
}

/** A6. Paste or upload a case list into a cluster. Rejected rows are data (200), not an error. No Claude call. */
app.post('/ingest/cases', async (c) => {
  const { cluster, pathogen, text } = await c.req.json<{ cluster?: string; pathogen?: string; text?: string }>();
  if (!cluster || !CASE_ID.test(cluster)) return c.json({ error: 'Enter a cluster id like OB-2026-10.' }, 400);
  if (!text?.trim()) return c.json({ error: 'Paste at least one case.' }, 400);
  try {
    return c.json(await ingestCases(cluster, text, pathogen));
  } catch (e) {
    if ((e as { status?: number }).status === 400) return c.json({ error: (e as Error).message }, 400);
    throw e;
  }
});

/** A cluster and its cases, for Page 1's table. No Claude call. */
app.get('/clusters/:id', async (c) => {
  const id = c.req.param('id');
  if (!CASE_ID.test(id)) return c.json({ error: 'Enter a cluster id like OB-2026-10.' }, 400);
  type Row = { pathogen: string; opened_at: string; id: string; region: string; onset: string; reported_at: string; sku: string | null; product: string | null; store: string; store_name: string; city: string; bought_at: string };
  const rows = await query<Row>(CLUSTER_DETAIL, { cluster: id });
  if (!rows.length) return c.json({ error: `No cases in cluster ${id}. Paste the case list first.` }, 404);
  const { pathogen, opened_at } = rows[0];
  return c.json({ id, pathogen, opened_at, cases: rows.map(({ pathogen: _p, opened_at: _o, ...r }) => r) });
});

/** B4. Finds the common source of a cluster. Validated before any Claude call. */
app.post('/outbreak', async (c) => {
  const { cluster } = await c.req.json<{ cluster?: string }>();
  const bad = await checkCluster(cluster);
  if (bad) return c.json({ error: bad[1] }, bad[0] as 400);
  if (overLimit(c)) return c.json({ error: LIMITED }, 429);
  return c.json(await runOutbreak(cluster!));
});

/** Same as POST /outbreak, streamed: start{cluster}, notes and tool calls, then done{outbreak}. */
app.get('/outbreak/stream', async (c) => {
  const cluster = c.req.query('cluster');
  const bad = await checkCluster(cluster);
  if (bad) return c.json({ error: bad[1] }, bad[0] as 400);
  if (overLimit(c)) return limitedSSE(c);
  return traceSSE(c, async (send) => { await runOutbreak(cluster!, send); });
});

/** B5. Every incident with its time to scope, newest first. */
app.get('/incidents', async (c) => c.json(await listIncidents()));

/** Real CDC outbreaks joined to their firm's openFDA recalls, from the separate "fda" graph (`bun run real`). */
app.get('/real/outbreaks', async (c) => c.json(await realOutbreaks()));
/** The outbreak's neighbourhood as a record network, and the demo queries run live with FalkorDB's time. */
app.get('/real/graph', async (c) => c.json(await realGraph()));
app.get('/real/queries', async (c) => c.json(await runDemoQueries()));
/** A public case report (states and illness dates) checked against the real recalls: the lot they share, and who it reached. No Claude call. */
app.post('/real/case-report', async (c) => {
  const { text } = await c.req.json<{ text?: string }>();
  if (!text?.trim()) return c.json({ error: 'Upload or paste a case report first.' }, 400);
  try {
    return c.json(await checkCaseReport(text));
  } catch (e) {
    if ((e as { status?: number }).status === 400) return c.json({ error: (e as Error).message }, 400);
    throw e;
  }
});

app.get('/incidents/supplier/:id', async (c) => {
  const id = c.req.param('id');
  if (!/^S-\d{1,4}$/.test(id)) return c.json({ error: 'Enter a supplier id like S-03.' }, 400);
  const r = await supplierIncidents(id);
  return r ? c.json(r) : c.json({ error: `No supplier ${id}` }, 404);
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

/** The coordinator answers the question the agent is waiting on (ask_coordinator) during a live run. */
app.post('/incident/:lot/answer', async (c) => {
  const { choice } = await c.req.json<{ choice?: string }>();
  if (!choice) return c.json({ error: 'choice is required' }, 400);
  if (!answer(c.req.param('lot'), choice)) return c.json({ error: 'The agent is not waiting for an answer on this lot' }, 409);
  return c.json({ ok: true });
});

/** The shell's graph line: graph size, and FalkorDB's own average time per query over the last run. No Claude call. */
/** The Records page: where each set of records came from, how many, and when loaded. Read-only, no Claude call. */
app.get('/records', async (c) => c.json(await recordSources()));

app.get('/stats', async (c) => {
  const [[{ n: nodes }], [{ n: edges }]] = await Promise.all([query<{ n: number }>(COUNT_NODES), query<{ n: number }>(COUNT_EDGES)]);
  let last_run: { lot: string; queries: number; db_ms: number; avg_db_ms: number } | null = null;
  try {
    const r = JSON.parse(readFileSync(LAST, 'utf8')) as RecallResult;
    const queries = r.tool_calls.reduce((n, t) => n + (t.queries ?? 0), 0);
    const ms = r.tool_calls.reduce((n, t) => n + (t.db_ms ?? 0), 0);
    // db_ms is the run's total FalkorDB time, the same figure the investigation log's header shows.
    if (queries) last_run = { lot: r.lot, queries, db_ms: Math.round(ms * 10) / 10, avg_db_ms: Math.round((ms / queries) * 10) / 10 };
  } catch { /* no run yet */ }
  return c.json({ graph: 'recall', nodes, edges, last_run });
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
  type N = { id: string; kind: string; stage: string; depth: number; label?: string; sub?: string };
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
  type L = { id: string; name?: string; city?: string; region?: string; site?: string; product?: string; ingredient?: string; supplier?: string };
  for (const r of await query<L>(GRAPH_LABELS, { ids: [...nodes.keys()] })) {
    const n = nodes.get(r.id)!;
    if (r.city) [n.label, n.sub] = [r.name, `${r.city}, ${r.region}`];
    else if (r.product) [n.label, n.sub] = [r.product, r.id];
    else if (r.site) n.sub = r.site.split(',')[0];
    else if (r.ingredient) [n.label, n.sub] = [`${r.id} ${r.ingredient}`, r.supplier];
  }
  return c.json({
    nodes: [...nodes.values()].map((data) => ({ data })),
    edges: [...edges.values()].map((data) => ({ data })),
  });
});

app.get('/notices', async (c) => c.json(await readNotices()));

app.post('/notices/approve', async (c) => {
  const { stores } = await c.req.json<{ stores?: string[] }>();
  if (!Array.isArray(stores)) return c.json({ error: 'stores must be an array' }, 400);
  return c.json({ approved: await approveNotices(stores) }); // a status change on the Notice nodes; nothing is sent
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

/** The same tools as the stdio server, over Streamable HTTP for remote MCP clients. */
const mcp = createMcpHandler(registerTools, { serverInfo: { name: 'recall-tracer', version: '0.1.0' } });
app.all('/mcp', (c) => mcp(c.req.raw));

const CHAT_MAX_MESSAGES = 10, CHAT_MAX_CHARS = 2000;
/** Chat with the recall agent: useChat sends its UI messages here, and tool-approval replies come back the same way. */
app.post('/chat', async (c) => {
  const { messages } = await c.req.json<{ messages: UIMessage[] }>();
  if (!Array.isArray(messages) || !messages.length) return c.text('No messages.', 400);
  const text = (m: UIMessage) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
  if (messages.some((m) => m.role === 'user' && text(m).length > CHAT_MAX_CHARS)) return c.text(`Keep each message under ${CHAT_MAX_CHARS} characters.`, 413);
  if (overLimit(c)) return c.text(LIMITED, 429);
  // Only the recent turns go to Claude, starting at a user message, so a long chat can't grow the bill per reply.
  const recent = messages.slice(-CHAT_MAX_MESSAGES);
  const from = recent.findIndex((m) => m.role === 'user');
  return createAgentUIStreamResponse({ agent: await getRecallAgent(), uiMessages: from < 0 ? recent : recent.slice(from), abortSignal: c.req.raw.signal });
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: app.fetch, port }, () => console.log(`API on http://localhost:${port}`));
}
