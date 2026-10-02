import { test } from "node:test";
import assert from "node:assert/strict";
import { appendClaimHint, KEY_CAP_NUDGE } from "../src/auth/claim-hint.ts";
import { browserError, browserFetch } from "../src/tools/browser-fetch.ts";

const AUTH014 = JSON.stringify({
  code: "AUTH014",
  detail: "This API key has reached its daily cap of 200 credits. The cap resets on 2026-10-03 at 00:00 UTC.",
  status: 402,
  title: "API key credit cap reached (AUTH014)",
});

test("browserFetch parses application/problem+json so a key-cap 402 keeps its code and detail", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(AUTH014, { status: 402, headers: { "content-type": "application/problem+json" } })) as typeof fetch;
  try {
    const result = await browserFetch("POST", "/browser/sessions", "k", "https://example.test");
    assert.equal(result.ok, false);
    const msg = browserError(result);
    assert.match(msg, /AUTH014/);
    assert.match(msg, /resets on 2026-10-03/);
    const text = appendClaimHint(`Failed to create session: ${msg}`);
    assert.ok(text.includes(KEY_CAP_NUDGE));
    assert.doesNotMatch(text, /Claim your Free account/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("browserError surfaces a non-JSON error body instead of a bare status", () => {
  assert.equal(browserError({ ok: false, status: 502, data: "Bad Gateway" }), "HTTP 502: Bad Gateway");
  assert.equal(browserError({ ok: false, status: 500, data: "" }), "HTTP 500");
});
