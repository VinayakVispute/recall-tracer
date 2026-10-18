import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { graph, close } from '../graph/db.js';

// Real public data in its own graph "fda", so `generate --reset` never wipes it and the agent's tools never see it.
const GRAPH = 'fda';
const RECALLS_FILE = 'data/real/openfda-food-recalls.json';
const OUTBREAKS_FILE = 'data/real/outbreaks.json';
const SINCE = '20250101';

type FdaRecord = Record<string, string>;
export type Recall = {
  id: string; event_id: string; firm: string; city: string; state: string; country: string;
  classification: string; status: string; reason: string; product: string; code_info: string; quantity: string;
  distribution: string; initiated: string; reported: string; voluntary: string;
  hazards: string[]; states: string[]; nationwide: boolean; downstream: boolean;
};

const HAZARDS: [string, RegExp][] = [
  ['Listeria monocytogenes', /listeria/i],
  ['Salmonella', /salmonella/i],
  ['E. coli (STEC)', /\be\.?\s?coli\b|\bstec\b|o157/i],
  ['Clostridium botulinum', /botulin/i],
  ['Undeclared allergen', /undeclared|allergen/i],
  ['Foreign material', /foreign (material|object)|metal|plastic|glass/i],
];
const STATES: Record<string, string> = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE',
  Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY',
  Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO',
  Montana: 'MT', Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
  'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI',
  'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT', Virginia: 'VA',
  Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY', 'District of Columbia': 'DC', 'Puerto Rico': 'PR',
};
const CODES = new Set(Object.values(STATES));

/** Pure. Every hazard the recall reason names; "Other" when none match. */
export function hazardsOf(reason: string) {
  const found = HAZARDS.filter(([, re]) => re.test(reason)).map(([name]) => name);
  return found.length ? found : ['Other'];
}

/** Pure. US state codes named in a free-text distribution pattern, by code ("MD, VA") or full name. */
export function statesIn(pattern: string) {
  const out = new Set<string>();
  for (const code of pattern.match(/\b[A-Z]{2}\b/g) ?? []) if (CODES.has(code)) out.add(code);
  // Longest names first, cut out once matched, so "West Virginia" doesn't also count as Virginia.
  let rest = pattern;
  for (const name of Object.keys(STATES).sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`\\b${name}\\b`, 'gi');
    if (re.test(rest)) out.add(STATES[name]), rest = rest.replace(re, ' ');
  }
  return [...out].sort();
}

