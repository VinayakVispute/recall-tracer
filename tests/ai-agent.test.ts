import { describe, it, expect, afterAll } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { makeRecallAgent, mcpTools, closeAiAgent, fdaUrl } from '../src/agent/ai-agent.js';
import { close } from '../src/graph/db.js';

afterAll(async () => { await closeAiAgent(); await close(); });

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };

describe('recall agent', () => {
  it('runs trace_forward through the MCP tools, then answers', async () => {
    const steps = [
      [{ type: 'tool-call', toolCallId: 'c1', toolName: 'trace_forward', input: JSON.stringify({ lot: 'L-204' }) }],
      [{ type: 'text', text: 'done' }],
    ];
    let n = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => ({ content: steps[n++] as never, finishReason: { unified: n === 1 ? 'tool-calls' : 'stop', raw: undefined }, usage, warnings: [] }) });
    const result = await makeRecallAgent(model, await mcpTools()).generate({ prompt: 'trace L-204' });
    const out = JSON.stringify(result.steps[0].toolResults[0].output);
    expect(result.steps[0].toolCalls[0].toolName).toBe('trace_forward');
    expect(out).toContain('TLC-09A');
    expect(result.text).toBe('done');
  }, 30_000);

  it('builds a valid openFDA URL', () => {
    const u = new URL(fdaUrl({ query: 'dry milk "powder"', classification: 'Class I', limit: 3 }));
    expect(u.origin + u.pathname).toBe('https://api.fda.gov/food/enforcement.json');
    const t = '(dry AND milk AND powder)';
    expect(u.searchParams.get('search')).toBe(`(reason_for_recall:${t} product_description:${t}) AND classification:"Class I"`);
    expect(u.searchParams.get('sort')).toBe('report_date:desc');
    expect(u.searchParams.get('limit')).toBe('3');
  });
});
