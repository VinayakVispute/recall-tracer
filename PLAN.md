# Recall Tracer: Implementation Plan

Source of truth: `../Recall Tracer Build Spec.md`. This file records only how we build it and where we deviate.

## Environment (verified Oct 16)

- FalkorDB `falkordb/falkordb:latest` (graph module v6.0.2) in Docker as container `falkordb`, host port **6380** (6379 is taken by another project's Redis), Browser on **3001** (3000 is used by another local app), volume `falkordb_data`, `--restart unless-stopped`.
- Multi-type variable-length patterns (`[:A|B*1..8]`) work → spec queries used as written.
- Node client `falkordb@6`: `FalkorDB.connect({socket:{host,port}})`, `db.selectGraph('recall')`, `graph.query(cypher, {params})`.
- Node 24, Bun 1.3, TypeScript, Vitest.

## Build order

| # | Step | Done when |
|---|------|-----------|
| 1 | `src/graph/db.ts`, `src/graph/queries.ts` | connects, all Cypher in one file |
| 2 | `src/data/generate.ts` (seeded, pure `build(seed)` + `load()`), writes `data/expected.json` | L-204 trace = 4 batches / 7 product lots / 31 stores |
| 3 | `src/tools/*` (5 handlers + zod schemas) | Vitest acceptance tests green |
| 4 | `src/mcp/server.ts` (stdio) | MCP client lists 5 tools and calls one |
| 5 | `src/agent/run.ts` + `prompt.md` (MCP client → Claude tool loop) | `POST /recall` < 60 s, counts match |
| 6 | `src/api/server.ts` (Hono, :8787) | all 5 routes respond |
| 7 | `web/` (Vite + React + cytoscape) | page runs the demo end to end |
| 8 | README (graph model, Cypher per tool, AI disclosure) | — |

## Planted data layout (seed 42)

- Bad lot L-204 (diced carrot, S-03) → B-03, B-05, B-07; B-03 also uses clean L-117; B-03 `REWORKED_INTO` B-09; decoy L-205 (same ingredient/supplier) → B-04, B-06.
- Affected SKUs P-01..P-03. Affected product lots: B-03→2, B-05→2, B-07→2, B-09→1 = 7.
- 75 stores shuffled by seed: 31 affected, 2 gap (`SHIPPED_UNTRACKED` of P-02), 38 safe (only clean lots of P-01..P-03), 4 untouched (other SKUs only). Blanket = 71.

## Decisions / deviations

- **Gap policy is a tool argument.** `minimal_recall(lot, add_gap_stores=true)`. Default auto-adds (targeted 33); `false` flags only (targeted 31, gaps listed separately). **User confirmed auto-add (Oct 16).**
- **Final JSON is assembled from tool results, not retyped by Claude.** `run.ts` keeps the `minimal_recall` output and adds Claude's summary + gap reasons + the tool-call trace. Faster, and the graph stays the only source of truth.
- `draft_recall_notice` input is `{lot, notices:[{store, reason}]}` (one reason per store).
- FDA CSV uses Shipping-tab KDE names from the FDA template (TLC, quantity, unit, product, ship-to, ship-from, ship date, TLC source, reference doc). Gap rows have an empty TLC.

## Tests

`tests/tools.test.ts` covers every acceptance item in the spec. The end-to-end `/recall` test runs only when `ANTHROPIC_API_KEY` is set.
