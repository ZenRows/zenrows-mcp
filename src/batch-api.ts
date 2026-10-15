/**
 * Client for the Zenrows Batch API (https://async.api.zenrows.com/v1).
 * Auth via X-API-Key header. Errors are application/problem+json (RFC 7807).
 */

export const DEFAULT_BATCH_API_BASE = "https://async.api.zenrows.com/v1";
export const BATCH_API_BASE_ENV = "ZENROWS_BATCH_API_BASE";

export function batchBase(): string {
  const env = process.env[BATCH_API_BASE_ENV];
  const base = env && env.trim() ? env.trim() : DEFAULT_BATCH_API_BASE;
  return base.replace(/\/+$/, "");
}

export interface JobStats {
  total: number;
  completed: number;
  successful: number;
  failed: number;
}

export interface JobRun {
  status: string;
  stats: JobStats;
  run_id?: string;
  /** Set only when status is failed: insufficient_credits, subscription_inactive, api_key_cap_reached. */
  failure_reason?: string;
  failure_detail?: string;
  /** "paused" while the run is suspended. Kept on the run after it ends, so check status too. */
  pause_state?: string;
  [k: string]: unknown;
}

export interface Job {
  job_id: string;
  latest_run: JobRun;
  [k: string]: unknown;
}

export interface ResultRow {
  external_id?: string;
  task_id: string;
  status?: string;
  result_url?: string;
  [k: string]: unknown;
}

export interface ResultsPage {
  results: ResultRow[];
  next_cursor: string | null;
}

export interface ProblemJson {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  code?: string;
  invalid_tasks?: Array<{ index: number; reason: string }>;
}

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "stopped", "deleted"]);

export class BatchError extends Error {
  code: string;
  status?: number;
  detail?: string;
  /** The Batch API's own problem `code` (e.g. job_not_open), when it sent one. */
  serverCode?: string;
  /** The wait the API asked for (Retry-After, in ms) before the next request, when it sent one. */
  retryAfterMs?: number;
  /**
   * Why a shared code was returned, e.g. BATCH_QUOTA_EXCEEDED is either insufficient_credits
   * (402) or too_many_jobs (429). Added alongside `code`, which keeps its meaning.
   */
  reason?: string;

  constructor(opts: {
    code: string;
    message: string;
    status?: number;
    detail?: string;
    serverCode?: string;
    reason?: string;
  }) {
    super(opts.message);
    this.name = "BatchError";
    this.code = opts.code;
    this.status = opts.status;
    this.detail = opts.detail;
    this.serverCode = opts.serverCode;
    this.reason = opts.reason;
  }

  toJSON(): {
    code: string;
    message: string;
    status?: number;
    detail?: string;
    server_code?: string;
    reason?: string;
  } {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      detail: this.detail,
      ...(this.serverCode ? { server_code: this.serverCode } : {}),
      ...(this.reason ? { reason: this.reason } : {}),
    };
  }
}

interface RequestOpts {
  apiKey: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
  timeoutMs?: number;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  /** Sent as Idempotency-Key. A POST retries only when it carries one. */
  idempotencyKey?: string;
  /**
   * Epoch ms the whole call must finish by, retries and their waits included. Each attempt's
   * timeout and each retry wait is cut to the time left, and no retry starts past it.
   */
  deadline?: number;
}

const RETRIES = 3;
/** The longest a Retry-After may make one retry wait, so a large server value cannot hang a call. */
export const MAX_RETRY_AFTER_SECONDS = 30;
const GET_RETRY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);
// A 429 on submit is an account limit (active or scheduled jobs): retrying only waits for a slot.
const POST_RETRY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/** 250 ms x 2^attempt, +/-20% jitter, capped at 10 s. */
function backoffMs(attempt: number): number {
  return Math.min(250 * 2 ** attempt, 10_000) * (0.8 + Math.random() * 0.4);
}

