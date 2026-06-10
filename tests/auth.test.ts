import { test } from "node:test";
import assert from "node:assert/strict";
import { BROWSER_SCOPES, clearIntrospectionCache, guardScopes, scrapeScopes } from "../src/auth.ts";

type FetchResponse = { ok: boolean; json: () => Promise<unknown> };

function stubFetch(response: FetchResponse | (() => never)): void {
  globalThis.fetch = (async () => {
    if (typeof response === "function") return response();
    return response;
  }) as typeof fetch;
}

function withScopes(scopes: string[]): FetchResponse {
  return { ok: true, json: async () => ({ data: { scopes } }) };
}

const LEGACY_KEY_401: FetchResponse = { ok: false, json: async () => ({}) };

test("legacy (non-agent) keys are not scope-gated", async () => {
  clearIntrospectionCache();
  stubFetch(LEGACY_KEY_401);
  assert.equal(await guardScopes("legacy-key-1", BROWSER_SCOPES), null);
});

test("scoped credential with the required scope is allowed", async () => {
  clearIntrospectionCache();
  stubFetch(withScopes(["scrape:write", "browser:session_write"]));
  assert.equal(await guardScopes("agent-key-1", BROWSER_SCOPES), null);
});

test("scoped credential missing a scope is denied with a helpful message", async () => {
  clearIntrospectionCache();
  stubFetch(withScopes(["scrape:write"]));
  const denial = await guardScopes("agent-key-2", BROWSER_SCOPES);
  assert.ok(denial);
  assert.match(denial!, /insufficient_scope/);
  assert.match(denial!, /browser:session_write/);
});

test("introspection outage fails open to pass-through", async () => {
  clearIntrospectionCache();
  stubFetch(() => {
    throw new Error("network down");
  });
  assert.equal(await guardScopes("agent-key-3", ["scrape:write"]), null);
});

test("scrapeScopes requires extract:json only for structured extraction", () => {
  assert.deepEqual(scrapeScopes({}), ["scrape:write"]);
  assert.deepEqual(scrapeScopes({ autoparse: true }), ["scrape:write", "extract:json"]);
  assert.deepEqual(scrapeScopes({ css_extractor: '{"t":"h1"}' }), ["scrape:write", "extract:json"]);
});
