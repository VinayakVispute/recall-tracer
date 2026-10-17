import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { build, load } from '../src/data/generate.js';
import { close } from '../src/graph/db.js';
import { scopeRecall, schemas, traceForward, coverageGaps, unaffectedStores, minimalRecall, draftRecallNotice, readNotices, NOTICES_FILE, traceBackward, placeHold, readHold, proposeClassification, findCommonSource, casePath, rankChokepoints, recallMemory, recordLessons } from '../src/tools/index.js';
import { incidentStatus, listIncidents, summarizeIncident } from '../src/tools/incident.js';
import { parseCases, formatCases, ingestCases } from '../src/data/cases.js';
import { writeFileSync } from 'node:fs';
import { query, measure } from '../src/graph/db.js';
import { incidentReport } from '../src/tools/incident.js';
import expected from '../data/expected.json';

const LOT = 'L-204';
let loaded: { nodes: number; edges: number };

beforeAll(async () => { loaded = await load(build(42)); });
afterAll(async () => {
  await (await import('../src/agent/ai-agent.js')).closeAiAgent();
  await close();
});

describe('generator', () => {
  it('same seed gives the same graph', async () => {
    expect(build(42)).toEqual(build(42));
    expect(build(42).expected).toEqual(expected);
    expect(loaded).toEqual({ nodes: expected.nodes, edges: expected.edges });
    expect(await load(build(42))).toEqual(loaded); // second load, identical counts
  });
});

