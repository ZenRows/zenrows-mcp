import { createRequire } from "module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendClaimHint } from "../auth/claim-hint.js";
import {
  CrawlError,
  CrawlResult,
  createCrawl,
  CreateCrawlBody,
  getCrawl,
  getCrawlContent,
  isTerminal,
  listCrawls,
  parseContentUrl,
  readResults,
  stopCrawl,
  waitForCrawl,
  withoutResults,
} from "../crawl-api.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

type TextContent = { type: "text"; text: string };

/** Default cap on crawl_content's HTML, in characters; a page can run to megabytes. */
export const DEFAULT_CONTENT_MAX_CHARS = 100_000;

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

function crawlErr(e: unknown): { content: TextContent[]; isError: true } {
  if (e instanceof CrawlError) {
    return err(e.toJSON(), { status: e.status, code: e.code, message: e.message });
  }
  return err({
    code: "CRAWL_FAILED",
    message: e instanceof Error ? e.message : String(e),
  });
}

/** A result row plus the content_id crawl_content takes, read off content_url. */
function withContentId(row: CrawlResult): CrawlResult & { content_id?: string } {
  const parsed = row.content_url ? parseContentUrl(row.content_url) : undefined;
  return parsed ? { ...row, content_id: parsed.contentId } : row;
}

const WHEN_TO_USE = `Crawl vs Batch vs scrape:
- crawl_*: you have ONE start URL (a listing, category, blog index) and want the
  URLs behind it discovered for you, optionally with each page's HTML. Crawl
  follows links in the page HTML and stays on the start URL's domain.
- batch_*: you already have the list of URLs to fetch.
- scrape / extract: one page, answered right away.`;

const crawlIdSchema = z.string().describe("Crawl id returned by crawl_create (c_…)");