// "Lot No: SAL2-24JB", "ISS Lot # SAL2-24JB", "Lot: A1, B2": the keyword, then one code or a list of them.
const LOT = /\blot\s*(?:no\.?|nos\.?|number|code|#)?\s*[:#]?\s*((?:[A-Z0-9][A-Z0-9.\-\/]*)(?:\s*(?:,|and|&)\s*[A-Z0-9][A-Z0-9.\-\/]*)*)/gi;

/**
 * Pure. Lot codes named in a recall's code text. Only codes with a letter and a digit, five characters or more:
 * bare numbers like "Lot 222" are each firm's own run numbers and would join unrelated firms.
 */
export function lotCodesIn(text = '') {
  const out = new Set<string>();
  for (const m of text.matchAll(LOT)) for (const t of m[1].split(/\s*(?:,|and|&)\s*/i)) {
    const code = t.replace(/[.\-\/]+$/, '').toUpperCase();
    if (code.length >= 5 && /[A-Z]/.test(code) && /\d/.test(code)) out.add(code);
  }
  return [...out].sort();
}

const date = (d = '') => d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : d;

export function toRecall(r: FdaRecord): Recall {
  const reason = r.reason_for_recall ?? '';
  return {
    id: r.recall_number, event_id: r.event_id, firm: r.recalling_firm.trim(), city: r.city, state: r.state, country: r.country,
    classification: r.classification, status: r.status, reason, product: r.product_description, code_info: r.code_info,
    quantity: r.product_quantity, distribution: r.distribution_pattern, initiated: date(r.recall_initiation_date),
    reported: date(r.report_date), voluntary: r.voluntary_mandated,
    hazards: hazardsOf(reason), states: statesIn(r.distribution_pattern ?? ''),
    nationwide: /nationwide|nation wide|all states|throughout the (us|u\.s|united states)/i.test(r.distribution_pattern ?? ''),
    downstream: /downstream|recalled by (the|their) supplier|supplier.{0,40}recall/i.test(reason),
  };
}

/** Pulls every openFDA food enforcement record reported since SINCE. openFDA pages at 1000 and needs no key. */
async function fetchRecalls() {
  const today = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const rows: FdaRecord[] = [];
  for (let skip = 0; ; skip += 1000) {
    const url = `https://api.fda.gov/food/enforcement.json?search=report_date:[${SINCE}+TO+${today}]&sort=report_date:desc&limit=1000&skip=${skip}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`openFDA ${res.status}: ${await res.text()}`);
    const body = await res.json() as { meta: { results: { total: number } }; results: FdaRecord[] };
    rows.push(...body.results);
    if (rows.length >= body.meta.results.total || !body.results.length) break;
  }
  mkdirSync('data/real', { recursive: true });
  const recalls = rows.map(toRecall);
  writeFileSync(RECALLS_FILE, JSON.stringify({ _source: `openFDA food/enforcement, report_date >= ${SINCE}, fetched ${today}`, recalls }, null, 1) + '\n');
  return recalls.length;
}

type Outbreaks = {
  outbreaks: { id: string; pathogen: string; food: string; status: string; cases: number; hospitalized: number; deaths: number;
    onset_from: string; onset_to: string; cases_by_state: Record<string, number>; linked_firm: string; sources: string[] }[];
  supplied: { from: string; to: string; product: string; basis: 'stated' | 'inferred'; why: string; source: string }[];
  /** Recall notices FDA posted that openFDA doesn't carry yet, copied from the notice text. Loaded as recalls, with their source. */
  notices?: { id: string; firm: string; city: string; state: string; classification: string; reason: string; product: string;
    code_info: string; quantity: string; distribution: string; initiated: string; source: string }[];
};

/** A notice in the shape of an openFDA recall, read the same way: hazards from the reason, states from the distribution. */
const fromNotice = (n: NonNullable<Outbreaks['notices']>[number]): Recall & { source: string } => ({
  ...n, event_id: n.id, country: 'United States', status: 'Ongoing', reported: n.initiated, voluntary: 'Voluntary: Firm initiated',
  hazards: hazardsOf(n.reason), states: statesIn(n.distribution), nationwide: false, downstream: false,
});

export async function loadReal() {
  const file = JSON.parse(readFileSync(RECALLS_FILE, 'utf8')) as { recalls: Recall[] };
  const { outbreaks, supplied, notices = [] } = JSON.parse(readFileSync(OUTBREAKS_FILE, 'utf8')) as Outbreaks;
  const recalls: (Recall & { source?: string })[] = [...file.recalls, ...notices.map(fromNotice)];
  const g = await graph(GRAPH);
  await g.delete().catch(() => {}); // fails only if the graph does not exist yet; a full reload keeps this idempotent
  for (const q of ['CREATE INDEX FOR (f:Firm) ON (f.name)', 'CREATE INDEX FOR (r:Recall) ON (r.id)', 'CREATE INDEX FOR (s:State) ON (s.code)',
    'CREATE INDEX FOR (h:Hazard) ON (h.name)', 'CREATE INDEX FOR (o:Outbreak) ON (o.id)', 'CREATE INDEX FOR (l:LotCode) ON (l.code)']) await g.query(q);
  const run = (q: string, rows: unknown[]) => g.query(q, { params: { rows } as never });

  const firms = new Map(recalls.map((r) => [r.firm, { name: r.firm, city: r.city, state: r.state, country: r.country }]));
  for (const o of outbreaks) if (!firms.has(o.linked_firm)) throw new Error(`${o.id}: no openFDA firm named "${o.linked_firm}"`);
  for (const s of supplied) for (const name of [s.from, s.to]) if (!firms.has(name)) firms.set(name, { name, city: '', state: '', country: 'United States' });
  await run('UNWIND $rows AS r CREATE (:State {code: r})', [...CODES].sort());
  await run('UNWIND $rows AS r CREATE (:Hazard {name: r})', [...HAZARDS.map(([n]) => n), 'Other']);
  await run('UNWIND $rows AS r CREATE (:Firm {name: r.name, city: r.city, state: r.state, country: r.country})', [...firms.values()]);
  await run(`UNWIND $rows AS r MATCH (f:Firm {name: r.firm})
    CREATE (f)-[:RECALLED]->(:Recall {id: r.id, event_id: r.event_id, classification: r.classification, status: r.status, reason: r.reason,
      product: r.product, code_info: r.code_info, quantity: r.quantity, distribution: r.distribution, initiated: r.initiated,
      reported: r.reported, voluntary: r.voluntary, nationwide: r.nationwide, downstream: r.downstream, source: r.source})`, recalls);
  await run('UNWIND $rows AS r UNWIND r.hazards AS h MATCH (x:Recall {id: r.id}), (z:Hazard {name: h}) CREATE (x)-[:HAZARD]->(z)', recalls);
  await run('UNWIND $rows AS r UNWIND r.states AS s MATCH (x:Recall {id: r.id}), (z:State {code: s}) CREATE (x)-[:DISTRIBUTED_TO]->(z)', recalls);
  // Each lot code once; every recall whose code text names it links to it, so recalls from different firms meet at the lot.
  const lots = recalls.map((r) => ({ id: r.id, lots: lotCodesIn(r.code_info) })).filter((r) => r.lots.length);
  await run('UNWIND $rows AS r CREATE (:LotCode {code: r})', [...new Set(lots.flatMap((r) => r.lots))]);
  await run('UNWIND $rows AS r UNWIND r.lots AS l MATCH (x:Recall {id: r.id}), (z:LotCode {code: l}) CREATE (x)-[:NAMES_LOT]->(z)', lots);
  await run(`UNWIND $rows AS r CREATE (o:Outbreak {id: r.id, pathogen: r.pathogen, food: r.food, status: r.status, cases: r.cases,
      hospitalized: r.hospitalized, deaths: r.deaths, onset_from: r.onset_from, onset_to: r.onset_to, source: r.sources[0]})
    WITH o, r MATCH (f:Firm {name: r.linked_firm}) CREATE (o)-[:LINKED_TO]->(f)`, outbreaks);
  await run(`UNWIND $rows AS r UNWIND keys(r.cases_by_state) AS s MATCH (o:Outbreak {id: r.id}), (z:State {code: s})
    CREATE (o)-[:CASES_IN {count: r.cases_by_state[s]}]->(z)`, outbreaks);
  await run(`UNWIND $rows AS r MATCH (a:Firm {name: r.from}), (b:Firm {name: r.to})
    CREATE (a)-[:SUPPLIED {product: r.product, basis: r.basis, why: r.why, source: r.source}]->(b)`, supplied);

  const count = async (q: string) => ((await g.query<{ n: number }>(q)).data ?? [])[0]?.n ?? 0;
  return { recalls: recalls.length, firms: firms.size, outbreaks: outbreaks.length,
    nodes: await count('MATCH (n) RETURN count(n) AS n'), edges: await count('MATCH ()-[e]->() RETURN count(e) AS n') };
}

export type RealOutbreak = {
  id: string; pathogen: string; food: string; status: string; cases: number; hospitalized: number; deaths: number;
  onset_from: string; onset_to: string; source: string;
  firm: { name: string; city: string; state: string };
  cases_by_state: Record<string, number>;
  recalls: { id: string; product: string; classification: string; initiated: string; states: string[] }[];
  /** States any of the firm's recalls named. */
  shipped: string[];
  /** States with sick people that no recall of the firm named: where the recall notice missed. */
  gap: string[];
  downstream: { firm: string; basis: string; why: string; source: string; recalls: string[] }[];
};

/** Every CDC outbreak in the fda graph, joined to its firm's real openFDA recalls. */
export async function realOutbreaks(): Promise<RealOutbreak[]> {
  const g = await graph(GRAPH);
  const rows = (await g.query<RealOutbreak & { firm_name: string; firm_city: string; firm_state: string; cases_in: { s: string; n: number }[] }>(`
    MATCH (o:Outbreak)-[:LINKED_TO]->(f:Firm)
    OPTIONAL MATCH (o)-[c:CASES_IN]->(cs:State)
    WITH o, f, collect({s: cs.code, n: c.count}) AS cases_in
    OPTIONAL MATCH (f)-[:RECALLED]->(r:Recall)
    OPTIONAL MATCH (r)-[:DISTRIBUTED_TO]->(s:State)
    WITH o, f, cases_in, r, collect(s.code) AS states
    WITH o, f, cases_in, collect(CASE WHEN r IS NULL THEN NULL ELSE {id: r.id, product: r.product, classification: r.classification, initiated: r.initiated, states: states} END) AS recalls
    OPTIONAL MATCH (f)-[e:SUPPLIED]->(b:Firm)
    OPTIONAL MATCH (b)-[:RECALLED]->(br:Recall)
    WITH o, f, cases_in, recalls, e, b, collect(br.id) AS b_recalls
    RETURN o.id AS id, o.pathogen AS pathogen, o.food AS food, o.status AS status, o.cases AS cases, o.hospitalized AS hospitalized,
      o.deaths AS deaths, o.onset_from AS onset_from, o.onset_to AS onset_to, o.source AS source,
      f.name AS firm_name, f.city AS firm_city, f.state AS firm_state, cases_in, recalls,
      collect(CASE WHEN b IS NULL THEN NULL ELSE {firm: b.name, basis: e.basis, why: e.why, source: e.source, recalls: b_recalls} END) AS downstream
    ORDER BY id`)).data ?? [];
  return rows.map(({ firm_name, firm_city, firm_state, cases_in, ...o }) => {
    const cases_by_state = Object.fromEntries(cases_in.filter((c) => c.s).map((c) => [c.s, c.n]));
    const shipped = [...new Set(o.recalls.flatMap((r) => r.states))].sort();
    return { ...o, firm: { name: firm_name, city: firm_city, state: firm_state }, cases_by_state, shipped,
      gap: Object.keys(cases_by_state).filter((s) => !shipped.includes(s)).sort(),
      recalls: o.recalls.sort((a, b) => a.id.localeCompare(b.id)) };
  });
}

type Row = Record<string, unknown>;
/** One query on the fda graph with FalkorDB's own execution time, read from the result metadata. */
async function timed<T = Row>(g: Awaited<ReturnType<typeof graph>>, cypher: string, params?: Record<string, unknown>) {
  const res = await g.query<T>(cypher, params ? { params: params as never } : undefined);
  const db_ms = Number(res.metadata?.find((m) => m.startsWith('Query internal execution time'))?.match(/[\d.]+/)?.[0] ?? 0);
  return { rows: res.data ?? [], db_ms: Math.round(db_ms * 100) / 100 };
}

export type RealGraph = {
  nodes: { data: { id: string; kind: string; label: string } }[];
  edges: { data: { id: string; source: string; target: string; kind: string; label?: string } }[];
  db_ms: number;
};

/** The outbreak's neighbourhood as nodes and edges for the record network: outbreak, firm, recalls, hazards, states, downstream firms. */
export async function realGraph(): Promise<RealGraph> {
  const g = await graph(GRAPH);
  const nodes = new Map<string, { id: string; kind: string; label: string }>();
  const edges = new Map<string, { id: string; source: string; target: string; kind: string; label?: string }>();
  const node = (id: string, kind: string, label = id) => { if (!nodes.has(id)) nodes.set(id, { id, kind, label }); };
  const edge = (source: string, target: string, kind: string, label?: string) => edges.set(`${source}>${target}`, { id: `${source}>${target}`, source, target, kind, label });
  let db_ms = 0;

  const a = await timed<{ o: string; pathogen: string; f: string; s: string | null; n: number | null }>(g, `
    MATCH (o:Outbreak)-[:LINKED_TO]->(f:Firm) OPTIONAL MATCH (o)-[c:CASES_IN]->(s:State)
    RETURN o.id AS o, o.pathogen AS pathogen, f.name AS f, s.code AS s, c.count AS n`);
  db_ms += a.db_ms;
  const caseStates = new Set<string>();
  for (const r of a.rows) {
    node(r.o, 'outbreak', `${r.pathogen} outbreak`); node(r.f, 'firm'); edge(r.o, r.f, 'linked', 'linked to');
    if (r.s) { caseStates.add(r.s); node(r.s, 'state'); edge(r.o, r.s, 'cases', `${r.n} sick`); }
  }
  const b = await timed<{ f: string; r: string; cls: string; s: string | null; h: string | null }>(g, `
    MATCH (:Outbreak)-[:LINKED_TO]->(f:Firm)-[:RECALLED]->(r:Recall)
    OPTIONAL MATCH (r)-[:DISTRIBUTED_TO]->(s:State) OPTIONAL MATCH (r)-[:HAZARD]->(h:Hazard)
    RETURN f.name AS f, r.id AS r, r.classification AS cls, s.code AS s, h.name AS h`);
  db_ms += b.db_ms;
  const shipped = new Set<string>();
  for (const x of b.rows) {
    node(x.r, 'recall', x.r); edge(x.f, x.r, 'recalled', x.cls);
    if (x.s) { shipped.add(x.s); node(x.s, 'state'); edge(x.r, x.s, 'distributed'); }
    if (x.h) { node(x.h, 'hazard'); edge(x.r, x.h, 'hazard'); }
  }
  const c = await timed<{ f: string; b: string; basis: string; r: string | null; s: string | null }>(g, `
    MATCH (:Outbreak)-[:LINKED_TO]->(f:Firm)-[e:SUPPLIED]->(b:Firm)
    OPTIONAL MATCH (b)-[:RECALLED]->(r:Recall) OPTIONAL MATCH (r)-[:DISTRIBUTED_TO]->(s:State)
    RETURN f.name AS f, b.name AS b, e.basis AS basis, r.id AS r, s.code AS s`);
  db_ms += c.db_ms;
  for (const x of c.rows) {
    node(x.b, 'firm-downstream'); edge(x.f, x.b, 'supplied', `supplied (${x.basis})`);
    if (x.r) { node(x.r, 'recall-downstream'); edge(x.b, x.r, 'recalled'); if (x.s) { node(x.s, 'state'); edge(x.r, x.s, 'distributed'); } }
  }
  // A state with sick people that no recall of the firm reached is the gap; it gets its own colour.
  for (const s of caseStates) { const n = nodes.get(s)!; n.kind = shipped.has(s) ? 'state-both' : 'state-gap'; }
  for (const s of shipped) if (!caseStates.has(s)) nodes.get(s)!.kind = 'state-shipped';
  return { nodes: [...nodes.values()].map((data) => ({ data })), edges: [...edges.values()].map((data) => ({ data })), db_ms: Math.round(db_ms * 100) / 100 };
}

export type ChainRecall = {
  id: string; firm: string; product: string; initiated: string; quantity: string; distribution: string;
  nationwide: boolean; states: string[]; /** The FDA notice, for a recall openFDA doesn't carry yet. */ source: string | null;
};
/** One step of a lot's recalls, in date order: the case states this firm's recall reached, and the ones no earlier recall had. */
export type CoverageStep = { date: string; firm: string; recalls: string[]; reached: string[]; added: string[]; total: number };
export type LotChain = {
  lot: string; firms: string[]; recalls: ChainRecall[]; coverage: CoverageStep[];
  /** Case states no recall of the lot reached. */ uncovered: string[];
  days_to_first: number; days_to_last: number;
};
export type CaseReport = {
  outbreak: { id: string; pathogen: string; hazards: string[]; states: string[]; onset_from: string; onset_to: string; source: string | null };
  rejected: { row: number; line: string; reason: string }[];
  /** Recalls of the report's hazards since the first illness: the haystack. `top` ranks them by case states reached. */
  matching: { recalls: number; firms: number; top: { firm: string; recalls: string[]; initiated: string; nationwide: boolean; reached: string[]; in_chain: boolean }[] };
  /** Lot codes read from the matching recalls' code text. */
  lots_read: number;
  /** Lot codes named by recalls from more than one firm. */
  chains: LotChain[];
  queries: { title: string; cypher: string; db_ms: number }[];
  db_ms: number;
};

/** Pure. Splits one CSV or tab-separated line, honouring double quotes. */
function cells(line: string) {
  if (line.includes('\t')) return line.split('\t').map((c) => c.trim());
  const out: string[] = []; let cur = '', quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) out.push(cur.trim()), cur = '';
    else cur += ch;
  }
  return [...out, cur.trim()];
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** Pure. A public case report: one row per state with cases, plus the pathogen and the illness onset window. */
export function parseCaseReport(text: string) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const head = cells(lines[0] ?? '').map((h) => h.toLowerCase());
  const col = (name: string) => head.indexOf(name);
  for (const need of ['state', 'pathogen', 'onset_from', 'onset_to']) {
    if (col(need) < 0) throw Object.assign(new Error(`The first line must name the columns, including "${need}". Expected: outbreak, pathogen, state, onset_from, onset_to, source.`), { status: 400 });
  }
  const rejected: CaseReport['rejected'] = [];
  const rows: { outbreak: string; pathogen: string; state: string; from: string; to: string; source: string }[] = [];
  lines.slice(1).forEach((line, i) => {
    const c = cells(line), get = (n: string) => (col(n) >= 0 ? c[col(n)] ?? '' : '');
    const state = get('state').toUpperCase(), from = get('onset_from'), to = get('onset_to');
    const reason = !CODES.has(state) ? `"${get('state')}" is not a US state code` : !ISO.test(from) || !ISO.test(to) ? 'onset dates must look like 2026-05-31'
      : !get('pathogen') ? 'no pathogen' : '';
    if (reason) rejected.push({ row: i + 2, line, reason });
    else rows.push({ outbreak: get('outbreak'), pathogen: get('pathogen'), state, from, to, source: get('source') });
  });
  if (!rows.length) throw Object.assign(new Error('No usable rows. Each row needs a state code, a pathogen and the onset dates.'), { status: 400 });
  const pathogen = [...new Set(rows.map((r) => r.pathogen))].join('; ');
  const hazards = hazardsOf(pathogen).filter((h) => h !== 'Other');
  if (!hazards.length) throw Object.assign(new Error(`No recall hazard matches "${pathogen}". Name the pathogen, for example Salmonella, Listeria or E. coli.`), { status: 400 });
  const source = rows.find((r) => r.source)?.source;
  return {
    outbreak: {
      id: rows.find((r) => r.outbreak)?.outbreak || 'Uploaded report', pathogen, hazards,
      states: [...new Set(rows.map((r) => r.state))].sort(),
      onset_from: rows.map((r) => r.from).sort()[0], onset_to: rows.map((r) => r.to).sort().at(-1)!,
      source: source ? (/^https?:/.test(source) ? source : `https://${source}`) : null,
    },
    rejected,
  };
}

