import { createRequire } from "module";
import { link, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendClaimHint } from "../auth/claim-hint.js";
import { getZenrowsDir } from "../auth/ensure-key.js";
import {
  Crawl,
  CrawlError,
  CrawlResult,
  CrawlStop,
  contentIdOf,
  crawlDownloadUrl,
  createCrawl,
  CreateCrawlBody,
  DEFAULT_LIMIT,
  DEFAULT_WAIT_SECONDS,
  downloadCrawl,
  getCrawl,
  getCrawlContent,
  isTerminal,
  listCrawls,
  readResults,
  stopCrawl,
  waitForCrawl,
} from "../crawl-api.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

type TextContent = { type: "text"; text: string };

/** Default cap on crawl_content's HTML, in characters; a page can run to megabytes. */
export const DEFAULT_CONTENT_MAX_CHARS = 20_000;

function err(
  data: unknown,
  hint?: { status?: number; code?: string; message?: string }
): {
  content: TextContent[];
  isError: true;
} {
  const raw = typeof data === "string" ? data : JSON.stringify(data);
  return {
    content: [
      {
        type: "text" as const,
        text: appendClaimHint(raw, {
          status: hint?.status,
          code: hint?.code,
          message: hint?.message ?? raw,
          body: raw,
        }),
      },
    ],
    isError: true as const,
  };
}