export function registerCrawlTools(server: McpServer, apiKey: string): void {
  const ua = `zenrows/mcp ${pkg.version}`;
  const call = { apiKey, userAgent: ua };

  server.registerTool(
    "crawl_create",
    {
      annotations: { title: "Create Crawl", readOnlyHint: false, destructiveHint: false },
      description: `Start a crawl from one URL (Zenrows Crawl API). Crawl follows the links in each page's HTML up to depth hops, keeps the URLs that match include_patterns / exclude_patterns, and stays on the start URL's domain.

${WHEN_TO_USE}

Each page fetched is billed as one scrape on this account; max_pages bounds the cost
(default 10), max_items bounds how many URLs are kept (default 10). The start page
itself is never a result. Set output_format "html" to also store each kept URL's page,
then read it with crawl_content.

Returns the crawl (crawl_id, status, coverage). The crawl runs asynchronously: pass
wait=true, or call crawl_wait / crawl_status, then crawl_results.
CRAWL_NOT_ENABLED: Crawl is not enabled for this account; do not retry.
CRAWL_TOO_MANY_CRAWLS: the account's 3 active crawls + Batch jobs are in use; retry after retry_after seconds.`,
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
        wait: z.boolean().nullish().describe("If true, poll until the crawl finishes before returning"),
        wait_timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(3_600_000)
          .nullish()
          .describe("Max wait time when wait=true (default 600000)"),
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
        const created = await createCrawl(body, call);
        const crawl =
          params.wait === true
            ? await waitForCrawl(created.crawl_id, { ...call, pollTimeoutMs: params.wait_timeout_ms ?? 600_000 })
            : created;
        return json({ ok: true, crawl_id: crawl.crawl_id, status: crawl.status, coverage: crawl.coverage, crawl });
      } catch (e) {
        return crawlErr(e);
      }
    }
  );

  server.registerTool(
    "crawl_status",
    {
      annotations: { title: "Crawl Status", readOnlyHint: true, destructiveHint: false },
      description: `Get a crawl's status (running, completed, stopped, failed) and coverage (pages_fetched, pages_failed, items_found). Returns no results: read those with crawl_results.

completed with stop_reason max_items / max_pages means a limit ended it; failed carries error.code and error.detail.`,
      inputSchema: { crawl_id: crawlIdSchema },
    },
    async ({ crawl_id }) => {
      try {
        const crawl = withoutResults(await getCrawl(crawl_id, { ...call, limit: 1 }));
        return json({ ok: true, crawl_id: crawl.crawl_id, status: crawl.status, coverage: crawl.coverage, crawl });
      } catch (e) {
        return crawlErr(e);
      }
    }
  );

  server.registerTool(
    "crawl_results",
    {
      annotations: { title: "Crawl Results", readOnlyHint: true, destructiveHint: false },
      description: `List the URLs a crawl kept, in the order it kept them, following the API's pages up to max_results.

Each result has url and, when the crawl has output_format, content_status (pending, fetched, failed) and, once fetched, content_url and content_id for crawl_content.

While the crawl runs the list is partial (partial=true): call again later with the returned next_cursor to get only the URLs kept since. next_cursor is null once the crawl ended and every URL was read.`,
      inputSchema: {
        crawl_id: crawlIdSchema,
        cursor: z.string().nullish().describe("next_cursor from a previous crawl_results call, to continue from there"),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(10_000)
          .nullish()
          .describe("Max results to return in this call (default 1000)"),
      },
    },
    async ({ crawl_id, cursor, max_results }) => {
      try {
        const read = await readResults(crawl_id, {
          ...call,
          cursor: cursor ?? undefined,
          maxResults: max_results ?? 1000,
        });
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
          results: read.results.map(withContentId),
        });
      } catch (e) {
        return crawlErr(e);
      }
    }
  );

  server.registerTool(
    "crawl_content",
    {
      annotations: { title: "Crawl Page Content", readOnlyHint: true, destructiveHint: false },
      description: `Read the stored HTML of one URL a crawl kept. Works only for crawls created with output_format "html", and only for results whose content_status is fetched.

Pass content_url from crawl_results, or crawl_id + content_id. Returns raw HTML,
cut to max_chars (default ${DEFAULT_CONTENT_MAX_CHARS}); a final note says when it was cut. For a
markdown or structured version of a page, use scrape or extract on its URL instead.`,
      inputSchema: {
        content_url: z
          .string()
          .nullish()
          .describe("content_url from a crawl_results row (/v1/crawls/{crawl_id}/contents/{content_id})"),
        crawl_id: z.string().nullish().describe("Crawl id; with content_id, instead of content_url"),
        content_id: z.string().nullish().describe("content_id from a crawl_results row (ct_…)"),
        max_chars: z
          .number()
          .int()
          .min(1000)
          .max(10_000_000)
          .nullish()
          .describe(`Max characters of HTML to return (default ${DEFAULT_CONTENT_MAX_CHARS})`),
      },
    },
    async ({ content_url, crawl_id, content_id, max_chars }) => {
      const ids = content_url
        ? parseContentUrl(content_url)
        : crawl_id && content_id
          ? { crawlId: crawl_id, contentId: content_id }
          : undefined;
      if (!ids) {
        return err({
          code: "INVALID_USAGE",
          message:
            "Provide content_url from crawl_results (/v1/crawls/{crawl_id}/contents/{content_id}), or crawl_id and content_id.",
        });
      }
      try {
        const page = await getCrawlContent(ids.crawlId, ids.contentId, call);
        const limit = max_chars ?? DEFAULT_CONTENT_MAX_CHARS;
        const content: TextContent[] = [{ type: "text", text: page.body.slice(0, limit) }];
        if (page.body.length > limit) {
          content.push({
            type: "text",
            text: `[truncated: returned ${limit} of ${page.body.length} characters. Raise max_chars for more.]`,
          });
        }
        return { content };
      } catch (e) {
        return crawlErr(e);
      }
    }
  );

  server.registerTool(
    "crawl_list",
    {
      annotations: { title: "List Crawls", readOnlyHint: true, destructiveHint: false },
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
      annotations: { title: "Stop Crawl", readOnlyHint: false, destructiveHint: true },
      description: `Stop a running crawl. No page still waiting is fetched or billed; pages already in flight finish. The URLs kept so far stay readable with crawl_results. A stopped crawl cannot resume.

Idempotent: a crawl that already ended answers with its final status. Coverage can still settle for a moment after the stop; read it with crawl_status.`,
      inputSchema: { crawl_id: crawlIdSchema },
    },
    async ({ crawl_id }) => {
      try {
        const stopped = await stopCrawl(crawl_id, call);
        return json({ ok: true, crawl_id: stopped.crawl_id, status: stopped.status, crawl: stopped });
      } catch (e) {
        return crawlErr(e);
      }
    }
  );

  server.registerTool(
    "crawl_wait",
    {
      annotations: { title: "Wait for Crawl", readOnlyHint: true, destructiveHint: false },
      description:
        "Poll a crawl until it ends (completed, stopped, or failed) and return its status and coverage. On timeout it returns CRAWL_WAIT_TIMEOUT and the crawl keeps running.",
      inputSchema: {
        crawl_id: crawlIdSchema,
        timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(3_600_000)
          .nullish()
          .describe("Max wait time in ms (default 600000)"),
      },
    },
    async ({ crawl_id, timeout_ms }) => {
      try {
        const crawl = await waitForCrawl(crawl_id, { ...call, pollTimeoutMs: timeout_ms ?? 600_000 });
        return json({ ok: true, crawl_id: crawl.crawl_id, status: crawl.status, coverage: crawl.coverage, crawl });
      } catch (e) {
        return crawlErr(e);
      }
    }
  );
}
