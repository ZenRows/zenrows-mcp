import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JSONRPCMessage, Progress } from "@modelcontextprotocol/sdk/types.js";
import { writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrawlToolOptions, registerCrawlTools } from "../src/tools/crawl.ts";

type Handler = (p: unknown) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
type Config = {
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: { destructiveHint: boolean; readOnlyHint: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
};

function register(options?: CrawlToolOptions) {
  const handlers: Record<string, Handler> = {};
  const configs: Record<string, Config> = {};
  registerCrawlTools(
    {
      registerTool: (name: string, c: Config, h: Handler) => {
        handlers[name] = h;
        configs[name] = c;
      },
    } as never,
    "k",
    options
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

test("registers the eight crawl tools, with only crawl_stop destructive and idempotent", () => {
  const { configs } = register();
  assert.deepEqual(Object.keys(configs).sort(), [
    "crawl_content",
    "crawl_create",
    "crawl_download",
    "crawl_get",
    "crawl_list",
    "crawl_results",
    "crawl_stop",
    "crawl_wait",
  ]);
  for (const [name, c] of Object.entries(configs)) {
    assert.equal(c.annotations.destructiveHint, name === "crawl_stop", name);
    assert.equal(c.annotations.readOnlyHint, !["crawl_create", "crawl_stop", "crawl_download"].includes(name), name);
    assert.equal(c.annotations.openWorldHint, true, `${name} talks to the Crawl API, an open world`);
  }
  assert.equal(configs.crawl_stop.annotations.idempotentHint, true);
});

test("crawl_create's output_format accepts only html", () => {
  const schema = z.object(register().configs.crawl_create.inputSchema);
  const base = { url: "https://example.com/", depth: 1 };
  assert.equal(schema.safeParse({ ...base, output_format: "html" }).success, true);
  assert.equal(schema.safeParse(base).success, true);
  assert.equal(schema.safeParse({ ...base, output_format: "json" }).success, false);
  assert.equal(schema.safeParse({ url: "https://example.com/" }).success, true, "depth is optional");
  assert.equal(schema.safeParse({ ...base, depth: null }).success, true, "null depth means no depth limit");
  // The API judges the lower bound: depth 0 reaches it and comes back as CRAWL_INVALID_REQUEST.
  assert.equal(schema.safeParse({ ...base, depth: 0 }).success, true);
  assert.equal(schema.safeParse({ ...base, depth: 1.5 }).success, false);
  assert.equal(schema.safeParse({ ...base, depth: 100_001 }).success, false);
});

test("crawl_create's description says an omitted depth means no depth limit, and the API defaults", () => {
  const c = register().configs.crawl_create;
  const shape = c.inputSchema as Record<string, z.ZodTypeAny>;
  assert.match(String(shape.depth.description), /Omit for no depth limit/);
  assert.match(String(shape.max_pages.description), /default 100\)/);
  assert.match(String(shape.max_items.description), /default 100\)/);
  assert.match(c.description, /no depth limit when depth is omitted/);
  assert.doesNotMatch(c.description, /default 10\)/);
});

test("crawl_create's description says a crawl whose patterns match nothing still bills the start page", () => {
  const c = register().configs.crawl_create;
  assert.match(c.description, /match\s+nothing still costs that one scrape/);
});

test("crawl_create returns the API's 422 for depth 0 as CRAWL_INVALID_REQUEST", async () => {
  const { handlers } = register();
  const out = await withFetch(
    () =>
      jsonResponse(
        {
          code: "invalid_parameter",
          title: "Invalid parameter",
          status: 422,
          detail: "'depth' is between 1 and 100000. Leave it out for no depth limit.",
        },
        422
      ),
    () => handlers.crawl_create({ url: "https://example.com/", depth: 0 })
  );
  const body = JSON.parse(out.content[0].text);
  assert.equal(out.isError, true);
  assert.equal(body.code, "CRAWL_INVALID_REQUEST");
  assert.equal(body.server_code, "invalid_parameter");
  assert.match(body.message, /Leave it out for no depth limit/);
});

