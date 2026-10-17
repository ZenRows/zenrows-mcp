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
 */

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
  // The docs root 308s to a welcome page; this is the MCP page itself.
  assert.equal(json.resource_documentation, "https://docs.zenrows.com/mcp/overview");
});

test("bearer methods are the RFC 6750 ones the server really reads", async () => {
  // "query" in RFC 6750 is ?access_token=, which /mcp never reads (it reads ?apikey=).
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const { json } = await get(path);
    assert.deepEqual(json.bearer_methods_supported, ["header"], path);
  }
});

test("each protected resource document names the resource its URL was built from", async () => {
  // RFC 9728 §3.3: a client must discard a document whose `resource` differs.
  const root = await get("/.well-known/oauth-protected-resource");
  assert.equal(root.statusCode, 200);
  assert.equal(root.json.resource, "https://mcp.zenrows.com");

  const endpoint = await get("/.well-known/oauth-protected-resource/mcp");
  assert.equal(endpoint.statusCode, 200);
  assert.equal(endpoint.json.resource, "https://mcp.zenrows.com/mcp");

  const { resource: _root, ...rootRest } = root.json;
  const { resource: _endpoint, ...endpointRest } = endpoint.json;
  assert.deepEqual(endpointRest, rootRest);
});

test("the key is read from a Bearer header and ?apikey=, never ?access_token=", async () => {
  // tools/call, because discovery methods such as initialize are answered without a key.
  const toolCall = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "no_such_tool", arguments: {} },
  });
  const call = (headers: Record<string, string>, rawQueryString?: string) =>
    handler({
      requestContext: { http: { method: "POST" } },
      rawPath: "/mcp",
      rawQueryString,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: toolCall,
    });

  assert.equal((await call({ authorization: "Bearer test-key" })).statusCode, 200);
  assert.equal((await call({}, "apikey=test-key")).statusCode, 200);
  assert.equal((await call({}, "access_token=test-key")).statusCode, 401);
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
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "scrape", arguments: {} } }),
  });

  assert.equal(response.statusCode, 401);

  const challenge = response.headers["www-authenticate"];
  assert.match(challenge, /scope="api"/);

  // RFC 9728 §3.3: the document the challenge points at must name the URL just called.
  const metadataUrl = new URL(challenge.match(/resource_metadata="([^"]+)"/)![1]);
  assert.equal(metadataUrl.origin, "https://mcp.zenrows.com");
  const { json } = await get(metadataUrl.pathname);
  assert.equal(json.resource, "https://mcp.zenrows.com/mcp");
  assert.equal(response.headers.link, `<${metadataUrl.href}>; rel="oauth-protected-resource"`);
});