function json(data: unknown): { content: TextContent[] } {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

/** crawlId: set on any call about one existing crawl, so the agent never takes a failed wait for a failed create. */
function crawlErr(e: unknown, crawlId?: string): { content: TextContent[]; isError: true } {
  const data =
    e instanceof CrawlError
      ? e.toJSON()
      : { code: "CRAWL_FAILED", message: e instanceof Error ? e.message : String(e) };
  const hint = e instanceof CrawlError ? { status: e.status, code: e.code, message: e.message } : undefined;
  return err(crawlId ? { ...data, crawl_id: crawlId } : data, hint);
}

const WAIT_NOTE =
  "The wait ran out and the crawl is still running. Call crawl_wait again, read partial results with crawl_results, or stop it with crawl_stop.";

/** What a crawl_results reply that still has a cursor tells the agent to do next. */
function resultsNote(status: string, ended: boolean, full: boolean): string {
  if (!ended) {
    return "The crawl is still running, so this list is partial: call crawl_results again with next_cursor later, or crawl_wait first.";
  }
  if (full || status !== "stopped") return "More results remain: call crawl_results again with next_cursor.";
  return "The crawl was stopped, but pages fetched before the stop can still add URLs for up to 10 minutes: call crawl_results again later with next_cursor. Once next_cursor is null, every URL was read.";
}

/**
 * The one output shape of crawl_create, crawl_get, crawl_wait and crawl_stop. A crawl that
 * ended `failed` answers ok: false with an error naming its code, as the CLI does, so an agent
 * that reads only `ok` does not take a failed crawl for a finished one.
 */
function crawlOut(
  crawl: CrawlStop,
  more: { note?: string; results?: CrawlResult[]; next_cursor?: string | null; first_urls?: string[] } = {}
): { content: TextContent[] } {
  const failed = crawl.status === "failed";
  const error = failed
    ? {
        code: "CRAWL_FAILED",
        message: `Crawl ${crawl.crawl_id} failed${crawl.error?.code ? ` (${crawl.error.code})` : ""}: ${crawl.error?.detail ?? "no reason given"}`,
        server_code: crawl.error?.code,
        detail: crawl.error?.detail,
      }
    : undefined;
  return json({
    ok: !failed,
    crawl_id: crawl.crawl_id,
    status: crawl.status,
    crawl,
    ...more,
    ...(error ? { error } : {}),
  });
}

/** How many URLs crawl_wait shows; crawl_download saves them all. */
export const WAIT_URLS = 20;

function waitedOut(crawl: Crawl, firstUrls?: string[]): { content: TextContent[] } {
  if (!isTerminal(crawl.status)) return crawlOut(crawl, { note: WAIT_NOTE });
  if (!firstUrls) return crawlOut(crawl);
  const more = (crawl.coverage?.items_found ?? 0) > firstUrls.length;
  return crawlOut(crawl, {
    first_urls: firstUrls,
    ...(more
      ? {
          note: `first_urls holds ${firstUrls.length} of ${crawl.coverage?.items_found} URLs. Save every result to a file with crawl_download, or page through them with crawl_results.`,
        }
      : {}),
  });
}

/** One line for a crawl_wait progress notification, e.g. "running: 12 pages fetched, 30 URLs kept". */
function progressMessage(crawl: Crawl): string {
  const c = crawl.coverage;
  return `${crawl.status}: ${c?.pages_fetched ?? 0} pages fetched, ${c?.items_found ?? 0} URLs kept`;
}

const WHEN_TO_USE = `Use crawl when you have one start page (a listing, category, blog index) and need
the URLs behind it, optionally with each page's HTML. For a single page, use scrape.`;

const crawlIdSchema = z.string().describe("Crawl id returned by crawl_create (c_…)");
const limitSchema = z.number().int().min(1).max(10_000).nullish();

export interface CrawlToolOptions {
  /** Hosted (HTTP) server: crawl_download writes no file and returns the URL and a command instead. */
  hosted?: boolean;
  /** Where crawl_download saves files and resolves relative paths. Default: ~/.zenrows/crawls. */
  downloadDir?: string;
}

export function registerCrawlTools(server: McpServer, apiKey: string, options: CrawlToolOptions = {}): void {
  const ua = `zenrows/mcp ${pkg.version}`;
  const call = { apiKey, userAgent: ua };
  const downloadDir = options.downloadDir ?? join(getZenrowsDir(), "crawls");

  server.registerTool(
    "crawl_create",
    {
      annotations: { title: "Create Crawl", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description: `Start a crawl from one URL (Zenrows Crawl API). Crawl follows the links in each page's HTML up to depth hops (no depth limit when depth is omitted), keeps the URLs that match include_patterns / exclude_patterns, and stays on the start URL's registrable domain (subdomains count).

${WHEN_TO_USE}

Each page fetched is billed as one scrape on this account; max_pages bounds the cost
(default 100), max_items bounds how many URLs are kept (default 100). Without depth, the
crawl keeps following links until max_pages or max_items stops it or nothing is left to
open, so set max_pages to what you are willing to spend. The start page itself is never
a result, but its fetch is billed: a crawl whose include_patterns / exclude_patterns match
nothing still costs that one scrape. Set output_format "html" or "markdown" to also store each kept URL's page,
then read it with crawl_content.

Returns crawl_id, status and the crawl (with coverage) at once; the crawl runs
asynchronously. Call crawl_wait, then crawl_results. Set idempotency_key to make a retry
safe: the same key returns the crawl the first request created instead of starting another.
CRAWL_NOT_ENABLED: Crawl is not enabled for this account; do not retry.
CRAWL_TOO_MANY_CRAWLS: the account has reached its limit of active jobs (3 by default), shared with its Batch jobs; retry after retry_after seconds.`,
      inputSchema: {
        url: z.string().url().describe("Start URL: a public http(s) page, such as a listing or category page"),
        // No lower bound here: the API rejects 0 or less as CRAWL_INVALID_REQUEST, naming the
        // parameter, the same answer every other client gets.
        depth: z
          .number()
          .int()
          .max(100_000)
          .nullish()
          .describe(
            "Link hops to follow from the start URL. 1 returns the start page's links; 2 also opens those. Omit for no depth limit: the crawl follows links until max_pages or max_items stops it."
          ),
        max_items: z.number().int().max(100_000).nullish().describe("Stop once this many URLs are kept (default 100)"),
        max_pages: z
          .number()
          .int()
          .max(100_000)
          .nullish()
          .describe(
            "Stop once this many pages are fetched, each billed as one scrape (default 100). With output_format, every kept URL's page counts too."
          ),
        include_patterns: z
          .array(z.string().min(1))
          .nullish()
          .describe('Keep only URLs containing at least one of these substrings, e.g. ["/product/"]'),
        exclude_patterns: z
          .array(z.string().min(1))
          .nullish()
          .describe("Drop URLs containing any of these substrings, even if they match include_patterns"),
        output_format: z
          .enum(["html", "markdown"])
          .nullish()
          .describe(
            "'html' or 'markdown' also stores each kept URL's page for crawl_content, as fetched or converted to Markdown. Omit for URLs only."
          ),
        idempotency_key: z
          .string()
          .min(1)
          .nullish()
          .describe(
            "Sent as the Idempotency-Key header. Reusing a key returns the crawl it created; reusing it with a different body is CRAWL_INVALID_REQUEST."
          ),
      },
    },
    async (params) => {
      const body: CreateCrawlBody = { url: params.url };
      if (params.depth != null) body.depth = params.depth;
      if (params.max_items != null) body.max_items = params.max_items;
      if (params.max_pages != null) body.max_pages = params.max_pages;
      if (params.include_patterns?.length) body.include_patterns = params.include_patterns;
      if (params.exclude_patterns?.length) body.exclude_patterns = params.exclude_patterns;
      if (params.output_format) body.output_format = params.output_format;

      try {
        return crawlOut(await createCrawl(body, { ...call, idempotencyKey: params.idempotency_key ?? undefined }));
      } catch (e) {
        return crawlErr(e);
      }
    }
  );

  server.registerTool(
    "crawl_get",
    {
      annotations: { title: "Get Crawl", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description: `Get a crawl and one page of the URLs it kept: crawl_id, status (running, completed, stopped, failed), the crawl (with coverage: pages_fetched, pages_failed, items_found), results and next_cursor.

completed with stop_reason max_items / max_pages means a limit ended it; failed carries error.code and error.detail. Pass next_cursor as cursor for the next page; while the crawl runs, next_cursor is never null. To read many pages at once, use crawl_results.`,
      inputSchema: {
        crawl_id: crawlIdSchema,
        cursor: z.string().nullish().describe("next_cursor from a previous crawl_get call, to continue from there"),
        limit: limitSchema.describe(`Results in this page (default ${DEFAULT_LIMIT}, max 10000)`),
      },
    },
    async ({ crawl_id, cursor, limit }) => {
      try {
        const { results, next_cursor, ...crawl } = await getCrawl(crawl_id, {
          ...call,
          cursor: cursor ?? undefined,
          limit: limit ?? DEFAULT_LIMIT,
        });
        return crawlOut(crawl, { results, next_cursor });
      } catch (e) {
        return crawlErr(e, crawl_id);
      }
    }
  );

  server.registerTool(
    "crawl_results",
    {
      annotations: { title: "Crawl Results", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description: `List the URLs a crawl kept, in the order it kept them, following the API's pages up to limit.

Each result has url and, when the crawl has output_format, content_status (pending, fetched, failed) and, once fetched, content_url: pass it to crawl_content as content.

While the crawl runs the list is partial (partial=true): call again later with the returned next_cursor to get only the URLs kept since. A stopped crawl can still add URLs from pages fetched before the stop for up to 10 minutes, so next_cursor stays set during that window: call again later. next_cursor is null once the crawl ended and every URL was read.`,
      inputSchema: {
        crawl_id: crawlIdSchema,
        cursor: z.string().nullish().describe("next_cursor from a previous crawl_results call, to continue from there"),
        limit: limitSchema.describe(`Max results to return in this call (default ${DEFAULT_LIMIT}, max 10000)`),
      },
    },
    async ({ crawl_id, cursor, limit }) => {
      try {
        const read = await readResults(crawl_id, { ...call, cursor: cursor ?? undefined, limit: limit ?? undefined });
        // Trust the API's cursor: a stopped crawl keeps the links found on pages still in flight at
        // the stop for up to 10 minutes, and the API keeps next_cursor set until they are read.
        const ended = isTerminal(read.status);
        const partial = read.next_cursor !== null;
        const full = read.results.length >= (limit ?? DEFAULT_LIMIT);
        return json({
          ok: true,
          crawl_id,
          status: read.status,
          count: read.results.length,
          partial,
          next_cursor: read.next_cursor,
          ...(partial ? { note: resultsNote(read.status, ended, full) } : {}),
          results: read.results,
        });
      } catch (e) {
        return crawlErr(e, crawl_id);
      }
    }
  );

  server.registerTool(
    "crawl_content",
    {
      annotations: { title: "Crawl Page Content", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description: `Read the stored page of one URL a crawl kept, in the crawl's output_format. Works only for crawls created with an output_format, and only for results whose content_status is fetched.

Pass crawl_id and content_id: a content id, or content_url from a crawl_results row. Returns the page
as stored — raw HTML for output_format "html", Markdown for "markdown" — cut to max_chars (default
${DEFAULT_CONTENT_MAX_CHARS}); a final note says when it was cut. To read a page the crawl did not
store, use scrape on its URL instead.`,
      inputSchema: {
        crawl_id: crawlIdSchema,
        content_id: z
          .string()
          .min(1)
          .describe("A content id (ct_…), or content_url from a crawl_results row; its last path segment is the id"),
        max_chars: z
          .number()
          .int()
          .min(1000)
          .max(10_000_000)
          .nullish()
          .describe(`Max characters of the page to return (default ${DEFAULT_CONTENT_MAX_CHARS})`),
      },
    },
    async ({ crawl_id, content_id, max_chars }) => {
      const contentId = contentIdOf(content_id);
      if (!contentId) {
        return err({ code: "INVALID_USAGE", message: "Pass a content id, or content_url from a crawl_results row." });
      }
      try {
        const page = await getCrawlContent(crawl_id, contentId, call);
        const limit = max_chars ?? DEFAULT_CONTENT_MAX_CHARS;
        const out: TextContent[] = [{ type: "text", text: page.body.slice(0, limit) }];
        if (page.body.length > limit) {
          out.push({
            type: "text",
            text: `[truncated: returned ${limit} of ${page.body.length} characters. Raise max_chars for more.]`,
          });
        }
        return { content: out };
      } catch (e) {
        return crawlErr(e, crawl_id);
      }
    }
  );

  server.registerTool(
    "crawl_list",
    {
      annotations: { title: "List Crawls", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description:
        "List this account's crawls, newest first, with status and coverage (no results). Pass next_cursor as cursor for the next page; next_cursor is absent on the last page.",
      inputSchema: {
        cursor: z.string().nullish().describe("next_cursor from a previous crawl_list call"),
        limit: z.number().int().min(1).max(100).nullish().describe("Crawls per page (default 20, max 100)"),
      },
    },
    async ({ cursor, limit }) => {
      try {
        const page = await listCrawls({ ...call, cursor: cursor ?? undefined, limit: limit ?? undefined });
        const crawls = page.crawls ?? [];
        return json({ ok: true, count: crawls.length, next_cursor: page.next_cursor ?? null, crawls });
      } catch (e) {
        return crawlErr(e);
      }
    }
  );

  server.registerTool(
    "crawl_stop",
    {
      annotations: {
        title: "Stop Crawl",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      description: `Stop a running crawl. No page still waiting is fetched or billed; pages already in flight finish. The URLs kept so far stay readable with crawl_results. A stopped crawl cannot resume.

Idempotent: a crawl that already ended answers with its final status. A 429, 502, 503 or 504 is retried up to 3 times, waiting at most 50 seconds in all; a 503 crawl_busy means the stop was not saved yet, and if it persists, CRAWL_BUSY says when to call again. Pages in flight still finish, so coverage and results can keep growing for up to 10 minutes after the stop; read them with crawl_get and crawl_results.`,
      inputSchema: { crawl_id: crawlIdSchema },
    },
    async ({ crawl_id }) => {
      try {
        return crawlOut(await stopCrawl(crawl_id, call));
      } catch (e) {
        return crawlErr(e, crawl_id);
      }
    }
  );

  server.registerTool(
    "crawl_wait",
    {
      annotations: { title: "Wait for Crawl", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description: `Poll a crawl until it ends (completed, stopped, or failed) and return its status, its counts and the first ${WAIT_URLS} URLs (first_urls). For every result, call crawl_download (one file) or crawl_results (pages). If the wait runs out first, it returns the crawl with status running and a note: call crawl_wait again. A call that carries a progressToken gets a progress notification after each poll, with the status and counts.`,
      inputSchema: {
        crawl_id: crawlIdSchema,
        timeout: z
          .number()
          .int()
          .min(1)
          .max(3600)
          .nullish()
          .describe(
            `Max wait in seconds (default ${DEFAULT_WAIT_SECONDS}). Many MCP clients cancel a call after 60 s.`
          ),
      },
    },
    async ({ crawl_id, timeout }, extra) => {
      // Progress goes only to a client that asked for it with a progressToken.
      const progressToken = extra?._meta?.progressToken;
      const onPoll =
        progressToken === undefined
          ? undefined
          : (crawl: Crawl, poll: number) =>
              extra
                .sendNotification({
                  method: "notifications/progress",
                  params: { progressToken, progress: poll, message: progressMessage(crawl) },
                })
                // A lost progress notification must not end the wait.
                .catch(() => undefined);
      try {
        const crawl = await waitForCrawl(crawl_id, { ...call, timeout: timeout ?? undefined, onPoll });
        if (!isTerminal(crawl.status) || !crawl.coverage?.items_found) return waitedOut(crawl);
        // The first URLs are a preview; a failed read of them must not hide that the crawl ended.
        const first = await getCrawl(crawl_id, { ...call, limit: WAIT_URLS }).catch(() => undefined);
        return waitedOut(
          crawl,
          first?.results?.map((r) => r.url)
        );
      } catch (e) {
        return crawlErr(e, crawl_id);
      }
    }
  );

  server.registerTool(
    "crawl_download",
    {
      annotations: { title: "Download Crawl", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description: `Save every result of a crawl to one local file, as JSON lines: url, content_status and, once fetched, content (the page). Returns the file's path and line count, not the results, so a crawl of any size costs one small reply. Read the file with your own tools.

The file goes to path when given (a relative path inside ~/.zenrows/crawls; an absolute path or one that leaves that folder fails with INVALID_PATH), else ~/.zenrows/crawls/<crawl_id>.jsonl. An existing file is kept and the call fails with FILE_EXISTS unless overwrite is true.

On a running crawl the file holds only what was kept so far: download again once crawl_wait says it ended. On the hosted server no file is written: the reply gives the download URL and a command to run where your API key is set.`,
      inputSchema: {
        crawl_id: crawlIdSchema,
        path: z
          .string()
          .min(1)
          .nullish()
          .describe("File to write, relative to ~/.zenrows/crawls (default <crawl_id>.jsonl)"),
        overwrite: z.boolean().nullish().describe("Replace the file if it exists (default false)"),
      },
    },
    async ({ crawl_id, path, overwrite }) => {
      try {
        if (options.hosted) return json(await hostedDownload(crawl_id));
        return json(await saveDownload(crawl_id, path ?? undefined, overwrite ?? false));
      } catch (e) {
        if (e instanceof PathRefused) {
          return err({ code: e.code, message: e.message, crawl_id, path: e.path });
        }
        return crawlErr(e, crawl_id);
      }
    }
  );

  /** The hosted server has no disk the user can read: hand back where the file is and how to fetch it. */
  async function hostedDownload(crawlId: string) {
    const crawl = await getCrawl(crawlId, { ...call, limit: 1 });
    // encodeURIComponent leaves ' alone; escape it so the id cannot end the quoted URL in command.
    const url = crawlDownloadUrl(crawlId).replace(/'/g, "%27");
    return {
      ok: true,
      crawl_id: crawlId,
      status: crawl.status,
      coverage: crawl.coverage,
      download_url: url,
      // A placeholder, never the key: the reply lands in the chat transcript.
      command: `curl -sS -H "X-API-Key: $ZENROWS_API_KEY" -o ${fileNameFor(crawlId)} '${url}'`,
      note: "This server is hosted, so it wrote no file. Run command where ZENROWS_API_KEY is set to save every result as JSON lines.",
    };
  }

  async function saveDownload(crawlId: string, path: string | undefined, overwrite: boolean) {
    const base = resolve(downloadDir);
    const target = resolve(base, path ?? fileNameFor(crawlId));
    const rel = relative(base, target);
    if (path !== undefined && (isAbsolute(path) || !rel || rel === ".." || rel.startsWith(`..${sep}`))) {
      throw new PathRefused(
        "INVALID_PATH",
        path,
        `${path} is not a file inside ${base}. Pass a path relative to it that stays inside it.`
      );
    }
    if (!overwrite && (await exists(target))) throw fileExists(target);
    await mkdir(dirname(target), { recursive: true });
    const res = await downloadCrawl(crawlId, call);
    const status = res.headers.get("x-crawl-status") ?? undefined;
    // Write beside the target, then move it into place: a cut-off download never leaves a short file
    // where a complete one is expected.
    const part = `${target}.part`;
    const counts: Record<string, number> = {};
    let lines = 0;
    let bytes = 0;
    const tally = (line: string) => {
      if (!line.trim()) return;
      lines++;
      let key = "none";
      try {
        const parsed = JSON.parse(line) as { content_status?: unknown };
        if (typeof parsed.content_status === "string") key = parsed.content_status;
      } catch {
        key = "unparsed";
      }
      counts[key] = (counts[key] ?? 0) + 1;
    };
    const file = await open(part, "w");
    try {
      const decoder = new TextDecoder();
      let rest = "";
      for await (const chunk of (res.body ?? []) as AsyncIterable<Uint8Array>) {
        await file.write(chunk);
        bytes += chunk.byteLength;
        const text = rest + decoder.decode(chunk, { stream: true });
        const split = text.split("\n");
        rest = split.pop() ?? "";
        split.forEach(tally);
      }
      tally(rest + decoder.decode());
      await file.close();
      if (overwrite) {
        await rename(part, target);
      } else {
        // link fails on an existing target, so a file made since the check above is never replaced.
        await link(part, target).catch((e: NodeJS.ErrnoException) => {
          throw e.code === "EEXIST" ? fileExists(target) : e;
        });
        await rm(part);
      }
    } catch (e) {
      await file.close().catch(() => undefined);
      await rm(part, { force: true });
      throw e;
    }
    const pending = counts.pending ?? 0;
    const note =
      status === "running"
        ? "The crawl is still running, so the file holds only what was kept so far. Download again once crawl_wait says it ended."
        : pending > 0
          ? `${pending} line(s) are pending, so they have no content yet. Pages in flight when a crawl stops can still finish for up to 10 minutes: download again with overwrite: true to pick them up.`
          : undefined;
    return {
      ok: true,
      crawl_id: crawlId,
      status,
      path: target,
      lines,
      bytes,
      // A URLs-only crawl has no content_status; counting its lines as "none" would say nothing.
      ...(Object.keys(counts).some((k) => k !== "none") ? { content_status: counts } : {}),
      ...(note ? { note } : {}),
    };
  }
}

class PathRefused extends Error {
  constructor(
    readonly code: "FILE_EXISTS" | "INVALID_PATH",
    readonly path: string,
    message: string
  ) {
    super(message);
  }
}

const fileExists = (path: string) =>
  new PathRefused("FILE_EXISTS", path, `${path} already exists. Pass overwrite: true to replace it, or another path.`);

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  );
}

/** A crawl id is the caller's input: keep only safe characters before it names a file. */
function fileNameFor(crawlId: string): string {
  return `${crawlId.replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`;
}