test("crawl_create without depth returns the crawl the API echoes, with no depth", async () => {
  const { handlers } = register();
  const { depth: _omitted, ...noDepth } = crawl();
  const out = await withFetch(
    () => jsonResponse({ ...noDepth, max_items: 100, max_pages: 100 }, 202),
    () => handlers.crawl_create({ url: "https://example.com/" })
  );
  const body = JSON.parse(out.content[0].text);
  assert.equal(out.isError, undefined);
  assert.equal(body.ok, true);
  assert.equal(body.crawl_id, "c_1");
  assert.equal("depth" in body.crawl, false);
  assert.equal(body.crawl.max_pages, 100);
  assert.equal(body.crawl.max_items, 100);
});

test("crawl_results on a stopped crawl ends at an empty page even while next_cursor stays set", async () => {
  const { handlers } = register();
  const rows = [{ url: "https://example.com/p/1", content_status: "pending" }];
  let calls = 0;
  const out = await withFetch(
    () => {
      calls++;
      // Pages in flight after the stop: the API keeps a cursor but has no new rows.
      return jsonResponse({ ...crawl("stopped"), results: calls === 1 ? rows : [], next_cursor: "still-set" });
    },
    () => handlers.crawl_results({ crawl_id: "c_1" })
  );
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.count, 1);
  assert.equal(body.partial, false);
  assert.equal(body.next_cursor, null);
  assert.equal("note" in body, false);
});

test("crawl_results on an ended crawl still says partial when the call filled its limit", async () => {
  const { handlers } = register();
  const out = await withFetch(
    () =>
      jsonResponse({
        ...crawl("completed"),
        results: [{ url: "https://example.com/p/1" }, { url: "https://example.com/p/2" }],
        next_cursor: "more",
      }),
    () => handlers.crawl_results({ crawl_id: "c_1", limit: 2 })
  );
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.partial, true);
  assert.equal(body.next_cursor, "more");
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
      await handlers.crawl_create({ url: "https://example.com/" });
      await handlers.crawl_create({ url: "https://example.com/", depth: null });
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
  assert.deepEqual(bodies[1], { url: "https://example.com/" }, "no depth sent when it is omitted");
  assert.deepEqual(bodies[2], { url: "https://example.com/" }, "no depth sent when it is null");
  assert.deepEqual(bodies[3], {
    url: "https://example.com/",
    depth: 1,
    max_items: 3,
    max_pages: 5,
    include_patterns: ["/product/"],
    output_format: "html",
  });
});

test("crawl_create takes idempotency_key and has no follow or timeout", () => {
  const shape = register().configs.crawl_create.inputSchema;
  assert.equal("follow" in shape, false);
  assert.equal("timeout" in shape, false);
  assert.equal("idempotency_key" in shape, true);
});

test("crawl_create sends Idempotency-Key only when idempotency_key is set", async () => {
  const { handlers } = register();
  const keys: Array<string | undefined> = [];
  await withFetch(
    (_u, init) => {
      keys.push((init?.headers as Record<string, string>)["Idempotency-Key"]);
      return jsonResponse(crawl(), 202);
    },
    async () => {
      await handlers.crawl_create({ url: "https://example.com/", depth: 1 });
      await handlers.crawl_create({ url: "https://example.com/", depth: 1, idempotency_key: null });
      await handlers.crawl_create({ url: "https://example.com/", depth: 1, idempotency_key: "key-1" });
    }
  );
  assert.deepEqual(keys, [undefined, undefined, "key-1"]);
});

