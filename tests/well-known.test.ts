import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * What this resource tells a client before the client trusts it with anything.
 *
 * These documents are the only machine-readable answer to "what am I granting?".
 * `scopes_supported` shipped as `[]`, which a least-privilege client reads as "this
 * resource has no scopes" rather than "nobody wrote them down", and the
 * authorization-server document omitted the field entirely. Both now name the one
 * scope the token really carries.
 *
 * Setting AWS_LAMBDA_FUNCTION_NAME before the import keeps src/http.ts from opening
 * a listener: the module starts a dev server when it thinks it is not on Lambda.
 */
process.env.AWS_LAMBDA_FUNCTION_NAME = "test";

const { handler } = await import("../src/http.ts");

async function get(path: string) {
  const response = await handler({
    requestContext: { http: { method: "GET" } },
    rawPath: path,
    headers: {},
  });

  return { ...response, json: JSON.parse(response.body) as Record<string, unknown> };
}

test("the protected resource names the scope the token grants", async () => {
  const { statusCode, json } = await get("/.well-known/oauth-protected-resource");

  assert.equal(statusCode, 200);
  assert.deepEqual(json.scopes_supported, ["api"]);
  assert.equal(json.resource_documentation, "https://docs.zenrows.com");
});

test("an empty scope list is never published", async () => {
  // The regression this file exists for: `[]` is a claim, and the wrong one.
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server"]) {
    const { json } = await get(path);
    const scopes = json.scopes_supported as string[] | undefined;

    assert.ok(Array.isArray(scopes), `${path} declares no scopes at all`);
    assert.ok(scopes.length > 0, `${path} declares an empty scope list`);
  }
});

test("the authorization server agrees with the resource", async () => {
  const resource = await get("/.well-known/oauth-protected-resource");
  const server = await get("/.well-known/oauth-authorization-server");

  assert.deepEqual(server.json.scopes_supported, resource.json.scopes_supported);
});

test("the challenge on an unauthenticated call names the scope", async () => {
  const response = await handler({
    requestContext: { http: { method: "POST" } },
    rawPath: "/mcp",
    headers: {},
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

  assert.equal(response.statusCode, 401);

  const challenge = response.headers["www-authenticate"];
  assert.match(challenge, /scope="api"/);
  assert.match(challenge, /resource_metadata="https:\/\/mcp\.zenrows\.com/);
});
