/**
 * Retry for the Fetch API calls (scrape, extract). A 429, 502, 503 or 504 means the
 * request was not served and not charged, so it is safe to send again. So is a
 * connection failure that happened before the request was written. Any other status
 * is the answer, and any other error is final: the server may have received the
 * request and may still be working on it.
 */
export const FETCH_RETRIES = 2;
export const FETCH_RETRY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);
/**
 * No retry starts once the next wait would take the call past this. MCP clients cancel
 * a tool call at about 60 s, and the hosted server never receives that cancel: each POST
 * gets its own transport. So the budget ends before the client leaves, like the 50 s
 * wait of the crawl and batch tools.
 */
export const FETCH_RETRY_BUDGET_MS = 50_000;
/** Environment variable that sets the retry count; 0 sends each call once. */
export const FETCH_RETRIES_ENV = "ZENROWS_FETCH_RETRIES";
const BASE_MS = 1_000;
const FLOOR_MS = 250;
const CAP_MS = 30_000;

/**
 * Error codes (on a fetch error's `cause`) for a connection that failed before the
 * request was written: refused, name resolution, unreachable network or host, and a
 * connect timeout. A reset after sending, a header timeout or an abort is not here.
 */
const NOT_SENT_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** Full jitter: uniform between 250 ms and max(250 ms, min(maxWaitMs, 1 s x 2^attempt)). */
export function fullJitterMs(attempt: number, random: () => number = Math.random, maxWaitMs = CAP_MS): number {
  const ceiling = Math.max(FLOOR_MS, Math.min(maxWaitMs, BASE_MS * 2 ** attempt));
  return FLOOR_MS + random() * (ceiling - FLOOR_MS);
}

/**
 * Retry-After in milliseconds, or undefined when the header is not whole seconds.
 * Only plain digits count; an HTTP date, a fraction, a sign or hex falls back to
 * jitter. The value is clamped to [250 ms, 30 s].
 */
export function retryAfterHeaderMs(header: string | null | undefined): number | undefined {
  const value = header?.trim();
  if (!value || !/^\d+$/.test(value)) return undefined;
  return Math.min(CAP_MS, Math.max(FLOOR_MS, Number(value) * 1000));
}

/** True when a fetch error shows the request was never written to the server. */
export function failedBeforeSend(e: unknown): boolean {
  const code = (e as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" && NOT_SENT_CODES.has(code);
}

/** Reads the retry count from the environment: unset or blank means the default. */
export function retriesFromEnv(value: string | undefined): number {
  const trimmed = value?.trim();
  if (!trimmed) return FETCH_RETRIES;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${FETCH_RETRIES_ENV} must be a whole number of 0 or more (0 turns retries off), got "${value}"`);
  }
  return Number(trimmed);
}

const configuredRetries = retriesFromEnv(process.env[FETCH_RETRIES_ENV]);

export interface RetryOptions {
  retries?: number;
  budgetMs?: number;
  /** The caller's cancel signal. Once it aborts, no new attempt starts and the wait ends at once. */
  signal?: AbortSignal;
  /** Names the tool in the retry log line. */
  label?: string;
  /** Receives one line per retry. Defaults to stderr: stdout carries the stdio protocol. */
  log?: (line: string) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

const defaultLog = (line: string) => void process.stderr.write(`${line}\n`);

/** Waits ms, or rejects with the signal's reason as soon as it aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Calls doFetch with the caller's signal, retrying a retryable status or a connection
 * that failed before sending, with full-jitter backoff. A whole-seconds Retry-After
 * replaces the backoff. No retry starts after the budget (50 s by default), and none
 * starts once the signal aborts. Returns the last response, or rethrows the last error.
 */
export async function fetchWithRetry(
  doFetch: (signal?: AbortSignal) => Promise<Response>,
  opts: RetryOptions = {}
): Promise<Response> {
  const retries = opts.retries ?? configuredRetries;
  const budgetMs = opts.budgetMs ?? FETCH_RETRY_BUDGET_MS;
  const sleep = opts.sleep ?? abortableSleep;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? defaultLog;
  const { signal } = opts;
  const start = now();
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    let res: Response | undefined;
    let err: unknown;
    try {
      res = await doFetch(signal);
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      if (!failedBeforeSend(e)) throw e;
      err = e;
    }
    const retryable = res === undefined || FETCH_RETRY_STATUSES.has(res.status);
    const wait = retryAfterHeaderMs(res?.headers.get("retry-after")) ?? fullJitterMs(attempt, opts.random);
    if (!retryable || attempt >= retries || now() - start + wait > budgetMs) {
      if (res) return res;
      throw err;
    }
    await res?.body?.cancel().catch(() => undefined);
    signal?.throwIfAborted();
    const reason = res ? String(res.status) : String((err as { cause?: { code?: unknown } }).cause?.code);
    log(
      `zenrows-mcp: ${opts.label ?? "fetch"} got ${reason} on attempt ${attempt + 1} of ${retries + 1}; retrying in ${Math.round(wait)} ms`
    );
    await sleep(wait, signal);
  }
}