test("crawl_create tells the agent to send a new key when the key was reused", async () => {
  const { handlers } = register();
  const out = await withFetch(
    () => jsonResponse({ code: "idempotency_key_reused", title: "Key reused", status: 422 }, 422),
    () => handlers.crawl_create({ url: "https://example.com/", depth: 1, idempotency_key: "key-1" })
  );
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.code, "CRAWL_INVALID_REQUEST");
  assert.match(body.message, /Send a new idempotency_key, or none/);
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

test("crawl_create returns the crawl at once, with no note", async () => {
  const { handlers } = register();
  const out = await withFetch(
    () => jsonResponse(crawl("running"), 202),
    () => handlers.crawl_create({ url: "https://example.com/", depth: 1 })
  );
  assert.deepEqual(JSON.parse(out.content[0].text), {
    ok: true,
    crawl_id: "c_1",
    status: "running",
    crawl: crawl("running"),
  });
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
  const { results, next_cursor, ...rest } = page;
  assert.deepEqual(JSON.parse(out.content[0].text), {
    ok: true,
    crawl_id: "c_1",
    status: "running",
    crawl: rest,
    results,
    next_cursor,
  });
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

test("a crawl that ended failed comes back ok: false with its error, from crawl_wait and crawl_get", async () => {
  const { handlers } = register();
  const failed = { ...crawl("failed"), error: { code: "no_items_found", detail: "No link matched the URL patterns." } };
  for (const call of [
    () => handlers.crawl_wait({ crawl_id: "c_1", timeout: 1 }),
    () => handlers.crawl_get({ crawl_id: "c_1" }),
  ]) {
    const out = await withFetch(() => jsonResponse({ ...failed, results: [], next_cursor: null }), call);
    const body = JSON.parse(out.content[0].text);
    assert.equal(body.ok, false);
    assert.equal(body.status, "failed");
    assert.equal(body.crawl_id, "c_1");
    assert.equal(body.error.code, "CRAWL_FAILED");
    assert.equal(body.error.server_code, "no_items_found");
    assert.match(body.error.message, /No link matched/);
  }
});

test("a crawl that did not fail stays ok: true with no error", async () => {
  const { handlers } = register();
  const out = await withFetch(
    () => jsonResponse({ ...crawl("completed"), results: [], next_cursor: null }),
    () => handlers.crawl_wait({ crawl_id: "c_1", timeout: 1 })
  );
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.ok, true);
  assert.equal("error" in body, false);
});

test("crawl_wait takes timeout in seconds and returns the running crawl when it runs out", async () => {
  const { handlers } = register();
  const out = await withFetch(
    () => jsonResponse({ ...crawl("running"), results: [], next_cursor: "x" }),
    () => handlers.crawl_wait({ crawl_id: "c_1", timeout: 1 })
  );
  assert.equal(out.isError, undefined);
  const body = JSON.parse(out.content[0].text);
  assert.deepEqual(Object.keys(body), ["ok", "crawl_id", "status", "crawl", "note"]);
  assert.equal(body.status, "running");
  assert.match(body.note, /call crawl_wait again/i);
});

/** crawl_wait through a real MCP client: the crawl runs for two polls, then completes. */
async function waitOverMcp(t: TestContext, onprogress?: (p: Progress) => void) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerCrawlTools(server, "k");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const sent: JSONRPCMessage[] = [];
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = (message, options) => {
    sent.push(message);
    return send(message, options);
  };
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  let polls = 0;
  try {
    await withFetch(
      () => {
        polls++;
        const status = polls <= 2 ? "running" : "completed";
        const c = crawl(status);
        return jsonResponse({
          ...c,
          coverage: { pages_fetched: polls * 3, pages_failed: 0, items_found: polls * 5 },
          results: [],
          next_cursor: status === "running" ? "x" : null,
        });
      },
      async () => {
        let done = false;
        const call = client.callTool({ name: "crawl_wait", arguments: { crawl_id: "c_1", timeout: 60 } }, undefined, {
          onprogress,
        });
        call.finally(() => (done = true)).catch(() => undefined);
        while (!done) {
          for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
          t.mock.timers.tick(1_000);
        }
        const out = (await call) as { content: { text: string }[] };
        assert.equal(JSON.parse(out.content[0].text).status, "completed");
      }
    );
  } finally {
    await client.close();
  }
  return sent.filter((m) => "method" in m && m.method === "notifications/progress");
}

test("crawl_wait sends a progress notification after each poll when the call carries a progressToken", async (t) => {
  const seen: Progress[] = [];
  const sent = await waitOverMcp(t, (p) => seen.push(p));
  assert.equal(sent.length, 3, "one notification per poll");
  assert.deepEqual(
    seen.map((p) => p.progress),
    [1, 2, 3]
  );
  assert.equal(seen[0].message, "running: 3 pages fetched, 5 URLs kept");
  assert.equal(seen[2].message, "completed: 9 pages fetched, 15 URLs kept");
});

test("crawl_wait sends no progress notification without a progressToken", async (t) => {
  assert.equal((await waitOverMcp(t)).length, 0);
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

test("crawl_content takes a content id or a content_url", async () => {
  const { handlers } = register();
  const urls: string[] = [];
  await withFetch(
    (u) => {
      urls.push(u);
      return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
    },
    async () => {
      await handlers.crawl_content({ crawl_id: "c_1", content_id: "ct_9" });
      await handlers.crawl_content({ crawl_id: "c_1", content_id: "/v1/crawls/c_1/contents/ct_9" });
    }
  );
  assert.match(urls[0], /\/crawls\/c_1\/contents\/ct_9$/);
  assert.equal(urls[1], urls[0]);
});

test("crawl_content returns the HTML and cuts it at max_chars", async () => {
  const { handlers } = register();
  const html = "<html>" + "x".repeat(5000) + "</html>";
  const respond = () => new Response(html, { status: 200, headers: { "content-type": "text/html" } });
  const out = await withFetch(respond, () =>
    handlers.crawl_content({ crawl_id: "c_1", content_id: "ct_9", max_chars: 1000 })
  );
  assert.equal(out.content[0].text, html.slice(0, 1000));
  assert.match(out.content[1].text, /truncated: returned 1000 of 5013/);

  const full = await withFetch(respond, () => handlers.crawl_content({ crawl_id: "c_1", content_id: "ct_9" }));
  assert.equal(full.content.length, 1, "5013 characters fit under the 20000 default");
  assert.equal(full.content[0].text, html);
});

test("crawl_content cuts at 20000 characters by default", async () => {
  const { handlers } = register();
  const out = await withFetch(
    () => new Response("x".repeat(25_000), { status: 200, headers: { "content-type": "text/html" } }),
    () => handlers.crawl_content({ crawl_id: "c_1", content_id: "ct_9" })
  );
  assert.equal(out.content[0].text.length, 20_000);
  assert.match(out.content[1].text, /returned 20000 of 25000/);
});

test("crawl_content with no content id in content is an INVALID_USAGE error, with no request", async () => {
  const { handlers } = register();
  let called = false;
  const out = await withFetch(
    () => {
      called = true;
      return jsonResponse({});
    },
    () => handlers.crawl_content({ crawl_id: "c_1", content_id: "/" })
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
  assert.deepEqual(JSON.parse(out.content[0].text), {
    ok: true,
    crawl_id: "c_1",
    status: "stopped",
    crawl: { crawl_id: "c_1", status: "stopped", stop_reason: "user" },
  });
});

test("crawl_create returns 429 too_many_crawls as CRAWL_TOO_MANY_CRAWLS; crawl_stop returns another 429 as CRAWL_RATE_LIMITED", async () => {
  const { handlers } = register();
  const created = await withFetch(
    () =>
      new Response(JSON.stringify({ code: "too_many_crawls", title: "Too many crawls", status: 429 }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "30" },
      }),
    () => handlers.crawl_create({ url: "https://example.com/" })
  );
  const createBody = JSON.parse(created.content[0].text);
  assert.equal(created.isError, true);
  assert.equal(createBody.code, "CRAWL_TOO_MANY_CRAWLS");
  assert.equal(createBody.retry_after, 30);

  let stopCalls = 0;
  const stopped = await withFetch(
    () => {
      stopCalls++;
      return new Response(JSON.stringify({ title: "Too Many Requests", status: 429 }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "0" },
      });
    },
    () => handlers.crawl_stop({ crawl_id: "c_1" })
  );
  const stopBody = JSON.parse(stopped.content[0].text);
  assert.equal(stopped.isError, true);
  assert.equal(stopBody.code, "CRAWL_RATE_LIMITED");
  assert.equal(stopBody.retry_after, 0);
  assert.doesNotMatch(stopBody.message, /Nothing was created|active jobs/);
  assert.equal(stopCalls, 4, "crawl_stop still retries a 429 three times");
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

test("crawl_wait on an ended crawl returns its counts and the first 20 URLs, pointing at crawl_download", async () => {
  const { handlers } = register();
  const limits: (string | null)[] = [];
  const many = { ...crawl("completed"), coverage: { pages_fetched: 30, pages_failed: 0, items_found: 30 } };
  const out = await withFetch(
    (u) => {
      const limit = new URL(u).searchParams.get("limit");
      limits.push(limit);
      const n = Number(limit);
      const results = Array.from({ length: n }, (_, i) => ({ url: `https://example.com/${i}` }));
      return jsonResponse({ ...many, results, next_cursor: "x" });
    },
    () => handlers.crawl_wait({ crawl_id: "c_1", timeout: 1 })
  );
  const body = JSON.parse(out.content[0].text);
  assert.deepEqual(limits, ["1", "20"]);
  assert.equal(body.first_urls.length, 20);
  assert.equal(body.first_urls[0], "https://example.com/0");
  assert.equal("results" in body, false);
  assert.match(body.note, /20 of 30 URLs.*crawl_download/);
});

test("crawl_wait still answers when reading the first URLs fails", async () => {
  const { handlers } = register();
  let calls = 0;
  const out = await withFetch(
    () =>
      ++calls === 1 ? jsonResponse({ ...crawl("completed"), results: [], next_cursor: null }) : jsonResponse({}, 404),
    () => handlers.crawl_wait({ crawl_id: "c_1", timeout: 1 })
  );
  const body = JSON.parse(out.content[0].text);
  assert.equal(out.isError, undefined);
  assert.equal(body.status, "completed");
  assert.equal("first_urls" in body, false);
});

const ndjson = (lines: unknown[], status = "completed", split = false) => {
  const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  const bytes = new TextEncoder().encode(text);
  // Split mid-line so the line count cannot rely on chunk boundaries.
  const chunks = split ? [bytes.slice(0, 7), bytes.slice(7)] : [bytes];
  const body = new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk);
      c.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/x-ndjson", "x-crawl-status": status },
  });
};

const lines = [
  { url: "https://example.com/a", content_status: "fetched", content: "<html>a</html>" },
  { url: "https://example.com/b", content_status: "fetched", content: "<html>b</html>" },
  { url: "https://example.com/c", content_status: "pending" },
];

test("crawl_download saves every line to <dir>/<crawl_id>.jsonl and counts them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crawl-dl-"));
  const { handlers } = register({ downloadDir: dir });
  const seen: string[] = [];
  const out = await withFetch(
    (u, init) => {
      seen.push(`${init?.method} ${new URL(u).pathname} ${(init?.headers as Record<string, string>)["X-API-Key"]}`);
      return ndjson(lines, "stopped", true);
    },
    () => handlers.crawl_download({ crawl_id: "c_1" })
  );
  assert.equal(out.isError, undefined, out.content[0].text);
  const body = JSON.parse(out.content[0].text);
  assert.deepEqual(seen, ["GET /v1/crawls/c_1/download k"]);
  assert.equal(body.ok, true);
  assert.equal(body.path, join(dir, "c_1.jsonl"));
  assert.equal(body.status, "stopped");
  assert.equal(body.lines, 3);
  assert.deepEqual(body.content_status, { fetched: 2, pending: 1 });
  assert.match(body.note, /1 line\(s\) are pending.*overwrite: true/);
  const saved = (await readFile(body.path, "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(saved, lines);
  assert.deepEqual(await readdir(dir), ["c_1.jsonl"]);
});

