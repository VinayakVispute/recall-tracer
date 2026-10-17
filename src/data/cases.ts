import { query } from '../graph/db.js';
import { ALL_STORES, CASE_CLUSTERS, CLUSTER_GET, CLUSTER_MERGE, CASES_UPSERT } from '../graph/queries.js';
import type { CaseInput } from '../contracts.js';

export type StoreRef = { id: string; name: string; city: string };
/** `row` is 1-based over the pasted lines (a header counts), so the UI can say "row 7 rejected". */
export type RejectedRow = { row: number; line: string; reason: string };

export const CASE_ID = /^[A-Za-z0-9-]{1,40}$/;
const COLUMNS = ['id', 'region', 'onset', 'reported_at', 'sku', 'store', 'bought_at'] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function cells(line: string, sep: string) {
  if (sep === '\t') return line.split('\t').map((c) => c.trim());
  const out: string[] = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') cur += '"', i++;
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') out.push(cur.trim()), cur = '';
    else cur += ch;
  }
  return [...out, cur.trim()];
}

/**
 * Pure. Parses CSV or pasted tab text into cases, resolving each store to a Store id.
 * Columns: id, region, onset, reported_at, sku, store, bought_at; an optional header row (first cell `id`)
 * reorders them by name and may add `city`, which lets `store` be a store name instead of an id.
 * Every bad row comes back in `rejected` with a reason; nothing is dropped silently.
 */
export function parseCases(text: string, stores: StoreRef[]) {
  const lines = text.split(/\r?\n/);
  const first = lines.find((l) => l.trim()) ?? '';
  const sep = first.includes('\t') ? '\t' : ',';
  const byId = new Map(stores.map((s) => [s.id.toLowerCase(), s.id]));
  const byName = new Map(stores.map((s) => [`${s.name}|${s.city}`.toLowerCase(), s.id]));
  let cols: string[] = [...COLUMNS];
  const cases: CaseInput[] = [], rejected: RejectedRow[] = [], source = new Map<string, Omit<RejectedRow, 'reason'>>();

  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const raw = cells(line, sep);
    if (raw[0].toLowerCase() === 'id') { cols = raw.map((c) => c.toLowerCase()); return; }
    const v = Object.fromEntries(cols.map((c, j) => [c, raw[j] ?? '']));
    const reject = (reason: string) => rejected.push({ row: i + 1, line, reason });
    const store = byId.get(v.store?.toLowerCase()) ?? byName.get(`${v.store}|${v.city ?? ''}`.toLowerCase());
    if (!CASE_ID.test(v.id)) return reject('case id must be 1-40 letters, digits or dashes');
    if (source.has(v.id)) return reject(`case ${v.id} appears twice in this paste`);
    if (!v.region) return reject('region is empty');
    for (const d of ['onset', 'reported_at', 'bought_at']) if (!DATE.test(v[d])) return reject(`${d} must be a date like 2026-10-09`);
    if (v.onset < v.bought_at) return reject('onset is before the purchase date');
    if (v.reported_at < v.onset) return reject('reported_at is before onset');
    if (!store) return reject(`no store matches "${v.store}"${v.city ? ` in ${v.city}` : ''}`);
    source.set(v.id, { row: i + 1, line });
    cases.push({ id: v.id, region: v.region, onset: v.onset, reported_at: v.reported_at, store, bought_at: v.bought_at, ...(v.sku ? { sku: v.sku } : {}) });
  });
  return { cases, rejected, source };
}

/** Pure inverse of parseCases: tab text with a header, the shape Page 1's paste box shows as its example. */
export function formatCases(cases: CaseInput[]) {
  return [COLUMNS.join('\t'), ...cases.map((c) => COLUMNS.map((k) => c[k] ?? '').join('\t'))].join('\n');
}

/**
 * Upserts cases into one cluster. Idempotent (re-ingesting the same rows changes nothing) and additive
 * (cases already in the cluster but missing from this paste stay). Case ids are global, so an id that
 * belongs to another cluster is rejected rather than moved. A new cluster needs a pathogen.
 */
export async function ingestCases(cluster: string, text: string, pathogen?: string) {
  const [exists] = await query<{ id: string }>(CLUSTER_GET, { id: cluster });
  if (!exists && !pathogen?.trim()) throw Object.assign(new Error(`Cluster ${cluster} is new: say which pathogen it is.`), { status: 400 });

  const { cases, rejected, source } = parseCases(text, await query<StoreRef>(ALL_STORES));
  const owners = new Map((await query<{ id: string; cluster: string }>(CASE_CLUSTERS, { ids: cases.map((c) => c.id) })).map((r) => [r.id, r.cluster]));
  const rows = cases.filter((c) => {
    const owner = owners.get(c.id);
    if (owner && owner !== cluster) rejected.push({ ...source.get(c.id)!, reason: `case ${c.id} already belongs to cluster ${owner}` });
    return !owner || owner === cluster;
  });
  await query(CLUSTER_MERGE, { id: cluster, pathogen: pathogen?.trim().slice(0, 100) ?? null, opened_at: new Date().toISOString().slice(0, 10) });
  if (rows.length) await query(CASES_UPSERT, { cluster, rows: rows.map((r) => ({ sku: null, ...r })) });
  return { cluster, created: !exists, loaded: rows.length, rejected: rejected.sort((a, b) => a.row - b.row) };
}
