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
};

export async function loadReal() {
  const { recalls } = JSON.parse(readFileSync(RECALLS_FILE, 'utf8')) as { recalls: Recall[] };
  const { outbreaks, supplied } = JSON.parse(readFileSync(OUTBREAKS_FILE, 'utf8')) as Outbreaks;
  const g = await graph(GRAPH);
  await g.delete().catch(() => {}); // fails only if the graph does not exist yet; a full reload keeps this idempotent
  for (const q of ['CREATE INDEX FOR (f:Firm) ON (f.name)', 'CREATE INDEX FOR (r:Recall) ON (r.id)', 'CREATE INDEX FOR (s:State) ON (s.code)',
    'CREATE INDEX FOR (h:Hazard) ON (h.name)', 'CREATE INDEX FOR (o:Outbreak) ON (o.id)']) await g.query(q);
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
      reported: r.reported, voluntary: r.voluntary, nationwide: r.nationwide, downstream: r.downstream})`, recalls);
  await run('UNWIND $rows AS r UNWIND r.hazards AS h MATCH (x:Recall {id: r.id}), (z:Hazard {name: h}) CREATE (x)-[:HAZARD]->(z)', recalls);
  await run('UNWIND $rows AS r UNWIND r.states AS s MATCH (x:Recall {id: r.id}), (z:State {code: s}) CREATE (x)-[:DISTRIBUTED_TO]->(z)', recalls);
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
async function timed<T = Row>(g: Awaited<ReturnType<typeof graph>>, cypher: string) {
  const res = await g.query<T>(cypher);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
