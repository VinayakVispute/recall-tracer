import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { minimalRecall } from '../tools/index.js';
import { TRACE_FORWARD, COVERAGE_GAPS, SKU_RECIPIENTS, TRACE_BACKWARD, STORES, INCIDENT_CLASSIFY, RAW_ON_HAND, FINISHED_ON_HAND, HOLD_FINISHED, INCIDENT_GET, LOT_INFO } from '../graph/queries.js';
import { query } from '../graph/db.js';

const MODEL = 'claude-opus-5-5';
const SYSTEM = readFileSync(new URL('./prompt.md', import.meta.url), 'utf8');
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

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
};

let mcp: Promise<Client> | undefined;

/** One MCP server process per API process; the agent only sees tools through it. */
export function mcpClient() {
  return (mcp ??= (async () => {
    const client = new Client({ name: 'recall-tracer-agent', version: '0.1.0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/mcp/server.ts'],
      cwd: ROOT,
      env: process.env as Record<string, string>,
    }));
    return client;
  })());
}

export async function closeAgent() {
  if (mcp) await (await mcp).close();
  mcp = undefined;
}

export type ToolCall = { id: string; name: string; input: unknown; ms: number; error?: boolean; summary: string; cypher: string[]; turn: number };
export type TraceEvent =
  | { type: 'start'; lot: string; model: string }
  | { type: 'note'; text: string; turn: number }
  | { type: 'tool_start'; id: string; name: string; input: unknown; turn: number }
  | { type: 'tool_end'; call: ToolCall }
  | { type: 'done'; result: RecallResult }
  | { type: 'error'; message: string };
type Recall = Awaited<ReturnType<typeof minimalRecall>>;

/** One line per tool result, for the trace timeline. */
function summarize(name: string, r: any): string {
  switch (name) {
    case 'propose_classification': return `Proposed Class ${r.class}, ${r.depth}-level recall. Awaiting confirmation`;
    case 'place_hold': return `${r.totals.units.toLocaleString()} units and ${r.totals.raw_kg} kg of raw ${r.lot} held at ${r.totals.locations} locations`;
    case 'trace_forward': return `${r.batches.length} batches, ${r.product_lots.length} product lots, ${r.stores.length} stores reached`;
    case 'coverage_gaps': return r.gaps.length ? `${r.gaps.length} stores got ${[...new Set(r.gaps.map((g: any) => g.product))].join(', ')} with no lot code on the delivery record` : 'Every delivery of the affected products has a lot code';
    case 'unaffected_stores': return `${r.stores.length} stores proven safe`;
    case 'minimal_recall': return `${r.counts.targeted} of ${r.counts.blanket} stores, ${r.units_to_pull.toLocaleString()} units; gaps ${r.add_gap_stores ? 'added' : 'flagged only'}`;
    case 'trace_backward': return `${r.results.length} product lots walked back; ${r.containing?.length ?? 0} contain ${r.lot ?? 'the lot'}`;
    case 'draft_recall_notice': return `${r.drafted} notices drafted, pending approval`;
    default: return '';
  }
}

export async function runAgent(lot: string, onEvent: (e: TraceEvent) => void = () => {}) {
  const client = new Anthropic();
  const mcpc = await mcpClient();
  const { tools: mcpTools } = await mcpc.listTools();
  const tools: Anthropic.Beta.BetaTool[] = mcpTools.map((t) => ({
    name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
  }));

  const t0 = Date.now();
  const [[info], [incident]] = await Promise.all([
    query<{ ingredient: string; supplier: string }>(LOT_INFO, { lot }),
    query<{ hazard: string; reported_at: string }>(INCIDENT_GET, { lot }),
  ]);
  const alert = `Supplier notice for lot ${lot} (${info?.ingredient ?? 'ingredient'} from ${info?.supplier ?? 'the supplier'}). ` +
    `Hazard: ${incident?.hazard ?? 'contamination, type not stated'}. Reported ${incident?.reported_at ?? new Date().toISOString()}.`;
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: alert }];
  const calls: ToolCall[] = [];
  const notes: { turn: number; text: string }[] = [];
  const usage = { input_tokens: 0, output_tokens: 0 };
  let recall: Recall | undefined;
  onEvent({ type: 'start', lot, model: MODEL });

  for (let turn = 0; turn < 14; turn++) {
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      tools,
      messages,
      thinking: { type: 'adaptive', display: 'updates' }, // short progress notes between tool calls, for the trace
      output_config: { effort: 'low' }, // fixed tool sequence; low effort keeps the run well under 60 s
      betas: ['server-side-fallback-2026-07-01', 'thinking-display-updates-2026-08-18'],
      fallbacks: 'default',
    } as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming);
    messages.push({ role: 'assistant', content: res.content });
    usage.input_tokens += res.usage.input_tokens;
    usage.output_tokens += res.usage.output_tokens;

    if (res.stop_reason === 'refusal') throw new Error('Model declined the request');
    for (const b of res.content as any[]) {
      const text = b.type === 'thinking' ? b.thinking : b.type === 'text' && res.stop_reason === 'tool_use' ? b.text : '';
      if (text?.trim()) { notes.push({ turn, text: text.trim() }); onEvent({ type: 'note', text: text.trim(), turn }); }
    }
    if (res.stop_reason !== 'tool_use') {
      const summary = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
      if (!recall) throw new Error(`Agent finished without calling minimal_recall: ${summary}`);
      const result = toResult(lot, recall, summary, calls, { model: res.model ?? MODEL, ms: Date.now() - t0, turns: turn + 1, ...usage, notes });
      onEvent({ type: 'done', result });
      return result;
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const b of res.content) {
      if (b.type !== 'tool_use') continue;
      onEvent({ type: 'tool_start', id: b.id, name: b.name, input: b.input, turn });
      const s = Date.now();
      const out = await mcpc.callTool({ name: b.name, arguments: b.input as Record<string, unknown> });
      const text = (out.content as { type: string; text: string }[]).map((c) => c.text).join('');
      let summary = text.slice(0, 200);
      if (!out.isError) {
        const parsed = JSON.parse(text);
        summary = summarize(b.name, parsed);
        if (b.name === 'minimal_recall') recall = parsed;
      }
      const call: ToolCall = { id: b.id, name: b.name, input: b.input, ms: Date.now() - s, error: !!out.isError, summary, cypher: CYPHER[b.name] ?? [], turn };
      calls.push(call);
      onEvent({ type: 'tool_end', call });
      results.push({ type: 'tool_result', tool_use_id: b.id, content: text, is_error: !!out.isError });
    }
    messages.push({ role: 'user', content: results });
  }
  throw new Error('Agent did not finish in 14 turns');
}

type Meta = { model: string; ms: number; turns: number; input_tokens: number; output_tokens: number; notes: { turn: number; text: string }[] };

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
