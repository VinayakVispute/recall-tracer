import { anthropic } from '@ai-sdk/anthropic';
import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { ToolLoopAgent, tool, isStepCount, type InferAgentUIMessage, type LanguageModel, type ToolSet } from 'ai';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import '../graph/db.js'; // loads .env.local / .env

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
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
  return (agent ??= mcpTools().then((t) => makeRecallAgent(anthropic('claude-opus-5-5'), t)).catch((e) => { agent = undefined; throw e; }));
}

export type RecallAgentUIMessage = InferAgentUIMessage<ReturnType<typeof makeRecallAgent>>;
