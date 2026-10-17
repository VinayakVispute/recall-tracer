// Shapes shared across lanes. Change one only after telling the lanes that read it.

// C1 (Dev A): outbreak cases in the graph.
// (Cluster)-[:HAS_CASE]->(Case)-[:BOUGHT_AT {date}]->(Store)
export type Cluster = { id: string; pathogen: string; opened_at: string };
export type Case = { id: string; region: string; onset: string; reported_at: string; sku?: string };
/** A case as it enters the system: the graph fields plus where and when the person bought the food. */
export type CaseInput = Case & { store: string; bought_at: string };

// C2 (Dev B): what find_common_source returns.
export type Candidate = {
  lot: string;
  ingredient: string;
  supplier: string;
  supplier_name: string;
  cases_explained: number;
  explained: string[];
  stores_reached: number;
  /** cases_explained / stores_reached: a lot that reached fewer stores to explain the same cases is the sharper suspect. */
  specificity: number;
};
export type OutbreakResult = {
  cluster: string;
  total_cases: number;
  candidates: Candidate[];
  /** For the top candidate: each case's path from the lot to the store, as node ids. */
  paths: Record<string, string[][]>;
  summary: string;
};

// C3 (Dev B): the SSE stream. TraceEvent and ToolCall live in src/agent/run.ts;
// every tool_end carries db_ms (FalkorDB's own execution time) and queries.
import type { TraceEvent } from './agent/run.js';
export type { TraceEvent, ToolCall } from './agent/run.js';
/** C3 for an outbreak run: start carries the cluster, done carries the C2 result. */
export type OutbreakEvent = TraceEvent<{ cluster: string }, { outbreak: OutbreakResult }>;

// B5 (Dev B): one row per incident, for Page 7 History.
export type { IncidentSummary } from './tools/incident.js';
