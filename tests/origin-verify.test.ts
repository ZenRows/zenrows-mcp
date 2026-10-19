import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

/**
 * The hosting edge stamps X-Origin-Verify; with MCP_ORIGIN_SECRET set, anything without the
 * right value is refused before routing, well-known documents included.
 */

const { handler, _setRequestLogSink } = await import("../src/http.ts");

const SECRET = "origin-secret-value-123";
let lines: string[] = [];
_setRequestLogSink((l) => lines.push(l));

afterEach(() => {
  delete process.env.MCP_ORIGIN_SECRET;
  lines = [];
});

function get(path: string, headers: Record<string, string> = {}) {
  return handler({ requestContext: { http: { method: "GET" } }, rawPath: path, headers });
}

test("no secret configured: requests pass without the header", async () => {
  const res = await get("/.well-known/oauth-protected-resource");
  assert.equal(res.statusCode, 200);
});

test("secret configured: missing or wrong header is 403, before any route", async () => {
  process.env.MCP_ORIGIN_SECRET = SECRET;
  for (const headers of [{}, { "x-origin-verify": "wrong" }, { "x-origin-verify": SECRET + "x" }]) {
    assert.equal((await get("/.well-known/oauth-protected-resource", headers)).statusCode, 403);
    assert.equal((await get("/health", headers)).statusCode, 403);
  }
  const l = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(l.origin_verified, false);
  assert.equal(l.status, 403);
});

test("secret configured: matching header passes and the log never holds the secret", async () => {
  process.env.MCP_ORIGIN_SECRET = SECRET;
  const res = await get("/.well-known/oauth-protected-resource", { "x-origin-verify": SECRET });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(lines[0]).origin_verified, true);
  assert.ok(!lines.join("").includes(SECRET));
});
