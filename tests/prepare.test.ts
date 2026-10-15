import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ZENROWS_HOME_ENV } from "../src/auth/ensure-key.ts";
import { createServer } from "../src/server.ts";
import {
  failureNextStep,
  normalizeDomain,
  prepareError,
  runPrepareDomain,
  runPreparedDomainStatus,
} from "../src/tools/prepare.ts";

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };

/** A fetch stub that answers by "METHOD path" and records every call. */
function stub(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const path = new URL(url).pathname;
    const route = routes[`${method} ${path}`];
    if (!route) throw new Error(`unexpected ${method} ${path}`);
    return route();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const res = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const problem = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  res(status, { code, detail: `${code} detail`, status, title: code, ...extra });

const BASE = "/v1/extract/prepared-domains";
const RECORD = {
  domain: "example.com",
  status: "preparing",
  state: "received",
  submitted_at: "2026-10-15T09:00:00Z",
  updated_at: "2026-10-15T09:00:00Z",
};
const ALLOWANCE = { used: 3, limit: 10, remaining: 7, month: "2026-10" };

test("normalizeDomain accepts a host or a URL and drops scheme, path and www", () => {
  assert.equal(normalizeDomain("example.com"), "example.com");
  assert.equal(normalizeDomain("https://www.Example.com/p/1?x=1"), "example.com");
  assert.equal(normalizeDomain("shop.example.com"), "shop.example.com");
});

test("prepare_domain posts the domain and example URLs with the key header and returns the 202 record", async () => {
  const { calls, fetchImpl } = stub({ [`POST ${BASE}`]: () => res(202, RECORD) });
  const out = await runPrepareDomain(
    "k",
    { domain: "https://www.example.com/", example_urls: ["https://www.example.com/p/1"], idempotency_key: "abc" },
    { fetchImpl }
  );
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.data.status, "preparing");
  assert.match(String(out.data.next), /prepared_domain_status/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.body, { domain: "example.com", example_urls: ["https://www.example.com/p/1"] });
  assert.equal(calls[0]!.headers["X-API-Key"], "k");
  assert.equal(calls[0]!.headers["Idempotency-Key"], "abc");
  assert.equal(calls[0]!.url, `https://api.zenrows.com${BASE}`);
});

test("prepare_domain on 409 in_progress returns the current status instead of an error", async () => {
  const { calls, fetchImpl } = stub({
    [`POST ${BASE}`]: () => problem(409, "in_progress"),
    [`GET ${BASE}/example.com`]: () => res(200, { ...RECORD, state: "verifying" }),
  });
  const out = await runPrepareDomain(
    "k",
    { domain: "example.com", example_urls: ["https://example.com/p"] },
    { fetchImpl }
  );
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.data.already_in_progress, true);
  assert.equal(out.data.state, "verifying");
  assert.equal(calls.length, 2);
});

test("prepare_domain on 409 in_progress by another account (status 404) says to poll, not resubmit", async () => {
  const { fetchImpl } = stub({
    [`POST ${BASE}`]: () => problem(409, "in_progress"),
    [`GET ${BASE}/example.com`]: () => problem(404, "not_found"),
  });
  const out = await runPrepareDomain(
    "k",
    { domain: "example.com", example_urls: ["https://example.com/p"] },
    { fetchImpl }
  );
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.error.code, "in_progress");
  assert.match(out.error.message, /Do not resubmit/);
});

for (const [status, code, pattern] of [
  [400, "invalid_argument", /1 to 5 full page URLs/],
  [429, "out_of_allowance", /monthly allowance/],
  [503, "overloaded", /Retry in a few minutes; do not loop/],
  [503, "disabled", /Retry in a few minutes; do not loop/],
  [409, "idempotency_conflict", /new key/],
] as const) {
  test(`prepare_domain maps ${status} ${code} to an error with the next step`, async () => {
    const { calls, fetchImpl } = stub({
      [`POST ${BASE}`]: () => problem(status, code, code === "invalid_argument" ? { reason: "invalid_domain" } : {}),
    });
    const out = await runPrepareDomain(
      "k",
      { domain: "example.com", example_urls: ["https://example.com/p"] },
      { fetchImpl }
    );
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.error.code, code);
    assert.equal(out.error.status, status);
    assert.match(out.error.message, pattern);
    assert.equal(calls.length, 1, "errors other than in_progress are not followed by a status call");
  });
}

test("out_of_allowance keeps used / limit / month from the body", () => {
  const e = prepareError(
    429,
    JSON.stringify({ code: "out_of_allowance", used: 10, limit: 10, month: "2026-10" }),
    "x.com"
  );
  assert.equal(e.used, 10);
  assert.equal(e.limit, 10);
  assert.equal(e.month, "2026-10");
});

test("invalid_argument keeps the reason", () => {
  const e = prepareError(400, JSON.stringify({ code: "invalid_argument", reason: "invalid_domain" }), "x");
  assert.equal(e.reason, "invalid_domain");
});

test("a network error is reported, not thrown", async () => {
  const fetchImpl = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  const out = await runPrepareDomain(
    "k",
    { domain: "example.com", example_urls: ["https://example.com/p"] },
    { fetchImpl }
  );
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.error.code, "NETWORK_ERROR");
});

