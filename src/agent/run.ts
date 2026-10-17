import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { minimalRecall } from '../tools/index.js';

const MODEL = 'claude-opus-5-5';
const SYSTEM = readFileSync(new URL('./prompt.md', import.meta.url), 'utf8');
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

let mcp: Promise<Client> | undefined;

/** One MCP server process per API process; the agent only sees tools through it. */
function mcpClient() {
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

export type ToolCall = { name: string; input: unknown; ms: number; error?: boolean };
type Recall = Awaited<ReturnType<typeof minimalRecall>>;

export async function runAgent(lot: string) {
  const client = new Anthropic();
  const mcpc = await mcpClient();
  const { tools: mcpTools } = await mcpc.listTools();
  const tools: Anthropic.Beta.BetaTool[] = mcpTools.map((t) => ({
    name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
  }));

  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: `Alert: lot ${lot} is contaminated.` }];
  const calls: ToolCall[] = [];
  let recall: Recall | undefined;

  for (let turn = 0; turn < 12; turn++) {
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      tools,
      messages,
      output_config: { effort: 'low' }, // fixed tool sequence; low effort keeps the run well under 60 s
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    } as Anthropic.Beta.MessageCreateParamsNonStreaming);
    messages.push({ role: 'assistant', content: res.content });

    if (res.stop_reason === 'refusal') throw new Error('Model declined the request');
    if (res.stop_reason !== 'tool_use') {
      const summary = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
      if (!recall) throw new Error(`Agent finished without calling minimal_recall: ${summary}`);
      return toResult(lot, recall, summary, calls);
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const b of res.content) {
      if (b.type !== 'tool_use') continue;
      const t0 = Date.now();
      const out = await mcpc.callTool({ name: b.name, arguments: b.input as Record<string, unknown> });
      const text = (out.content as { type: string; text: string }[]).map((c) => c.text).join('');
      calls.push({ name: b.name, input: b.input, ms: Date.now() - t0, error: !!out.isError });
      if (b.name === 'minimal_recall' && !out.isError) recall = JSON.parse(text);
      results.push({ type: 'tool_result', tool_use_id: b.id, content: text, is_error: !!out.isError });
    }
    messages.push({ role: 'user', content: results });
  }
  throw new Error('Agent did not finish in 12 turns');
}

/** Final JSON comes from the graph's tool output; Claude contributes only the summary. */
export function toResult(lot: string, r: Recall, summary: string, tool_calls: ToolCall[]) {
  return {
    lot,
    affected: r.recall_stores.filter((s) => s.kind === 'affected').map((s) => ({ store: s.store, path: s.paths, units: s.units })),
    gaps: r.gaps.map((g) => ({ store: g.store, sku: g.sku, reason: g.reason, units: g.units, added_to_recall: r.add_gap_stores })),
    safe: r.safe,
    counts: { blanket: r.counts.blanket, targeted: r.counts.targeted, safe: r.counts.safe },
    batches: r.batches,
    product_lots: r.product_lots,
    units_to_pull: r.units_to_pull,
    summary,
    tool_calls,
  };
}
export type RecallResult = ReturnType<typeof toResult>;
