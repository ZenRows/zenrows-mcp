/**
 * Client for the Zenrows Batch API (https://async.api.zenrows.com/v1).
 * Auth via X-API-Key header. Errors are application/problem+json (RFC 9457).
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

/** status: pending | running | completed | stopped | failed. completed, stopped and failed are terminal. */
export interface JobRun {
  status: string;
  stats: JobStats;
  run_id?: string;
  job_id?: string;
  /** Set only when status is failed: insufficient_credits, subscription_inactive, api_key_cap_reached, ... */
  failure_reason?: string;
  failure_detail?: string;
  /** "paused" while the run is suspended. Kept on the run after it ends, so check status too. */
  pause_state?: string;
  /** "pending" while a large submit or a rerun is still writing its tasks; "done" after. */
  ingest_status?: string;
  [k: string]: unknown;
}

export interface Job {
  job_id: string;
  /** Absent when the job has no run left (its only run was deleted). */
  latest_run?: JobRun;
  [k: string]: unknown;
}

export interface RerunResponse extends Job {
  rerun_of?: string;
  retried_tasks?: number;
  inherited_tasks?: number;
}

export interface JobList {
  jobs: Job[];
  next_cursor?: string | null;
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
  invalid_tasks?: Array<{ index: number; reason: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

/** Run statuses after which the run never changes again. `deleted` is internal but can show up. */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "stopped", "deleted"]);

export class BatchError extends Error {
  code: string;
  status?: number;
  detail?: string;
  /** The Batch API's own problem `code` (e.g. quota_exceeded), when it sent one. */
  serverCode?: string;
  /** Seconds to wait before retrying, from Retry-After. */
  retryAfter?: number;
  /** Per-task reasons on a rejected submit, as the API sent them (first 20). */
  invalidTasks?: ProblemJson["invalid_tasks"];
  /** The stored problem of a failed task (content endpoint, 422). */
  taskError?: unknown;

  constructor(opts: {
    code: string;
    message: string;
    status?: number;
    detail?: string;
    serverCode?: string;
    retryAfter?: number;
    invalidTasks?: ProblemJson["invalid_tasks"];
    taskError?: unknown;
  }) {
    super(opts.message);
    this.name = "BatchError";
    this.code = opts.code;
    this.status = opts.status;
    this.detail = opts.detail;
    this.serverCode = opts.serverCode;
    this.retryAfter = opts.retryAfter;
    this.invalidTasks = opts.invalidTasks;
    this.taskError = opts.taskError;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      detail: this.detail,
      ...(this.serverCode ? { server_code: this.serverCode } : {}),
      ...(this.retryAfter !== undefined ? { retry_after: this.retryAfter } : {}),
      ...(this.invalidTasks?.length ? { invalid_tasks: this.invalidTasks } : {}),
      ...(this.taskError !== undefined ? { task_error: this.taskError } : {}),
    };
  }
}

interface RequestOpts {
  apiKey: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
  timeoutMs?: number;
  userAgent?: string;
  /** Sent on every request, e.g. x-mcp-client-name and x-mcp-tool. */
  headers?: Record<string, string>;
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
// 500 included: the Batch API answers a failed storage read with 500 internal, which a retry can fix.
const GET_RETRY_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
// A 429 from the Batch API is an account limit (active jobs, scheduled jobs, open-job size) and
// carries no Retry-After: a retry only waits for a slot. A POST retries a 429 only when something
// in front of the API sent Retry-After.
const POST_RETRY_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504]);

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

function retryDelayMs(attempt: number, retryAfter: number | undefined): number {
  return retryAfter !== undefined ? Math.min(retryAfter, MAX_RETRY_AFTER_SECONDS) * 1000 : backoffMs(attempt);
}

function shouldRetry(method: string, opts: RequestOpts, status: number, retryAfter: number | undefined): boolean {
  if (method === "GET") return GET_RETRY_STATUSES.has(status);
  if (!opts.idempotencyKey) return false;
  return POST_RETRY_STATUSES.has(status) || (status === 429 && retryAfter !== undefined);
}

