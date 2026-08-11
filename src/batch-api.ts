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

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "stopped", "deleted"]);

export class BatchError extends Error {
  code: string;
  status?: number;
  detail?: string;

  constructor(opts: { code: string; message: string; status?: number; detail?: string }) {
    super(opts.message);
    this.name = "BatchError";
    this.code = opts.code;
    this.status = opts.status;
    this.detail = opts.detail;
  }

  toJSON(): { code: string; message: string; status?: number; detail?: string } {
    return { code: this.code, message: this.message, status: this.status, detail: this.detail };
  }
}

interface RequestOpts {
  apiKey: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
  timeoutMs?: number;
  userAgent?: string;
  fetchImpl?: typeof fetch;
}

export async function batchRequest<T>(method: string, path: string, opts: RequestOpts): Promise<T> {
  const url = new URL(batchBase() + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  const headers: Record<string, string> = {
    "X-API-Key": opts.apiKey,
    Accept: "application/json",
    "User-Agent": opts.userAgent ?? "zenrows/mcp",
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url.toString(), {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    throw new BatchError({
      code: "BACKEND_UNAVAILABLE",
      message: `Could not reach the Zenrows Batch API: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  clearTimeout(timeout);

  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    throw problemToError(res.status, text, method, path);
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

function problemToError(status: number, body: string, method: string, path: string): BatchError {
  let problem: ProblemJson = {};
  try {
    problem = JSON.parse(body) as ProblemJson;
  } catch {
    // non-JSON — fall through
  }
  const serverCode = problem.code ?? "";
  const detail = problem.detail || problem.title || body.slice(0, 240) || `HTTP ${status}`;
  const cause = `HTTP ${status}${serverCode ? ` (${serverCode})` : ""} for ${method} ${path}: ${detail}`;

  if (status === 403) {
    return new BatchError({
      code: "BATCH_ACCESS_DENIED",
      message:
        "The Batch API rejected this request (access denied). The Batch API is in beta and this account does not have beta access. Request access from Zenrows, or fan out with scrape/extract per URL.",
      status,
      detail: cause,
    });
  }
  if (status === 401) {
    return new BatchError({
      code: "AUTH_INVALID",
      message: "Zenrows rejected the API key for the Batch API.",
      status,
      detail: cause,
    });
  }
  if (status === 404) {
    return new BatchError({
      code: "BATCH_NOT_FOUND",
      message: "Batch job, run, or task not found.",
      status,
      detail: cause,
    });
  }
  if (status === 429) {
    return new BatchError({
      code: "BATCH_QUOTA_EXCEEDED",
      message:
        "Batch quota exceeded (e.g. max concurrent active jobs). Wait for an in-flight job to finish or cancel one, then retry.",
      status,
      detail: cause,
    });
  }
  if (status === 402) {
    return new BatchError({
      code: "BATCH_QUOTA_EXCEEDED",
      message: "Subscription has no credit available for the Batch API.",
      status,
      detail: cause,
    });
  }

  const invalid = problem.invalid_tasks?.length
    ? ` invalid_tasks: ${problem.invalid_tasks
        .slice(0, 10)
        .map((t) => `#${t.index}: ${t.reason}`)
        .join("; ")}`
    : "";
  return new BatchError({
    code: "BATCH_FAILED",
    message: `Batch request failed (HTTP ${status}).${invalid}`,
    status,
    detail: cause,
  });
}

interface CallOpts {
  apiKey: string;
  timeoutMs?: number;
  userAgent?: string;
  fetchImpl?: typeof fetch;
}

export function createJob(body: unknown, opts: CallOpts): Promise<Job> {
  return batchRequest<Job>("POST", "/jobs", { ...opts, body });
}

export function getJob(id: string, opts: CallOpts): Promise<Job> {
  return batchRequest<Job>("GET", `/jobs/${encodeURIComponent(id)}`, opts);
}

export function stopJob(id: string, opts: CallOpts): Promise<Job> {
  return batchRequest<Job>("POST", `/jobs/${encodeURIComponent(id)}/stop`, opts);
}

export async function listResults(
  id: string,
  opts: CallOpts & { status?: "successful" | "failed" | "all" }
): Promise<ResultRow[]> {
  const all: ResultRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await batchRequest<ResultsPage>("GET", `/jobs/${encodeURIComponent(id)}/results`, {
      ...opts,
      query: { status: opts.status, cursor },
    });
    if (page?.results) all.push(...page.results);
    cursor = page?.next_cursor ?? undefined;
  } while (cursor);
  return all;
}

export async function waitForJob(
  id: string,
  opts: CallOpts & { pollTimeoutMs?: number }
): Promise<Job> {
  const deadline = Date.now() + (opts.pollTimeoutMs ?? opts.timeoutMs ?? 600_000);
  let delay = 2000;
  for (;;) {
    const job = await getJob(id, opts);
    if (job.latest_run && TERMINAL_STATUSES.has(job.latest_run.status)) return job;
    if (Date.now() > deadline) {
      throw new BatchError({
        code: "BATCH_FAILED",
        message: `Timed out waiting for batch job ${id} to finish.`,
        detail: `The run did not reach a terminal state within ${Math.round((opts.pollTimeoutMs ?? opts.timeoutMs ?? 600_000) / 1000)}s.`,
      });
    }
    await new Promise<void>((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 15_000);
  }
}
