import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Without a key, /mcp answers the read-only discovery methods so registries and
 * scanners can list the tools, and keeps the 401 challenge on everything else, which
 * is what starts an OAuth client's sign-in.
 */

const { handler } = await import("../src/http.ts");

function post(body: unknown, method = "POST") {
  return handler({
    requestContext: { http: { method } },
    rawPath: "/mcp",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

const rpc = (method: string, params: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: 1, method, params });

test("initialize and tools/list answer without a key", async () => {
  const init = await post(
    rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } })
  );
  assert.equal(init.statusCode, 200);

  const list = await post(rpc("tools/list"));
  assert.equal(list.statusCode, 200);
  const tools = (JSON.parse(list.body) as { result: { tools: { name: string }[] } }).result.tools;
  assert.ok(tools.some((t) => t.name === "scrape"));
});

test("tools/call without a key still gets the challenge", async () => {
  const response = await post(rpc("tools/call", { name: "scrape", arguments: { url: "https://example.com" } }));
  assert.equal(response.statusCode, 401);
  assert.match(response.headers["www-authenticate"], /^Bearer /);
});

test("a batch is public only when every message is a discovery method", async () => {
  assert.equal((await post([rpc("tools/list"), rpc("tools/call", { name: "scrape", arguments: {} })])).statusCode, 401);
  assert.equal((await post([])).statusCode, 401);
});

test("a GET or an unparsable body without a key gets the challenge", async () => {
  assert.equal((await post(undefined, "GET")).statusCode, 401);
  const garbled = await handler({
    requestContext: { http: { method: "POST" } },
    rawPath: "/mcp",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(garbled.statusCode, 401);
});
