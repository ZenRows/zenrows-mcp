import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";

/**
 * The scrape and extract tools through a real MCP client, with the API played by a
 * local node:http server. Global fetch is redirected there; the request still goes
 * through the real fetch, so cancellation and sockets behave as in production.
 */
async function harness(t: TestContext, handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const hits: number[] = [];
  const t0 = Date.now();
  const api = http.createServer((req, res) => {
    hits.push(Date.now() - t0);
    handler(req, res);
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}/v1/`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = ((u: RequestInfo | URL, init?: RequestInit) =>
    realFetch(String(u).replace("https://api.zenrows.com/v1/", base), init)) as typeof fetch;
  const stderr = t.mock.method(process.stderr, "write", () => true);

  const server = createServer("k");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);

  t.after(async () => {
    await client.close();
    globalThis.fetch = realFetch;
    api.closeAllConnections();
    await new Promise<void>((r) => api.close(() => r()));
  });
  const retryLines = () =>
    stderr.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.startsWith("zenrows-mcp:"));
  return { client, hits, retryLines };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("scrape retries a 503 and returns the retry's page", async (t) => {
  let n = 0;
  const { client, hits, retryLines } = await harness(t, (_req, res) => {
    if (n++ === 0) {
      res.writeHead(503, { "retry-after": "0" }).end('{"code":"RESP009"}');
    } else {
      res.writeHead(200, { "content-type": "text/plain" }).end("page body");
    }
  });
  const out = (await client.callTool({ name: "scrape", arguments: { url: "https://example.com" } })) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  assert.equal(out.isError, undefined);
  assert.equal(out.content[0].text, "page body");
  assert.equal(hits.length, 2);
  assert.deepEqual(retryLines(), ["zenrows-mcp: scrape got 503 on attempt 1 of 3; retrying in 250 ms\n"]);
});

for (const tool of ["scrape", "extract"]) {
  test(`${tool}: no request reaches the API after the client times out the call`, async (t) => {
    const { client, hits } = await harness(t, (_req, res) => {
      res.writeHead(503, { "retry-after": "1", "content-type": "application/json" }).end('{"code":"RESP009"}');
    });
    const c0 = Date.now();
    await assert.rejects(
      client.callTool({ name: tool, arguments: { url: "https://example.com" } }, undefined, { timeout: 300 }),
      /timed out/i
    );
    const cancelledAt = Date.now() - c0;
    // Without cancellation the retry would go out at about 1 s and the next at about 2 s.
    await wait(2_500);
    assert.equal(hits.length, 1, `requests at ${hits.join(", ")} ms; client cancelled at ${cancelledAt} ms`);
  });
}

for (const tool of ["scrape", "extract"]) {
  test(`${tool}: a client timeout closes the attempt that is still running`, async (t) => {
    let closedAt: number | undefined;
    const c0 = Date.now();
    const { client, hits } = await harness(t, (req) => {
      req.socket.on("close", () => void (closedAt = Date.now() - c0));
    });
    await assert.rejects(
      client.callTool({ name: tool, arguments: { url: "https://example.com" } }, undefined, { timeout: 200 }),
      /timed out/i
    );
    await wait(300);
    assert.equal(hits.length, 1);
    assert.ok(closedAt !== undefined && closedAt < 1_000, `connection closed at ${closedAt} ms`);
  });
}

// On the prepared-domains endpoints a 429 (allowance used up) and a 503 (preparation
// unavailable) are answers for the agent to read, not busy signals: never resend them.
for (const status of [429, 503]) {
  for (const [tool, args, expected] of [
    ["prepare_domain", { domain: "example.com", example_urls: ["https://example.com/p/1"] }, 1],
    ["prepared_domain_status", { domain: "example.com" }, 2],
  ] as const) {
    test(`${tool}: a ${status} is returned on the first attempt`, async (t) => {
      const paths: string[] = [];
      const { client, hits, retryLines } = await harness(t, (req, res) => {
        paths.push(`${req.method} ${req.url}`);
        res.writeHead(status, { "retry-after": "0", "content-type": "application/json" }).end("{}");
      });
      const out = (await client.callTool({ name: tool, arguments: args })) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      await wait(600);
      assert.equal(out.isError, true);
      assert.equal(JSON.parse(out.content[0].text).status, status);
      // prepared_domain_status reads the domain and the allowance: one request each.
      assert.equal(hits.length, expected, `requests: ${paths.join(", ")}`);
      assert.equal(new Set(paths).size, expected, `a path was sent twice: ${paths.join(", ")}`);
      assert.deepEqual(retryLines(), []);
    });
  }
}

// A status that belongs to the target site is never retried. The API returns the
// target's own status only when the request sets original_status, and treats a status
// in allowed_status_codes as the target's answer. scrape and extract offer neither
// parameter and never send it, so every status they see is the API's own and the
// retry rules apply to it unchanged. If either tool ever gains one of these
// parameters, these tests fail: the retry must then skip target statuses.
const TARGET_STATUS_PARAMS = ["original_status", "allowed_status_codes"];

test("scrape and extract offer no parameter that returns the target site's status", async (t) => {
  const { client } = await harness(t, (_req, res) => res.writeHead(500).end());
  const { tools } = await client.listTools();
  for (const name of ["scrape", "extract"]) {
    const tool = tools.find((x) => x.name === name);
    assert.ok(tool, `${name} is listed`);
    const offered = Object.keys(tool.inputSchema.properties ?? {});
    for (const param of TARGET_STATUS_PARAMS) {
      assert.ok(!offered.includes(param), `${name} offers ${param}; its statuses must then not be retried`);
    }
  }
});

for (const tool of ["scrape", "extract"]) {
  test(`${tool}: a caller's original_status or allowed_status_codes never reaches the API`, async (t) => {
    const urls: string[] = [];
    const { client, hits } = await harness(t, (req, res) => {
      urls.push(req.url ?? "");
      if (urls.length === 1) {
        res.writeHead(503, { "retry-after": "0", "content-type": "application/json" }).end('{"code":"RESP009"}');
      } else {
        res.writeHead(200, { "content-type": "application/json" }).end('{"parsed":{"title":"x"}}');
      }
    });
    const out = (await client.callTool({
      name: tool,
      arguments: { url: "https://example.com", original_status: true, allowed_status_codes: "503" },
    })) as { isError?: boolean };
    for (const u of urls) {
      const query = new URL(u, "http://api.invalid").searchParams;
      for (const param of TARGET_STATUS_PARAMS) assert.equal(query.has(param), false, `${param} sent in ${u}`);
    }
    // The 503 is the API's own, so the retry still happens.
    assert.equal(hits.length, 2);
    assert.equal(out.isError, undefined);
  });
}
