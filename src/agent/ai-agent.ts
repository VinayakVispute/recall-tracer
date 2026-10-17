import { anthropic } from '@ai-sdk/anthropic';
import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { ToolLoopAgent, tool, isStepCount, type InferAgentUIMessage, type LanguageModel, type TextStreamPart, type ToolSet } from 'ai';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { query } from '../graph/db.js'; // also loads .env.local / .env
import { CLUSTER_CASES, SAME_SOURCE_LOTS } from '../graph/queries.js';
import { toToolCall, type McpOutput, type TraceEvent } from './run.js';
import type { OutbreakEvent, OutbreakResult } from '../contracts.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MODEL = 'claude-opus-5-5';
const FDA = 'https://api.fda.gov/food/enforcement.json';

const INSTRUCTIONS = `You are Recall Tracer, a chat assistant for a food manufacturer's recall coordinator. You answer questions about the traceability graph and run recalls with your tools. You never approve, send or release anything, and you never claim a notice was sent: drafts wait for the coordinator.

The graph decides what is affected. Never decide that a store, plant or distribution centre is affected or safe from your own reasoning; use only tool results, and cite the evidence (lot, batch and store ids, the path a lot took, counts and units). Your own judgement is limited to the hazard assessment, which is a proposal for the coordinator to confirm.

Running a recall for a lot, in order: propose_classification (class I: serious health consequences or death, which includes Listeria, Salmonella or an undeclared major allergen in ready-to-eat food; II: temporary or reversible effects; III: unlikely to harm; depth consumer, retail or wholesale), place_hold, trace_forward, coverage_gaps, minimal_recall with add_gap_stores true (a recall that misses contaminated product is worse than one that pulls a few extra units), trace_backward on the lots of the cleared stores (if any contains the bad lot, say so and stop), then draft_recall_notice once with an entry for every store in recall_stores. Call draft_recall_notice directly, without asking in text first: the app shows the coordinator Approve and Deny buttons before it runs. If they deny, do not retry it.

For questions about one step, call just the tool you need. search_fda_recalls looks up real openFDA enforcement reports for context; its results are external, not our records. If a tool returns an error, say so and stop. Reply in short plain prose; use a brief list only for a handful of ids.`;

