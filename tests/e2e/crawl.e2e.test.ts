import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.ts";

/**
 * End-to-end: drives the crawl_* tools through a real MCP client against a live
 * Crawl API. Opt-in, so `npm test` stays hermetic: it runs only when
 * ZENROWS_API_KEY (a key with Crawl access), ZENROWS_CRAWL_API_BASE and
 * ZENROWS_E2E_CRAWL_URL (the start URL to crawl) are set. ZENROWS_E2E_CRAWL_INCLUDE
 * is an optional include pattern; when set, every result URL must contain it.
 */
const apiKey = process.env.ZENROWS_API_KEY;
const base = process.env.ZENROWS_CRAWL_API_BASE;
const startUrl = process.env.ZENROWS_E2E_CRAWL_URL;
const include = process.env.ZENROWS_E2E_CRAWL_INCLUDE || undefined;
const skip =
  !apiKey || !base || !startUrl
    ? "set ZENROWS_API_KEY, ZENROWS_CRAWL_API_BASE and ZENROWS_E2E_CRAWL_URL to run"
    : false;

const SLOT_WAIT_MS = 5 * 60_000;

type ToolOut = { content: { type: string; text: string }[]; isError?: boolean };

let client: Client;

before(async () => {
  if (skip) return;
  const server = createServer(apiKey!);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "crawl-e2e", version: "0.0.0" });
  await client.connect(clientTransport);
});

after(async () => {
  await client?.close();
});

async function call(name: string, args: Record<string, unknown>): Promise<ToolOut> {
  return (await client.callTool({ name, arguments: args })) as ToolOut;
}

function body(out: ToolOut): Record<string, unknown> {
  return JSON.parse(out.content[0].text) as Record<string, unknown>;
}

test("crawl tools end to end", { skip, timeout: 15 * 60_000 }, async () => {
  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const name of [
    "crawl_create",
    "crawl_get",
    "crawl_results",
    "crawl_content",
    "crawl_list",
    "crawl_stop",
    "crawl_wait",
  ]) {
    assert.ok(tools.includes(name), `${name} is listed`);
  }

  // Create and wait. Other crawls on the account may be running, so wait out a 429.
  const deadline = Date.now() + SLOT_WAIT_MS;
  let created: Record<string, unknown>;
  for (;;) {
    const out = await call("crawl_create", {
      url: startUrl,
      depth: 1,
      max_items: 3,
      max_pages: 5,
      ...(include ? { include_patterns: [include] } : {}),
      output_format: "html",
      follow: true,
    });
    const b = body(out);
    if (out.isError && b.code === "CRAWL_TOO_MANY_CRAWLS" && Date.now() < deadline) {
      const seconds = typeof b.retry_after === "number" ? b.retry_after : 30;
      console.log(`crawl_create: too many crawls, retrying in ${seconds}s`);
      await new Promise((r) => setTimeout(r, seconds * 1000));
      continue;
    }
    assert.ok(!out.isError, `crawl_create failed: ${out.content[0].text}`);
    created = b;
    break;
  }
  const crawlId = created.crawl_id as string;
  // The wait stays under the MCP client timeout, so a slow crawl comes back running.
  while (created.status === "running") created = body(await call("crawl_wait", { crawl_id: crawlId }));
  console.log(`crawl_create: ${created.status}`);
  assert.equal(created.status, "completed");

  const results = await call("crawl_results", { crawl_id: crawlId });
  assert.ok(!results.isError, results.content[0].text);
  const r = body(results) as {
    count: number;
    partial: boolean;
    next_cursor: string | null;
    results: { url: string; content_status?: string; content_url?: string }[];
  };
  console.log(`crawl_results: count=${r.count} partial=${r.partial} next_cursor=${r.next_cursor}`);
  assert.ok(r.count >= 1, "at least one result");
  assert.equal(r.partial, false);
  assert.equal(r.next_cursor, null);
  if (include) for (const row of r.results) assert.ok(row.url.includes(include), `${row.url} contains ${include}`);

  const fetched = r.results.find((row) => row.content_status === "fetched");
  assert.ok(fetched?.content_url, "a fetched result with content_url");
  const content = await call("crawl_content", { content_url: fetched.content_url });
  assert.ok(!content.isError, content.content[0].text);
  const html = content.content[0].text;
  console.log(`crawl_content: ${html.length} chars of HTML`);
  assert.match(html, /<html|<!doctype html/i);

  const list = body(await call("crawl_list", { limit: 100 })) as { crawls: { crawl_id: string }[] };
  assert.ok(
    list.crawls.some((c) => c.crawl_id === crawlId),
    "crawl_list holds the new crawl"
  );
  console.log("crawl_list: new crawl listed");

  const stop = await call("crawl_stop", { crawl_id: crawlId });
  assert.ok(!stop.isError, stop.content[0].text);
  assert.equal(body(stop).status, "completed", "stop on an ended crawl answers as it ended");
  console.log(`crawl_stop: ${body(stop).status}`);

  const got = body(await call("crawl_get", { crawl_id: crawlId })) as { status: string; results: unknown[] };
  assert.equal(got.status, "completed");
  assert.equal(got.results.length, r.count, "crawl_get holds the same page of results");

  const missing = await call("crawl_get", { crawl_id: "c_does_not_exist" });
  assert.equal(missing.isError, true);
  assert.equal(body(missing).code, "CRAWL_NOT_FOUND");
  assert.equal(body(missing).crawl_id, "c_does_not_exist");
  console.log(`crawl_get(bad id): ${body(missing).code}`);
});
