import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * GET /mcp asks for a server-to-client event stream. The hosted server has none, and an
 * empty 200 stream makes clients reconnect in a tight loop, so it answers 405 (what the
 * spec prescribes and the SDK client treats as "no stream"). Auth still comes first, so a
 * client that starts with GET still learns how to authenticate.
 */

const { handler } = await import("../src/http.ts");

function call(method: string, headers: Record<string, string> = {}, body?: string) {
  return handler({ requestContext: { http: { method } }, rawPath: "/mcp", headers, body });
}

const SSE = { accept: "application/json, text/event-stream" };

test("authenticated GET is 405 with Allow: POST", async () => {
  const res = await call("GET", { ...SSE, authorization: "Bearer test-key" });
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers?.allow ?? res.headers?.Allow, "POST");
});

test("unauthenticated GET is still the 401 challenge", async () => {
  const res = await call("GET", SSE);
  assert.equal(res.statusCode, 401);
});

test("POST is unaffected", async () => {
  const res = await call(
    "POST",
    { ...SSE, "content-type": "application/json", authorization: "Bearer test-key" },
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  );
  assert.equal(res.statusCode, 200);
});