test("crawl_download keeps an existing file unless overwrite is true", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crawl-dl-"));
  await writeFile(join(dir, "mine.jsonl"), "keep me\n");
  const { handlers } = register({ downloadDir: dir });
  let fetched = 0;
  const impl = () => {
    fetched++;
    return ndjson(lines.slice(0, 1));
  };
  const kept = await withFetch(impl, () => handlers.crawl_download({ crawl_id: "c_1", path: "mine.jsonl" }));
  assert.equal(kept.isError, true);
  assert.equal(JSON.parse(kept.content[0].text).code, "FILE_EXISTS");
  assert.equal(fetched, 0, "nothing is downloaded before the path is known to be free");
  assert.equal(await readFile(join(dir, "mine.jsonl"), "utf8"), "keep me\n");

  const replaced = await withFetch(impl, () =>
    handlers.crawl_download({ crawl_id: "c_1", path: "mine.jsonl", overwrite: true })
  );
  const body = JSON.parse(replaced.content[0].text);
  assert.equal(body.lines, 1);
  assert.equal("note" in body, false);
  assert.equal(JSON.parse(await readFile(join(dir, "mine.jsonl"), "utf8")).url, "https://example.com/a");
});

test("crawl_download keeps a file made while it downloaded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crawl-dl-"));
  const { handlers } = register({ downloadDir: dir });
  const out = await withFetch(
    () => {
      writeFileSync(join(dir, "mine.jsonl"), "keep me\n");
      return ndjson(lines);
    },
    () => handlers.crawl_download({ crawl_id: "c_1", path: "mine.jsonl" })
  );
  assert.equal(out.isError, true);
  assert.equal(JSON.parse(out.content[0].text).code, "FILE_EXISTS");
  assert.equal(await readFile(join(dir, "mine.jsonl"), "utf8"), "keep me\n");
  assert.deepEqual(await readdir(dir), ["mine.jsonl"]);
});