test("prepared_domain_status returns the record, the allowance and the next step while preparing", async () => {
  const { fetchImpl } = stub({
    [`GET ${BASE}/example.com`]: () => res(200, { ...RECORD, state: "preparing" }),
    [`GET ${BASE}/allowance`]: () => res(200, ALLOWANCE),
  });
  const out = await runPreparedDomainStatus("k", "www.example.com", { fetchImpl });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.data.status, "preparing");
  assert.deepEqual(out.data.allowance, ALLOWANCE);
  assert.match(String(out.data.next), /again in about 30 seconds/);
});

test("prepared_domain_status says to call extract once ready", async () => {
  const { fetchImpl } = stub({
    [`GET ${BASE}/example.com`]: () => res(200, { ...RECORD, status: "ready", state: "ready" }),
    [`GET ${BASE}/allowance`]: () => res(200, ALLOWANCE),
  });
  const out = await runPreparedDomainStatus("k", "example.com", { fetchImpl });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.match(String(out.data.next), /call extract again/);
});

test("prepared_domain_status on failed names the step for the failure code", async () => {
  const { fetchImpl } = stub({
    [`GET ${BASE}/example.com`]: () =>
      res(200, {
        ...RECORD,
        status: "failed",
        state: "failed",
        failure: { code: "discovery_failed", detail: "no pages", slot_consumed: false },
      }),
    [`GET ${BASE}/allowance`]: () => res(200, ALLOWANCE),
  });
  const out = await runPreparedDomainStatus("k", "example.com", { fetchImpl });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.data.failure?.code, "discovery_failed");
  assert.match(String(out.data.next), /with example_urls/);
});

test("failureNextStep covers every documented failure code", () => {
  assert.match(failureNextStep("interrupted"), /again with the same/);
  assert.match(failureNextStep("preparation_exhausted"), /again with the same/);
  assert.match(failureNextStep("discovery_failed"), /example_urls/);
  assert.match(failureNextStep("unpreparable"), /different example URLs/);
  assert.match(failureNextStep("preparation_failed"), /other example URLs/);
  assert.match(failureNextStep("verification_failed"), /support/);
  assert.match(failureNextStep("unsupported"), /support/);
});

test("prepared_domain_status still returns the record when the allowance call fails", async () => {
  const { fetchImpl } = stub({
    [`GET ${BASE}/example.com`]: () => res(200, RECORD),
    [`GET ${BASE}/allowance`]: () => problem(503, "overloaded"),
  });
  const out = await runPreparedDomainStatus("k", "example.com", { fetchImpl });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.data.allowance, undefined);
});

test("prepared_domain_status on 404 says to call prepare_domain", async () => {
  const { fetchImpl } = stub({
    [`GET ${BASE}/example.com`]: () => problem(404, "not_found"),
    [`GET ${BASE}/allowance`]: () => res(200, ALLOWANCE),
  });
  const out = await runPreparedDomainStatus("k", "example.com", { fetchImpl });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.error.code, "not_found");
  assert.match(out.error.message, /Call prepare_domain/);
  assert.deepEqual(out.error.allowance, ALLOWANCE);
});

function isolateHome(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "zr-mcp-prepare-"));
  const saved = process.env[ZENROWS_HOME_ENV];
  process.env[ZENROWS_HOME_ENV] = home;
  t.after(() => {
    if (saved === undefined) delete process.env[ZENROWS_HOME_ENV];
    else process.env[ZENROWS_HOME_ENV] = saved;
    rmSync(home, { recursive: true, force: true });
  });
}

test("the server lists prepare_domain and prepared_domain_status, and calls them end to end", async (t) => {
  isolateHome(t);
  const { calls, fetchImpl } = stub({
    [`POST ${BASE}`]: () => res(202, RECORD),
    [`GET ${BASE}/example.com`]: () => res(200, RECORD),
    [`GET ${BASE}/allowance`]: () => res(200, ALLOWANCE),
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const server = createServer("k", undefined, { hosted: false });
  const client = new Client({ name: "prepare-test", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(() => client.close());

  const names = (await client.listTools()).tools.map((x) => x.name);
  assert.ok(names.includes("prepare_domain"));
  assert.ok(names.includes("prepared_domain_status"));

  const prepared = (await client.callTool({
    name: "prepare_domain",
    arguments: { domain: "example.com", example_urls: ["https://example.com/p/1"] },
  })) as { isError?: boolean; content: { text: string }[] };
  assert.notEqual(prepared.isError, true);
  assert.equal(JSON.parse(prepared.content[0]!.text).status, "preparing");

  const tooMany = (await client.callTool({
    name: "prepare_domain",
    arguments: { domain: "example.com", example_urls: Array.from({ length: 6 }, (_, i) => `https://example.com/${i}`) },
  })) as { isError?: boolean };
  assert.equal(tooMany.isError, true, "more than 5 example URLs is rejected before any request");

  const status = (await client.callTool({ name: "prepared_domain_status", arguments: { domain: "example.com" } })) as {
    content: { text: string }[];
  };
  assert.deepEqual(JSON.parse(status.content[0]!.text).allowance, ALLOWANCE);
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
});
