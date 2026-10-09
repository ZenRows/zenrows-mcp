import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { registerCrawlTools } from "../src/tools/crawl.ts";

type Handler = (p: unknown) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
type Config = {
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: { destructiveHint: boolean; readOnlyHint: boolean; idempotentHint?: boolean };
};

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
  url: "https://example.com/",
  depth: 1,
  max_items: 10,
  max_pages: 10,
  coverage: { pages_fetched: 1, pages_failed: 0, items_found: 2 },
  created_at: "2026-10-08T00:00:00Z",
});

test("registers the seven crawl tools as Beta, with only crawl_stop destructive and idempotent", () => {
  const { configs } = register();
  assert.deepEqual(Object.keys(configs).sort(), [
    "crawl_content",
    "crawl_create",
    "crawl_get",
    "crawl_list",
    "crawl_results",
    "crawl_stop",
    "crawl_wait",
  ]);
  for (const [name, c] of Object.entries(configs)) {
    assert.equal(c.annotations.destructiveHint, name === "crawl_stop", name);
    assert.equal(c.annotations.readOnlyHint, !["crawl_create", "crawl_stop"].includes(name), name);
    assert.ok(c.description.startsWith("Beta: "), name);
  }
  assert.equal(configs.crawl_stop.annotations.idempotentHint, true);
});

test("crawl_create's output_format accepts only html", () => {
  const schema = z.object(register().configs.crawl_create.inputSchema);
  const base = { url: "https://example.com/", depth: 1 };
  assert.equal(schema.safeParse({ ...base, output_format: "html" }).success, true);
  assert.equal(schema.safeParse(base).success, true);
  assert.equal(schema.safeParse({ ...base, output_format: "json" }).success, false);
  assert.equal(schema.safeParse({ url: "https://example.com/" }).success, false, "depth is required");
  assert.equal(schema.safeParse({ ...base, depth: 0 }).success, false);
});

test("crawl_create's schema takes only its own inputs and drops unknown ones", () => {
  const shape = register().configs.crawl_create.inputSchema;
  assert.equal("discovery" in shape, false);
  const parsed = z.object(shape).parse({ url: "https://example.com/", depth: 1, discovery: ["links"] });
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
      await handlers.crawl_create({ url: "https://example.com/", depth: 2 });
      await handlers.crawl_create({
        url: "https://example.com/",
        depth: 1,
        max_items: 3,
        max_pages: 5,
        include_patterns: ["/product/"],
        exclude_patterns: null,
        output_format: "html",
      });
    }
  );
  assert.deepEqual(bodies[0], { url: "https://example.com/", depth: 2 });
  assert.deepEqual(bodies[1], {
    url: "https://example.com/",
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
    () => handlers.crawl_create({ url: "https://example.com/", depth: 1 })
  );
  assert.equal(out.isError, true);
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.code, "CRAWL_NOT_ENABLED");
  assert.equal(body.server_code, "REQS008");
  assert.match(body.message, /Crawl is not enabled for this account/);
  assert.equal(body.crawl_id, undefined, "nothing was created");
});

test("crawl_create with follow returns the running crawl, not an error, when the timeout runs out", async () => {
  const { handlers } = register();
  const out = await withFetch(
    (_u, init) => jsonResponse(crawl("running"), init?.method === "POST" ? 202 : 200),
    () => handlers.crawl_create({ url: "https://example.com/", depth: 1, follow: true, timeout: 1 })
  );
  assert.equal(out.isError, undefined);
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.crawl_id, "c_1");
  assert.equal(body.status, "running");
  assert.match(body.note, /call crawl_wait again/i);
});

test("crawl_create with follow carries crawl_id when the wait fails after the create", async () => {
  const { handlers } = register();
  const out = await withFetch(
    (_u, init) =>
      init?.method === "POST"
        ? jsonResponse(crawl("running"), 202)
        : jsonResponse({ code: "internal_error", title: "Internal error", status: 500 }, 500),
    () => handlers.crawl_create({ url: "https://example.com/", depth: 1, follow: true })
  );
  assert.equal(out.isError, true);
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.code, "CRAWL_FAILED");
  assert.equal(body.server_code, "internal_error");
  assert.equal(body.crawl_id, "c_1");
});

test("crawl_create without follow returns the crawl with no note", async () => {
  const { handlers } = register();
  const out = await withFetch(
    () => jsonResponse(crawl("running"), 202),
    () => handlers.crawl_create({ url: "https://example.com/", depth: 1 })
  );
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.crawl_id, "c_1");
  assert.equal(body.note, undefined);
});

