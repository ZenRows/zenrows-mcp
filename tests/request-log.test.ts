import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

/**
 * The hosted server writes one JSON line per request. It must say what was asked and
 * how it went, and must never carry the key, the caller's IP, or tool arguments.
 * AWS_LAMBDA_FUNCTION_NAME keeps src/http.ts from starting its dev listener.
 */
process.env.AWS_LAMBDA_FUNCTION_NAME = "test";

const { handler, _setRequestLogSink } = await import("../src/http.ts");

let lines: string[] = [];
_setRequestLogSink((l) => lines.push(l));
beforeEach(() => {
  lines = [];
});

const KEY = "zr_secret_0123456789abcdef";

function post(body: unknown, opts: { headers?: Record<string, string>; query?: string } = {}) {
  return handler({
    requestContext: { http: { method: "POST" } },
    rawPath: "/mcp",
    rawQueryString: opts.query,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": "test-agent/1.0",
      "x-forwarded-for": "203.0.113.7",
      ...opts.headers,
    },
    body: JSON.stringify(body),
  });
}

function only(): Record<string, unknown> {
  assert.equal(lines.length, 1, "exactly one log line per request");
  return JSON.parse(lines[0]) as Record<string, unknown>;
}

test("initialize logs method, clientInfo, status and no auth", async () => {
  const res = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "0.1.0" } },
  });
  const l = only();
  assert.deepEqual(l.rpc_methods, ["initialize"]);
  assert.equal(l.client_name, "claude-ai");
  assert.equal(l.client_version, "0.1.0");
  assert.equal(l.authenticated, false);
  assert.equal(l.auth_kind, "none");
  assert.equal(l.status, res.statusCode);
  assert.equal(l.user_agent, "test-agent/1.0");
  assert.equal(typeof l.duration_ms, "number");
  assert.ok(!lines[0].includes("203.0.113.7"), "no IP");
});

// An unknown tool name keeps the test offline: the server rejects it without calling the API.
const scrapeCall = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "no_such_tool", arguments: { url: "https://target.example/private-page" } },
};

test("tools/call with a bearer key logs the tool but never the key or arguments", async () => {
  await post(scrapeCall, { headers: { authorization: `Bearer ${KEY}` } });
  const l = only();
  assert.deepEqual(l.rpc_methods, ["tools/call"]);
  assert.deepEqual(l.tool, ["no_such_tool"]);
  assert.equal(l.authenticated, true);
  assert.equal(l.auth_kind, "bearer");
  assert.ok(!lines[0].includes(KEY.slice(0, 8)), "no part of the key");
  assert.ok(!lines[0].includes("target.example"), "no tool arguments");
});

test("a ?apikey= key is logged as query auth without the key or query string", async () => {
  await post(scrapeCall, { query: `apikey=${KEY}` });
  const l = only();
  assert.equal(l.auth_kind, "query");
  assert.equal(l.path, "/mcp");
  assert.ok(!lines[0].includes(KEY.slice(0, 8)), "no part of the key");
});

test("an unauthenticated tools/call logs its 401", async () => {
  await post(scrapeCall);
  const l = only();
  assert.equal(l.status, 401);
  assert.equal(l.authenticated, false);
});
