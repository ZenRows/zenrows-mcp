import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ZENROWS_HOME_ENV } from "../src/auth/ensure-key.ts";
import {
  buildExtractParams,
  FALLBACK_AUTOPARSE_NOTE,
  isEmptyData,
  refusalReason,
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

test("runExtract ignores fallback_autoparse: true on AUTH010: one call, the prepare error, and a note", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(AUTH010, { status: 402, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const outcome = await runExtract("testkey", { url: "https://example.com", fallback_autoparse: true }, { fetchImpl });

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(calls.length, 1, "fallback_autoparse must not retry with autoparse");
  assert.doesNotMatch(calls[0]!, /autoparse=true/);
  const body = JSON.parse(outcome.errorText) as {
    code: string;
    reason: string;
    next_tool?: { name: string };
    note?: string;
  };
  assert.equal(body.code, "AUTH010");
  assert.equal(body.reason, "domain_not_prepared");
  assert.equal(body.next_tool?.name, "prepare_domain");
  assert.equal(body.note, FALLBACK_AUTOPARSE_NOTE);
});

const PREPARE_MESSAGE =
  'Extract hasn\'t prepared example.com yet. Call prepare_domain with domain "example.com" and 1 to 5 example URLs ' +
  "(a few minutes, no credits), then retry once prepared_domain_status says ready; meanwhile use mode=css. " +
  "One URL works; we recommend 3 or more of the same page type as this one: add them to example_urls, up to 5.";

test("runExtract reports REQS007 by default with the prepare step, in one call", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ code: "REQS007", detail: "Extract has not been prepared" }), { status: 403 });
  }) as typeof fetch;

  const outcome = await runExtract("testkey", { url: "https://www.example.com/item/1" }, { fetchImpl });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(calls.length, 1, "REQS007 must not be retried with autoparse");
  const body = JSON.parse(outcome.errorText) as {
    code: string;
    message: string;
    next_tool: { name: string; arguments: { domain: string; example_urls: string[] } };
    then: string;
  };
  assert.equal(body.code, "REQS007");
  assert.equal(body.message, PREPARE_MESSAGE);
  assert.deepEqual(body.next_tool, {
    name: "prepare_domain",
    arguments: { domain: "example.com", example_urls: ["https://www.example.com/item/1"] },
  });
  assert.match(body.then, /prepared_domain_status/);
});

/** A REQS007 the way the gateway sends it: with `reason`, or (an older gateway) without. */
function reqs007(kind: "domain" | "page" | "allowlist", withReason: boolean): string {
  const bodies = {
    domain: {
      title: "Extract is not prepared for the requested domain (example.com) (REQS007)",
      detail: "Extract has not been prepared for example.com yet.",
      reason: "domain_not_prepared",
    },
    page: {
      title: "Extract did not recognise this page on example.com (REQS007)",
      detail: "Extract serves example.com, but did not recognise this page as one it can extract.",
      reason: "page_not_recognised",
    },
    allowlist: {
      title: "Extract is not enabled for the requested domain (example.com) (REQS007)",
      detail: "Extract is not enabled for the requested domain (example.com) yet.",
      reason: "domain_not_enabled",
    },
  } as const;
  const { reason, ...rest } = bodies[kind];
  return JSON.stringify({ code: "REQS007", status: 403, ...rest, ...(withReason ? { reason } : {}) });
}

async function reqs007Error(body: string, url = "https://example.com/search?q=x") {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(body, { status: 403 });
  }) as typeof fetch;
  const outcome = await runExtract("testkey", { url }, { fetchImpl });
  assert.equal(outcome.ok, false);
  assert.equal(calls, 1);
  if (outcome.ok) throw new Error("unreachable");
  return {
    raw: outcome.errorText,
    err: JSON.parse(outcome.errorText) as { code: string; reason: string; message: string; next_tool?: unknown },
  };
}

for (const withReason of [true, false]) {
  const via = withReason ? "the reason field" : "the title (gateway without the reason field)";

  test(`REQS007 page_not_recognised, read from ${via}: gateway's advice in order, no prepare_domain`, async () => {
    const { raw, err } = await reqs007Error(reqs007("page", withReason));
    assert.equal(err.code, "REQS007");
    assert.equal(err.reason, "page_not_recognised");
    const steps = [
      /product, article or listing page/,
      /retry it once in a few minutes; do not retry in a loop/,
      /mode=css with a css_extractor/,
      /Preparing the domain again does not change this/,
    ];
    let last = -1;
    for (const step of steps) {
      const at = err.message.search(step);
      assert.ok(at > last, `${step} missing or out of order in: ${err.message}`);
      last = at;
    }
    assert.equal(err.next_tool, undefined, "no prepare_domain: it would answer ready and loop");
    assert.doesNotMatch(raw, /autoparse|contact Zenrows support/);
  });

  test(`REQS007 domain_not_enabled, read from ${via}: no prepare_domain, css`, async () => {
    const { raw, err } = await reqs007Error(reqs007("allowlist", withReason));
    assert.equal(err.reason, "domain_not_enabled");
    assert.match(err.message, /preparing it does not change this/);
    assert.match(err.message, /mode=css/);
    assert.equal(err.next_tool, undefined);
    assert.doesNotMatch(raw, /autoparse/);
  });

  test(`REQS007 domain_not_prepared, read from ${via}: prepare_domain`, async () => {
    const { err } = await reqs007Error(reqs007("domain", withReason), "https://www.example.com/p/1");
    assert.equal(err.reason, "domain_not_prepared");
    assert.deepEqual(err.next_tool, {
      name: "prepare_domain",
      arguments: { domain: "example.com", example_urls: ["https://www.example.com/p/1"] },
    });
  });
}