test("crawl_download refuses a path outside its directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crawl-dl-"));
  const { handlers } = register({ downloadDir: join(dir, "crawls") });
  let fetched = 0;
  for (const path of [join(dir, "crawls", "abs.jsonl"), "../out.jsonl", "a/../../out.jsonl", "."]) {
    const out = await withFetch(
      () => {
        fetched++;
        return ndjson(lines);
      },
      () => handlers.crawl_download({ crawl_id: "c_1", path })
    );
    assert.equal(out.isError, true, path);
    assert.equal(JSON.parse(out.content[0].text).code, "INVALID_PATH", path);
  }
  assert.equal(fetched, 0);
  assert.deepEqual(await readdir(dir), []);
});

test("crawl_download on a running crawl says the file is partial", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crawl-dl-"));
  const { handlers } = register({ downloadDir: dir });
  const out = await withFetch(
    () => ndjson([{ url: "https://example.com/a" }], "running"),
    () => handlers.crawl_download({ crawl_id: "c_1" })
  );
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.status, "running");
  assert.equal("content_status" in body, false, "a URLs-only crawl has no content_status to count");
  assert.match(body.note, /still running.*Download again/);
});

test("crawl_download keeps the crawl id from naming a file outside the directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crawl-dl-"));
  const { handlers } = register({ downloadDir: dir });
  const out = await withFetch(
    () => ndjson(lines),
    () => handlers.crawl_download({ crawl_id: "../../c_1" })
  );
  assert.equal(JSON.parse(out.content[0].text).path, join(dir, "______c_1.jsonl"));
});

