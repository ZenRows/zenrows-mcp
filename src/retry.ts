import { setTimeout as delay } from "node:timers/promises";

/*
 * Opt-in retry for the scrape and extract calls. A 429, 502, 503 or 504, or a connection
 * that failed before the request was sent, means the API did not serve the call, so it is
 * safe to send again. Anything else is the answer: the API may have received the request.
 */

const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const NOT_SENT_CODES = new Set<unknown>([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const MIN_WAIT_MS = 250;
const MAX_WAIT_MS = 30_000;
/** A retry starts only if its wait ends this soon after the first request: MCP clients cancel at about 60 s. */
export const BUDGET_MS = 50_000;

export function parseRetries(value: string | undefined): number {
  const trimmed = value?.trim();
  if (!trimmed) return 0;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`ZENROWS_FETCH_RETRIES must be a whole number of 0 or more, got "${value}"`);
  }
  return Number(trimmed);
}

// Read once at startup. An invalid value throws on import, which stops the server.
const RETRIES = parseRetries(process.env.ZENROWS_FETCH_RETRIES);

/** A Retry-After in whole seconds, clamped; any other form is ignored. */
export function retryAfterMs(header: string | null): number | undefined {
  const value = header?.trim();
  if (!value || !/^\d+$/.test(value)) return undefined;
  return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, Number(value) * 1000));
}

/** Full jitter: uniform between 250 ms and min(30 s, 1 s x 2^attempt). */
export function jitterMs(attempt: number, random = Math.random): number {
  return MIN_WAIT_MS + random() * (Math.min(MAX_WAIT_MS, 1000 * 2 ** attempt) - MIN_WAIT_MS);
}

type CodedError = { code?: unknown; syscall?: unknown; errors?: unknown };

function connectFailed(e: CodedError | undefined): boolean {
  return NOT_SENT_CODES.has(e?.code) || (e?.code === "ETIMEDOUT" && e.syscall === "connect");
}

/** True when a fetch error shows the request was never sent. With several addresses, every one must have failed to connect. */
export function failedBeforeSend(error: unknown): boolean {
  const cause = (error as { cause?: CodedError } | undefined)?.cause;
  if (Array.isArray(cause?.errors)) return cause.errors.length > 0 && cause.errors.every(connectFailed);
  return connectFailed(cause);
}

export interface RetryOptions {
  /** Names the tool in the stderr line. */
  label: string;
  /** The tool call's cancel signal: once it aborts, no retry starts and the wait ends. */
  signal?: AbortSignal;
  /** Test seams. */
  retries?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<unknown>;
  now?: () => number;
  random?: () => number;
}

/** Sends the request, and sends it again while the API did not serve it and the policy allows. */
export async function fetchWithRetry(send: () => Promise<Response>, opts: RetryOptions): Promise<Response> {
  const { label, signal, retries = RETRIES, now = Date.now, random } = opts;
  const sleep = opts.sleep ?? ((ms: number, s?: AbortSignal) => delay(ms, undefined, { signal: s }));
  const start = now();
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined;
    let error: unknown;
    try {
      res = await send();
    } catch (e) {
      if (!failedBeforeSend(e)) throw e;
      error = e;
    }
    const wait = retryAfterMs(res?.headers.get("retry-after") ?? null) ?? jitterMs(attempt, random);
    const retryable = res === undefined || RETRY_STATUSES.has(res.status);
    if (!retryable || attempt >= retries || signal?.aborted || now() - start + wait > BUDGET_MS) {
      if (res) return res;
      throw error;
    }
    await res?.body?.cancel().catch(() => undefined);
    const reason = res?.status ?? (error as { cause?: CodedError }).cause?.code ?? "a network error";
    process.stderr.write(
      `zenrows-mcp: ${label} got ${reason} on attempt ${attempt + 1} of ${retries + 1}; retrying in ${Math.round(wait)} ms\n`
    );
    await sleep(wait, signal);
  }
}
