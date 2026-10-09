import { createRequire } from "module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendClaimHint } from "../auth/claim-hint.js";
import {
  Crawl,
  CrawlError,
  CrawlResult,
  CrawlStop,
  contentIdOf,
  createCrawl,
  CreateCrawlBody,
  DEFAULT_LIMIT,
  DEFAULT_WAIT_SECONDS,
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

/** The one output shape of crawl_create, crawl_get, crawl_wait and crawl_stop. */
function crawlOut(
  crawl: CrawlStop,
  more: { note?: string; results?: CrawlResult[]; next_cursor?: string | null } = {}
): { content: TextContent[] } {
  return json({ ok: true, crawl_id: crawl.crawl_id, status: crawl.status, crawl, ...more });
}

function waitedOut(crawl: Crawl): { content: TextContent[] } {
  return crawlOut(crawl, isTerminal(crawl.status) ? {} : { note: WAIT_NOTE });
}

const WHEN_TO_USE = `Use crawl when you have one start page (a listing, category, blog index) and need
the URLs behind it, optionally with each page's HTML. For a single page, use scrape.`;

const crawlIdSchema = z.string().describe("Crawl id returned by crawl_create (c_…)");
const limitSchema = z.number().int().min(1).max(10_000).nullish();

export function registerCrawlTools(server: McpServer, apiKey: string): void {
  const ua = `zenrows/mcp ${pkg.version}`;
  const call = { apiKey, userAgent: ua };

  server.registerTool(
    "crawl_create",
    {
      annotations: { title: "Create Crawl", readOnlyHint: false, destructiveHint: false },
      description: `Beta: Start a crawl from one URL (Zenrows Crawl API). Crawl follows the links in each page's HTML up to depth hops, keeps the URLs that match include_patterns / exclude_patterns, and stays on the start URL's registrable domain (subdomains count).

${WHEN_TO_USE}

Each page fetched is billed as one scrape on this account; max_pages bounds the cost
(default 10), max_items bounds how many URLs are kept (default 10). The start page
itself is never a result. Set output_format "html" to also store each kept URL's page,
then read it with crawl_content.

Returns crawl_id, status and the crawl (with coverage) at once; the crawl runs
asynchronously. Call crawl_wait, then crawl_results. Set idempotency_key to make a retry
safe: the same key returns the crawl the first request created instead of starting another.
CRAWL_NOT_ENABLED: Crawl is not enabled for this account; do not retry.
CRAWL_TOO_MANY_CRAWLS: the account has reached its limit of active jobs (3 by default), shared with its Batch jobs; retry after retry_after seconds.`,
      inputSchema: {
        url: z.string().url().describe("Start URL: a public http(s) page, such as a listing or category page"),
        depth: z
          .number()
          .int()
          .min(1)
          .max(100_000)
          .describe("Link hops to follow from the start URL. 1 returns the start page's links; 2 also opens those."),
        max_items: z
          .number()
          .int()
          .min(1)
          .max(100_000)
          .nullish()
          .describe("Stop once this many URLs are kept (default 10)"),
        max_pages: z
          .number()
          .int()
          .min(1)
          .max(100_000)
          .nullish()
          .describe(
            "Stop once this many pages are fetched, each billed as one scrape (default 10). With output_format, every kept URL's page counts too."
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
          .enum(["html"])
          .nullish()
          .describe("'html' also stores each kept URL's page for crawl_content. Omit for URLs only."),
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
      const body: CreateCrawlBody = { url: params.url, depth: params.depth };
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
      annotations: { title: "Get Crawl", readOnlyHint: true, destructiveHint: false },
      description: `Beta: Get a crawl and one page of the URLs it kept: crawl_id, status (running, completed, stopped, failed), the crawl (with coverage: pages_fetched, pages_failed, items_found), results and next_cursor.

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
      annotations: { title: "Crawl Results", readOnlyHint: true, destructiveHint: false },
      description: `Beta: List the URLs a crawl kept, in the order it kept them, following the API's pages up to limit.

Each result has url and, when the crawl has output_format, content_status (pending, fetched, failed) and, once fetched, content_url: pass it to crawl_content as content.

While the crawl runs the list is partial (partial=true): call again later with the returned next_cursor to get only the URLs kept since. next_cursor is null once the crawl ended and every URL was read.`,
      inputSchema: {
        crawl_id: crawlIdSchema,
        cursor: z.string().nullish().describe("next_cursor from a previous crawl_results call, to continue from there"),
        limit: limitSchema.describe(`Max results to return in this call (default ${DEFAULT_LIMIT}, max 10000)`),
      },
    },
    async ({ crawl_id, cursor, limit }) => {
      try {
        const read = await readResults(crawl_id, { ...call, cursor: cursor ?? undefined, limit: limit ?? undefined });
        const partial = !isTerminal(read.status) || read.next_cursor !== null;
        return json({
          ok: true,
          crawl_id,
          status: read.status,
          count: read.results.length,
          partial,
          next_cursor: read.next_cursor,
          ...(partial
            ? {
                note: isTerminal(read.status)
                  ? "More results remain: call crawl_results again with next_cursor."
                  : "The crawl is still running, so this list is partial: call crawl_results again with next_cursor later, or crawl_wait first.",
              }
            : {}),
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
      annotations: { title: "Crawl Page Content", readOnlyHint: true, destructiveHint: false },
      description: `Beta: Read the stored HTML of one URL a crawl kept. Works only for crawls created with output_format "html", and only for results whose content_status is fetched.

Pass crawl_id and content: a content id, or content_url from a crawl_results row. Returns raw HTML,
cut to max_chars (default ${DEFAULT_CONTENT_MAX_CHARS}); a final note says when it was cut. For a
markdown version of a page, use scrape on its URL instead.`,
      inputSchema: {
        crawl_id: crawlIdSchema,
        content: z
          .string()
          .min(1)
          .describe("A content id (ct_…), or content_url from a crawl_results row; its last path segment is the id"),
        max_chars: z
          .number()
          .int()
          .min(1000)
          .max(10_000_000)
          .nullish()
          .describe(`Max characters of HTML to return (default ${DEFAULT_CONTENT_MAX_CHARS})`),
      },
    },
    async ({ crawl_id, content, max_chars }) => {
      const contentId = contentIdOf(content);
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
      annotations: { title: "List Crawls", readOnlyHint: true, destructiveHint: false },
      description:
        "Beta: List this account's crawls, newest first, with status and coverage (no results). Pass next_cursor as cursor for the next page; next_cursor is absent on the last page.",
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
      annotations: { title: "Stop Crawl", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      description: `Beta: Stop a running crawl. No page still waiting is fetched or billed; pages already in flight finish. The URLs kept so far stay readable with crawl_results. A stopped crawl cannot resume.

Idempotent: a crawl that already ended answers with its final status. Pages in flight still finish, so coverage and results can keep growing for up to 10 minutes after the stop; read them with crawl_get and crawl_results.`,
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
      annotations: { title: "Wait for Crawl", readOnlyHint: true, destructiveHint: false },
      description:
        "Beta: Poll a crawl until it ends (completed, stopped, or failed) and return its status and coverage. If the wait runs out first, it returns the crawl with status running and a note: call crawl_wait again.",
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
    async ({ crawl_id, timeout }) => {
      try {
        return waitedOut(await waitForCrawl(crawl_id, { ...call, timeout: timeout ?? undefined }));
      } catch (e) {
        return crawlErr(e, crawl_id);
      }
    }
  );
}
