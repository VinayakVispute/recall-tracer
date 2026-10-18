import type { minimalRecall } from '../tools/index.js';
import { TRACE_FORWARD, COVERAGE_GAPS, SKU_RECIPIENTS, TRACE_BACKWARD, STORES, INCIDENT_CLASSIFY, RAW_ON_HAND, FINISHED_ON_HAND, HOLD_FINISHED, FIND_COMMON_SOURCE, CASE_PATH, CHOKEPOINTS, MEMORY_READ, MEMORY_WRITE } from '../graph/queries.js';

/** The Cypher behind each MCP tool, shown in the agent trace. */
const CYPHER: Record<string, string[]> = {
  propose_classification: [INCIDENT_CLASSIFY],
  place_hold: [RAW_ON_HAND, FINISHED_ON_HAND, HOLD_FINISHED],
  trace_forward: [TRACE_FORWARD],
  coverage_gaps: [COVERAGE_GAPS],
  unaffected_stores: [SKU_RECIPIENTS],
  minimal_recall: [TRACE_FORWARD, COVERAGE_GAPS, SKU_RECIPIENTS],
  trace_backward: [TRACE_BACKWARD],
  draft_recall_notice: [STORES],
  find_common_source: [FIND_COMMON_SOURCE, CASE_PATH],
  case_path: [CASE_PATH],
  rank_chokepoints: [CHOKEPOINTS],
  recall_memory: [MEMORY_READ],
  record_lessons: [MEMORY_WRITE],
};
/** Steps where the agent decides rather than reads the graph; the UI draws them as decision cards. */
const JUDGEMENT = new Set(['propose_classification', 'minimal_recall', 'ask_coordinator']);

export type ToolCall = {
  id: string; name: string; input: unknown; ms: number; error?: boolean; summary: string; cypher: string[]; turn: number;
  /** FalkorDB's own execution time over the tool's queries, and how many it ran. */
  db_ms: number; queries: number;
  kind?: 'judgement';
  /** recall_memory only: the lessons it read, for the memory panel. */
  lessons?: { from_lot: string; about: string; kind: string; fact: string }[];
};
/** C3. The defaults are a recall run; an outbreak run is TraceEvent<{ cluster }, { outbreak }> (OutbreakEvent in contracts.ts). */
export type TraceEvent<Subject = { lot: string }, Done = { result: RecallResult }> =
  | ({ type: 'start'; model: string } & Subject)
  | { type: 'note'; text: string; turn: number }
  | { type: 'tool_start'; id: string; name: string; input: unknown; turn: number }
  | { type: 'tool_end'; call: ToolCall }
  | ({ type: 'done' } & Done)
  | { type: 'error'; message: string };
/** What an MCP tools/call returns. */
export type McpOutput = { content: unknown; isError?: boolean };
export type Recall = Awaited<ReturnType<typeof minimalRecall>>;

