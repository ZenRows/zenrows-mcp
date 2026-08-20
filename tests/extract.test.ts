import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ZENROWS_HOME_ENV } from "../src/auth/ensure-key.ts";
import {
  buildExtractParams,
  registerExtractTool,
  runExtract,
  zrErrorCode,
} from "../src/tools/extract.ts";

/** Minimal stand-in for McpServer#registerTool — captures the handler so we can call it directly. */
function fakeServer() {
  let handler: ((params: unknown) => Promise<unknown>) | undefined;
  return {
    server: {
      registerTool: (_name: string, _config: unknown, h: typeof handler) => {
        handler = h;
      },
    },
    call: (params: unknown) => {
      assert.ok(handler, "registerExtractTool never called server.registerTool");
      return handler!(params);
    },
  };
}

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

test("buildExtractParams sets css_extractor for mode css", () => {
  const sp = buildExtractParams("k", "https://example.com", "css", {
    css_extractor: '{"title":"h1"}',
  });
  assert.equal(sp.get("css_extractor"), '{"title":"h1"}');
  assert.equal(sp.get("extract"), null);
  assert.equal(sp.get("autoparse"), null);
});

test("buildExtractParams omits css_extractor for mode css when it's missing", () => {
  const sp = buildExtractParams("k", "https://example.com", "css", {});
  assert.equal(sp.get("css_extractor"), null);
});

test("buildExtractParams wires every stealth option, uppercasing proxy_country", () => {
  const sp = buildExtractParams("k", "https://example.com", "auto", {
    mode_auto: true,
    js_render: true,
    premium_proxy: true,
    proxy_country: "us",
    wait_for: ".content",
    wait: 2500,
  });
  assert.equal(sp.get("mode"), "auto");
  assert.equal(sp.get("js_render"), "true");
  assert.equal(sp.get("premium_proxy"), "true");
  assert.equal(sp.get("proxy_country"), "US");
  assert.equal(sp.get("wait_for"), ".content");
  assert.equal(sp.get("wait"), "2500");
});

test("buildExtractParams leaves falsy/undefined stealth options unset", () => {
  const sp = buildExtractParams("k", "https://example.com", "auto", {
    js_render: false,
    premium_proxy: false,
    wait: undefined,
  });
  assert.equal(sp.get("js_render"), null);
  assert.equal(sp.get("premium_proxy"), null);
  assert.equal(sp.get("wait"), null);
});

test("buildExtractParams keeps wait=0 (a valid explicit value, not falsy-omitted)", () => {
  const sp = buildExtractParams("k", "https://example.com", "auto", { wait: 0 });
  assert.equal(sp.get("wait"), "0");
});

test("runExtract surfaces a network error as the raw message, not double-JSON-wrapped", async () => {
  const fetchImpl = (async () => {
    throw new TypeError("fetch failed: getaddrinfo ENOTFOUND");
  }) as typeof fetch;

  const outcome = await runExtract("k", { url: "https://example.com" }, { fetchImpl });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.errorText, /Network error contacting Zenrows/);
  assert.match(outcome.errorText, /ENOTFOUND/);
  // Unlike the JSON-wrapped upstream-error case, this must NOT be JSON — it's status 0.
  assert.throws(() => JSON.parse(outcome.errorText));
});

test("runExtract treats a 200 response with a non-JSON body as empty, not a crash", async () => {
  const fetchImpl = (async () =>
    new Response("not json at all", { status: 200, headers: { "content-type": "text/plain" } })) as typeof fetch;

  const outcome = await runExtract("k", { url: "https://example.com" }, { fetchImpl });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.empty, true);
  assert.equal(outcome.data, null);
  assert.equal(outcome.raw, "not json at all");
});

test("runExtract passes the caller's MCP client name through as a request header", async () => {
  let sentHeader: string | null = null;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sentHeader = (init?.headers as Record<string, string>)["x-mcp-client-name"] ?? null;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  await runExtract(
    "k",
    { url: "https://example.com" },
    { fetchImpl, getClientName: () => "cursor" }
  );
  assert.equal(sentHeader, "cursor");
});

test("runExtract omits the client-name header entirely when there is none", async () => {
  let sawHeader = true;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sawHeader = "x-mcp-client-name" in (init?.headers as Record<string, string>);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  await runExtract("k", { url: "https://example.com" }, { fetchImpl });
  assert.equal(sawHeader, false);
});

test("runExtract treats a non-empty auto-mode envelope without a 'parsed' key as ordinary data (empty=false)", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ foo: "bar" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const outcome = await runExtract("k", { url: "https://example.com" }, { fetchImpl });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.data, { foo: "bar" });
  assert.equal(outcome.empty, false);
});

test("runExtract treats an empty object/array/string result as empty", async () => {
  const cases: Array<[string, boolean]> = [
    [JSON.stringify({}), true],
    [JSON.stringify([]), true],
    [JSON.stringify(""), true],
    [JSON.stringify([{ a: 1 }]), false],
  ];

  for (const [body, expectEmpty] of cases) {
    const fetchImpl = (async () =>
      new Response(body, { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const outcome = await runExtract("k", { url: "https://example.com" }, { fetchImpl });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) continue;
    assert.equal(outcome.empty, expectEmpty, `expected empty=${expectEmpty} for body ${body}`);
  }
});

test("registerExtractTool's handler formats a success outcome as non-error JSON content", async (t) => {
  // No account file present -> appendClaimHint is a no-op passthrough, so err()'s output is
  // deterministic in CI regardless of any real local account state.
  const home = mkdtempSync(join(tmpdir(), "zr-mcp-extract-"));
  const saved = process.env[ZENROWS_HOME_ENV];
  process.env[ZENROWS_HOME_ENV] = home;
  t.after(() => {
    if (saved === undefined) delete process.env[ZENROWS_HOME_ENV];
    else process.env[ZENROWS_HOME_ENV] = saved;
    rmSync(home, { recursive: true, force: true });
  });

  const { server, call } = fakeServer() as any;
  registerExtractTool(server, "k", () => undefined);

  const fetchImpl = (async () =>
    new Response(JSON.stringify({ title: "T" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  // registerExtractTool doesn't take a fetchImpl itself — it always uses the global fetch inside
  // runExtract. Stub the global so the handler's real code path (not a re-implementation) runs.
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const result = (await call({ url: "https://example.com" })) as {
    isError?: true;
    content: { type: "text"; text: string }[];
  };

  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0]!.text);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.data, { title: "T" });
});

test("registerExtractTool's handler formats a failure outcome as isError content, unchanged when no account claim hint applies", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "zr-mcp-extract-"));
  const saved = process.env[ZENROWS_HOME_ENV];
  process.env[ZENROWS_HOME_ENV] = home;
  t.after(() => {
    if (saved === undefined) delete process.env[ZENROWS_HOME_ENV];
    else process.env[ZENROWS_HOME_ENV] = saved;
    rmSync(home, { recursive: true, force: true });
  });

  const { server, call } = fakeServer() as any;
  registerExtractTool(server, "k", () => undefined);

  // mode=css with no css_extractor fails validation before any network call — deterministic.
  const result = (await call({ url: "https://example.com", mode: "css" })) as {
    isError?: true;
    content: { type: "text"; text: string }[];
  };

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]!.text);
  assert.equal(payload.code, "INVALID_USAGE");
});
