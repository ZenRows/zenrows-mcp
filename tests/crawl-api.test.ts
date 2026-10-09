import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import {
  CrawlError,
  contentIdOf,
  crawlBase,
  createCrawl,
  getCrawl,
  getCrawlContent,
  listCrawls,
  readResults,
  stopCrawl,
  waitForCrawl,
} from "../src/crawl-api.ts";

const BASE = "https://api.zenrows.com/v1";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": status >= 400 ? "application/problem+json" : "application/json", ...headers },
  });
}

const crawl = (status = "running", extra: Record<string, unknown> = {}) => ({
  crawl_id: "c_1",
  status,
  url: "https://example.com/",
  depth: 1,
  max_items: 10,
  max_pages: 10,
  coverage: { pages_fetched: 0, pages_failed: 0, items_found: 0 },
  created_at: "2026-10-08T00:00:00Z",
  ...extra,
});

test("createCrawl POSTs /crawls with X-API-Key and the body as given", async () => {
  let seen: { url: string; init?: RequestInit } | undefined;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = { url: String(input), init };
    return jsonResponse(crawl(), 202, { location: "/v1/crawls/c_1" });
  }) as typeof fetch;

  const out = await createCrawl({ url: "https://example.com/", depth: 1 }, { apiKey: "k", fetchImpl });
  assert.equal(out.crawl_id, "c_1");
  assert.equal(seen!.url, `${BASE}/crawls`);
  assert.equal(seen!.init!.method, "POST");
  const headers = seen!.init!.headers as Record<string, string>;
  assert.equal(headers["X-API-Key"], "k");
  assert.equal(headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(String(seen!.init!.body)), { url: "https://example.com/", depth: 1 });
});

test("getCrawl, listCrawls and stopCrawl hit the documented paths and query", async () => {
  const urls: string[] = [];
  const methods: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    methods.push(String(init?.method));
    return jsonResponse({ ...crawl("completed"), results: [], next_cursor: null, crawls: [] });
  }) as typeof fetch;

  await getCrawl("c/1", { apiKey: "k", fetchImpl, cursor: "cur", limit: 5 });
  await listCrawls({ apiKey: "k", fetchImpl, limit: 50 });
  await stopCrawl("c_1", { apiKey: "k", fetchImpl });
  assert.deepEqual(urls, [
    `${BASE}/crawls/c%2F1?cursor=cur&limit=5`,
    `${BASE}/crawls?limit=50`,
    `${BASE}/crawls/c_1/stop`,
  ]);
  assert.deepEqual(methods, ["GET", "GET", "POST"]);
});

test("403 REQS008 maps to CRAWL_NOT_ENABLED with a message saying Crawl is not enabled", async () => {
  const fetchImpl = (async () =>
    jsonResponse(
      {
        code: "REQS008",
        title: "Crawl is not enabled for this account.",
        detail: "Crawl is not enabled for this account.",
        status: 403,
      },
      403
    )) as typeof fetch;

  await assert.rejects(
    () => createCrawl({ url: "https://example.com/", depth: 1 }, { apiKey: "k", fetchImpl }),
    (e: unknown) => {
      assert.ok(e instanceof CrawlError);
      assert.equal(e.code, "CRAWL_NOT_ENABLED");
      assert.equal(e.status, 403);
      assert.match(e.message, /Crawl is not enabled for this account/);
      assert.match(e.detail ?? "", /REQS008/);
      assert.equal(e.toJSON().server_code, "REQS008");
      return true;
    }
  );
});

test("404 crawl_not_found and content_not_found map to their own codes", async () => {
  const notFound = (code: string) =>
    (async () => jsonResponse({ code, title: "Not found", status: 404 }, 404)) as typeof fetch;
  await assert.rejects(
    () => getCrawl("c_missing", { apiKey: "k", fetchImpl: notFound("crawl_not_found") }),
    (e: unknown) => e instanceof CrawlError && e.code === "CRAWL_NOT_FOUND" && e.status === 404
  );
  await assert.rejects(
    () => getCrawlContent("c_1", "ct_1", { apiKey: "k", fetchImpl: notFound("content_not_found") }),
    (e: unknown) => e instanceof CrawlError && e.code === "CRAWL_CONTENT_NOT_FOUND"
  );
});