/** Retry-After as delay-seconds or as an HTTP-date. */
export function retryAfterSeconds(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds : undefined;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The wait before retry `attempt`: Retry-After when sent (capped), else backoff. Exported for tests. */
export function retryDelayMs(attempt: number, retryAfterHeader: string | null | undefined): number {
  const after = retryAfterSeconds(retryAfterHeader);
  return after !== undefined ? Math.min(after, MAX_RETRY_AFTER_SECONDS) * 1000 : backoffMs(attempt);
}

/**
 * GETs retry on 429, 502, 503, 504 and network errors; a POST retries on 502, 503, 504 and
 * network errors only when it carries an Idempotency-Key, so the API answers a repeat with the
 * original response instead of creating a second job. Up to 3 retries, honoring Retry-After
 * (capped at MAX_RETRY_AFTER_SECONDS). With a deadline, no attempt starts after it, each attempt's
 * timeout ends at it, and a retry is made only if its wait ends before it.
 */
export async function batchRequest<T>(method: string, path: string, opts: RequestOpts): Promise<T> {
  const url = new URL(batchBase() + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }

  const headers: Record<string, string> = {
    "X-API-Key": opts.apiKey,
    Accept: "application/json",
    "User-Agent": opts.userAgent ?? "zenrows/mcp",
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  const retryStatuses = method === "GET" ? GET_RETRY_STATUSES : opts.idempotencyKey ? POST_RETRY_STATUSES : undefined;

  const doFetch = opts.fetchImpl ?? fetch;
  const left = () => (opts.deadline === undefined ? Number.POSITIVE_INFINITY : opts.deadline - Date.now());
  // The error a retry would replace: thrown instead of retrying once the deadline has passed.
  let lastError: BatchError | undefined;
  for (let attempt = 0; ; attempt++) {
    // Checked before every attempt, so a retry wait that overran (a slow timer, a busy event
    // loop) never starts a request past the deadline.
    if (left() <= 0) {
      throw (
        lastError ??
        new BatchError({ code: "BACKEND_UNAVAILABLE", message: "The deadline passed before the request was sent." })
      );
    }
    const canRetry = retryStatuses !== undefined && attempt < RETRIES;
    // A retry is made only if its wait ends before the deadline.
    const fits = (waitMs: number) => canRetry && waitMs < left();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(0, Math.min(opts.timeoutMs ?? 60_000, left())));
    let res: Response;
    let text: string;
    try {
      res = await doFetch(url.toString(), {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      clearTimeout(timeout);
      lastError = new BatchError({
        code: "BACKEND_UNAVAILABLE",
        message: `Could not reach the Zenrows Batch API: ${err instanceof Error ? err.message : String(err)}`,
      });
      const wait = backoffMs(attempt);
      if (fits(wait)) {
        await sleep(wait);
        continue;
      }
      throw lastError;
    }
    clearTimeout(timeout);

    if (res.status < 200 || res.status >= 300) {
      lastError = problemToError(res.status, text, method, path);
      const retryAfter = retryAfterSeconds(res.headers.get("retry-after"));
      if (retryAfter !== undefined) lastError.retryAfterMs = retryAfter * 1000;
      if (retryStatuses?.has(res.status)) {
        const wait = retryDelayMs(attempt, res.headers.get("retry-after"));
        if (fits(wait)) {
          await sleep(wait);
          continue;
        }
      }
      throw lastError;
    }
    if (!text) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new BatchError({
        code: "BATCH_FAILED",
        message: "The Batch API response was not valid JSON.",
        detail: text.slice(0, 240),
      });
    }
  }
}

function problemToError(status: number, body: string, method: string, path: string): BatchError {
  let problem: ProblemJson = {};
  try {
    problem = JSON.parse(body) as ProblemJson;
  } catch {
    // non-JSON: fall through
  }
  const serverCode = problem.code || undefined;
  const detail = problem.detail || problem.title || body.slice(0, 240) || `HTTP ${status}`;
  const cause = `HTTP ${status}${serverCode ? ` (${serverCode})` : ""} for ${method} ${path}: ${detail}`;
  const make = (code: string, message: string, reason?: string) =>
    new BatchError({ code, message, status, detail: cause, serverCode, reason });

  if (status === 403) {
    return make(
      "BATCH_ACCESS_DENIED",
      "The Batch API rejected this request (access denied). Batch is not enabled for this account or API key. Check that the key is active and contact Zenrows support if this persists, or fan out with scrape/extract per URL."
    );
  }
  if (status === 401) {
    return make("AUTH_INVALID", "Zenrows rejected the API key for the Batch API.");
  }
  if (status === 404) {
    return make("BATCH_NOT_FOUND", "Batch job, run, or task not found.");
  }
  // 402 and 429 share BATCH_QUOTA_EXCEEDED, as they always have; `reason` tells them apart.
  if (status === 429) {
    return make(
      "BATCH_QUOTA_EXCEEDED",
      "Batch quota exceeded (e.g. max concurrent active jobs). Wait for an in-flight job to finish or cancel one, then retry.",
      "too_many_jobs"
    );
  }
  if (status === 402 && serverCode === "api_key_cap_reached") {
    return make(
      "BATCH_KEY_CAP_REACHED",
      "This API key reached one of its credit caps, so the Batch API refused the request. The account's other API keys still work. Raise or remove the cap at https://app.zenrows.com/settings/api-keys, or wait until it resets (see detail).",
      "api_key_cap_reached"
    );
  }
  if (status === 402) {
    return make(
      "BATCH_QUOTA_EXCEEDED",
      "Subscription has no credit available for the Batch API.",
      "insufficient_credits"
    );
  }

  const invalid = problem.invalid_tasks?.length
    ? ` invalid_tasks: ${problem.invalid_tasks
        .slice(0, 10)
        .map((t) => `#${t.index}: ${t.reason}`)
        .join("; ")}`
    : "";
  return make("BATCH_FAILED", `Batch request failed (HTTP ${status}).${invalid}`);
}

interface CallOpts {
  apiKey: string;
  timeoutMs?: number;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  deadline?: number;
}

/** Pass an idempotencyKey so a retried submit returns the original job instead of a second one. */
export function createJob(body: unknown, opts: CallOpts & { idempotencyKey?: string }): Promise<Job> {
  return batchRequest<Job>("POST", "/jobs", { ...opts, body });
}

export function getJob(id: string, opts: CallOpts): Promise<Job> {
  return batchRequest<Job>("GET", `/jobs/${encodeURIComponent(id)}`, opts);
}

/** POST /jobs/:id/stop answers with the refreshed Run, not the Job. */
export function stopJob(id: string, opts: CallOpts): Promise<JobRun> {
  return batchRequest<JobRun>("POST", `/jobs/${encodeURIComponent(id)}/stop`, opts);
}

export type ResultsStatus = "successful" | "failed" | "processing" | "all";

/** One page of results as the API returns it (about 1,000 rows per page). */
export async function listResultsPage(
  id: string,
  opts: CallOpts & { status?: ResultsStatus; cursor?: string }
): Promise<ResultsPage> {
  const page = await batchRequest<ResultsPage>("GET", `/jobs/${encodeURIComponent(id)}/results`, {
    ...opts,
    query: { status: opts.status, cursor: opts.cursor },
  });
  return { results: page?.results ?? [], next_cursor: page?.next_cursor ?? null };
}

/**
 * Whole pages from `cursor` until at least `limit` rows are collected or the results end.
 * Never cuts a page in half, so next_cursor always resumes exactly where this call stopped.
 */
export async function listResults(
  id: string,
  opts: CallOpts & { status?: ResultsStatus; cursor?: string; limit?: number }
): Promise<ResultsPage> {
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  const results: ResultRow[] = [];
  let cursor = opts.cursor;
  for (;;) {
    const page = await listResultsPage(id, { ...opts, cursor });
    results.push(...page.results);
    cursor = page.next_cursor ?? undefined;
    if (!cursor || results.length >= limit) break;
  }
  return { results, next_cursor: cursor ?? null };
}

/**
 * The run is paused and has not ended. Pausing stops new task pickups; tasks already in flight
 * can still finish, and the run completes on its own if those were the last ones. pause_state
 * stays on a run that later stops or completes, so a terminal run is never reported as paused.
 */
export function isPausedRun(run: JobRun | undefined): boolean {
  return run?.pause_state === "paused" && (run.status === "running" || run.status === "pending");
}

const FINAL_POLL_MS = 1000;

/**
 * Polls until the latest run is terminal or paused, or the deadline passes. The deadline bounds
 * everything: each poll's request and retries, and the wait between polls.
 */
export async function waitForJob(id: string, opts: CallOpts & { pollTimeoutMs?: number }): Promise<Job> {
  const budgetMs = opts.pollTimeoutMs ?? opts.timeoutMs ?? 600_000;
  const deadline = Date.now() + budgetMs;
  // Time kept for the final poll: up to a second, and never more than a quarter of the budget.
  const reserveMs = Math.min(FINAL_POLL_MS, budgetMs / 4);
  let lastError: BatchError | undefined;
  const timedOut = () =>
    new BatchError({
      code: "BATCH_FAILED",
      message: `Timed out waiting for batch job ${id} to finish.`,
      detail: `The run did not reach a terminal state within ${Math.round(budgetMs / 1000)}s.${
        lastError ? ` Last poll failed: ${lastError.detail ?? lastError.message}` : ""
      }`,
      status: lastError?.status,
      serverCode: lastError?.serverCode,
    });
  let delay = 2000;
  for (;;) {
    try {
      const job = await getJob(id, { ...opts, deadline });
      lastError = undefined;
      // No latest run: its only run was deleted (or a scheduled job has not run yet). Nothing to
      // wait for. A deleted job answers 404 instead, which ends the wait below.
      if (!job.latest_run) return job;
      if (TERMINAL_STATUSES.has(job.latest_run.status)) return job;
      // A paused run picks up no new tasks; return so the caller can resume or stop it.
      if (isPausedRun(job.latest_run)) return job;
    } catch (e) {
      // A transient failure (or a request cut short by the deadline) is one missed poll; keep
      // polling until the deadline. Anything else, such as a 404, ends the wait at once.
      if (!isTransient(e)) throw e;
      lastError = e as BatchError;
    }
    const left = deadline - Date.now();
    if (left <= 0) throw timedOut();
    // The API's Retry-After on the last failed poll sets the earliest next poll.
    const notBeforeMs = lastError?.retryAfterMs ?? 0;
    if (left <= reserveMs || notBeforeMs >= left) {
      // No poll fits: the last one is done, or the API asked us to wait past the deadline.
      // Wait out the rest so the timeout lands at the deadline, not early.
      await sleep(left);
      throw timedOut();
    }
    // Sleep at most until reserveMs before the deadline, so one more poll fits inside the budget,
    // but never less than the API asked for.
    await sleep(Math.max(Math.min(delay, left - reserveMs), notBeforeMs));
    delay = Math.min(delay * 1.5, 15_000);
  }
}

function isTransient(e: unknown): boolean {
  if (!(e instanceof BatchError)) return false;
  if (e.code === "BACKEND_UNAVAILABLE") return true;
  return e.status !== undefined && GET_RETRY_STATUSES.has(e.status);
}
