/**
 * One way to call the Hono API from both sides. The browser goes through the /api rewrite in next.config.ts;
 * Server Components call RECALL_API directly, since rewrites only apply to incoming requests.
 */
export const API_BASE = typeof window === "undefined" ? (process.env.RECALL_API ?? "http://localhost:8787") : "/api";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, body === undefined
    ? { cache: "no-store" }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
  return data;
}

/** Like api(), but a 404 resolves to null: "nothing there yet" is a normal answer, not an error. */
export async function apiOrNull<T>(path: string): Promise<T | null> {
  try {
    return await api<T>(path);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

export const LOT_RE = /^L-\d{1,6}$/;