test("crawl_get returns one API page with 100 results by default, and passes cursor and limit", async () => {
  const { handlers } = register();
  const urls: string[] = [];
  const page = { ...crawl("running"), results: [{ url: "https://example.com/p/1" }], next_cursor: "x" };
  const out = await withFetch(
    (u) => {
      urls.push(u);
      return jsonResponse(page);
    },
    async () => {
      const first = await handlers.crawl_get({ crawl_id: "c_1" });
      await handlers.crawl_get({ crawl_id: "c_1", cursor: "x", limit: 5 });
      return first;
    }
  );
  assert.deepEqual(JSON.parse(out.content[0].text), { ok: true, ...page });
  assert.match(urls[0], /\/crawls\/c_1\?limit=100$/);
  assert.match(urls[1], /\/crawls\/c_1\?cursor=x&limit=5$/);
});

test("crawl_get carries crawl_id on an error", async () => {
  const { handlers } = register();
  const out = await withFetch(
    () => jsonResponse({ code: "crawl_not_found", title: "Not found", status: 404 }, 404),
    () => handlers.crawl_get({ crawl_id: "c_missing" })
  );
  assert.equal(out.isError, true);
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.code, "CRAWL_NOT_FOUND");
  assert.equal(body.server_code, "crawl_not_found");
  assert.equal(body.crawl_id, "c_missing");
});

test("crawl_wait takes timeout in seconds and returns the running crawl when it runs out", async () => {
  const { handlers } = register();
  const out = await withFetch(
    () => jsonResponse({ ...crawl("running"), results: [], next_cursor: "x" }),
    () => handlers.crawl_wait({ crawl_id: "c_1", timeout: 1 })
  );
  assert.equal(out.isError, undefined);
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.status, "running");
  assert.match(body.note, /call crawl_wait again/i);
});

test("crawl_results takes cursor and limit, and caps limit at 10000", async () => {
  const { handlers, configs } = register();
  const schema = z.object(configs.crawl_results.inputSchema);
  assert.equal(schema.safeParse({ crawl_id: "c_1", limit: 10_000 }).success, true);
  assert.equal(schema.safeParse({ crawl_id: "c_1", limit: 10_001 }).success, false);
  const urls: string[] = [];
  await withFetch(
    (u) => {
      urls.push(u);
      return jsonResponse({ ...crawl("completed"), results: [], next_cursor: null });
    },
    async () => {
      await handlers.crawl_results({ crawl_id: "c_1" });
      await handlers.crawl_results({ crawl_id: "c_1", cursor: "cur", limit: 7 });
    }
  );
  assert.match(urls[0], /\/crawls\/c_1\?limit=100$/);
  assert.match(urls[1], /\/crawls\/c_1\?cursor=cur&limit=7$/);
});

test("crawl_results flags a running crawl as partial and passes rows through as the API sent them", async () => {
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
                url: "https://example.com/product/1",
                content_status: "fetched",
                content_url: "/v1/crawls/c_1/contents/ct_9",
              },
              { url: "https://example.com/product/2", content_status: "pending" },
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
  assert.deepEqual(body.results[0], {
    url: "https://example.com/product/1",
    content_status: "fetched",
    content_url: "/v1/crawls/c_1/contents/ct_9",
  });
  assert.match(body.note, /still running/);
});

test("crawl_results on an ended crawl read to the end is not partial", async () => {
  const { handlers } = register();
  const out = await withFetch(
    () => jsonResponse({ ...crawl("completed"), results: [{ url: "https://example.com/p/1" }], next_cursor: null }),
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
    () => handlers.crawl_content({ content_url: "/v1/crawls/c_1/contents/ct_9" })
  );
  assert.equal(full.content.length, 1, "5013 characters fit under the 20000 default");
  assert.equal(full.content[0].text, html);
});

test("crawl_content cuts at 20000 characters by default", async () => {
  const { handlers } = register();
  const out = await withFetch(
    () => new Response("x".repeat(25_000), { status: 200, headers: { "content-type": "text/html" } }),
    () => handlers.crawl_content({ content_url: "/v1/crawls/c_1/contents/ct_9" })
  );
  assert.equal(out.content[0].text.length, 20_000);
  assert.match(out.content[1].text, /returned 20000 of 25000/);
});

test("crawl_content with a content_url it cannot read is an INVALID_USAGE error, with no request", async () => {
  const { handlers } = register();
  let called = false;
  const out = await withFetch(
    () => {
      called = true;
      return jsonResponse({});
    },
    () => handlers.crawl_content({ content_url: "/v1/crawls/c_1" })
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