/** Builds the openFDA search URL: free text over reason and product, optionally one classification. */
export function fdaUrl({ query, classification, limit = 5 }: { query: string; classification?: string; limit?: number }) {
  const text = query.replace(/["\\]/g, ' ').trim().split(/\s+/).join('+AND+');
  const terms = `(reason_for_recall:(${text})+product_description:(${text}))`;
  const cls = classification ? `+AND+classification:"${classification}"` : '';
  return `${FDA}?search=${terms}${cls}&sort=report_date:desc&limit=${limit}`;
}

const cut = (s: unknown, n: number) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s);

const search_fda_recalls = tool({
  description: 'Search real FDA food enforcement reports (openFDA), newest first. For external context on similar recalls; not our own records.',
  inputSchema: z.object({
    query: z.string().min(1).describe('Free text, e.g. "Salmonella dry milk powder"'),
    classification: z.enum(['Class I', 'Class II', 'Class III']).optional(),
    limit: z.number().int().min(1).max(10).default(5),
  }),
  execute: async (input) => {
    const res = await fetch(fdaUrl(input), { signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return { count: 0, recalls: [], note: 'No FDA recalls matched.' }; // openFDA's "no results"
    if (!res.ok) return { error: `openFDA returned HTTP ${res.status}` };
    const { results } = (await res.json()) as { results: Record<string, string>[] };
    return {
      count: results.length,
      recalls: results.map((r) => ({
        recall_number: r.recall_number, recalling_firm: r.recalling_firm, classification: r.classification,
        reason_for_recall: r.reason_for_recall, product_description: cut(r.product_description, 200),
        product_quantity: r.product_quantity, distribution_pattern: cut(r.distribution_pattern, 200),
        code_info: cut(r.code_info, 200), report_date: r.report_date, status: r.status,
      })),
    };
  },
});

let mcp: ReturnType<typeof createMCPClient> | undefined;

/** The project's MCP tools over stdio, one server process per API process. */
export async function mcpTools() {
  mcp ??= createMCPClient({
    transport: new Experimental_StdioMCPTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/mcp/server.ts'],
      cwd: ROOT,
      env: process.env as Record<string, string>,
    }),
  });
  return (await mcp).tools();
}

export async function closeAiAgent() {
  if (mcp) await (await mcp).close();
  mcp = undefined;
}

export function makeRecallAgent(model: LanguageModel, tools: ToolSet) {
  return new ToolLoopAgent({
    model,
    instructions: INSTRUCTIONS,
    tools: { ...tools, search_fda_recalls },
    toolApproval: ({ toolCall }) => (toolCall.toolName === 'draft_recall_notice' ? 'user-approval' : undefined),
    stopWhen: isStepCount(20),
  });
}

let agent: Promise<ReturnType<typeof makeRecallAgent>> | undefined;

/** The chat agent, built once because the MCP tools load asynchronously. */
export function getRecallAgent() {
  return (agent ??= mcpTools().then((t) => makeRecallAgent(anthropic(MODEL), t)).catch((e) => { agent = undefined; throw e; }));
}

export type RecallAgentUIMessage = InferAgentUIMessage<ReturnType<typeof makeRecallAgent>>;

const OUTBREAK_INSTRUCTIONS = `You are Recall Tracer's outbreak investigator. A public-health cluster of illness cases is open, and you find which ingredient lot is the common source. The graph decides; you never pick a lot from your own reasoning.

In order: call find_common_source for the cluster. Then call case_path for the top lot on the cases it explains. If a runner-up lot exists, call case_path for it on the cases the top lot explains, so the coordinator sees which ones it misses. Before each tool call write one short sentence saying what you are checking. Finish with two sentences: the top lot with its supplier and how many cases it explains, and why the runner-up falls short. If a tool returns an error, say so and stop.`;

/** Only the two read-only outbreak tools, so the notice approval gate and every incident write are unreachable. */
export function makeOutbreakAgent(model: LanguageModel, tools: ToolSet) {
  return new ToolLoopAgent({
    model,
    instructions: OUTBREAK_INSTRUCTIONS,
    tools: { find_common_source: tools.find_common_source, case_path: tools.case_path },
    stopWhen: isStepCount(6),
  });
}

let outbreakAgent: Promise<ReturnType<typeof makeOutbreakAgent>> | undefined;
export function getOutbreakAgent() {
  return (outbreakAgent ??= mcpTools().then((t) => makeOutbreakAgent(anthropic(MODEL), t)).catch((e) => { outbreakAgent = undefined; throw e; }));
}

type StepEvent = Extract<TraceEvent, { type: 'note' | 'tool_start' | 'tool_end' }>;

/**
 * The one AI SDK stream to C3 mapper. turn is the step index from 0, like run.ts. A step's text is flushed
 * as a note before its first tool_start. An MCP failure arrives as a tool-result with isError and becomes call.error.
 */
export async function streamTrace(parts: AsyncIterable<TextStreamPart<ToolSet>>, onEvent: (e: StepEvent) => void) {
  const calls: ReturnType<typeof toToolCall>[] = [];
  const started = new Map<string, number>();
  let turn = -1, buf = '';
  const flush = () => { if (buf.trim()) onEvent({ type: 'note', text: buf.trim(), turn }); buf = ''; };
  const end = (id: string, name: string, input: unknown, out: McpOutput) => {
    const r = toToolCall(id, name, input, turn, Date.now() - (started.get(id) ?? Date.now()), out);
    calls.push(r);
    onEvent({ type: 'tool_end', call: r.call });
  };
  for await (const p of parts) {
    switch (p.type) {
      case 'start-step': turn++; buf = ''; break;
      case 'text-delta': case 'reasoning-delta': buf += p.text; break;
      case 'tool-call':
        flush();
        started.set(p.toolCallId, Date.now());
        onEvent({ type: 'tool_start', id: p.toolCallId, name: p.toolName, input: p.input, turn });
        break;
      case 'tool-result': end(p.toolCallId, p.toolName, p.input, p.output as McpOutput); break;
      case 'tool-error': end(p.toolCallId, p.toolName, p.input, { content: [{ type: 'text', text: String(p.error) }], isError: true }); break;
      case 'finish-step': flush(); break;
      case 'error': throw p.error;
      case 'abort': throw new Error('Outbreak run aborted');
    }
  }
  return calls;
}

/**
 * B4. The result is find_common_source's own output (the graph decides), plus one sentence naming the
 * same-supplier, same-ingredient lot that explains no case. Never emits done without a successful find_common_source.
 */
export async function runOutbreak(cluster: string, onEvent: (e: OutbreakEvent) => void = () => {}, agent?: ReturnType<typeof makeOutbreakAgent>): Promise<OutbreakResult> {
  const ids = (await query<{ id: string }>(CLUSTER_CASES, { cluster })).map((r) => r.id);
  if (!ids.length) throw new Error(`no cases in cluster ${cluster}`);
  onEvent({ type: 'start', cluster, model: MODEL });
  const res = await (agent ?? (await getOutbreakAgent())).stream({ prompt: `Outbreak cluster ${cluster}: ${ids.length} cases (${ids.join(', ')}). Find the common source.` });
  const calls = await streamTrace(res.stream, onEvent);
  const found = calls.findLast((c) => c.call.name === 'find_common_source' && c.parsed)?.parsed;
  if (!found) throw new Error('Agent finished without a successful find_common_source');
  const { db_ms, queries, ...r } = found as OutbreakResult & { db_ms: number; queries: number };
  const top = r.candidates[0];
  const decoys = top ? (await query<{ lot: string }>(SAME_SOURCE_LOTS, { lot: top.lot, ranked: r.candidates.map((c) => c.lot) })).map((d) => d.lot) : [];
  const outbreak = { ...r, summary: r.summary + (decoys.length ? ` ${decoys.join(', ')} (same supplier, same ingredient) explains none.` : '') };
  onEvent({ type: 'done', outbreak });
  return outbreak;
}
