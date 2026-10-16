import { retryAfterMs, retryAfterSeconds } from "./crawl-api.js";

/**
 * Retry for the Fetch API calls (scrape, extract). A 429, 502, 503 or 504 means the
 * request was not served and not charged, so it is safe to send again; so is a
 * network error, which never produced a response. Any other status is the answer.
 */
export const FETCH_RETRIES = 2;
export const FETCH_RETRY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);
/** No retry starts once the next wait would take the call past this. */
export const FETCH_RETRY_BUDGET_MS = 90_000;
const BASE_MS = 1_000;
const FLOOR_MS = 250;
const CAP_MS = 30_000;

/** Full jitter: uniform between 250 ms and min(30 s, 1 s x 2^attempt). */
export function fullJitterMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.max(FLOOR_MS, Math.min(CAP_MS, BASE_MS * 2 ** attempt));
  return FLOOR_MS + random() * (ceiling - FLOOR_MS);
}

export interface RetryOptions {
  retries?: number;
  budgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isAbort(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
}

/**
 * Calls doFetch, retrying a retryable status or a network error with full-jitter
 * backoff. Retry-After (capped at 30 s) replaces the backoff when the server sends
 * it. An abort or timeout is never retried: the server may still be working on it.
 * Returns the last response, or rethrows the last network error.
 */
export async function fetchWithRetry(doFetch: () => Promise<Response>, opts: RetryOptions = {}): Promise<Response> {
  const retries = opts.retries ?? FETCH_RETRIES;
  const budgetMs = opts.budgetMs ?? FETCH_RETRY_BUDGET_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const start = now();
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined;
    let err: unknown;
    try {
      res = await doFetch();
    } catch (e) {
      if (isAbort(e)) throw e;
      err = e;
    }
    const retryable = res === undefined || FETCH_RETRY_STATUSES.has(res.status);
    const delay = fullJitterMs(attempt, opts.random);
    const wait = res ? retryAfterMs(retryAfterSeconds(res.headers.get("retry-after")), delay) : delay;
    if (!retryable || attempt >= retries || now() - start + wait > budgetMs) {
      if (res) return res;
      throw err;
    }
    await res?.body?.cancel().catch(() => undefined);
    await sleep(wait);
  }
}
