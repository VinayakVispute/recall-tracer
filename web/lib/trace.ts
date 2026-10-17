import type { RecallResult, TraceEvent, ToolCall } from "@server/agent/run";

/** A trace event stamped with when it arrived, in ms from the start of the run. */
export type TimedEvent = TraceEvent & { at: number };
/** A run that can be played back: the events in order with their real (or estimated) timing. */
export type Recording = { lot: string; recorded_at: string; events: TimedEvent[]; source: "live" | "recorded" | "estimated" };

export type Step =
  | { kind: "note"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown; running: boolean; call?: ToolCall };

/** Steps where the agent made a judgement, not a graph lookup. Shown as decision cards. */
export const JUDGEMENT = new Set(["propose_classification", "minimal_recall"]);

/** Builds the investigation log from events, so a live run and a replay render the same way. */
export function stepsOf(events: TraceEvent[]): Step[] {
  const steps: Step[] = [];
  for (const ev of events) {
    if (ev.type === "note") steps.push({ kind: "note", text: ev.text });
    else if (ev.type === "tool_start") steps.push({ kind: "tool", id: ev.id, name: ev.name, input: ev.input, running: true });
    else if (ev.type === "tool_end") {
      const i = steps.findIndex((s) => s.kind === "tool" && s.id === ev.call.id);
      if (i >= 0) steps[i] = { ...(steps[i] as Extract<Step, { kind: "tool" }>), running: false, call: ev.call };
    }
  }
  return steps;
}

/** Names of tools that finished without error, in order. Drives the record network's reveal. */
export const completedOf = (steps: Step[]) => steps.flatMap((s) => (s.kind === "tool" && s.call && !s.call.error ? [s.name] : []));

/** FalkorDB's own execution time for a tool's queries. Runs saved before db_ms existed fall back to the MCP call time. */
export const graphTime = (c: ToolCall) => (typeof c.db_ms === "number" && c.queries > 0 ? { ms: c.db_ms, db: true } : { ms: c.ms, db: false });
const round = (ms: number) => (ms < 10 ? Math.round(ms * 10) / 10 : Math.round(ms));
export const fmtMs = (ms: number) => `${round(ms)} ms`;

/** Totals for the log header: graph tool calls, queries run, and time spent in FalkorDB. */
export const toolTotals = (steps: Step[]) => {
  const calls = steps.flatMap((s) => (s.kind === "tool" && s.call ? [s.call] : []));
  const db = calls.every((c) => graphTime(c).db);
  return { calls: calls.length, queries: calls.reduce((n, c) => n + (c.queries ?? 0), 0), ms: calls.reduce((n, c) => n + graphTime(c).ms, 0), db };
};

/**
 * A saved run has tool timings and turns but no arrival times. Rebuild an event list with estimated timing:
 * the model's thinking time is spread evenly over the turns, tool calls keep their measured duration.
 */
export function fromResult(r: RecallResult): Recording {
  const notes = r.meta?.notes ?? [];
  const turns = [...new Set([...notes.map((n) => n.turn), ...r.tool_calls.map((c) => c.turn)])].sort((a, b) => a - b);
  const toolMs = r.tool_calls.reduce((n, c) => n + c.ms, 0);
  const think = Math.max(800, ((r.meta?.ms ?? turns.length * 2500) - toolMs) / (turns.length + 1));
  const events: TimedEvent[] = [{ type: "start", lot: r.lot, model: r.meta?.model ?? "", at: 0 }];
  let t = 0;
  for (const turn of turns) {
    t += think;
    for (const n of notes.filter((x) => x.turn === turn)) events.push({ type: "note", text: n.text, turn, at: Math.round(t) });
    for (const c of r.tool_calls.filter((x) => x.turn === turn)) {
      events.push({ type: "tool_start", id: c.id, name: c.name, input: c.input, turn, at: Math.round(t) });
      t += c.ms;
      events.push({ type: "tool_end", call: c, at: Math.round(t) });
    }
  }
  events.push({ type: "done", result: r, at: Math.round(t + think) });
  return { lot: r.lot, recorded_at: r.finished_at, events, source: "estimated" };
}

/**
 * The server's recording of a run: the curated demo run if there is one, else the latest live run.
 * Served by GET /recall/replay?format=json, which needs no API key and no database.
 */
export async function loadRecorded(lot: string): Promise<Recording | undefined> {
  const res = await fetch(`/api/recall/replay?lot=${encodeURIComponent(lot)}&format=json`);
  if (!res.ok) return undefined;
  const data = (await res.json()) as { lot: string; recorded_at: string; events: { t_ms: number; event: TraceEvent }[] };
  return { lot: data.lot, recorded_at: data.recorded_at, events: data.events.map(({ t_ms, event }) => ({ ...event, at: t_ms }) as TimedEvent), source: "recorded" };
}

/** One marker per finished tool call, at the time it finished. */
export type Marker = { n: number; name: string; at: number; judgement: boolean; error: boolean };
export function markersOf(events: TimedEvent[]): Marker[] {
  let n = 0;
  return events.flatMap((e) => (e.type === "tool_end" ? [{ n: ++n, name: e.call.name, at: e.at, judgement: JUDGEMENT.has(e.call.name), error: !!e.call.error }] : []));
}
