import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { build, load } from '../src/data/generate.js';
import { close } from '../src/graph/db.js';
import { schemas, traceForward, coverageGaps, unaffectedStores, minimalRecall, draftRecallNotice, readNotices, NOTICES_FILE, traceBackward } from '../src/tools/index.js';
import { incidentReport } from '../src/tools/incident.js';
import expected from '../data/expected.json';

const LOT = 'L-204';
let loaded: { nodes: number; edges: number };

beforeAll(async () => { loaded = await load(build(42)); });
afterAll(async () => {
  await (await import('../src/agent/run.js')).closeAgent();
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
  });

  it('array tool arguments sent as JSON strings are accepted', () => {
    const notices = [{ store: 'ST-032', reason: 'x' }];
    expect(schemas.draft_recall_notice.notices.parse(JSON.stringify(notices))).toEqual(notices);
    expect(schemas.trace_backward.product_lots.parse('["TLC-06A"]')).toEqual(['TLC-06A']);
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

  it.skipIf(!process.env.ANTHROPIC_API_KEY)('end to end: POST /recall in under 60 s with matching counts', async () => {
    const { app } = await import('../src/api/server.js');
    const t0 = Date.now();
    const res = await app.request('/recall', { method: 'POST', body: JSON.stringify({ lot: LOT }) });
    const r = await res.json();
    console.log(`e2e: ${Date.now() - t0} ms`, JSON.stringify({ counts: r.counts, calls: r.tool_calls, summary: r.summary }, null, 1));
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(r.counts).toEqual({ blanket: 71, targeted: 33, safe: 38 });
    expect(r.tool_calls.map((c: any) => c.name)).toEqual(['trace_forward', 'coverage_gaps', 'minimal_recall', 'trace_backward', 'draft_recall_notice']);
    expect(r.tool_calls.every((c: any) => c.summary && c.cypher.length)).toBe(true);
    expect(readNotices().filter((n) => n.lot === LOT)).toHaveLength(33);
  }, 90_000);
});