describe('tools on L-204', () => {
  it('trace_forward: 4 batches, 7 product lots, 31 stores', async () => {
    const t = await traceForward({ lot: LOT });
    expect(t.batches).toEqual(expected.batches);
    expect(t.product_lots).toEqual(expected.product_lots);
    expect(t.stores.map((s) => s.store)).toEqual(expected.affected_stores);
  });

  it('rework B-09 is traced; decoy L-205 is not', async () => {
    const t = await traceForward({ lot: LOT });
    expect(t.batches).toContain('B-09');
    const ids = t.stores.flatMap((s) => s.paths.flat());
    expect(ids).not.toContain('L-205');
    expect(ids.filter((id) => ['B-04', 'B-06'].includes(id))).toEqual([]); // L-205's batches
    expect((await traceForward({ lot: 'L-205' })).batches).toEqual(['B-04', 'B-06']);
  });

  it('coverage_gaps: exactly the 2 planted gap stores', async () => {
    const g = await coverageGaps({ lot: LOT });
    expect(g.gaps.map((x) => x.store).sort()).toEqual(expected.gap_stores);
  });

  it('unaffected_stores: 38 stores, none in the recall, each with proof', async () => {
    const u = await unaffectedStores({ lot: LOT });
    const ids = u.stores.map((s) => s.store);
    expect(ids).toEqual(expected.safe_stores);
    const recall = new Set([...expected.affected_stores, ...expected.gap_stores]);
    expect(ids.filter((s) => recall.has(s))).toEqual([]);
    expect(u.stores.every((s) => s.received_lots.length > 0 && s.received_lots.every((l) => !l.reachable_from_bad_lot))).toBe(true);
  });

  it('minimal_recall: blanket 71, targeted 33, safe 38', async () => {
    const m = await minimalRecall({ lot: LOT });
    expect(m.counts).toMatchObject({ blanket: 71, targeted: 33, safe: 38 });
    expect(m.units_to_pull).toBe(expected.units_to_pull);
    expect(expected.untouched_stores.some((s) => m.recall_stores.some((r) => r.store === s))).toBe(false);
  });

  it('minimal_recall with add_gap_stores=false flags gaps only', async () => {
    const m = await minimalRecall({ lot: LOT, add_gap_stores: false });
    expect(m.counts).toMatchObject({ targeted: 31, gaps: 2, safe: 38 });
  });

  it('trace_backward: only the 7 affected product lots contain L-204 (independent of trace_forward)', async () => {
    const u = await unaffectedStores({ lot: LOT });
    const safeLots = [...new Set(u.stores.flatMap((s) => s.received_lots.map((l) => l.lot)))];
    expect((await traceBackward({ product_lots: safeLots, lot: LOT })).containing).toEqual([]);
    const b = await traceBackward({ product_lots: expected.product_lots, lot: LOT });
    expect(b.containing).toEqual(expected.product_lots);
    expect(b.results.find((r) => r.product_lot === 'TLC-09A')!.ingredient_lots).toContain('L-204'); // via rework
  });

  it('place_hold: unused raw lot at the plant plus unshipped units at plants and DCs; made = shipped + held', async () => {
    const h = await placeHold({ lot: LOT });
    expect(h.totals).toEqual(expected.hold);
    expect(h.raw).toHaveLength(1);
    expect(h.finished.every((f) => expected.product_lots.includes(f.product_lot))).toBe(true);
    expect((await readHold(LOT)).totals).toEqual(expected.hold);
    const rows = await query<{ id: string; made: number; shipped: number; held: number }>(`
      MATCH (:Batch)-[p:PRODUCED]->(pl:ProductLot)
      OPTIONAL MATCH (pl)-[s:SHIPPED_TO]->(:Store)
      WITH pl, p.units AS made, sum(s.units) AS shipped
      OPTIONAL MATCH (pl)-[h:HELD_AT]->()
      RETURN pl.id AS id, made, shipped, sum(h.units) AS held`);
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.every((r) => r.made === r.shipped + r.held)).toBe(true);
    const [{ n }] = await query<{ n: number }>('MATCH ()-[h:HELD_AT {held_for: $lot}]->() RETURN count(h) AS n', { lot: LOT });
    expect(n).toBe(h.finished.length); // the hold is written to the graph
  });

  it('incident: open, agent proposes a class, coordinator confirms', async () => {
    const { openIncident, app } = await import('../src/api/server.js');
    await openIncident(LOT, 'Listeria monocytogenes in supplier testing');
    let s = await incidentStatus(LOT);
    expect(s.incident).toMatchObject({ hazard: 'Listeria monocytogenes in supplier testing', class: null, confirmed_at: null });
    const p = await proposeClassification({ lot: LOT, class: 'I', depth: 'consumer', rationale: 'Listeria in ready-to-eat chilled soup.' });
    expect(p.status).toBe('proposed');
    s = await incidentStatus(LOT);
    expect(s.incident).toMatchObject({ class: 'I', depth: 'consumer', confirmed_at: null });
    const bad = await app.request(`/incident/${LOT}/confirm`, { method: 'POST', body: JSON.stringify({ class: 'IV', depth: 'consumer' }) });
    expect(bad.status).toBe(400);
    const ok = await app.request(`/incident/${LOT}/confirm`, { method: 'POST', body: JSON.stringify({ class: 'I', depth: 'retail' }) });
    expect((await ok.json()).incident).toMatchObject({ confirmed_class: 'I', confirmed_depth: 'retail' });
    expect((await incidentStatus(LOT)).incident?.confirmed_at).toBeTruthy();
    expect((await incidentReport(LOT)).incident?.confirmed_depth).toBe('retail');
  });

  it('incident report agrees with the tools', async () => {
    const r = await incidentReport(LOT);
    const ids = (st: string) => r.stores.filter((s) => s.status === st).map((s) => s.id).sort();
    expect(ids('recall')).toEqual(expected.affected_stores);
    expect(ids('gap')).toEqual(expected.gap_stores);
    expect(ids('safe')).toEqual(expected.safe_stores);
    expect(r.counts.units_to_pull).toBe(expected.units_to_pull);
    expect(r.stores.reduce((n, s) => n + s.units_at_risk, 0)).toBe(expected.units_to_pull);
    expect(r.lineage.filter((e) => e.type === 'REWORKED_INTO')).toEqual([expect.objectContaining({ source: 'B-03', target: 'B-09' })]);
    expect(r.stores.filter((s) => s.status === 'safe').every((s) => s.shipments.every((x) => !x.origins.includes(LOT)))).toBe(true);
    const affected = r.product_lots.filter((p) => p.affected);
    expect(affected.map((p) => p.id).sort()).toEqual(expected.product_lots);
    expect(affected.reduce((n, p) => n + p.held, 0)).toBe(expected.hold.units);
    expect(affected.every((p) => p.units === p.shipped + p.held && p.upc.length === 12 && p.best_by > p.produced_at)).toBe(true);
  });

  it('array tool arguments sent as JSON strings are accepted, even with a stray bracket, through MCP', async () => {
    const notices = [{ store: 'ST-032', reason: 'x' }];
    expect(schemas.draft_recall_notice.notices.parse(JSON.stringify(notices))).toEqual(notices);
    expect(schemas.draft_recall_notice.notices.parse(JSON.stringify(notices) + '}')).toEqual(notices); // what the model sent once
    expect(schemas.trace_backward.product_lots.parse('["TLC-06A"]')).toEqual(['TLC-06A']);
    const { mcpTools } = await import('../src/agent/ai-agent.js');
    const r = await (await mcpTools()).draft_recall_notice.execute!({ lot: LOT, notices: '[{"store":"ST-013","reason":"test"}]}' }, { toolCallId: 't', messages: [], context: {} }) as any;
    expect(r.isError).toBeFalsy();
    expect(JSON.parse((r.content as any)[0].text).drafted).toBe(1);
  });

  it('the same tools are served over Streamable HTTP at /mcp', async () => {
    const { app } = await import('../src/api/server.js');
    const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
    const c = new Client({ name: 'test', version: '0.0.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL('http://x/mcp'), { fetch: async (u, init) => app.request(String(u), init) }));
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(Object.keys(schemas).sort());
    const r = await c.callTool({ name: 'trace_forward', arguments: { lot: LOT } });
    expect(JSON.parse((r.content as any)[0].text).stores).toHaveLength(31);
    await c.close();
  });

  it('draft_recall_notice: 33 drafts, all pending_approval', async () => {
    rmSync(NOTICES_FILE, { force: true });
    const m = await minimalRecall({ lot: LOT });
    await draftRecallNotice({ lot: LOT, notices: m.recall_stores.map((r) => ({ store: r.store, reason: 'test' })) });
    const n = readNotices();
    expect(n).toHaveLength(33);
    expect(n.every((x) => x.status === 'pending_approval')).toBe(true);
  });
});

describe('API', () => {
  it('CSV export: one row per affected shipment plus the 2 gap rows', async () => {
    const { exportCsv } = await import('../src/api/server.js');
    const lines = (await exportCsv(LOT)).trim().split('\n');
    expect(lines).toHaveLength(1 + expected.affected_shipments + 2);
    expect(lines.filter((l) => l.startsWith(',')).length).toBe(2); // gap rows have an empty lot code
  });

  it('GET /graph and approve flow', async () => {
    const { app } = await import('../src/api/server.js');
    const g = await (await app.request(`/graph/${LOT}`)).json();
    const kinds = (k: string) => g.nodes.filter((n: any) => n.data.kind === k).length;
    expect([kinds('store-affected'), kinds('store-gap'), kinds('store-safe')]).toEqual([31, 2, 38]);
    const res = await app.request('/notices/approve', { method: 'POST', body: JSON.stringify({ stores: expected.gap_stores }) });
    expect(await res.json()).toEqual({ approved: 2 });
  });

  it('POST /recall: bad input is 400, unknown lot is 404 (no Claude call)', async () => {
    const { app } = await import('../src/api/server.js');
    const post = (lot: string) => app.request('/recall', { method: 'POST', body: JSON.stringify({ lot }) });
    expect((await post('204; DROP')).status).toBe(400);
    expect((await post('L-999')).status).toBe(404);
  });

  it.skipIf(!process.env.E2E)('end to end: POST /recall in under 60 s with matching counts', async () => {
    const { app } = await import('../src/api/server.js');
    const t0 = Date.now();
    const res = await app.request('/recall', { method: 'POST', body: JSON.stringify({ lot: LOT, hazard: 'Listeria monocytogenes detected in supplier finished-product testing' }) });
    const r = await res.json();
    console.log(`e2e: ${Date.now() - t0} ms`, JSON.stringify({ counts: r.counts, calls: r.tool_calls, summary: r.summary }, null, 1));
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(r.counts).toEqual({ blanket: 71, targeted: 33, safe: 38 });
    expect(r.tool_calls.map((c: any) => c.name)).toEqual(['recall_memory', 'propose_classification', 'place_hold', 'trace_forward', 'rank_chokepoints', 'coverage_gaps', 'minimal_recall', 'trace_backward', 'draft_recall_notice', 'record_lessons']);
    expect(r.tool_calls.every((c: any) => c.summary && c.cypher.length)).toBe(true);
    expect(readNotices().filter((n) => n.lot === LOT)).toHaveLength(33);
  }, 90_000);
});

describe('graph algorithm and memory', () => {
  it('rank_chokepoints: betweenness puts the reworked batch B-03 first, the same on every run', async () => {
    const r = await rankChokepoints({ lot: LOT });
    expect(r.nodes[0]).toMatchObject({ kind: 'Batch', id: 'B-03', stores: 16 });
    expect(await rankChokepoints({ lot: LOT })).toEqual(r);
    expect(r.nodes.every((n) => n.score > 0)).toBe(true);
  });

  it('lessons one incident records are read by the next incident from the same supplier, and only by others', async () => {
    const saved = await recordLessons({ lot: 'L-TEST', lessons: [{ about: 'S-03', fact: 'a' }, { about: 'ST-013', fact: 'b' }, { about: 'NOPE', fact: 'c' }] });
    expect([saved.saved.map((l) => l.about).sort(), saved.unknown]).toEqual([['S-03', 'ST-013'], ['NOPE']]);
    await recordLessons({ lot: 'L-TEST', lessons: [{ about: 'S-03', fact: 'a2' }] }); // a rerun replaces, never piles up
    const mine = (lot: string) => recallMemory({ lot }).then((r) => r.lessons.filter((l) => l.from_lot === 'L-TEST').map((l) => [l.about, l.fact]));
    expect(await mine('L-205')).toEqual([['S-03', 'a2']]); // same supplier S-03
    expect(await mine('L-101')).toEqual([]); // supplier S-08
    expect(await mine('L-TEST')).toEqual([]);
    await query('MATCH (m:Memory {lot: $lot}) DELETE m', { lot: 'L-TEST' });
  });
});

describe('outbreak OB-2026-10', () => {
  it('ranks lots exactly as the generator planted them', async () => {
    const r = await findCommonSource({ cluster: 'OB-2026-10' });
    expect(r.total_cases).toBe(6);
    expect(r.candidates.map(({ lot, cases_explained, explained, stores_reached }) => ({ lot, cases_explained, explained, stores_reached })))
      .toEqual(expected.outbreak.ranking);
    expect(r.candidates[0]).toMatchObject({ lot: 'L-204', cases_explained: 6, stores_reached: 31, supplier: 'S-03' });
    expect(r.candidates.map((c) => c.lot)).not.toContain('L-205'); // same ingredient, same supplier, reaches no case
  });

  it('every case has a path from L-204 to the store it bought at', async () => {
    const { paths } = await findCommonSource({ cluster: 'OB-2026-10' });
    expect(Object.keys(paths).sort()).toEqual(expected.outbreak.cases);
    for (const [id, ps] of Object.entries(paths)) {
      expect(ps.length).toBeGreaterThan(0);
      for (const p of ps) expect([p[0], p.at(-1)]).toEqual(['L-204', id]);
    }
  });

  it('case_path: decoy reaches nothing, unknown ids are an error', async () => {
    expect((await casePath({ lot: 'L-205', cases: ['C1', 'C2'] })).unexplained).toEqual(['C1', 'C2']);
    await expect(casePath({ lot: 'L-204', cases: ['C1', 'C99'] })).rejects.toThrow('unknown case ids: C99');
    await expect(findCommonSource({ cluster: 'OB-NOPE' })).rejects.toThrow('no cases');
  });

  it('measure reports FalkorDB time and query count', async () => {
    const m = await measure(() => findCommonSource({ cluster: 'OB-2026-10' }));
    expect(m.queries).toBe(4);
    expect(m.db_ms).toBeGreaterThan(0);
  });
});

describe('case ingest (A6)', () => {
  const { stores, cases } = build(42).nodes;
  const st = stores[0];

  it('formatCases and parseCases round-trip the planted cases', () => {
    expect(parseCases(formatCases(cases), stores)).toMatchObject({ cases, rejected: [] });
  });

  it('matches a store by name and city, and rejects each bad row with its row number', () => {
    const text = [
      'id,region,onset,reported_at,store,city,bought_at',
      `X1,MI,2026-10-05,2026-10-06,"${st.name}",${st.city.toUpperCase()},2026-10-03`,
      'X2,MI,2026-10-05,2026-10-06,Nowhere #999,Austin,2026-10-03',
      'X1,MI,2026-10-05,2026-10-06,ST-001,,2026-10-03',
      'X3,MI,2026-10-02,2026-10-06,ST-001,,2026-10-03',
      'X4,MI,10/05/2026,2026-10-06,ST-001,,2026-10-03',
    ].join('\n');
    const r = parseCases(text, stores);
    expect(r.cases).toEqual([{ id: 'X1', region: 'MI', onset: '2026-10-05', reported_at: '2026-10-06', store: st.id, bought_at: '2026-10-03' }]);
    expect(r.rejected.map(({ row, reason }) => [row, reason])).toEqual([
      [3, 'no store matches "Nowhere #999" in Austin'],
      [4, 'case X1 appears twice in this paste'],
      [5, 'onset is before the purchase date'],
      [6, 'onset must be a date like 2026-10-09'],
    ]);
  });

  it('ingest is additive and idempotent, keeps case ids global, and needs a pathogen for a new cluster', async () => {
    const row = `T1\tMI\t2026-10-05\t2026-10-06\t\t${st.id}\t2026-10-03`;
    await expect(ingestCases('OB-TEST', row)).rejects.toThrow('say which pathogen');
    expect(await ingestCases('OB-TEST', row, 'Salmonella')).toEqual({ cluster: 'OB-TEST', created: true, loaded: 1, rejected: [] });
    expect(await ingestCases('OB-TEST', row)).toEqual({ cluster: 'OB-TEST', created: false, loaded: 1, rejected: [] });
    const r = await ingestCases('OB-TEST', `T2\tMI\t2026-10-05\t2026-10-06\t\t${st.id}\t2026-10-03\nC1\tMI\t2026-10-05\t2026-10-06\t\t${st.id}\t2026-10-03`);
    expect(r.rejected).toEqual([{ row: 2, line: `C1\tMI\t2026-10-05\t2026-10-06\t\t${st.id}\t2026-10-03`, reason: 'case C1 already belongs to cluster OB-2026-10' }]);
    const rows = await query<{ id: string; n: number }>('MATCH (:Cluster {id: "OB-TEST"})-[:HAS_CASE]->(c:Case)-[b:BOUGHT_AT]->() RETURN c.id AS id, count(b) AS n ORDER BY id');
    expect(rows).toEqual([{ id: 'T1', n: 1 }, { id: 'T2', n: 1 }]);
    expect((await findCommonSource({ cluster: 'OB-2026-10' })).total_cases).toBe(6);
  });

  it('POST /ingest/cases and the outbreak routes validate before any Claude call', async () => {
    const { app } = await import('../src/api/server.js');
    const post = (path: string, body: object) => app.request(path, { method: 'POST', body: JSON.stringify(body) });
    expect((await post('/ingest/cases', { cluster: 'bad id!', text: 'x' })).status).toBe(400);
    expect((await post('/ingest/cases', { cluster: 'OB-TEST', text: ' ' })).status).toBe(400);
    expect(await (await post('/ingest/cases', { cluster: 'OB-NEW', text: 'x' })).json()).toEqual({ error: 'Cluster OB-NEW is new: say which pathogen it is.' });
    expect((await post('/outbreak', { cluster: 'OB-NOPE' })).status).toBe(404);
    expect((await app.request('/outbreak/stream?cluster=a%20b')).status).toBe(400);
  });
});

describe('incident history (B5)', () => {
  it('summarizeIncident derives time to scope and status', () => {
    const row = { id: 'INC-1', lot: 'L-1', hazard: 'h', reported_at: '2026-10-17T10:00:00.000Z', class: 'I', confirmed_class: null, scoped_at: '2026-10-17T10:00:45.000Z', stores: 33, supplier_id: 'S-03', supplier: 'Harlow Farms' };
    expect(summarizeIncident(row, new Set())).toMatchObject({ minutes_to_scope: 0.8, status: 'scoped' });
    expect(summarizeIncident({ ...row, scoped_at: null }, new Set())).toMatchObject({ minutes_to_scope: null, status: 'open' });
    expect(summarizeIncident(row, new Set(['L-1'])).status).toBe('notices_approved');
  });

  it('the MCP minimal_recall stamps scoped_at once; the dashboard read never does', async () => {
    const { openIncident, app } = await import('../src/api/server.js');
    await openIncident(LOT, 'Listeria');
    await incidentReport(LOT);
    expect((await listIncidents()).find((i) => i.lot === LOT)).toMatchObject({ status: 'open', scoped_at: null });
    await scopeRecall({ lot: LOT });
    const first = (await listIncidents()).find((i) => i.lot === LOT)!;
    await scopeRecall({ lot: LOT });
    expect((await listIncidents()).find((i) => i.lot === LOT)).toMatchObject({ status: 'scoped', stores: 33, scoped_at: first.scoped_at });
    expect(first.minutes_to_scope).toBeGreaterThanOrEqual(0);
    const sup = await (await app.request('/incidents/supplier/S-03')).json();
    expect([sup.name, sup.incidents.map((i: any) => i.lot)]).toEqual(['Valley Root Co.', [LOT]]);
    expect((await app.request('/incidents/supplier/S-999')).status).toBe(404);
    expect((await app.request('/incidents/supplier/x')).status).toBe(400);
  });
});

describe('replay (B2)', () => {
  it('replays a recorded run in order with no key and no database; bad input is 400/404', async () => {
    const { app } = await import('../src/api/server.js');
    const events = [
      { t_ms: 0, event: { type: 'start', lot: 'L-999999', model: 'm' } },
      { t_ms: 40, event: { type: 'note', text: 'hi', turn: 0 } },
      { t_ms: 80, event: { type: 'done', result: { lot: 'L-999999' } } },
    ];
    writeFileSync('out/run-L-999999.json', JSON.stringify({ lot: 'L-999999', recorded_at: 'x', events }));
    try {
      const body = await (await app.request('/recall/replay?lot=L-999999&speed=20')).text();
      expect([...body.matchAll(/^event: (\w+)$/gm)].map((m) => m[1])).toEqual(['start', 'note', 'done']);
      expect((await app.request('/recall/replay?lot=L-999999&speed=0')).status).toBe(400);
      expect((await app.request('/recall/replay?lot=L-999998')).status).toBe(404);
      // The dashboard's timeline needs the whole recording at once.
      expect(await (await app.request('/recall/replay?lot=L-999999&format=json')).json()).toEqual({ lot: 'L-999999', recorded_at: 'x', events });
      expect((await app.request('/recall/replay?lot=L-999998&format=json')).status).toBe(404);
      writeFileSync('out/run-L-999999.json', JSON.stringify({ lot: 'L-999999', recorded_at: 'x', events: events.slice(0, 2) }));
      expect((await app.request('/recall/replay?lot=L-999999')).status).toBe(404); // incomplete run: no done
    } finally { rmSync('out/run-L-999999.json'); }
  });
});
