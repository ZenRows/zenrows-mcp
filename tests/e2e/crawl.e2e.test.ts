import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.ts";

/**
 * End-to-end: drives the crawl_* tools through a real MCP client against a live
 * Crawl API. Opt-in, so `npm test` stays hermetic: it runs only when both
 * ZENROWS_API_KEY (a key with Crawl access) and ZENROWS_CRAWL_API_BASE are set.
 *
 *   ZENROWS_CRAWL_API_BASE=https://api.zenrows.com/v1 npm run test:e2e
 */
const apiKey = process.env.ZENROWS_API_KEY;
const base = process.env.ZENROWS_CRAWL_API_BASE;
const skip = !apiKey || !base ? "set ZENROWS_API_KEY and ZENROWS_CRAWL_API_BASE to run" : false;

const START_URL = "https://www.scrapingcourse.com/ecommerce/";
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
    "crawl_status",
    "crawl_results",
    "crawl_content",
    "crawl_list",
    "crawl_stop",
    "crawl_wait",
  ]) {
    assert.ok(tools.includes(name), `${name} is listed`);
  }

  // Create and wait. The account shares 3 active crawl + Batch slots, so wait out a 429.
  const deadline = Date.now() + SLOT_WAIT_MS;
  let created: Record<string, unknown>;
  for (;;) {
    const out = await call("crawl_create", {
      url: START_URL,
      depth: 1,
      max_items: 3,
      max_pages: 5,
      include_patterns: ["/product/"],
      output_format: "html",
      wait: true,
      wait_timeout_ms: 600_000,
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
  console.log(`crawl_create: ${crawlId} ${created.status} ${JSON.stringify(created.coverage)}`);
  assert.equal(created.status, "completed");

  const results = await call("crawl_results", { crawl_id: crawlId });
  assert.ok(!results.isError, results.content[0].text);
  const r = body(results) as {
    count: number;
    partial: boolean;
    next_cursor: string | null;
    results: { url: string; content_status?: string; content_url?: string; content_id?: string }[];
  };
  console.log(`crawl_results: count=${r.count} partial=${r.partial} next_cursor=${r.next_cursor}`);
  assert.ok(r.count >= 1, "at least one result");
  assert.equal(r.partial, false);
  assert.equal(r.next_cursor, null);
  for (const row of r.results) assert.match(row.url, /\/product\//);

  const fetched = r.results.find((row) => row.content_status === "fetched");
  assert.ok(fetched?.content_url, "a fetched result with content_url");
  const content = await call("crawl_content", { content_url: fetched.content_url });
  assert.ok(!content.isError, content.content[0].text);
  const html = content.content[0].text;
  console.log(`crawl_content: ${fetched.url} -> ${html.length} chars`);
  assert.match(html, /<html|<!doctype html/i);
  const byId = await call("crawl_content", { crawl_id: crawlId, content_id: fetched.content_id });
  assert.equal(byId.content[0].text, html);

  const list = body(await call("crawl_list", { limit: 100 })) as { crawls: { crawl_id: string }[] };
  assert.ok(
    list.crawls.some((c) => c.crawl_id === crawlId),
    "crawl_list holds the new crawl"
  );
  console.log(`crawl_list: ${list.crawls.length} crawls, new one listed`);

  const stop = await call("crawl_stop", { crawl_id: crawlId });
  assert.ok(!stop.isError, stop.content[0].text);
  assert.equal(body(stop).status, "completed", "stop on an ended crawl answers as it ended");
  console.log(`crawl_stop: ${body(stop).status}`);

  const status = await call("crawl_status", { crawl_id: crawlId });
  assert.equal(body(status).status, "completed");

  const missing = await call("crawl_status", { crawl_id: "c_does_not_exist" });
  assert.equal(missing.isError, true);
  assert.equal(body(missing).code, "CRAWL_NOT_FOUND");
  console.log(`crawl_status(bad id): ${body(missing).code}`);
});