test("refusalReason trusts the field over the sentence, and ignores a reason it does not know", () => {
  const pageTitleWithDomainReason = JSON.stringify({
    code: "REQS007",
    title: "Extract did not recognise this page on x.com (REQS007)",
    reason: "domain_not_prepared",
  });
  assert.equal(refusalReason(pageTitleWithDomainReason), "domain_not_prepared");
  assert.equal(
    refusalReason(JSON.stringify({ code: "REQS007", reason: "something_new", detail: "Extract serves x.com, but" })),
    "page_not_recognised"
  );
  assert.equal(refusalReason("not json"), "domain_not_prepared");
});

test("runExtract reports legacy AUTH010 by default like REQS007, in one call", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(AUTH010, { status: 402, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const outcome = await runExtract("testkey", { url: "https://example.com" }, { fetchImpl });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(calls, 1);
  const body = JSON.parse(outcome.errorText) as { code: string; message: string };
  assert.equal(body.code, "AUTH010");
  assert.equal(body.message, PREPARE_MESSAGE);
});

test("runExtract does not fall back when fallback_autoparse is false", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(AUTH010, { status: 402, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const outcome = await runExtract("testkey", { url: "https://example.com", fallback_autoparse: false }, { fetchImpl });

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(calls, 1);
  const body = JSON.parse(outcome.errorText) as { code: string; message: string };
  assert.equal(body.code, "AUTH010");
  assert.equal(body.message, PREPARE_MESSAGE);
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
  assert.deepEqual(outcome.data, { title: "T" });
  assert.equal(outcome.html, undefined, "html is returned only with include_html");
});

test("runExtract returns the page html when include_html is true", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ parsed: { title: "T" }, html: "<h1>T</h1>" }), { status: 200 })) as typeof fetch;

  const outcome = await runExtract("testkey", { url: "https://example.com", include_html: true }, { fetchImpl });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
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
    js_render: true,
    premium_proxy: true,
    proxy_country: "us",
    wait_for: ".content",
    wait: 2500,
  });
  assert.equal(sp.get("mode"), null, "forced flags turn Adaptive Stealth Mode off");
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
  assert.equal(sp.get("mode"), "auto");
});

test("buildExtractParams defaults to Adaptive Stealth Mode in every mode", () => {
  for (const mode of ["auto", "autoparse", "css"] as const) {
    const sp = buildExtractParams("k", "https://example.com", mode, { css_extractor: '{"t":"h1"}' });
    assert.equal(sp.get("mode"), "auto", mode);
  }
});

test("buildExtractParams keeps proxy_country alongside Adaptive Stealth Mode", () => {
  const sp = buildExtractParams("k", "https://example.com", "auto", { proxy_country: "de" });
  assert.equal(sp.get("mode"), "auto");
  assert.equal(sp.get("proxy_country"), "DE");
});

test("buildExtractParams: mode_auto=false opts out of Adaptive Stealth Mode", () => {
  const sp = buildExtractParams("k", "https://example.com", "auto", { mode_auto: false });
  assert.equal(sp.get("mode"), null);
});

test("buildExtractParams: premium_proxy alone overrides Adaptive Stealth Mode", () => {
  const sp = buildExtractParams("k", "https://example.com", "auto", { premium_proxy: true, mode_auto: true });
  assert.equal(sp.get("mode"), null);
  assert.equal(sp.get("premium_proxy"), "true");
});

test("runExtract ignores fallback_autoparse: true on REQS007: one call, the prepare error, and a note", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ code: "REQS007", detail: "Extract has not been prepared" }), { status: 403 });
  }) as typeof fetch;

  const outcome = await runExtract("testkey", { url: "https://example.com", fallback_autoparse: true }, { fetchImpl });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(calls.length, 1);
  const body = JSON.parse(outcome.errorText) as {
    code: string;
    reason: string;
    next_tool?: { name: string };
    note?: string;
  };
  assert.equal(body.code, "REQS007");
  assert.equal(body.reason, "domain_not_prepared");
  assert.equal(body.next_tool?.name, "prepare_domain");
  assert.equal(body.note, FALLBACK_AUTOPARSE_NOTE);
});

test("runExtract adds the fallback_autoparse note to a successful result, after one call", async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    return new Response(JSON.stringify({ parsed: { title: "T" } }), { status: 200 });
  }) as typeof fetch;
  const outcome = await runExtract("testkey", { url: "https://example.com", fallback_autoparse: true }, { fetchImpl });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(n, 1);
  assert.deepEqual(outcome.data, { title: "T" });
  assert.equal(outcome.note, FALLBACK_AUTOPARSE_NOTE);
});

