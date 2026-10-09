import { createRequire } from "module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendClaimHint } from "../auth/claim-hint.js";
import {
  Crawl,
  CrawlError,
  createCrawl,
  CreateCrawlBody,
  DEFAULT_MAX_RESULTS,
  DEFAULT_WAIT_MS,
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

/** crawlId: set when the crawl exists, so the agent never takes a failed wait for a failed create. */
function crawlErr(e: unknown, crawlId?: string): { content: TextContent[]; isError: true } {
  const data =
    e instanceof CrawlError
      ? e.toJSON()
      : { code: "CRAWL_FAILED", message: e instanceof Error ? e.message : String(e) };
  const hint = e instanceof CrawlError ? { status: e.status, code: e.code, message: e.message } : undefined;
  return err(crawlId ? { ...data, crawl_id: crawlId } : data, hint);
}

function crawlOut(crawl: Crawl, waited = false): { content: TextContent[] } {
  return json({
    ok: true,
    crawl_id: crawl.crawl_id,
    status: crawl.status,
    coverage: crawl.coverage,
    ...(waited && !isTerminal(crawl.status)
      ? {
          note: "The wait ran out and the crawl is still running. Call crawl_wait again, read partial results with crawl_results, or stop it with crawl_stop.",
        }
      : {}),
    crawl,
  });
}

const WHEN_TO_USE = `Use crawl when you have one start page (a listing, category, blog index) and need
the URLs behind it, optionally with each page's HTML. For a single page, use scrape.`;

const crawlIdSchema = z.string().describe("Crawl id returned by crawl_create (c_…)");

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

Returns the crawl (crawl_id, status, coverage). The crawl runs asynchronously: pass
wait=true, or call crawl_wait / crawl_status, then crawl_results. If the wait runs out,
the answer is the crawl with status running: call crawl_wait again. An error after the
crawl started carries its crawl_id.
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
        wait: z.boolean().nullish().describe("If true, poll until the crawl finishes before returning"),
        wait_timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(3_600_000)
          .nullish()
          .describe(
            `Max wait time when wait=true (default ${DEFAULT_WAIT_MS}). Many MCP clients cancel a call after 60000.`
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

      let created: Crawl;
      try {
        created = await createCrawl(body, call);
      } catch (e) {
        return crawlErr(e);
      }
      if (params.wait !== true) return crawlOut(created);
      try {
        return crawlOut(
          await waitForCrawl(created.crawl_id, { ...call, pollTimeoutMs: params.wait_timeout_ms ?? DEFAULT_WAIT_MS }),
          true
        );
      } catch (e) {
        return crawlErr(e, created.crawl_id);
      }
    }
  );

  server.registerTool(
    "crawl_status",
    {
      annotations: { title: "Crawl Status", readOnlyHint: true, destructiveHint: false },
      description: `Beta: Get a crawl's status (running, completed, stopped, failed) and coverage (pages_fetched, pages_failed, items_found). Returns no results: read those with crawl_results.

completed with stop_reason max_items / max_pages means a limit ended it; failed carries error.code and error.detail.`,
      inputSchema: { crawl_id: crawlIdSchema },
    },
    async ({ crawl_id }) => {
      try {
        return crawlOut(withoutResults(await getCrawl(crawl_id, { ...call, limit: 1 })));
      } catch (e) {
        return crawlErr(e);
      }
    }
  );

  server.registerTool(
    "crawl_results",
    {
      annotations: { title: "Crawl Results", readOnlyHint: true, destructiveHint: false },
      description: `Beta: List the URLs a crawl kept, in the order it kept them, following the API's pages up to max_results.

Each result has url and, when the crawl has output_format, content_status (pending, fetched, failed) and, once fetched, content_url: pass it to crawl_content.

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
          .describe(`Max results to return in this call (default ${DEFAULT_MAX_RESULTS})`),
      },
    },
    async ({ crawl_id, cursor, max_results }) => {
      try {
        const read = await readResults(crawl_id, {
          ...call,
          cursor: cursor ?? undefined,
          maxResults: max_results ?? DEFAULT_MAX_RESULTS,
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
          results: read.results,
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
      description: `Beta: Read the stored HTML of one URL a crawl kept. Works only for crawls created with output_format "html", and only for results whose content_status is fetched.

Pass content_url from crawl_results. Returns raw HTML,
cut to max_chars (default ${DEFAULT_CONTENT_MAX_CHARS}); a final note says when it was cut. For a
markdown version of a page, use scrape on its URL instead.`,
      inputSchema: {
        content_url: z
          .string()
          .describe("content_url from a crawl_results row (/v1/crawls/{crawl_id}/contents/{content_id})"),
        max_chars: z
          .number()
          .int()
          .min(1000)
          .max(10_000_000)
          .nullish()
          .describe(`Max characters of HTML to return (default ${DEFAULT_CONTENT_MAX_CHARS})`),
      },
    },
    async ({ content_url, max_chars }) => {
      const ids = parseContentUrl(content_url);
      if (!ids) {
        return err({
          code: "INVALID_USAGE",
          message: "Pass content_url from a crawl_results row (/v1/crawls/{crawl_id}/contents/{content_id}).",
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

Idempotent: a crawl that already ended answers with its final status. Pages in flight still finish, so coverage and results can keep growing for up to 10 minutes after the stop; read them with crawl_status and crawl_results.`,
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
        "Beta: Poll a crawl until it ends (completed, stopped, or failed) and return its status and coverage. If the wait runs out first, it returns the crawl with status running and a note: call crawl_wait again.",
      inputSchema: {
        crawl_id: crawlIdSchema,
        timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(3_600_000)
          .nullish()
          .describe(`Max wait time in ms (default ${DEFAULT_WAIT_MS}). Many MCP clients cancel a call after 60000.`),
      },
    },
    async ({ crawl_id, timeout_ms }) => {
      try {
        return crawlOut(await waitForCrawl(crawl_id, { ...call, pollTimeoutMs: timeout_ms ?? DEFAULT_WAIT_MS }), true);
      } catch (e) {
        return crawlErr(e);
      }
    }
  );
}