test("422 passes Crawl's detail through in the message", async () => {
  const fetchImpl = (async () =>
    jsonResponse(
      { code: "invalid_parameter", title: "Invalid parameter", detail: "'depth' is above 100000.", status: 422 },
      422
    )) as typeof fetch;
  await assert.rejects(
    () => createCrawl({ url: "https://example.com/", depth: 1 }, { apiKey: "k", fetchImpl }),
    (e: unknown) => {
      assert.ok(e instanceof CrawlError);
      assert.equal(e.code, "CRAWL_INVALID_REQUEST");
      assert.match(e.message, /invalid_parameter/);
      assert.match(e.message, /'depth' is above 100000/);
      return true;
    }
  );
});

test("429 too_many_crawls maps to CRAWL_TOO_MANY_CRAWLS and carries Retry-After", async () => {
  const fetchImpl = (async () =>
    jsonResponse({ code: "too_many_crawls", title: "Too many crawls", status: 429 }, 429, {
      "retry-after": "30",
    })) as typeof fetch;
  await assert.rejects(
    () => createCrawl({ url: "https://example.com/", depth: 1 }, { apiKey: "k", fetchImpl }),
    (e: unknown) => {
      assert.ok(e instanceof CrawlError);
      assert.equal(e.code, "CRAWL_TOO_MANY_CRAWLS");
      assert.equal(e.retryAfter, 30);
      assert.equal(e.toJSON().retry_after, 30);
      assert.equal(e.toJSON().server_code, "too_many_crawls");
      assert.match(e.message, /limit of active jobs \(3 by default\), shared with its Batch jobs/);
      return true;
    }
  );
});

test("401, 409, 402 and other 403s map to AUTH_INVALID, CRAWL_REQUEST_IN_FLIGHT, CRAWL_QUOTA_EXCEEDED, CRAWL_KEY_CAP_REACHED and CRAWL_FAILED", async () => {
  const respond = (status: number, code?: string) =>
    (async () => jsonResponse({ code, title: "x", status }, status)) as typeof fetch;
  const codeOf = async (fetchImpl: typeof fetch) => {
    try {
      await listCrawls({ apiKey: "k", fetchImpl });
    } catch (e) {
      return (e as CrawlError).code;
    }
  };
  assert.equal(await codeOf(respond(401)), "AUTH_INVALID");
  assert.equal(await codeOf(respond(409, "idempotency_request_in_flight")), "CRAWL_REQUEST_IN_FLIGHT");
  assert.equal(await codeOf(respond(402, "AUTH002")), "CRAWL_QUOTA_EXCEEDED");
  assert.equal(await codeOf(respond(402, "AUTH014")), "CRAWL_KEY_CAP_REACHED");
  assert.equal(await codeOf(respond(500)), "CRAWL_FAILED");
  assert.equal(await codeOf(respond(403, "AUTH001")), "CRAWL_FAILED");
});

test("an error without a server code carries no server_code", async () => {
  const fetchImpl = (async () => new Response("internal error", { status: 500 })) as typeof fetch;
  await assert.rejects(
    () => listCrawls({ apiKey: "k", fetchImpl }),
    (e: unknown) => {
      assert.ok(e instanceof CrawlError);
      assert.equal(e.code, "CRAWL_FAILED");
      assert.equal("server_code" in e.toJSON(), false);
      return true;
    }
  );
});

test("readResults returns at most 100 results by default", async () => {
  const limits: Array<string | null> = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    limits.push(new URL(String(input)).searchParams.get("limit"));
    return jsonResponse({ ...crawl("completed"), results: [], next_cursor: null });
  }) as typeof fetch;
  await readResults("c_1", { apiKey: "k", fetchImpl });
  assert.deepEqual(limits, ["100"]);
});

test("a network failure becomes BACKEND_UNAVAILABLE", async () => {
  const fetchImpl = (async () => {
    throw new TypeError("fetch failed: ECONNREFUSED");
  }) as typeof fetch;
  await assert.rejects(
    () => stopCrawl("c_1", { apiKey: "k", fetchImpl }),
    (e: unknown) => e instanceof CrawlError && e.code === "BACKEND_UNAVAILABLE" && /ECONNREFUSED/.test(e.message)
  );
});

