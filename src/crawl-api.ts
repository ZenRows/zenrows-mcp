/**
 * Client for the Zenrows Crawl API (https://api.zenrows.com/v1/crawls).
 * Auth via X-API-Key header. Errors are application/problem+json (RFC 9457).
 *
 * A crawl follows the links on each page up to `depth` and stays on the start URL's
 * registrable domain (subdomains count). `output_format` is `html` (each kept URL's page
 * is stored) or absent (URLs only).
 */

export const DEFAULT_CRAWL_API_BASE = "https://api.zenrows.com/v1";
export const CRAWL_API_BASE_ENV = "ZENROWS_CRAWL_API_BASE";

export function crawlBase(): string {
  const env = process.env[CRAWL_API_BASE_ENV];
  const base = env && env.trim() ? env.trim() : DEFAULT_CRAWL_API_BASE;
  return base.replace(/\/+$/, "");
}

export interface CrawlCoverage {
  pages_fetched: number;
  pages_failed: number;
  items_found: number;
}

/** status: running | completed | stopped | failed. New values may appear; anything but running is terminal. */
export interface Crawl {
  crawl_id: string;
  status: string;
  url: string;
  depth: number;
  max_items: number;
  max_pages: number;
  coverage: CrawlCoverage;
  created_at: string;
  stop_reason?: string;
  error?: { code: string; detail: string };
  finished_at?: string;
  [k: string]: unknown;
}

export interface CrawlResult {
  url: string;
  /** pending | fetched | failed; present only when the crawl has an output_format. */
  content_status?: string;
  /** Path like /v1/crawls/c_x/contents/ct_y, present when content_status is fetched. */
  content_url?: string;
  [k: string]: unknown;
}

export interface CrawlWithResults extends Crawl {
  results: CrawlResult[];
  /** Never null while the crawl runs; null once it ended and this page holds its last URLs. */
  next_cursor: string | null;
}

export interface CrawlList {
  crawls: Crawl[];
  next_cursor?: string;
}

export interface CrawlStop {
  crawl_id: string;
  status: string;
  stop_reason?: string;
  error?: { code: string; detail: string };
  finished_at?: string;
  [k: string]: unknown;
}

/** Create body. Unset fields are not sent. */
export interface CreateCrawlBody {
  url: string;
  depth: number;
  max_items?: number;
  max_pages?: number;
  include_patterns?: string[];
  exclude_patterns?: string[];
  output_format?: "html";
}

export interface ProblemJson {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  code?: string;
  instance?: string;
}

export function isTerminal(status: string | undefined): boolean {
  return status !== undefined && status !== "running";
}

export class CrawlError extends Error {
  code: string;
  status?: number;
  detail?: string;
  /** The problem+json `code` the server sent, if any. */
  serverCode?: string;
  /** Seconds to wait before retrying, from Retry-After on a 429. */
  retryAfter?: number;

  constructor(opts: {
    code: string;
    message: string;
    status?: number;
    detail?: string;
    serverCode?: string;
    retryAfter?: number;
  }) {
    super(opts.message);
    this.name = "CrawlError";
    this.code = opts.code;
    this.status = opts.status;
    this.detail = opts.detail;
    this.serverCode = opts.serverCode;
    this.retryAfter = opts.retryAfter;
  }