/** Pure. Walks a lot's recalls in date order and records which case states each one reached first. */
export function coverageOf(caseStates: string[], recalls: ChainRecall[]): { coverage: CoverageStep[]; uncovered: string[] } {
  const steps = new Map<string, ChainRecall[]>();
  for (const r of [...recalls].sort((a, b) => a.initiated.localeCompare(b.initiated) || a.id.localeCompare(b.id))) {
    const k = `${r.initiated}|${r.firm}`;
    steps.set(k, [...(steps.get(k) ?? []), r]);
  }
  const covered = new Set<string>();
  const coverage = [...steps.values()].map((rs) => {
    const reached = caseStates.filter((s) => rs.some((r) => r.nationwide || r.states.includes(s)));
    const added = reached.filter((s) => !covered.has(s));
    added.forEach((s) => covered.add(s));
    return { date: rs[0].initiated, firm: rs[0].firm, recalls: rs.map((r) => r.id), reached, added, total: covered.size };
  });
  return { coverage, uncovered: caseStates.filter((s) => !covered.has(s)) };
}

const CASE_QUERIES = {
  matching: `MATCH (f:Firm)-[:RECALLED]->(r:Recall)-[:HAZARD]->(h:Hazard)
WHERE h.name IN $hazards AND r.initiated >= $from
WITH DISTINCT f, r
OPTIONAL MATCH (r)-[:DISTRIBUTED_TO]->(s:State) WHERE s.code IN $states
OPTIONAL MATCH (r)-[:NAMES_LOT]->(l:LotCode)
RETURN f.name AS firm, r.id AS id, r.initiated AS initiated, r.nationwide AS nationwide,
  collect(DISTINCT s.code) AS reached, collect(DISTINCT l.code) AS lots`,
  chains: `MATCH (h:Hazard)<-[:HAZARD]-(m:Recall)-[:NAMES_LOT]->(l:LotCode)
WHERE h.name IN $hazards AND m.initiated >= $from
WITH DISTINCT l
MATCH (l)<-[:NAMES_LOT]-(r:Recall)<-[:RECALLED]-(f:Firm)
WITH l, count(DISTINCT f) AS firms, collect(DISTINCT r) AS rs WHERE firms > 1
UNWIND rs AS r
MATCH (f:Firm)-[:RECALLED]->(r)
OPTIONAL MATCH (r)-[:DISTRIBUTED_TO]->(s:State)
RETURN l.code AS lot, r.id AS id, f.name AS firm, r.product AS product, r.initiated AS initiated, r.quantity AS quantity,
  r.distribution AS distribution, r.nationwide AS nationwide, r.source AS source, collect(s.code) AS states
ORDER BY initiated, id`,
};