test("getCrawlContent returns the HTML body as text", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    assert.equal(String(input), `${BASE}/crawls/c_1/contents/ct_1`);
    return new Response("<html><body>hi</body></html>", { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  const page = await getCrawlContent("c_1", "ct_1", { apiKey: "k", fetchImpl });
  assert.equal(page.body, "<html><body>hi</body></html>");
  assert.match(page.contentType, /text\/html/);
});

test("contentIdOf takes a content id as given, or a content_url's last path segment", () => {
  assert.equal(contentIdOf("ct_2"), "ct_2");
  assert.equal(contentIdOf("/v1/crawls/c_1/contents/ct_2"), "ct_2");
  assert.equal(contentIdOf("https://api.zenrows.com/v1/crawls/c_1/contents/ct_2/?download=true"), "ct_2");
  assert.equal(contentIdOf("/"), "");
});

test("readResults follows next_cursor and stops when it is null", async () => {
  const pages: Record<string, { results: { url: string }[]; next_cursor: string | null }> = {
    start: {
      results: [{ url: "https://example.com/product/1" }, { url: "https://example.com/product/2" }],
      next_cursor: "p2",
    },
    p2: { results: [{ url: "https://example.com/product/3" }], next_cursor: null },
  };
  const cursors: Array<string | null> = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const c = new URL(String(input)).searchParams.get("cursor");
    cursors.push(c);
    return jsonResponse({ ...crawl("completed"), ...pages[c ?? "start"] });
  }) as typeof fetch;

  const read = await readResults("c_1", { apiKey: "k", fetchImpl });
  assert.deepEqual(
    read.results.map((r) => r.url),
    ["https://example.com/product/1", "https://example.com/product/2", "https://example.com/product/3"]
  );
  assert.equal(read.next_cursor, null);
  assert.deepEqual(cursors, [null, "p2"]);
});

test("readResults on a running crawl stops at the first empty page and keeps the cursor", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return calls === 1
      ? jsonResponse({ ...crawl("running"), results: [{ url: "https://example.com/product/1" }], next_cursor: "p2" })
      : jsonResponse({ ...crawl("running"), results: [], next_cursor: "p2" });
  }) as typeof fetch;
  const read = await readResults("c_1", { apiKey: "k", fetchImpl });
  assert.equal(read.results.length, 1);
  assert.equal(read.next_cursor, "p2");
  assert.equal(read.status, "running");
  assert.equal(calls, 2);
});

test("readResults stops at limit and asks only for what is left", async () => {
  const limits: Array<string | null> = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    limits.push(new URL(String(input)).searchParams.get("limit"));
    return jsonResponse({
      ...crawl("completed"),
      results: [{ url: "https://example.com/product/1" }, { url: "https://example.com/product/2" }],
      next_cursor: "more",
    });
  }) as typeof fetch;
  const read = await readResults("c_1", { apiKey: "k", fetchImpl, limit: 3 });
  assert.equal(read.results.length, 4);
  assert.equal(read.next_cursor, "more");
  assert.deepEqual(limits, ["3", "1"]);
});

test("waitForCrawl polls with limit=1 until terminal and drops the results page", async () => {
  const statuses = ["running", "running", "completed"];
  const limits: Array<string | null> = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    limits.push(new URL(String(input)).searchParams.get("limit"));
    return jsonResponse({
      ...crawl(statuses.shift()),
      results: [{ url: "https://example.com/product/1" }],
      next_cursor: "x",
    });
  }) as typeof fetch;
  const out = await waitForCrawl("c_1", { apiKey: "k", fetchImpl, pollDelayMs: 1 });
  assert.equal(out.status, "completed");
  assert.equal("results" in out, false);
  assert.equal("next_cursor" in out, false);
  assert.deepEqual(limits, ["1", "1", "1"]);
});

test("waitForCrawl returns the running crawl when the wait runs out, and does not stop it", async () => {
  const methods: string[] = [];
  const fetchImpl = (async (_i: RequestInfo | URL, init?: RequestInit) => {
    methods.push(String(init?.method));
    return jsonResponse({ ...crawl("running"), results: [], next_cursor: "x" });
  }) as typeof fetch;
  const out = await waitForCrawl("c_1", { apiKey: "k", fetchImpl, timeout: 0.03, pollDelayMs: 10 });
  assert.equal(out.status, "running");
  assert.equal(out.crawl_id, "c_1");
  assert.ok(methods.every((m) => m === "GET"));
});

