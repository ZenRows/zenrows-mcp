import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CrawlError,
  crawlBase,
  createCrawl,
  getCrawl,
  getCrawlContent,
  listCrawls,
  parseContentUrl,
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
  url: "https://shop.example/",
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

  const out = await createCrawl({ url: "https://shop.example/", depth: 1 }, { apiKey: "k", fetchImpl });
  assert.equal(out.crawl_id, "c_1");
  assert.equal(seen!.url, `${BASE}/crawls`);
  assert.equal(seen!.init!.method, "POST");
  const headers = seen!.init!.headers as Record<string, string>;
  assert.equal(headers["X-API-Key"], "k");
  assert.equal(headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(String(seen!.init!.body)), { url: "https://shop.example/", depth: 1 });
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
    () => createCrawl({ url: "https://shop.example/", depth: 1 }, { apiKey: "k", fetchImpl }),
    (e: unknown) => {
      assert.ok(e instanceof CrawlError);
      assert.equal(e.code, "CRAWL_NOT_ENABLED");
      assert.equal(e.status, 403);
      assert.match(e.message, /Crawl is not enabled for this account/);
      assert.match(e.detail ?? "", /REQS008/);
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
    () => createCrawl({ url: "https://shop.example/", depth: 1 }, { apiKey: "k", fetchImpl }),
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
    () => createCrawl({ url: "https://shop.example/", depth: 1 }, { apiKey: "k", fetchImpl }),
    (e: unknown) => {
      assert.ok(e instanceof CrawlError);
      assert.equal(e.code, "CRAWL_TOO_MANY_CRAWLS");
      assert.equal(e.retryAfter, 30);
      assert.equal(e.toJSON().retry_after, 30);
      return true;
    }
  );
});

test("401 and 402 map to AUTH_INVALID, CRAWL_QUOTA_EXCEEDED and CRAWL_KEY_CAP_REACHED", async () => {
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
  assert.equal(await codeOf(respond(402, "AUTH002")), "CRAWL_QUOTA_EXCEEDED");
  assert.equal(await codeOf(respond(402, "AUTH014")), "CRAWL_KEY_CAP_REACHED");
  assert.equal(await codeOf(respond(500, "internal_error")), "CRAWL_FAILED");
});

test("a network failure becomes BACKEND_UNAVAILABLE", async () => {
  const fetchImpl = (async () => {
    throw new TypeError("fetch failed: ECONNREFUSED");
  }) as typeof fetch;
  await assert.rejects(
    () => listCrawls({ apiKey: "k", fetchImpl }),
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

test("parseContentUrl reads both ids from a content_url", () => {
  assert.deepEqual(parseContentUrl("/v1/crawls/c_1/contents/ct_2"), { crawlId: "c_1", contentId: "ct_2" });
  assert.deepEqual(parseContentUrl("https://api.zenrows.com/v1/crawls/c_1/contents/ct_2?download=true"), {
    crawlId: "c_1",
    contentId: "ct_2",
  });
  assert.equal(parseContentUrl("/v1/crawls/c_1"), undefined);
});

test("readResults follows next_cursor and stops when it is null", async () => {
  const pages: Record<string, { results: { url: string }[]; next_cursor: string | null }> = {
    start: { results: [{ url: "https://a/1" }, { url: "https://a/2" }], next_cursor: "p2" },
    p2: { results: [{ url: "https://a/3" }], next_cursor: null },
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
    ["https://a/1", "https://a/2", "https://a/3"]
  );
  assert.equal(read.next_cursor, null);
  assert.equal(read.truncated, false);
  assert.deepEqual(cursors, [null, "p2"]);
});

test("readResults on a running crawl stops at the first empty page and keeps the cursor", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return calls === 1
      ? jsonResponse({ ...crawl("running"), results: [{ url: "https://a/1" }], next_cursor: "p2" })
      : jsonResponse({ ...crawl("running"), results: [], next_cursor: "p2" });
  }) as typeof fetch;
  const read = await readResults("c_1", { apiKey: "k", fetchImpl });
  assert.equal(read.results.length, 1);
  assert.equal(read.next_cursor, "p2");
  assert.equal(read.status, "running");
  assert.equal(calls, 2);
});

test("readResults stops at maxResults and asks only for what is left", async () => {
  const limits: Array<string | null> = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    limits.push(new URL(String(input)).searchParams.get("limit"));
    return jsonResponse({
      ...crawl("completed"),
      results: [{ url: "https://a/1" }, { url: "https://a/2" }],
      next_cursor: "more",
    });
  }) as typeof fetch;
  const read = await readResults("c_1", { apiKey: "k", fetchImpl, maxResults: 3 });
  assert.equal(read.results.length, 4);
  assert.equal(read.truncated, true);
  assert.equal(read.next_cursor, "more");
  assert.deepEqual(limits, ["3", "1"]);
});

test("waitForCrawl polls with limit=1 until terminal and drops the results page", async () => {
  const statuses = ["running", "running", "completed"];
  const limits: Array<string | null> = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    limits.push(new URL(String(input)).searchParams.get("limit"));
    return jsonResponse({ ...crawl(statuses.shift()), results: [{ url: "https://a/1" }], next_cursor: "x" });
  }) as typeof fetch;
  const out = await waitForCrawl("c_1", { apiKey: "k", fetchImpl, pollDelayMs: 1 });
  assert.equal(out.status, "completed");
  assert.equal("results" in out, false);
  assert.equal("next_cursor" in out, false);
  assert.deepEqual(limits, ["1", "1", "1"]);
});

test("waitForCrawl times out with CRAWL_WAIT_TIMEOUT and does not stop the crawl", async () => {
  const methods: string[] = [];
  const fetchImpl = (async (_i: RequestInfo | URL, init?: RequestInit) => {
    methods.push(String(init?.method));
    return jsonResponse({ ...crawl("running"), results: [], next_cursor: "x" });
  }) as typeof fetch;
  await assert.rejects(
    () => waitForCrawl("c_1", { apiKey: "k", fetchImpl, pollTimeoutMs: 30, pollDelayMs: 10 }),
    (e: unknown) => e instanceof CrawlError && e.code === "CRAWL_WAIT_TIMEOUT"
  );
  assert.ok(methods.every((m) => m === "GET"));
});

test("crawlBase trims trailing slashes and defaults when the env override is unset/blank", () => {
  const original = process.env.ZENROWS_CRAWL_API_BASE;
  try {
    delete process.env.ZENROWS_CRAWL_API_BASE;
    assert.equal(crawlBase(), BASE);
    process.env.ZENROWS_CRAWL_API_BASE = "   ";
    assert.equal(crawlBase(), BASE);
    process.env.ZENROWS_CRAWL_API_BASE = "https://staging.example.com/v1//";
    assert.equal(crawlBase(), "https://staging.example.com/v1");
  } finally {
    if (original === undefined) delete process.env.ZENROWS_CRAWL_API_BASE;
    else process.env.ZENROWS_CRAWL_API_BASE = original;
  }
});
