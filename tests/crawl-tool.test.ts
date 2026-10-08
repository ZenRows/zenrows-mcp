import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { registerCrawlTools } from "../src/tools/crawl.ts";

type Handler = (p: unknown) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
type Config = { inputSchema: z.ZodRawShape; annotations: { destructiveHint: boolean; readOnlyHint: boolean } };

function register() {
  const handlers: Record<string, Handler> = {};
  const configs: Record<string, Config> = {};
  registerCrawlTools(
    {
      registerTool: (name: string, c: Config, h: Handler) => {
        handlers[name] = h;
        configs[name] = c;
      },
    } as never,
    "k"
  );
  return { handlers, configs };
}

async function withFetch<T>(impl: (url: string, init?: RequestInit) => Response, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (u: RequestInfo | URL, init?: RequestInit) => impl(String(u), init)) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const crawl = (status = "running") => ({
  crawl_id: "c_1",
  status,
  url: "https://shop.example/",
  depth: 1,
  max_items: 10,
  max_pages: 10,
  coverage: { pages_fetched: 1, pages_failed: 0, items_found: 2 },
  created_at: "2026-10-08T00:00:00Z",
});

test("registers the seven crawl tools, with only crawl_stop destructive", () => {
  const { configs } = register();
  assert.deepEqual(Object.keys(configs).sort(), [
    "crawl_content",
    "crawl_create",
    "crawl_list",
    "crawl_results",
    "crawl_status",
    "crawl_stop",
    "crawl_wait",
  ]);
  for (const [name, c] of Object.entries(configs)) {
    assert.equal(c.annotations.destructiveHint, name === "crawl_stop", name);
  }
});

test("crawl_create's output_format accepts only html", () => {
  const schema = z.object(register().configs.crawl_create.inputSchema);
  const base = { url: "https://shop.example/", depth: 1 };
  assert.equal(schema.safeParse({ ...base, output_format: "html" }).success, true);
  assert.equal(schema.safeParse(base).success, true);
  assert.equal(schema.safeParse({ ...base, output_format: "json" }).success, false);
  assert.equal(schema.safeParse({ url: "https://shop.example/" }).success, false, "depth is required");
  assert.equal(schema.safeParse({ ...base, depth: 0 }).success, false);
});

test("crawl_create's schema takes only its own inputs and drops unknown ones", () => {
  const shape = register().configs.crawl_create.inputSchema;
  assert.equal("discovery" in shape, false);
  const parsed = z.object(shape).parse({ url: "https://shop.example/", depth: 1, discovery: ["links"] });
  assert.equal("discovery" in parsed, false);
});

test("crawl_create sends only the fields the caller set", async () => {
  const { handlers } = register();
  const bodies: Record<string, unknown>[] = [];
  await withFetch(
    (_u, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(crawl(), 202);
    },
    async () => {
      await handlers.crawl_create({ url: "https://shop.example/", depth: 2 });
      await handlers.crawl_create({
        url: "https://shop.example/",
        depth: 1,
        max_items: 3,
        max_pages: 5,
        include_patterns: ["/product/"],
        exclude_patterns: null,
        output_format: "html",
      });
    }
  );
  assert.deepEqual(bodies[0], { url: "https://shop.example/", depth: 2 });
  assert.deepEqual(bodies[1], {
    url: "https://shop.example/",
    depth: 1,
    max_items: 3,
    max_pages: 5,
    include_patterns: ["/product/"],
    output_format: "html",
  });
});

test("crawl_create surfaces 403 REQS008 as CRAWL_NOT_ENABLED", async () => {
  const { handlers } = register();
  const out = await withFetch(
    () =>
      jsonResponse(
        {
          code: "REQS008",
          title: "Crawl is not enabled for this account.",
          detail: "Crawl is not enabled for this account.",
          status: 403,
        },
        403
      ),
    () => handlers.crawl_create({ url: "https://shop.example/", depth: 1 })
  );
  assert.equal(out.isError, true);
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.code, "CRAWL_NOT_ENABLED");
  assert.match(body.message, /Crawl is not enabled for this account/);
});