/**
 * GETs retry on 429, 500, 502, 503, 504 and network errors. A POST retries only when it carries
 * an Idempotency-Key, so the API answers a repeat with the original response instead of creating
 * a second job: on 500, 502, 503, 504, network errors, and a 429 that carries Retry-After. Up to 3
 * retries, honoring Retry-After (capped at MAX_RETRY_AFTER_SECONDS). With a deadline, no attempt
 * starts after it, each attempt's timeout ends at it, and a retry is made only if its wait ends
 * before it. With `consume`, a success or a redirect is handed to it instead of read as text: it
 * runs under the same timeout and retries, and a redirect is not followed, so the API key is never
 * sent to the redirect's host. A BatchError it throws ends the call; any other error is retried
 * like a network error.
 */
async function batchFetch<T = undefined>(
  method: string,
  path: string,
  opts: RequestOpts,
  accept = "application/json",
  consume?: (res: Response, signal: AbortSignal) => Promise<T>
): Promise<{ res: Response; body: string; value?: T }> {
  const url = new URL(batchBase() + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }

  const headers: Record<string, string> = {
    ...(opts.headers ?? {}),
    "X-API-Key": opts.apiKey,
    Accept: accept,
    "User-Agent": opts.userAgent ?? "zenrows/mcp",
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  const canRetryMethod = method === "GET" || !!opts.idempotencyKey;

  const doFetch = opts.fetchImpl ?? fetch;
  const left = () => (opts.deadline === undefined ? Number.POSITIVE_INFINITY : opts.deadline - Date.now());
  // The error a retry would replace: thrown instead of retrying once the deadline has passed.
  let lastError: BatchError | undefined;
  for (let attempt = 0; ; attempt++) {
    if (left() <= 0) {
      throw (
        lastError ??
        new BatchError({ code: "BACKEND_UNAVAILABLE", message: "The deadline passed before the request was sent." })
      );
    }
    const canRetry = canRetryMethod && attempt < RETRIES;
    const fits = (waitMs: number) => canRetry && waitMs < left();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(0, Math.min(opts.timeoutMs ?? 60_000, left())));
    let res: Response;
    let body = "";
    let value: T | undefined;
    let handed = false;
    try {
      res = await doFetch(url.toString(), {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
        ...(consume ? { redirect: "manual" as const } : {}),
      });
      handed = !!consume && res.status >= 200 && res.status < 400;
      if (handed) value = await consume!(res, controller.signal);
      else body = await res.text();
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof BatchError) throw err;
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
    if (handed || (res.status >= 200 && res.status < 300)) return { res, body, value };

    const retryAfter = retryAfterSeconds(res.headers.get("retry-after"));
    lastError = problemToError(res.status, body, method, path, retryAfter);
    if (shouldRetry(method, opts, res.status, retryAfter)) {
      const wait = retryDelayMs(attempt, retryAfter);
      if (fits(wait)) {
        await sleep(wait);
        continue;
      }
    }
    throw lastError;
  }
}