/**
 * A public case report checked against the real recall graph. Read-only: finds the recalls of the report's hazards since
 * the first illness, then the lot codes those recalls share across firms, and which case states each recall reached.
 */
export async function checkCaseReport(text: string): Promise<CaseReport> {
  const { outbreak, rejected } = parseCaseReport(text);
  const g = await graph(GRAPH);
  const params = { hazards: outbreak.hazards, from: outbreak.onset_from, states: outbreak.states };
  const m = await timed<{ firm: string; id: string; initiated: string; nationwide: boolean; reached: string[]; lots: string[] }>(g, CASE_QUERIES.matching, params);
  const c = await timed<ChainRecall & { lot: string }>(g, CASE_QUERIES.chains, params);

  const byLot = new Map<string, ChainRecall[]>();
  for (const { lot, ...r } of c.rows) byLot.set(lot, [...(byLot.get(lot) ?? []), { ...r, source: r.source ?? null }]);
  const chains = [...byLot].map(([lot, recalls]): LotChain => {
    const { coverage, uncovered } = coverageOf(outbreak.states, recalls);
    return { lot, firms: [...new Set(recalls.map((r) => r.firm))], recalls, coverage, uncovered,
      days_to_first: days(outbreak.onset_from, coverage[0].date), days_to_last: days(coverage[0].date, coverage.at(-1)!.date) };
  });
  const inChain = new Set(chains.flatMap((ch) => ch.recalls.map((r) => r.id)));

  // One line per firm: its recalls of these hazards, and the case states any of them reached.
  const firms = new Map<string, CaseReport['matching']['top'][number]>();
  for (const r of m.rows) {
    const f = firms.get(r.firm) ?? { firm: r.firm, recalls: [], initiated: r.initiated, nationwide: false, reached: [], in_chain: false };
    f.recalls.push(r.id); f.nationwide ||= r.nationwide; f.in_chain ||= inChain.has(r.id);
    f.initiated = r.initiated < f.initiated ? r.initiated : f.initiated;
    f.reached = [...new Set([...f.reached, ...(r.nationwide ? outbreak.states : r.reached)])].sort();
    firms.set(r.firm, f);
  }
  const top = [...firms.values()].sort((a, b) => b.reached.length - a.reached.length || a.initiated.localeCompare(b.initiated)).slice(0, 8);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    outbreak, rejected,
    matching: { recalls: m.rows.length, firms: firms.size, top },
    lots_read: new Set(m.rows.flatMap((r) => r.lots)).size,
    chains,
    queries: [
      { title: 'Recalls of these hazards since the first illness, with the case states and lot codes each names', cypher: CASE_QUERIES.matching, db_ms: m.db_ms },
      { title: 'Lot codes those recalls share with another firm', cypher: CASE_QUERIES.chains, db_ms: c.db_ms },
    ],
    db_ms: round(m.db_ms + c.db_ms),
  };
}