test("crawlBase trims trailing slashes and defaults when the env override is unset/blank", () => {
  const original = process.env.ZENROWS_CRAWL_API_BASE;
  try {
    delete process.env.ZENROWS_CRAWL_API_BASE;
    assert.equal(crawlBase(), BASE);
    process.env.ZENROWS_CRAWL_API_BASE = "   ";
    assert.equal(crawlBase(), BASE);
    process.env.ZENROWS_CRAWL_API_BASE = "https://example.com/v1//";
    assert.equal(crawlBase(), "https://example.com/v1");
  } finally {
    if (original === undefined) delete process.env.ZENROWS_CRAWL_API_BASE;
    else process.env.ZENROWS_CRAWL_API_BASE = original;
  }
});

const createBody = { url: "https://example.com/", depth: 1 };

/** Answers each request with the next status in turn, 200 with a crawl once they run out. */
function sequence(statuses: number[], headers: Record<string, string> = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (_i: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(init?.method));
    const status = statuses.shift();
    return status === undefined
      ? jsonResponse({ ...crawl(), results: [], next_cursor: "x" })
      : jsonResponse({ code: "x", title: "x", status }, status, headers);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

/** Runs a call under fake timers, ticking through every backoff until it settles. */
async function settle<T>(t: TestContext, p: Promise<T>): Promise<T> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true)
  );
  while (!done) {
    await flush();
    t.mock.timers.tick(10_000);
  }
  return p;
}

test("a GET is retried on 503 and then succeeds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, fetchImpl } = sequence([503, 503]);
  const out = await settle(t, getCrawl("c_1", { apiKey: "k", fetchImpl }));
  assert.equal(out.crawl_id, "c_1");
  assert.deepEqual(calls, ["GET", "GET", "GET"]);
});

test("a GET gives up after 3 retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, fetchImpl } = sequence([503, 503, 503, 503, 503]);
  await assert.rejects(settle(t, getCrawl("c_1", { apiKey: "k", fetchImpl })), (e: unknown) => {
    return e instanceof CrawlError && e.code === "CRAWL_FAILED" && e.status === 503;
  });
  assert.equal(calls.length, 4);
});

test("a create without an idempotency key is not retried on 503", async () => {
  const { calls, fetchImpl } = sequence([503]);
  await assert.rejects(createCrawl(createBody, { apiKey: "k", fetchImpl }), (e: unknown) => {
    return e instanceof CrawlError && e.status === 503;
  });
  assert.equal(calls.length, 1);
});

test("a create with an idempotency key is retried on 503", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, fetchImpl } = sequence([503]);
  const out = await settle(t, createCrawl(createBody, { apiKey: "k", fetchImpl, idempotencyKey: "key-1" }));
  assert.equal(out.crawl_id, "c_1");
  assert.deepEqual(calls, ["POST", "POST"]);
});

test("a create is never retried on 429, even with an idempotency key", async () => {
  const { calls, fetchImpl } = sequence([429], { "retry-after": "1" });
  await assert.rejects(createCrawl(createBody, { apiKey: "k", fetchImpl, idempotencyKey: "key-1" }), (e: unknown) => {
    return e instanceof CrawlError && e.code === "CRAWL_TOO_MANY_CRAWLS" && e.retryAfter === 1;
  });
  assert.equal(calls.length, 1);
});

test("stop is not retried", async () => {
  const { calls, fetchImpl } = sequence([503]);
  await assert.rejects(stopCrawl("c_1", { apiKey: "k", fetchImpl }), (e: unknown) => {
    return e instanceof CrawlError && e.status === 503;
  });
  assert.equal(calls.length, 1);
});

test("a retry waits the Retry-After seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, fetchImpl } = sequence([429], { "retry-after": "5" });
  const done = getCrawl("c_1", { apiKey: "k", fetchImpl });
  await flush();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(4_999);
  await flush();
  assert.equal(calls.length, 1, "no retry before Retry-After");
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls.length, 2);
  assert.equal((await done).crawl_id, "c_1");
});

test("a GET is retried after a network error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const fetchImpl = (async () => {
    if (++calls === 1) throw new TypeError("fetch failed: ECONNRESET");
    return jsonResponse({ crawls: [] });
  }) as typeof fetch;
  await settle(t, listCrawls({ apiKey: "k", fetchImpl }));
  assert.equal(calls, 2);
});