export async function batchRequest<T>(method: string, path: string, opts: RequestOpts): Promise<T> {
  const { body: text } = await batchFetch(method, path, opts);
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

/** 409 codes with their own MCP code and advice. */
const CONFLICTS: Record<string, [code: string, message: string]> = {
  run_not_stoppable: [
    "BATCH_RUN_ENDED",
    "The job's latest run already ended (completed, failed or stopped), so it cannot be stopped, paused or resumed. Start a new run with batch_rerun.",
  ],
  run_not_terminal: [
    "BATCH_RUN_NOT_FINISHED",
    "The job's latest run is still pending or running. Wait for it with batch_wait, or stop it with batch_cancel, then retry.",
  ],
  no_prior_run: ["BATCH_NO_PRIOR_RUN", "The job has no earlier run to rerun."],
  no_matching_tasks: [
    "BATCH_NO_MATCHING_TASKS",
    "No task of the latest run has one of the statuses asked for, so there is nothing to rerun. Pass full: true to scrape every task again.",
  ],
  partial_rerun_window_expired: [
    "BATCH_RERUN_WINDOW_EXPIRED",
    "A rerun of only some tasks works up to 10 days after the run started. Pass full: true to scrape every task again.",
  ],
  idempotency_key_conflict: [
    "BATCH_IDEMPOTENCY_CONFLICT",
    "This idempotency key was used with a different request, or the first request with it has not finished. To retry the same request, keep this key and retry later, and check batch_list first: the first request may have created the job or run. Use a new key only for a different request; a new key on the same request can create a second, billed job.",
  ],
  task_not_ready: [
    "BATCH_TASK_NOT_READY",
    "The task is still pending or processing, so it has no content yet. Wait with batch_wait, then retry.",
  ],
  conflict: ["BATCH_CONFLICT", "The job changed while this request ran. Retry it."],
  job_not_open: ["BATCH_JOB_NOT_OPEN", "The job is closed and takes no more tasks."],
  last_batch_received: ["BATCH_JOB_NOT_OPEN", "The job already received its last batch of tasks."],
};

export function problemToError(
  status: number,
  body: string,
  method: string,
  path: string,
  retryAfter?: number
): BatchError {
  let problem: ProblemJson = {};
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object") problem = parsed as ProblemJson;
  } catch {
    // non-JSON: fall through
  }
  const serverCode = problem.code || undefined;
  const detail = problem.detail || problem.title || body.slice(0, 240) || `HTTP ${status}`;
  const cause = `HTTP ${status}${serverCode ? ` (${serverCode})` : ""} for ${method} ${path}: ${detail}`;
  const make = (code: string, message: string, extra: { invalidTasks?: ProblemJson["invalid_tasks"] } = {}) =>
    new BatchError({ code, message, status, detail: cause, serverCode, retryAfter, ...extra });

  if (status === 403) {
    return make(
      "BATCH_ACCESS_DENIED",
      "The Batch API rejected this request (access denied). Batch is not enabled for this account or API key. Do not retry: check that the key is active and contact Zenrows support if this persists, or fan out with scrape/extract per URL."
    );
  }
  if (status === 401 && serverCode === "subscription_inactive") {
    // The key is valid; the subscription needs a billing action. Same AUTH_INVALID code as any
    // 401 so clients that branch on it keep working; server_code tells them apart.
    return make(
      "AUTH_INVALID",
      "Zenrows refused the Batch API request because the subscription is not active (past due, unpaid, incomplete or paused). The API key is valid: fix the subscription in Billing at https://app.zenrows.com/billing, or in Azure Marketplace if you subscribed there, then retry."
    );
  }
  if (status === 401) {
    return make("AUTH_INVALID", "Zenrows rejected the API key for the Batch API.");
  }
  if (status === 404) {
    return make(
      "BATCH_NOT_FOUND",
      "Batch job, run or task not found for this account (a deleted job reads as not found). batch_list shows the account's jobs."
    );
  }
  if (status === 402 && serverCode === "api_key_cap_reached") {
    return make(
      "BATCH_KEY_CAP_REACHED",
      "This API key reached one of its credit caps, so the Batch API refused the request. The account's other API keys still work. Raise or remove the cap at https://app.zenrows.com/settings/api-keys, or wait until it resets (see detail)."
    );
  }
  if (status === 402) {
    return make(
      "BATCH_INSUFFICIENT_CREDITS",
      "This account has no credits left, so the Batch API refused the request. Add credits or upgrade in Billing at https://app.zenrows.com/billing, then retry."
    );
  }
  if (status === 429 && serverCode === "quota_exceeded") {
    return make(
      "BATCH_QUOTA_EXCEEDED",
      "The account reached a Batch limit that more credits do not raise: 3 active jobs by default, shared with Crawl (or 5 scheduled jobs, or 100,000 tasks in one open job; see detail). Wait for a job to finish, stop one with batch_cancel or delete one with batch_delete, then retry."
    );
  }
  if (status === 429) {
    return make(
      "BATCH_RATE_LIMITED",
      `The Batch API is rate limiting requests. ${retryAfter !== undefined ? `Retry after ${retryAfter} seconds.` : "Retry later."}`
    );
  }
  if (status === 409) {
    const known = serverCode ? CONFLICTS[serverCode] : undefined;
    if (known) return make(known[0], known[1]);
    return make(
      "BATCH_CONFLICT",
      `The Batch API refused the request (HTTP 409${serverCode ? `, ${serverCode}` : ""}): ${detail}`
    );
  }
  if (status === 410) {
    return make(
      "BATCH_RESULT_EXPIRED",
      "This task's result is past the job's retention (14 days by default) and can no longer be read. Rerun the job with batch_rerun (full: true) to scrape it again."
    );
  }
  if (status === 422) {
    // The content endpoint answers a failed task with its stored problem.
    return new BatchError({
      code: "BATCH_TASK_FAILED",
      message: `The task failed, so it has no content${serverCode ? ` (${serverCode})` : ""}: ${detail}. Rerun failed tasks with batch_rerun.`,
      status,
      detail: cause,
      serverCode,
      taskError: Object.keys(problem).length ? problem : body.slice(0, 2000) || undefined,
    });
  }
  if (status === 400) {
    const invalid = problem.invalid_tasks?.length
      ? ` First invalid tasks: ${problem.invalid_tasks
          .slice(0, 10)
          .map((t) => `#${t.index}: ${t.reason}`)
          .join("; ")}.`
      : "";
    return make(
      "BATCH_INVALID_REQUEST",
      `The Batch API rejected the request${serverCode ? ` (${serverCode})` : ""}: ${detail}${invalid} Fix it and send it again; nothing was created.`,
      { invalidTasks: problem.invalid_tasks?.slice(0, 20) }
    );
  }
  if (status === 503 && method === "POST") {
    return make(
      "BATCH_FAILED",
      "The Batch API could not finish the request (HTTP 503). If it created a run, that run ends as stopped: check with batch_status or batch_list before retrying, and rerun it with batch_rerun."
    );
  }
  return make("BATCH_FAILED", `Batch request failed (HTTP ${status}).`);
}

/**
 * The code and advice for a run that an account problem ended (`failure_reason`): the same code
 * the matching HTTP error gets, so an agent sees one code for one cause.
 */
export function runFailure(reason: string | undefined): { code: string; advice: string } {
  switch (reason) {
    case "insufficient_credits":
      return {
        code: "BATCH_INSUFFICIENT_CREDITS",
        advice:
          "The account ran out of credits, so the run stopped. Add credits or upgrade in Billing at https://app.zenrows.com/billing, then call batch_rerun: its default reruns the failed and pending tasks.",
      };
    case "api_key_cap_reached":
      return {
        code: "BATCH_KEY_CAP_REACHED",
        advice:
          "This API key reached one of its credit caps, so the run stopped. The account's other API keys still work. Raise or remove the cap at https://app.zenrows.com/settings/api-keys, or wait until it resets, then call batch_rerun.",
      };
    case "subscription_inactive":
      return {
        code: "AUTH_INVALID",
        advice:
          "The subscription is not active (past due, unpaid, incomplete or paused), so the run stopped. Fix it in Billing at https://app.zenrows.com/billing, or in Azure Marketplace if you subscribed there, then call batch_rerun.",
      };
    default:
      return {
        code: "BATCH_RUN_FAILED",
        advice: "The run ended as failed; failure_reason and failure_detail say why. batch_rerun starts a new run.",
      };
  }
}

export interface CallOpts {
  apiKey: string;
  timeoutMs?: number;
  userAgent?: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  deadline?: number;
}

const jobPath = (id: string) => `/jobs/${encodeURIComponent(id)}`;
const runPrefix = (id: string, runId?: string) =>
  runId ? `${jobPath(id)}/runs/${encodeURIComponent(runId)}` : jobPath(id);

/** Pass an idempotencyKey so a retried submit returns the original job instead of a second one. */
export function createJob(body: unknown, opts: CallOpts & { idempotencyKey?: string }): Promise<Job> {
  return batchRequest<Job>("POST", "/jobs", { ...opts, body });
}

export function getJob(id: string, opts: CallOpts): Promise<Job> {
  return batchRequest<Job>("GET", jobPath(id), opts);
}

export function listJobs(
  opts: CallOpts & { cursor?: string; limit?: number; status?: string; type?: string }
): Promise<JobList> {
  return batchRequest<JobList>("GET", "/jobs", {
    ...opts,
    query: {
      cursor: opts.cursor,
      limit: opts.limit !== undefined ? String(opts.limit) : undefined,
      status: opts.status,
      type: opts.type,
    },
  });
}

/** POST /jobs/:id/stop answers with the refreshed Run, not the Job. */
export function stopJob(id: string, opts: CallOpts): Promise<JobRun> {
  return batchRequest<JobRun>("POST", `${jobPath(id)}/stop`, opts);
}

/** Pause and resume answer with the refreshed Run. */
export function pauseJob(id: string, opts: CallOpts): Promise<JobRun> {
  return batchRequest<JobRun>("POST", `${jobPath(id)}/pause`, opts);
}

export function resumeJob(id: string, opts: CallOpts): Promise<JobRun> {
  return batchRequest<JobRun>("POST", `${jobPath(id)}/resume`, opts);
}

/** No statuses: a full rerun. Answers 202 with the job and its new latest run. */
export function rerunJob(
  id: string,
  opts: CallOpts & { statuses?: string[]; idempotencyKey?: string }
): Promise<RerunResponse> {
  return batchRequest<RerunResponse>("POST", `${jobPath(id)}/rerun`, {
    ...opts,
    query: { status: opts.statuses?.length ? opts.statuses.join(",") : undefined },
  });
}

/** Asynchronous delete: answers 202 with no body. */
export async function deleteJob(id: string, opts: CallOpts): Promise<void> {
  await batchFetch("DELETE", jobPath(id), opts);
}

export type ResultsStatus = "successful" | "failed" | "processing" | "all";

/** One page of results as the API returns it (about 1,000 rows per page; short pages happen). */
export async function listResultsPage(
  id: string,
  opts: CallOpts & { status?: ResultsStatus; cursor?: string; runId?: string }
): Promise<ResultsPage> {
  const page = await batchRequest<ResultsPage>("GET", `${runPrefix(id, opts.runId)}/results`, {
    ...opts,
    query: { status: opts.status, cursor: opts.cursor },
  });
  return { results: page?.results ?? [], next_cursor: page?.next_cursor ?? null };
}

/** Default rows per batch_results call, to keep a tool answer small. */
export const DEFAULT_RESULTS_LIMIT = 100;
/** Most API pages one batch_results call reads, so a sparse filter cannot scan a whole job in one call. */
export const MAX_RESULT_PAGES_PER_CALL = 10;

/**
 * Where a results read stopped: the API page it was on and the last task_id already returned
 * from it. Rows in a page come in task_id order, so a read that stopped mid-page resumes after
 * that id, even when rows left or joined the filter (a processing row that finished) in between.
 */
interface ResultsCursor {
  c: string | null;
  a?: string;
}

export function encodeResultsCursor(c: ResultsCursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

export function decodeResultsCursor(s: string): ResultsCursor {
  try {
    const v = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Partial<ResultsCursor>;
    if ((typeof v.c === "string" || v.c === null) && (v.a === undefined || typeof v.a === "string")) {
      return { c: v.c, ...(v.a !== undefined ? { a: v.a } : {}) };
    }
  } catch {
    // fall through
  }
  throw new BatchError({
    code: "INVALID_USAGE",
    message:
      "cursor is not a next_cursor this server returned. Pass next_cursor from a previous batch_results call, or none.",
  });
}

export interface ResultsRead {
  results: ResultRow[];
  /** Pass back as cursor to continue. Null once every row was read. */
  next_cursor: string | null;
  /** API pages read by this call. */
  pages: number;
}

/**
 * Reads up to `limit` rows from `cursor` on. The API's pages hold about 1,000 rows and take no
 * size, so a call that stops mid-page returns a cursor naming that page and the last task_id it
 * returned; the next call reads the page again and goes on after that id. Reads at most
 * MAX_RESULT_PAGES_PER_CALL pages, then returns what it has with a cursor.
 */
export async function readResults(
  id: string,
  opts: CallOpts & { status?: ResultsStatus; cursor?: string; limit?: number; runId?: string }
): Promise<ResultsRead> {
  const limit = opts.limit ?? DEFAULT_RESULTS_LIMIT;
  const start: ResultsCursor = opts.cursor ? decodeResultsCursor(opts.cursor) : { c: null };
  const results: ResultRow[] = [];
  let apiCursor = start.c;
  let after = start.a;
  for (let pages = 1; ; pages++) {
    const page = await listResultsPage(id, { ...opts, cursor: apiCursor ?? undefined });
    const rows = after === undefined ? page.results : page.results.filter((r) => r.task_id > after!);
    const take = rows.slice(0, limit - results.length);
    results.push(...take);
    if (take.length < rows.length) {
      return {
        results,
        next_cursor: encodeResultsCursor({ c: apiCursor, a: take[take.length - 1]?.task_id ?? after }),
        pages,
      };
    }
    if (page.next_cursor === null) return { results, next_cursor: null, pages };
    apiCursor = page.next_cursor;
    after = undefined;
    if (results.length >= limit || pages >= MAX_RESULT_PAGES_PER_CALL) {
      return { results, next_cursor: encodeResultsCursor({ c: apiCursor }), pages };
    }
  }
}

/** True for a content type the tool can return as text. */
export function isTextContentType(contentType: string): boolean {
  const t = contentType.toLowerCase();
  return t.startsWith("text/") || /\b(json|xml|markdown|javascript)\b/.test(t);
}

export type TaskContent =
  | { kind: "text"; contentType: string; body: string }
  | { kind: "binary"; contentType: string; bytes?: number; resultUrl?: string };

/**
 * Reads a success response as text, or describes a binary one without downloading it. Runs while
 * the request's timeout is still armed, so a stalled body ends the call instead of hanging it.
 */
async function toContent(res: Response, resultUrl?: string): Promise<TaskContent> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType && !isTextContentType(contentType)) {
    await res.body?.cancel().catch(() => undefined);
    const length = Number(res.headers.get("content-length"));
    return {
      kind: "binary",
      contentType,
      ...(Number.isFinite(length) && length > 0 ? { bytes: length } : {}),
      ...(resultUrl ? { resultUrl } : {}),
    };
  }
  return { kind: "text", contentType, body: await res.text() };
}

/**
 * One task's stored result. Text bodies are read; a binary body (a PDF) is not downloaded.
 * When the API redirects to a presigned URL, that URL is followed without the API key and comes
 * back as resultUrl for a binary body. Reading the body, the redirect's included, is bounded by
 * the request timeout and retried like the request.
 */
export async function getTaskContent(
  id: string,
  taskId: string,
  opts: CallOpts & { runId?: string }
): Promise<TaskContent> {
  const path = `${runPrefix(id, opts.runId)}/tasks/${encodeURIComponent(taskId)}/content`;
  const doFetch = opts.fetchImpl ?? fetch;
  const { value } = await batchFetch("GET", path, opts, "*/*", async (res, signal) => {
    if (res.status < 300) return toContent(res);
    const location = res.headers.get("location");
    if (!location) {
      throw new BatchError({
        code: "BATCH_FAILED",
        message: `The Batch API redirected (HTTP ${res.status}) without a Location.`,
      });
    }
    const target = new URL(location, batchBase() + path).toString();
    const followed = await doFetch(target, { signal });
    if (!followed.ok) {
      await followed.body?.cancel().catch(() => undefined);
      throw new BatchError({
        code: "BATCH_FAILED",
        message: `Reading the task's result_url failed (HTTP ${followed.status}).`,
        status: followed.status,
      });
    }
    return toContent(followed, target);
  });
  return value!;
}