test("crawl_status returns status and coverage without results", async () => {
  const { handlers } = register();
  const urls: string[] = [];
  const out = await withFetch(
    (u) => {
      urls.push(u);
      return jsonResponse({ ...crawl("running"), results: [{ url: "https://shop.example/p/1" }], next_cursor: "x" });
    },
    () => handlers.crawl_status({ crawl_id: "c_1" })
  );
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.status, "running");
  assert.equal(body.coverage.items_found, 2);
  assert.equal(body.crawl.results, undefined);
  assert.match(urls[0], /\/crawls\/c_1\?limit=1$/);
});

test("crawl_results flags a running crawl as partial and adds content_id", async () => {
  const { handlers } = register();
  let calls = 0;
  const out = await withFetch(
    () => {
      calls++;
      return calls === 1
        ? jsonResponse({
            ...crawl("running"),
            results: [
              {
                url: "https://shop.example/product/1",
                content_status: "fetched",
                content_url: "/v1/crawls/c_1/contents/ct_9",
              },
              { url: "https://shop.example/product/2", content_status: "pending" },
            ],
            next_cursor: "cur2",
          })
        : jsonResponse({ ...crawl("running"), results: [], next_cursor: "cur2" });
    },
    () => handlers.crawl_results({ crawl_id: "c_1" })
  );
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.partial, true);
  assert.equal(body.next_cursor, "cur2");
  assert.equal(body.count, 2);
  assert.equal(body.results[0].content_id, "ct_9");
  assert.equal(body.results[1].content_id, undefined);
  assert.match(body.note, /still running/);
});

test("crawl_results on an ended crawl read to the end is not partial", async () => {
  const { handlers } = register();
  const out = await withFetch(
    () => jsonResponse({ ...crawl("completed"), results: [{ url: "https://shop.example/p/1" }], next_cursor: null }),
    () => handlers.crawl_results({ crawl_id: "c_1" })
  );
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.partial, false);
  assert.equal(body.next_cursor, null);
  assert.equal(body.note, undefined);
});

test("crawl_content takes a content_url, returns the HTML, and cuts it at max_chars", async () => {
  const { handlers } = register();
  const html = "<html>" + "x".repeat(5000) + "</html>";
  const urls: string[] = [];
  const out = await withFetch(
    (u) => {
      urls.push(u);
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    },
    () => handlers.crawl_content({ content_url: "/v1/crawls/c_1/contents/ct_9", max_chars: 1000 })
  );
  assert.match(urls[0], /\/crawls\/c_1\/contents\/ct_9$/);
  assert.equal(out.content[0].text, html.slice(0, 1000));
  assert.match(out.content[1].text, /truncated: returned 1000 of 5013/);

  const full = await withFetch(
    () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
    () => handlers.crawl_content({ crawl_id: "c_1", content_id: "ct_9" })
  );
  assert.equal(full.content.length, 1);
  assert.equal(full.content[0].text, html);
});

test("crawl_content without ids is an INVALID_USAGE error, with no request", async () => {
  const { handlers } = register();
  let called = false;
  const out = await withFetch(
    () => {
      called = true;
      return jsonResponse({});
    },
    () => handlers.crawl_content({ crawl_id: "c_1" })
  );
  assert.equal(out.isError, true);
  assert.equal(JSON.parse(out.content[0].text).code, "INVALID_USAGE");
  assert.equal(called, false);
});

test("crawl_stop POSTs stop and returns the status", async () => {
  const { handlers } = register();
  const seen: string[] = [];
  const out = await withFetch(
    (u, init) => {
      seen.push(`${init?.method} ${u}`);
      return jsonResponse({ crawl_id: "c_1", status: "stopped", stop_reason: "user" });
    },
    () => handlers.crawl_stop({ crawl_id: "c_1" })
  );
  assert.match(seen[0], /^POST .*\/crawls\/c_1\/stop$/);
  assert.equal(JSON.parse(out.content[0].text).status, "stopped");
});

test("crawl_list passes cursor and limit and reports next_cursor null on the last page", async () => {
  const { handlers } = register();
  const urls: string[] = [];
  const out = await withFetch(
    (u) => {
      urls.push(u);
      return jsonResponse({ crawls: [crawl("completed")] });
    },
    () => handlers.crawl_list({ cursor: "abc", limit: 5 })
  );
  assert.match(urls[0], /\/crawls\?cursor=abc&limit=5$/);
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.count, 1);
  assert.equal(body.next_cursor, null);
});