test("a cut-off crawl_download leaves no file behind and reports the error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crawl-dl-"));
  const { handlers } = register({ downloadDir: dir });
  const out = await withFetch(
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"url":"https://example.com/a"}\n'));
            c.error(new Error("connection reset"));
          },
        }),
        { status: 200, headers: { "x-crawl-status": "completed" } }
      ),
    () => handlers.crawl_download({ crawl_id: "c_1" })
  );
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /connection reset/);
  assert.equal(JSON.parse(out.content[0].text).crawl_id, "c_1");
  assert.deepEqual(await readdir(dir), []);
});

test("crawl_download maps a missing crawl to CRAWL_NOT_FOUND and writes nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crawl-dl-"));
  const { handlers } = register({ downloadDir: dir });
  const out = await withFetch(
    () =>
      new Response(JSON.stringify({ status: 404, code: "crawl_not_found", detail: "no such crawl" }), {
        status: 404,
        headers: { "content-type": "application/problem+json" },
      }),
    () => handlers.crawl_download({ crawl_id: "c_missing" })
  );
  assert.equal(out.isError, true);
  assert.equal(JSON.parse(out.content[0].text).code, "CRAWL_NOT_FOUND");
  assert.deepEqual(await readdir(dir), []);
});

test("hosted crawl_download writes no file and gives a command that names the key, never holds it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crawl-dl-"));
  const { handlers } = register({ hosted: true, downloadDir: dir });
  const out = await withFetch(
    () => jsonResponse({ ...crawl("completed"), results: [], next_cursor: null }),
    () => handlers.crawl_download({ crawl_id: "c_1" })
  );
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.ok, true);
  assert.equal(body.status, "completed");
  assert.equal(body.download_url, "https://api.zenrows.com/v1/crawls/c_1/download");
  assert.equal(
    body.command,
    `curl -sS -H "X-API-Key: $ZENROWS_API_KEY" -o c_1.jsonl 'https://api.zenrows.com/v1/crawls/c_1/download'`
  );
  assert.equal(body.command.includes("X-API-Key: k"), false);
  assert.equal("path" in body, false);
  assert.deepEqual(await readdir(dir), []);

  const quoted = await withFetch(
    () => jsonResponse({ ...crawl("completed"), results: [], next_cursor: null }),
    () => handlers.crawl_download({ crawl_id: "c_1'; rm -rf ~; '" })
  );
  const cmd = JSON.parse(quoted.content[0].text).command as string;
  assert.equal(cmd.split("'").length, 3, `the URL stays one quoted word: ${cmd}`);
});