/**
 * The run is paused and has not ended. Pausing stops new task pickups; tasks already in flight
 * can still finish, and the run completes on its own if those were the last ones. pause_state
 * stays on a run that later stops or completes, so a terminal run is never reported as paused.
 */
export function isPausedRun(run: JobRun | undefined): boolean {
  return run?.pause_state === "paused" && (run.status === "running" || run.status === "pending");
}

/** Default wait in seconds, below the 60 s after which many MCP clients cancel a tool call. */
export const DEFAULT_WAIT_SECONDS = 50;

export interface WaitOutcome {
  /** The last job read; undefined only when no poll succeeded. */
  job?: Job;
  /** The deadline passed before the run ended. */
  timedOut: boolean;
  /** The last poll's error, when polls were failing as the deadline passed. */
  lastError?: BatchError;
}

function isTransient(e: unknown): e is BatchError {
  if (!(e instanceof BatchError)) return false;
  if (e.code === "BACKEND_UNAVAILABLE") return true;
  return e.status !== undefined && GET_RETRY_STATUSES.has(e.status);
}

/**
 * Polls until the latest run is terminal or paused, or `timeout` seconds pass. Running out is
 * not an error: it returns the last job read with timedOut set. A transient poll failure is one
 * missed poll; anything else (a 404) ends the wait with that error. `onPoll` runs after each
 * successful poll with the job and the poll's number, counted from 1.
 */