export type DemoQueryResult = { title: string; cypher: string; rows: Row[]; db_ms: number };
/** Every demo query, run now, with its rows and FalkorDB time. */
export async function runDemoQueries(): Promise<DemoQueryResult[]> {
  const g = await graph(GRAPH);
  const out: DemoQueryResult[] = [];
  for (const [title, cypher] of DEMO_QUERIES) out.push({ title, cypher: cypher.trim().replace(/\n {4}/g, '\n'), ...(await timed(g, cypher)) });
  return out;
}

/** The questions the demo asks of the real graph. */
export const DEMO_QUERIES: [string, string][] = [
  ['Outbreak to firm to recalls: where it shipped vs where people got sick', `
    MATCH (o:Outbreak)-[:LINKED_TO]->(f:Firm)-[:RECALLED]->(r:Recall)
    OPTIONAL MATCH (r)-[:DISTRIBUTED_TO]->(s:State)
    WITH o, f, count(DISTINCT r) AS recalls, collect(DISTINCT s.code) AS shipped
    MATCH (o)-[c:CASES_IN]->(cs:State)
    RETURN o.pathogen AS pathogen, f.name AS firm, recalls, shipped, collect(cs.code + ':' + toString(c.count)) AS cases`],
  ['Sick in a state no recall named (a traceability gap)', `
    MATCH (o:Outbreak)-[:CASES_IN]->(s:State), (o)-[:LINKED_TO]->(f:Firm)
    WHERE NOT (f)-[:RECALLED]->(:Recall)-[:DISTRIBUTED_TO]->(s)
    RETURN o.id AS outbreak, s.code AS state`],
  ['Downstream: who got product from the linked firm', `
    MATCH (a:Firm)-[e:SUPPLIED]->(b:Firm) OPTIONAL MATCH (b)-[:RECALLED]->(r:Recall)
    RETURN a.name AS from, b.name AS to, e.basis AS basis, collect(r.id) AS their_recalls`],
  [`Hazards in real food recalls since ${date(SINCE)}`, `
    MATCH (r:Recall)-[:HAZARD]->(h:Hazard) RETURN h.name AS hazard, count(r) AS recalls,
    sum(CASE WHEN r.classification = 'Class I' THEN 1 ELSE 0 END) AS class_I ORDER BY recalls DESC`],
  ['Firms with repeat Listeria recall events', `
    MATCH (f:Firm)-[:RECALLED]->(r:Recall)-[:HAZARD]->(:Hazard {name: 'Listeria monocytogenes'})
    WITH f, count(DISTINCT r.event_id) AS events, count(r) AS products WHERE events > 1
    RETURN f.name AS firm, f.state AS state, events, products ORDER BY events DESC, products DESC LIMIT 5`],
  ['Recalls caused by a supplier (from the reason text)', `
    MATCH (r:Recall {downstream: true}) RETURN count(r) AS downstream_recalls, count(DISTINCT r.event_id) AS events`],
];

// Case-insensitive: on Windows the drive letter can differ (e: vs E:) between argv and import.meta.url.
if (process.argv[1]?.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const { values } = parseArgs({ options: { fetch: { type: 'boolean', default: false }, show: { type: 'boolean', default: false } } });
  if (values.fetch) console.log(`Fetched ${await fetchRecalls()} openFDA recalls into ${RECALLS_FILE}`);
  if (!values.show || values.fetch) {
    const c = await loadReal();
    console.log(`Loaded graph "${GRAPH}": ${c.recalls} recalls, ${c.firms} firms, ${c.outbreaks} outbreaks, ${c.nodes} nodes, ${c.edges} edges`);
  }
  if (values.show) for (const [title, q] of DEMO_QUERIES) {
    console.log(`\n${title}`);
    console.table((await (await graph(GRAPH)).query(q)).data);
  }
  await close();
}
