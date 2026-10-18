/**
 * The agent's channel to the coordinator during a live run. The stream route opens a lot's channel; ask_coordinator
 * then waits for POST /incident/:lot/answer. No open channel (POST /recall, tests) or no reply in time means the
 * question's default applies, and the result says so.
 */
const open = new Set<string>();
const waiting = new Map<string, (choice: string) => void>();
export const ASK_TIMEOUT_MS = Number(process.env.ASK_TIMEOUT_MS ?? 90_000);

export const listen = (lot: string) => open.add(lot);
export const unlisten = (lot: string) => { open.delete(lot); waiting.get(lot)?.(''); };

export async function ask(lot: string, options: string[], fallback: string) {
  if (!open.has(lot)) return { choice: fallback, answered_by: 'policy default (no coordinator on this run)' };
  const choice = await new Promise<string>((resolve) => {
    const t = setTimeout(() => resolve(''), ASK_TIMEOUT_MS);
    waiting.set(lot, (c) => { clearTimeout(t); resolve(c); });
  });
  waiting.delete(lot);
  return options.includes(choice)
    ? { choice, answered_by: 'coordinator' }
    : { choice: fallback, answered_by: `policy default (no reply in ${Math.round(ASK_TIMEOUT_MS / 1000)} s)` };
}

/** False when nothing on that lot is waiting for an answer. */
export function answer(lot: string, choice: string) {
  const r = waiting.get(lot);
  r?.(choice);
  return !!r;
}
