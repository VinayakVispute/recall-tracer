import { describe, it, expect, afterAll } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { simulateReadableStream } from 'ai';
import { makeRecallAgent, makeOutbreakAgent, runOutbreak, mcpTools, closeAiAgent, fdaUrl } from '../src/agent/ai-agent.js';
import type { OutbreakEvent } from '../src/contracts.js';
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

describe('outbreak agent', () => {
  const finish = (unified: string) => ({ type: 'finish', finishReason: { unified, raw: undefined }, usage });
  const say = (text: string) => [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' }];
  const call = (id: string, toolName: string, input: object) => ({ type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) });
  const run = async (steps: object[][]) => {
    let n = 0;
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: steps[n++] as never[] }) }) });
    const events: OutbreakEvent[] = [];
    const out = await runOutbreak('OB-2026-10', (e) => events.push(e), makeOutbreakAgent(model, await mcpTools()));
    return { out, events };
  };

  it('streams C3 events and returns the graph result with the decoy named', async () => {
    const { out, events } = await run([
      [...say('Ranking lots for the cluster.'), call('a', 'find_common_source', { cluster: 'OB-2026-10' }), finish('tool-calls')],
      [call('b', 'case_path', { lot: 'L-162', cases: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'] }), finish('tool-calls')],
      [...say('L-204 explains all six.'), finish('stop')],
    ]);
    expect(events.map((e) => e.type)).toEqual(['start', 'note', 'tool_start', 'tool_end', 'tool_start', 'tool_end', 'note', 'done']);
    expect(events[0]).toEqual({ type: 'start', cluster: 'OB-2026-10', model: 'claude-opus-5-5' });
    expect(events[1]).toEqual({ type: 'note', text: 'Ranking lots for the cluster.', turn: 0 });
    const ends = events.filter((e) => e.type === 'tool_end').map((e) => e.call);
    expect(ends.map((c) => [c.name, c.turn, c.error, c.queries > 0])).toEqual([['find_common_source', 0, false, true], ['case_path', 1, false, true]]);
    expect(ends[1].summary).toBe('4 of 6 cases reached by L-162');
    expect(out.candidates[0].lot).toBe('L-204');
    expect(out.summary).toBe('L-204 (diced carrot, Valley Root Co.) explains 6 of 6 cases and reached 31 stores. Runner-up L-162 explains 4. L-205 (same supplier, same ingredient) explains none.');
    expect(events.at(-1)).toEqual({ type: 'done', outbreak: out });
    expect(out).not.toHaveProperty('db_ms');
  }, 30_000);

  it('an MCP error becomes call.error, and no done without find_common_source', async () => {
    const events: OutbreakEvent[] = [];
    let n = 0;
    const steps = [[call('a', 'case_path', { lot: 'L-204', cases: ['NOPE'] }), finish('tool-calls')], [...say('Tool failed.'), finish('stop')]];
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: steps[n++] as never[] }) }) });
    await expect(runOutbreak('OB-2026-10', (e) => events.push(e), makeOutbreakAgent(model, await mcpTools()))).rejects.toThrow('without a successful find_common_source');
    const end = events.find((e) => e.type === 'tool_end');
    expect(end?.type === 'tool_end' && [end.call.error, end.call.summary]).toEqual([true, 'Error: unknown case ids: NOPE']);
    expect(events.map((e) => e.type)).not.toContain('done');
  }, 30_000);
});