/** One line per tool result, for the trace timeline. */
function summarize(name: string, r: any): string {
  switch (name) {
    case 'propose_classification': return `Proposed Class ${r.class}, ${r.depth}-level recall. Awaiting confirmation`;
    case 'place_hold': return `${r.totals.units.toLocaleString()} units and ${r.totals.raw_kg} kg of raw ${r.lot} held at ${r.totals.locations} location${r.totals.locations === 1 ? '' : 's'}`;
    case 'trace_forward': return `${r.batches.length} batches, ${r.product_lots.length} product lots, ${r.stores.length} stores reached`;
    case 'coverage_gaps': return r.gaps.length ? `${r.gaps.length} stores got ${[...new Set(r.gaps.map((g: any) => g.product))].join(', ')} with no lot code on the delivery record` : 'Every delivery of the affected products has a lot code';
    case 'unaffected_stores': return `${r.stores.length} stores proven safe`;
    case 'minimal_recall': return `${r.counts.targeted} of ${r.counts.blanket} stores, ${r.units_to_pull.toLocaleString()} units${r.gaps.length ? `; ${r.gaps.length} gap stores ${r.add_gap_stores ? 'added' : 'flagged only'}` : ''}`;
    case 'trace_backward': return `${r.results.length} product lots walked back; ${r.containing?.length ?? 0} contain ${r.lot ?? 'the lot'}`;
    case 'draft_recall_notice': return `${r.drafted} notices drafted, pending approval`;
    case 'find_common_source': return r.summary;
    case 'case_path': return `${Object.keys(r.paths).length - r.unexplained.length} of ${Object.keys(r.paths).length} cases reached by ${r.lot}`;
    case 'rank_chokepoints': return r.nodes.length ? `${r.nodes[0].id} is the chokepoint: betweenness ${r.nodes[0].score}, ${r.nodes[0].stores} stores downstream` : 'No node carries more paths than another';
    case 'recall_memory': return r.lessons.length ? `${r.lessons.length} lessons from earlier incidents (${[...new Set(r.lessons.map((l: any) => l.from_lot))].join(', ')})` : 'No lessons from earlier incidents';
    case 'ask_coordinator': return `${r.answered_by === 'coordinator' ? 'Coordinator chose' : 'No answer; default applied:'} ${r.label ?? r.choice}`;
    case 'record_lessons': return `${r.saved.length} lessons saved for future incidents${r.unknown.length ? `; ${r.unknown.length} unknown ids dropped` : ''}`;
    default: return '';
  }
}

/** The one place an MCP result becomes a ToolCall. `parsed` is set iff the call succeeded. */
export function toToolCall(id: string, name: string, input: unknown, turn: number, ms: number, out: McpOutput) {
  // A local tool (ask_coordinator) returns its object as is; an MCP tool wraps JSON text in content.
  const text = Array.isArray(out.content) ? (out.content as { text?: string }[]).map((c) => c.text ?? '').join('') : JSON.stringify(out);
  let summary = text.slice(0, 200), db_ms = 0, queries = 0, parsed: any;
  if (!out.isError) {
    parsed = JSON.parse(text);
    if (name === 'ask_coordinator') parsed.label = (input as { options?: { value: string; label: string }[] })?.options?.find((o) => o.value === parsed.choice)?.label;
    ({ db_ms = 0, queries = 0 } = parsed);
    summary = summarize(name, parsed);
  }
  const call: ToolCall = { id, name, input, ms, error: !!out.isError, summary, cypher: CYPHER[name] ?? [], turn,
    db_ms, queries, ...(JUDGEMENT.has(name) ? { kind: 'judgement' as const } : {}),
    ...(name === 'recall_memory' && parsed ? { lessons: parsed.lessons.map(({ from_lot, about, kind, fact }: any) => ({ from_lot, about, kind, fact })) } : {}) };
  return { call, parsed, text };
}

export type Meta = { model: string; ms: number; turns: number; input_tokens: number; output_tokens: number; notes: { turn: number; text: string }[] };

/** Final JSON comes from the graph's tool output; Claude contributes the summary and the decisions. */
export function toResult(lot: string, r: Recall, summary: string, tool_calls: ToolCall[], meta?: Meta) {
  return {
    lot,
    affected: r.recall_stores.filter((s) => s.kind === 'affected').map((s) => ({ store: s.store, path: s.paths, units: s.units })),
    gaps: r.gaps.map((g) => ({ store: g.store, sku: g.sku, reason: g.reason, units: g.units, added_to_recall: r.add_gap_stores })),
    safe: r.safe,
    counts: { blanket: r.counts.blanket, targeted: r.counts.targeted, safe: r.counts.safe },
    batches: r.batches,
    product_lots: r.product_lots,
    units_to_pull: r.units_to_pull,
    add_gap_stores: r.add_gap_stores,
    summary,
    tool_calls,
    meta,
    finished_at: new Date().toISOString(),
  };
}
export type RecallResult = ReturnType<typeof toResult>;
