import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildExtractParams,
  runExtract,
  zrErrorCode,
} from "../src/tools/extract.ts";

const AUTH010 = JSON.stringify({
  code: "AUTH010",
  title: "Feature is not included in plan (AUTH010)",
});

const AUTH004 = JSON.stringify({
  code: "AUTH004",
  title: "Concurrency limit reached (AUTH004)",
});

test("buildExtractParams sets extract=auto for mode auto", () => {
  const sp = buildExtractParams("k", "https://example.com", "auto", {});
  assert.equal(sp.get("extract"), "auto");
  assert.equal(sp.get("autoparse"), null);
});

test("buildExtractParams sets autoparse for mode autoparse", () => {
  const sp = buildExtractParams("k", "https://example.com", "autoparse", {});
  assert.equal(sp.get("autoparse"), "true");
  assert.equal(sp.get("extract"), null);
});

test("zrErrorCode reads code field and AUTH from error string", () => {
  assert.equal(zrErrorCode(AUTH010), "AUTH010");
  assert.equal(zrErrorCode(JSON.stringify({ error: "nope (AUTH004)" })), "AUTH004");
});

test("runExtract falls back to autoparse on AUTH010 for mode=auto", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("extract=auto")) {
      return new Response(AUTH010, { status: 402, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ title: "fallback" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const outcome = await runExtract(
    "testkey",
    { url: "https://example.com" },
    { fetchImpl }
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.mode, "autoparse");
  assert.equal(outcome.fellBackToAutoparse, true);
  assert.deepEqual(outcome.data, { title: "fallback" });
  assert.equal(calls.length, 2);
  assert.match(calls[0]!, /extract=auto/);
  assert.match(calls[1]!, /autoparse=true/);
  assert.doesNotMatch(calls[1]!, /extract=auto/);
});

test("runExtract does not fall back when fallback_autoparse is false", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(AUTH010, { status: 402, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const outcome = await runExtract(
    "testkey",
    { url: "https://example.com", fallback_autoparse: false },
    { fetchImpl }
  );

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(calls, 1);
  const body = JSON.parse(outcome.errorText) as { code: string; mode: string };
  assert.equal(body.code, "AUTH010");
  assert.equal(body.mode, "auto");
});

test("runExtract does not fall back on AUTH004", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(AUTH004, { status: 402, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const outcome = await runExtract("testkey", { url: "https://example.com" }, { fetchImpl });
  assert.equal(outcome.ok, false);
  assert.equal(calls, 1);
  if (outcome.ok) return;
  assert.equal(JSON.parse(outcome.errorText).code, "AUTH004");
});

test("runExtract surfaces autoparse failure after AUTH010 fallback", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("extract=auto")) {
      return new Response(AUTH010, { status: 402, headers: { "content-type": "application/json" } });
    }
    return new Response("upstream boom", { status: 500, headers: { "content-type": "text/plain" } });
  }) as typeof fetch;

  const outcome = await runExtract("testkey", { url: "https://example.com" }, { fetchImpl });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  const body = JSON.parse(outcome.errorText) as { code: string; mode: string };
  assert.equal(body.code, "EXTRACT_FAILED");
  assert.equal(body.mode, "autoparse");
});

test("runExtract unwraps extract=auto {parsed,html} envelope", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ parsed: { title: "T" }, html: "<h1>T</h1>" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const outcome = await runExtract("testkey", { url: "https://example.com" }, { fetchImpl });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.mode, "auto");
  assert.equal(outcome.fellBackToAutoparse, false);
  assert.deepEqual(outcome.data, { title: "T" });
  assert.equal(outcome.html, "<h1>T</h1>");
});

test("runExtract mode=css requires css_extractor", async () => {
  const outcome = await runExtract("k", { url: "https://example.com", mode: "css" });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(JSON.parse(outcome.errorText).code, "INVALID_USAGE");
});