  toJSON(): {
    code: string;
    message: string;
    status?: number;
    detail?: string;
    server_code?: string;
    retry_after?: number;
  } {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      detail: this.detail,
      ...(this.serverCode ? { server_code: this.serverCode } : {}),
      ...(this.retryAfter !== undefined ? { retry_after: this.retryAfter } : {}),
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
}

async function crawlFetch(method: string, path: string, opts: RequestOpts, accept: string): Promise<Response> {
  const url = new URL(crawlBase() + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  const headers: Record<string, string> = {
    "X-API-Key": opts.apiKey,
    Accept: accept,
    "User-Agent": opts.userAgent ?? "zenrows/mcp",
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(url.toString(), {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    if (res.status < 200 || res.status >= 300) {
      throw problemToError(res.status, await res.text(), method, path, res.headers.get("retry-after"));
    }
    return res;
  } catch (err) {
    if (err instanceof CrawlError) throw err;
    throw new CrawlError({
      code: "BACKEND_UNAVAILABLE",
      message: `Could not reach the Zenrows Crawl API: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function crawlRequest<T>(method: string, path: string, opts: RequestOpts): Promise<T> {
  const res = await crawlFetch(method, path, opts, "application/json");
  const text = await res.text();
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CrawlError({
      code: "CRAWL_FAILED",
      message: "The Crawl API response was not valid JSON.",
      detail: text.slice(0, 240),
    });
  }
}

export function problemToError(
  status: number,
  body: string,
  method: string,
  path: string,
  retryAfterHeader?: string | null
): CrawlError {
  let problem: ProblemJson = {};
  try {
    problem = JSON.parse(body) as ProblemJson;
  } catch {
    // non-JSON — fall through
  }
  const serverCode = problem.code || undefined;
  const detail = problem.detail || problem.title || body.slice(0, 240) || `HTTP ${status}`;
  const cause = `HTTP ${status}${serverCode ? ` (${serverCode})` : ""} for ${method} ${path}: ${detail}`;
  const error = (code: string, message: string, retryAfter?: number) =>
    new CrawlError({ code, message, status, detail: cause, serverCode, retryAfter });

  if (status === 403 && serverCode === "REQS008") {
    return error(
      "CRAWL_NOT_ENABLED",
      "Crawl is not enabled for this account. Do not retry. Ask the user to request Crawl access from Zenrows; meanwhile, scrape the pages one by one."
    );
  }
  if (status === 401) {
    return error("AUTH_INVALID", "Zenrows rejected the API key for the Crawl API.");
  }
  if (status === 404) {
    return serverCode === "content_not_found"
      ? error(
          "CRAWL_CONTENT_NOT_FOUND",
          "No page stored for this content_url: the crawl ran without output_format, or the page is not fetched yet, or its fetch failed. Check content_status in crawl_results."
        )
      : error(
          "CRAWL_NOT_FOUND",
          "Crawl not found for this account. Check the crawl_id (crawl_list shows the account's crawls)."
        );
  }
  if (status === 429) {
    const seconds = Number(retryAfterHeader);
    return error(
      "CRAWL_TOO_MANY_CRAWLS",
      "The account has reached its limit of active jobs (3 by default), shared with its Batch jobs. Wait for a crawl or Batch job to finish, or stop one with crawl_stop or batch_cancel, then retry after retry_after seconds.",
      Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
    );
  }
  if (status === 402 && serverCode === "AUTH014") {
    return error(
      "CRAWL_KEY_CAP_REACHED",
      "This API key reached one of its credit caps, so the Crawl API refused the request. The account's other API keys still work. Raise or remove the cap at https://app.zenrows.com/settings/api-keys, or wait until it resets (see detail)."
    );
  }
  if (status === 402) {
    return error("CRAWL_QUOTA_EXCEEDED", "Subscription has no credit available for the Crawl API.");
  }
  if (status === 409) {
    return error(
      "CRAWL_REQUEST_IN_FLIGHT",
      "A request with the same idempotency key is still in progress. Retry after the first request finishes."
    );
  }
  if (status === 400 || status === 422) {
    return error(
      "CRAWL_INVALID_REQUEST",
      `Crawl rejected the request${serverCode ? ` (${serverCode})` : ""}: ${detail}`
    );
  }
  return error("CRAWL_FAILED", `Crawl request failed (HTTP ${status}).`);
}

interface CallOpts {
  apiKey: string;
  timeoutMs?: number;
  userAgent?: string;
  fetchImpl?: typeof fetch;
}

const crawlPath = (id: string) => `/crawls/${encodeURIComponent(id)}`;

export function createCrawl(body: CreateCrawlBody, opts: CallOpts): Promise<Crawl> {
  return crawlRequest<Crawl>("POST", "/crawls", { ...opts, body });
}

export function getCrawl(id: string, opts: CallOpts & { cursor?: string; limit?: number }): Promise<CrawlWithResults> {
  return crawlRequest<CrawlWithResults>("GET", crawlPath(id), {
    ...opts,
    query: { cursor: opts.cursor, limit: opts.limit !== undefined ? String(opts.limit) : undefined },
  });
}

export function listCrawls(opts: CallOpts & { cursor?: string; limit?: number }): Promise<CrawlList> {
  return crawlRequest<CrawlList>("GET", "/crawls", {
    ...opts,
    query: { cursor: opts.cursor, limit: opts.limit !== undefined ? String(opts.limit) : undefined },
  });
}

export function stopCrawl(id: string, opts: CallOpts): Promise<CrawlStop> {
  return crawlRequest<CrawlStop>("POST", `${crawlPath(id)}/stop`, opts);
}

/** One kept URL's page, as the crawl stored it (HTML text for output_format html). */
export async function getCrawlContent(
  id: string,
  contentId: string,
  opts: CallOpts
): Promise<{ contentType: string; body: string }> {
  const res = await crawlFetch("GET", `${crawlPath(id)}/contents/${encodeURIComponent(contentId)}`, opts, "*/*");
  return { contentType: res.headers.get("content-type") ?? "", body: await res.text() };
}

/** Reads the crawl and content ids out of a result's content_url (/v1/crawls/{crawl}/contents/{content}). */
export function parseContentUrl(contentUrl: string): { crawlId: string; contentId: string } | undefined {
  const m = contentUrl.match(/\/crawls\/([^/?#]+)\/contents\/([^/?#]+)/);
  if (!m) return undefined;
  return { crawlId: decodeURIComponent(m[1]), contentId: decodeURIComponent(m[2]) };
}

/** Default page size for crawl_get and cap for crawl_results, to keep a tool answer small. */
export const DEFAULT_LIMIT = 100;

/** Default wait in seconds, below the 60 s after which many MCP clients cancel a tool call. */
export const DEFAULT_WAIT_SECONDS = 50;

export interface ResultsRead {
  results: CrawlResult[];
  /** Pass back as cursor to continue. Null once the crawl ended and every result was read. */
  next_cursor: string | null;
  status: string;
}

/**
 * Reads results from `cursor` on, following next_cursor until it is null (crawl ended,
 * all read), a page comes back empty (a running crawl has nothing new yet), or
 * `limit` results are read.
 */
export async function readResults(
  id: string,
  opts: CallOpts & { cursor?: string; limit?: number }
): Promise<ResultsRead> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const results: CrawlResult[] = [];
  let cursor = opts.cursor;
  for (;;) {
    const page = await getCrawl(id, { ...opts, cursor, limit: limit - results.length });
    const rows = page.results ?? [];
    results.push(...rows);
    const next = page.next_cursor ?? null;
    if (next === null || results.length >= limit || rows.length === 0) {
      return { results, next_cursor: next, status: page.status };
    }
    cursor = next;
  }
}

/**
 * Polls the crawl (limit=1, so each poll is cheap) until its status is terminal or
 * `timeout` seconds run out. Running out is not an error: it returns the crawl, still running.
 */
export async function waitForCrawl(
  id: string,
  opts: CallOpts & { timeout?: number; pollDelayMs?: number }
): Promise<Crawl> {
  const deadline = Date.now() + (opts.timeout ?? DEFAULT_WAIT_SECONDS) * 1000;
  let delay = opts.pollDelayMs ?? 2000;
  for (;;) {
    const crawl = await getCrawl(id, { ...opts, limit: 1 });
    if (isTerminal(crawl.status) || Date.now() + delay > deadline) return withoutResults(crawl);
    await new Promise<void>((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 15_000);
  }
}

/** The crawl without its page of results. */
function withoutResults(crawl: Crawl | CrawlWithResults): Crawl {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { results, next_cursor, ...rest } = crawl as CrawlWithResults;
  return rest;
}