export async function waitForJob(
  id: string,
  opts: CallOpts & {
    timeout?: number;
    pollDelayMs?: number;
    onPoll?: (job: Job, poll: number) => void | Promise<void>;
  }
): Promise<WaitOutcome> {
  const deadline = Date.now() + (opts.timeout ?? DEFAULT_WAIT_SECONDS) * 1000;
  let delay = opts.pollDelayMs ?? 2000;
  let job: Job | undefined;
  let lastError: BatchError | undefined;
  for (let poll = 1; ; poll++) {
    try {
      job = await getJob(id, { ...opts, deadline });
      lastError = undefined;
      await opts.onPoll?.(job, poll);
      const run = job.latest_run;
      // No latest run: its only run was deleted. Nothing to wait for.
      if (!run || TERMINAL_STATUSES.has(run.status) || isPausedRun(run)) return { job, timedOut: false };
    } catch (e) {
      if (!isTransient(e)) throw e;
      lastError = e;
    }
    // The API's Retry-After on a failed poll sets the earliest next poll.
    const wait = Math.max(delay, (lastError?.retryAfter ?? 0) * 1000);
    if (Date.now() + wait >= deadline) return { job, timedOut: true, lastError };
    await sleep(wait);
    delay = Math.min(delay * 1.5, 15_000);
  }
}

/** How long one batch_content call may look for a binary result's row before it hands back a cursor. */
export const FIND_ROW_BUDGET_MS = 40_000;

export type FindRowOutcome =
  | { row: ResultRow }
  | { notFound: true }
  /** The budget ran out first: pass `cursor` back to go on from there. */
  | { cursor: string };

/**
 * Looks for one task's row in a run's successful results, to hand out a binary result's
 * presigned URL. Bounded by `budgetMs`; past it, it returns a cursor to resume from.
 */
export async function findResultRow(
  id: string,
  taskId: string,
  opts: CallOpts & { runId?: string; cursor?: string; budgetMs?: number }
): Promise<FindRowOutcome> {
  const deadline = Date.now() + (opts.budgetMs ?? FIND_ROW_BUDGET_MS);
  let cursor = opts.cursor;
  for (;;) {
    const read = await listResultsPage(id, { ...opts, status: "successful", cursor });
    const row = read.results.find((r) => r.task_id === taskId);
    if (row) return { row };
    // No early stop on task_id order: the API keeps order inside a page, not always across pages.
    if (read.next_cursor === null) return { notFound: true };
    cursor = read.next_cursor;
    if (Date.now() >= deadline) return { cursor };
  }
}
