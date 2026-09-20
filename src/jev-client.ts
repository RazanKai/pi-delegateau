import { TypeSafeClient } from "@typesafe-ai/sdk";

/** The shape both selectors call. Structural, so a test stub satisfies it. */
export interface JevClientLike {
  systemOne(
    request: unknown,
    options?: { signal?: AbortSignal; timeout?: number; retry?: { maxRetries: number } },
  ): Promise<any>;
}

/**
 * One client per (timeout) for the life of the process.
 *
 * Both selectors are constructed per dispatch, so building a client in the
 * constructor builds one per delegation decision. That is pure waste — the
 * client is a stateless transport wrapper that reads the API key from the
 * environment at construction — and it is also the shape that broke
 * pi-typesafe's per-instance request counter (measured: a per-dispatch client
 * hits a 20-attempt budget after 20 decisions).
 *
 * Session-scoped rather than process-wide is deliberate: the API key is read at
 * construction, so a key added or rotated mid-process must not be pinned by a
 * cache built before it existed.
 */
const clients = new Map<number, JevClientLike>();

/** Test-only hook: forget cached clients so a stub can be installed. */
export function resetJevClientCache(): void {
  clients.clear();
}

/**
 * The shared client for a timeout, or `undefined` when credentials or the
 * transport are unusable. Never throws: construction failure is a normal
 * choose() error inside the caller's deadline/fallback logic, not a constructor
 * throw outside it (F01).
 */
export function sharedJevClient(timeoutMs: number): JevClientLike | undefined {
  const cached = clients.get(timeoutMs);
  if (cached) return cached;
  try {
    const client = new TypeSafeClient({ timeout: timeoutMs, retry: { maxRetries: 0 } });
    clients.set(timeoutMs, client);
    return client;
  } catch {
    return undefined;
  }
}
