# Recall Tracer

When a supplier reports a contaminated ingredient lot, most food companies can't say which stores got it, so they recall everything. Recall Tracer is an agent that follows the lot through a FalkorDB graph of batches, rework and shipments. It finds every affected store with the path that proves it, proves which stores are safe, widens the recall where records are missing, and drafts notices for a human to approve.

Built for [Graph Hacks: Context for AI Agents](https://www.wemakedevs.org/hackathons/falkordb), Track 01 (agents that act on connected data).

**Demo, seeded data, lot L-204:**

| | |
|---|---|
| Reached | 4 batches (one blends L-204 with clean L-117; B-09 reuses leftovers of B-03), 7 product lots, 31 stores |
| Gaps | 2 stores got the affected SKU P-02 with no lot code recorded, so they're added with the reason |
| Safe | 38 stores got the same SKUs, but only from lots that don't trace to L-204, each listed with the lots checked |
| Result | Blanket recall 71 stores vs targeted 33; 2,232 units to pull; 33 draft notices awaiting approval; FDA-style shipping CSV |

## How it works

```text
React page ──> Hono API ──> agent (Claude) ──MCP stdio──> MCP server ──> tools ──Cypher──> FalkorDB
```

- **The graph decides; Claude doesn't.** Which stores are affected, gaps or safe comes only from Cypher results. Claude picks the tools, makes the gap decision, explains the result and writes the notice reasons. The API's final JSON is built from the `minimal_recall` tool output, not retyped by the model.
- **Tools go through MCP.** The agent starts the project's own MCP server (`src/mcp/server.ts`) as a stdio child process, lists its tools and hands them to Claude. The same server works in Claude Code or Claude Desktop (`.mcp.json` is included).
- **Gap detection is the agent's decision.** `minimal_recall` takes `add_gap_stores`. The agent adds gap stores (policy: missing product is worse than pulling a few extra units); `false` only flags them.
- **Humans approve.** Notices are written to `out/notices.json` as `pending_approval`. Approving changes their status; nothing is ever sent.

## Graph model

Graph name `recall`. All ids are strings and dates are ISO strings.

| Node | Properties |
|---|---|
| `Supplier` | `id`, `name` |
| `Lot` | `code` (e.g. L-204), `ingredient`, `received_at`, `supplier_id` |
| `Batch` | `id` (e.g. B-03), `produced_at`, `site` |
| `Product` | `sku`, `name` |
| `ProductLot` | `id` (traceability lot code, e.g. TLC-03A), `sku`, `produced_at` |
| `Store` | `id`, `name`, `city`, `region` |

| Edge | Properties | Meaning |
|---|---|---|
| `(Supplier)-[:SUPPLIED]->(Lot)` | | Who sent the lot |
| `(Lot)-[:USED_IN]->(Batch)` | `qty_kg` | Lot blended into a batch |
| `(Batch)-[:REWORKED_INTO]->(Batch)` | `qty_kg` | Leftovers reused in a later batch |
| `(Batch)-[:PRODUCED]->(ProductLot)` | `units` | Batch split into product lots |
| `(ProductLot)-[:OF]->(Product)` | | Which SKU |
| `(ProductLot)-[:SHIPPED_TO]->(Store)` | `units`, `shipped_at` | Shipment with the lot code recorded |
| `(Product)-[:SHIPPED_UNTRACKED]->(Store)` | `units`, `shipped_at` | Shipment where the lot code wasn't recorded (a gap) |

There are indexes on `Lot.code`, `Batch.id`, `ProductLot.id`, `Product.sku`, `Store.id` and `Supplier.id`. Edges only point forward in time, so the graph has no cycles and bounded variable-length matches are safe.

## The dashboard

The page is built for a recall coordinator in the first hour of an incident.

- **Incident header**: the lot, ingredient and supplier, plus progress through Traced → Gaps decided → Safe stores verified → Notices drafted → Approved.
- **Headline numbers**: stores to recall vs blanket, with one tick per store; units to pull vs a blanket recall (2,232 vs 7,311, a 69% saving); spread; stores that can't be cleared; stores proven safe.
- **How the lot spread**: a flow diagram of units from the lot through batches and rework to product lots and states, with a hatched band for shipments with no lot code. A second tab shows every record as a network you can click.
- **Where it went**: a map of states drawn as tiles, with recall, gap and safe counts. Click a state to filter the store table.
- **Exposure window**: every affected shipment by date and product, and how long the oldest product has been on shelves.
- **Store table**: all 71 stores, with status, lots received, units at risk, last shipment and notice status. You can filter and search it.
- **Evidence drawer**: click a store to see why. For a recalled store it shows the chain of records with quantities and dates (lot → batch → rework → product lot → shipment). For a gap store it shows the missing record. For a safe store it shows each lot it holds, traced back to its ingredients.
- **Agent trace**: streams live as the agent works. You see Claude's short notes, each MCP tool call with its input, its result in one line, its timing and its Cypher, the gap decision, and the conclusion.
- **Notices**: an approval queue grouped by state, plus the FDA CSV export.

All the dashboard data comes from `GET /incident/:lot`, which reads the graph without calling Claude. Store statuses come from `minimal_recall`, so the dashboard and the agent always agree.

## Tools and their Cypher

All Cypher is in [`src/graph/queries.ts`](src/graph/queries.ts) and the handlers are in [`src/tools/index.ts`](src/tools/index.ts).

**`trace_forward(lot)`** returns every store reached, with the full path. The handler groups by store, collects the batches and product lots on the paths, and sums units per shipment.

```cypher
MATCH path = (l:Lot {code: $lot})-[:USED_IN|REWORKED_INTO|PRODUCED|SHIPPED_TO*1..8]->(st:Store)
RETURN st.id AS store,
       [n IN nodes(path) | coalesce(n.code, n.id)] AS path,
       [n IN nodes(path) | labels(n)[0]] AS kinds,
       last(relationships(path)).units AS units
```

**`coverage_gaps(lot)`** returns stores that got an affected SKU through a shipment with no lot code. The handler drops stores already found by `trace_forward` and writes the reason.

```cypher
MATCH (:Lot {code: $lot})-[:USED_IN|REWORKED_INTO|PRODUCED*1..6]->(pl:ProductLot)
WITH collect(DISTINCT pl.sku) AS skus
MATCH (p:Product)-[u:SHIPPED_UNTRACKED]->(st:Store)
WHERE p.sku IN skus
RETURN st.id AS store, p.sku AS sku, p.name AS product, u.units AS units, u.shipped_at AS shipped_at
```

**`unaffected_stores(lot)`** returns every store that got an affected SKU, minus the affected and gap stores. Each store lists the lots it received with `reachable_from_bad_lot: false`; the handler fails loudly if a safe store holds an affected lot.

```cypher
MATCH (:Lot {code: $lot})-[:USED_IN|REWORKED_INTO|PRODUCED*1..6]->(pl:ProductLot)
WITH collect(DISTINCT pl.sku) AS skus
MATCH (pl2:ProductLot)-[:SHIPPED_TO]->(st:Store)
WHERE pl2.sku IN skus
RETURN st.id AS store, collect(DISTINCT pl2.id) AS received_lots
```

**`minimal_recall(lot, add_gap_stores = true)`** combines the three tools above: `recall_stores` (affected plus gap stores), `units_to_pull`, and `blanket`, `targeted` and `safe` counts. Blanket means every store that received any affected SKU.

**`trace_backward(product_lots, lot?)`** walks product lots back to every ingredient lot in them, including through rework. The agent uses it to verify the safe stores independently of `trace_forward`: none of the lots they hold may contain the bad lot.

```cypher
MATCH (l:Lot)-[:USED_IN]->(:Batch)-[:REWORKED_INTO*0..3]->(:Batch)-[:PRODUCED]->(pl:ProductLot)
WHERE pl.id IN $product_lots
RETURN pl.id AS product_lot, collect(DISTINCT l.code) AS ingredient_lots
```

**`draft_recall_notice(lot, notices[{store, reason}])`** looks up the store details and saves one draft per store with status `pending_approval`. It never sends anything.

```cypher
MATCH (st:Store) WHERE st.id IN $ids RETURN st.id AS id, st.name AS name, st.city AS city, st.region AS region
```

**FDA export** (`GET /export/L-204.csv`) has one row per affected shipment, plus one row per gap shipment with an empty lot code. Columns follow the Shipping tab of the FDA's [sortable spreadsheet template](https://www.fda.gov/food/food-safety-modernization-act-fsma/fsma-final-rule-requirements-additional-traceability-records-certain-foods).

```cypher
MATCH (:Lot {code: $lot})-[:USED_IN|REWORKED_INTO*1..4]->(b:Batch)-[:PRODUCED]->(pl:ProductLot)-[s:SHIPPED_TO]->(st:Store),
      (pl)-[:OF]->(p:Product)
RETURN DISTINCT pl.id AS tlc, p.name AS product, s.units AS units, s.shipped_at AS shipped_at,
       st.id AS store, st.name AS store_name, st.city AS city, st.region AS region, b.site AS site
ORDER BY tlc, store
```

## Demo video

[`demo/recall-tracer-demo.mp4`](demo/recall-tracer-demo.mp4) is a 108-second captioned walkthrough of one live run, from the alert to the CSV export.

## Run it with one command

Needs Docker and an Anthropic API key.

```bash
cp .env.example .env            # add ANTHROPIC_API_KEY
docker compose up --build       # FalkorDB + app; seeds the demo graph on start
```

Open http://localhost:8787 (set `APP_PORT` to use another port). The same `Dockerfile` deploys to any container host. Point `FALKORDB_HOST`/`FALKORDB_PORT` at a FalkorDB instance (for example FalkorDB Cloud) and set `ANTHROPIC_API_KEY`.

## Run it for development

Needs Docker, Node 22+ and pnpm.

```bash
docker run -d --name falkordb -p 6380:6379 -p 3001:3000 falkordb/falkordb:latest
pnpm install
cp .env.example .env          # add ANTHROPIC_API_KEY; FALKORDB_PORT=6380
pnpm generate --seed 42 --reset
pnpm test                     # 14 tests; the end-to-end one runs only with an API key
pnpm dev                      # API on :8787, page on http://localhost:5173
```

Enter `L-204` and press **Trace**. FalkorDB Browser on http://localhost:3001 shows the raw graph. For one-port production use, run `pnpm build && pnpm start` and open http://localhost:8787.

To use the tools from Claude Code in this folder, the included `.mcp.json` registers the `recall-tracer` MCP server.

### API

| Method | Path | Does |
|---|---|---|
| POST | `/recall` | Body `{lot}`. Runs the agent and returns the recall decision as JSON. Returns 404 without calling Claude if the lot isn't in the graph |
| GET | `/recall/last` | The last decision, so a page reload doesn't rerun the agent |
| GET | `/recall/stream?lot=` | Runs the agent and streams each step as Server-Sent Events (`note`, `tool_start`, `tool_end`, `done`) |
| GET | `/incident/:lot` | Dashboard data straight from the graph: lineage with quantities, every store's shipments, where each lot came from. Add `?gaps=flag` for flag-only mode |
| GET | `/graph/:lot` | Cytoscape nodes and edges for affected paths, gap stores and safe stores |
| GET | `/notices` | Draft notices with their status |
| POST | `/notices/approve` | Body `{stores}`. Marks them `approved`; nothing is sent |
| GET | `/export/:lot.csv` | FDA-style shipping records |

## Data

`src/data/generate.ts` builds a seeded synthetic graph: 8 suppliers, 20 lots, 15 batches, 10 products, 29 product lots, 75 stores, 158 nodes and 344 edges. The planted cases (bad lot, blend, rework, decoy lot L-205, gap, untouched stores) are hard-coded and everything else is randomised by `seedrandom`, so the same seed always gives the same graph. All company, store and supplier names are fictional. The generator writes `data/expected.json`, and the tests assert against it.

## Tests

`tests/tools.test.ts` covers the spec's acceptance list:
- the same seed gives the same graph
- the trace finds exactly 4 batches, 7 product lots and 31 stores
- rework is traced and the decoy lot isn't
- there are exactly 2 gap stores
- 38 safe stores, none of them in the recall
- blanket 71, targeted 33, safe 38, and flag-only mode gives 31
- the backward trace independently finds only the 7 affected product lots containing L-204
- the dashboard's incident report agrees with the tools, store by store
- 33 drafts are written
- bad input gets a 400 and an unknown lot a 404, without calling Claude
- the CSV has one row per shipment plus the gap rows
- the graph data and the approval step work
- `POST /recall` runs end to end in under 60 seconds, with all five steps in order, each with a summary and its Cypher

## AI disclosure

This project was built with AI coding help (Claude Code, Claude Opus 5.5) during the event, Oct 15–18 2026: scaffolding, the generator, tool handlers, the MCP server, the agent loop, the UI and this README. The team reviewed the code and can explain every part of it. At runtime the agent uses Claude (`claude-opus-5-5`) through the Anthropic API.

## Limits

- Synthetic data only; there's no real company data.
- No login. Notices are never sent; approval only changes their status.
- No dilution or risk scoring: any path from the bad lot counts as affected.