test("runExtract appends the fallback_autoparse note as a line to a plain-text error", async () => {
  const fetchImpl = (async () => {
    throw new Error("connection reset");
  }) as typeof fetch;
  const outcome = await runExtract("testkey", { url: "https://example.com", fallback_autoparse: true }, { fetchImpl });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.errorText, /^Network error contacting Zenrows: connection reset\n/);
  assert.ok(outcome.errorText.endsWith(FALLBACK_AUTOPARSE_NOTE));
});

test("runExtract adds no note without fallback_autoparse, or with it false", async () => {
  for (const fallback_autoparse of [undefined, false]) {
    const ok = await runExtract(
      "testkey",
      { url: "https://example.com", fallback_autoparse },
      {
        fetchImpl: (async () =>
          new Response(JSON.stringify({ parsed: { title: "T" } }), { status: 200 })) as typeof fetch,
      }
    );
    assert.equal(ok.ok && ok.note, undefined);
    const failed = await runExtract(
      "testkey",
      { url: "https://example.com", fallback_autoparse },
      {
        fetchImpl: (async () => new Response(JSON.stringify({ code: "REQS007" }), { status: 403 })) as typeof fetch,
      }
    );
    assert.equal(failed.ok, false);
    if (failed.ok) return;
    assert.doesNotMatch(failed.errorText, /fallback_autoparse/);
  }
});

test("runExtract does not fall back on REQS007 when fallback_autoparse is false", async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    return new Response(JSON.stringify({ code: "REQS007", detail: "not prepared" }), { status: 403 });
  }) as typeof fetch;
  const outcome = await runExtract("testkey", { url: "https://example.com", fallback_autoparse: false }, { fetchImpl });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.errorText, /REQS007/);
  assert.equal(n, 1);
});

test("runExtract makes one call in autoparse and css modes too, with fallback_autoparse: true", async () => {
  for (const mode of ["autoparse", "css"] as const) {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return new Response(JSON.stringify({ code: "REQS007" }), { status: 403 });
    }) as typeof fetch;
    const outcome = await runExtract(
      "testkey",
      { url: "https://example.com", mode, css_extractor: '{"t":"h1"}', fallback_autoparse: true },
      { fetchImpl }
    );
    assert.equal(outcome.ok, false, mode);
    assert.equal(n, 1, mode);
  }
});

test("runExtract makes one call on other 403s, with fallback_autoparse: true", async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    return new Response(JSON.stringify({ code: "REQS001", detail: "blocked by policy" }), { status: 403 });
  }) as typeof fetch;
  const outcome = await runExtract("testkey", { url: "https://example.com", fallback_autoparse: true }, { fetchImpl });
  assert.equal(outcome.ok, false);
  assert.equal(n, 1);
});

test("isEmptyData treats an object of empty fields as empty", () => {
  assert.equal(isEmptyData({ listings: [] }), true);
  assert.equal(isEmptyData({ title: "", items: [], meta: {} }), true);
  assert.equal(isEmptyData({ listings: [], total: 0 }), false);
  assert.equal(isEmptyData({ title: "x" }), false);
  assert.equal(isEmptyData({ flag: false }), false);
  assert.equal(isEmptyData({ listings: [{ title: null, price: "" }], author: { name: null } }), true);
  assert.equal(isEmptyData({ listings: [{ title: null }, { title: "A" }] }), false);
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
    new Response("not json at all", {
      status: 200,
      headers: { "content-type": "text/plain" },
    })) as typeof fetch;

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

  await runExtract("k", { url: "https://example.com" }, { fetchImpl, getClientName: () => "cursor" });
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
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
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

const NO_DATA = JSON.stringify({
  code: "no_data_extracted",
  detail: "Extract found no data on this page.",
  status: 422,
});

test("runExtract reports 422 no_data_extracted as an empty result, in one call, without fallback", async () => {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(NO_DATA, { status: 422, headers: { "content-type": "application/problem+json" } });
  }) as typeof fetch;

  const outcome = await runExtract("testkey", { url: "https://example.com" }, { fetchImpl });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(urls.length, 1);
  assert.match(urls[0]!, /extract=auto/);
  assert.equal(outcome.mode, "auto");
  assert.equal(outcome.empty, true);
  assert.equal(outcome.noDataExtracted, true);
  assert.equal(outcome.data, null);
  assert.match(outcome.message ?? "", /no data/i);
});

test("runExtract keeps other 422s as errors", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ code: "RESP001", detail: "Could not get content." }), {
      status: 422,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const outcome = await runExtract("testkey", { url: "https://example.com" }, { fetchImpl });

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal((JSON.parse(outcome.errorText) as { code: string }).code, "RESP001");
});

test("a 422 no_data_extracted in autoparse mode stays an error", async () => {
  const fetchImpl = (async () =>
    new Response(NO_DATA, { status: 422, headers: { "content-type": "application/json" } })) as typeof fetch;

  const outcome = await runExtract("testkey", { url: "https://example.com", mode: "autoparse" }, { fetchImpl });

  assert.equal(outcome.ok, false);
});
