import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FETCH_RETRIES_ENV,
  FETCH_RETRY_BUDGET_MS,
  abortableSleep,
  failedBeforeSend,
  fetchWithRetry,
  fullJitterMs,
  retriesFromEnv,
  retryAfterHeaderMs,
} from "../src/retry.ts";
import { runExtract } from "../src/tools/extract.ts";

type Step = number | Error | { status: number; retryAfter?: string; body?: string };

/** A fetch that answers from a script of statuses (or thrown errors) and records each call. */
function scripted(...steps: Step[]) {
  const calls: number[] = [];
  const fetchImpl = (async () => {
    const step = steps[Math.min(calls.length, steps.length - 1)];
    calls.push(calls.length);
    if (step instanceof Error) throw step;
    if (typeof step === "number") return new Response(step === 200 ? '{"title":"x"}' : "busy", { status: step });
    const headers: Record<string, string> = step.retryAfter === undefined ? {} : { "retry-after": step.retryAfter };
    return new Response(step.body ?? "busy", { status: step.status, headers });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function recordingSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

const quiet = { log: () => undefined };

/** The error shape undici gives for a failed connection: TypeError('fetch failed') with a coded cause. */
function fetchFailed(code: string, syscall?: string): TypeError {
  const cause = Object.assign(new Error(code), syscall === undefined ? { code } : { code, syscall });
  return new TypeError("fetch failed", { cause });
}

/**
 * The shape for a failed happy-eyeballs connect: one error per address tried, wrapped in
 * an AggregateError that, as in Node, carries the first error's code.
 */
function happyEyeballsFailed(...inner: Array<[code: string, syscall: string]>): TypeError {
  const errors = inner.map(([code, syscall]) => Object.assign(new Error(code), { code, syscall }));
  const cause = Object.assign(new AggregateError(errors), errors.length ? { code: errors[0].code } : {});
  return new TypeError("fetch failed", { cause });
}

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` };
}

function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((r) => server.close(() => r()));
}

// ─── Retry-After and jitter (conformance vectors) ────────────────────────────

test("Retry-After conformance vectors: whole seconds clamped to [250 ms, 30 s], anything else is jitter", async () => {
  const vectors: Array<[string, number | undefined]> = [
    ["5", 5_000],
    ["0", 250],
    [" 7 ", 7_000],
    ["99999", 30_000],
    ["1.5", undefined],
    ["-1", undefined],
    ["1e3", undefined],
    ["0x10", undefined],
    ["", undefined],
    ["abc", undefined],
    ["Wed, 21 Oct 2026 07:28:00 GMT", undefined],
  ];
  for (const [header, expected] of vectors) {
    assert.equal(retryAfterHeaderMs(header), expected, `parse ${JSON.stringify(header)}`);
    // Through the retry loop: random() = 1 makes the first jitter wait exactly 1000 ms.
    const { fetchImpl } = scripted({ status: 503, retryAfter: header }, 200);
    const { waits, sleep } = recordingSleep();
    await fetchWithRetry(() => fetchImpl("u"), { sleep, random: () => 1, ...quiet });
    assert.deepEqual(waits, [expected ?? 1_000], `wait for ${JSON.stringify(header)}`);
  }
});

test("jitter conformance vectors: [250 ms, max(250 ms, min(maxWait, 1 s x 2^attempt))]", () => {
  const vectors: Array<[attempt: number, maxWaitMs: number, low: number, high: number]> = [
    [0, 30_000, 250, 1_000],
    [1, 30_000, 250, 2_000],
    [2, 30_000, 250, 4_000],
    [5, 30_000, 250, 30_000],
    [9, 30_000, 250, 30_000],
    [4, 5_000, 250, 5_000],
    [0, 100, 250, 250],
    [6, 100, 250, 250],
  ];
  for (const [attempt, maxWaitMs, low, high] of vectors) {
    assert.equal(
      fullJitterMs(attempt, () => 0, maxWaitMs),
      low,
      `attempt ${attempt} max ${maxWaitMs} low`
    );
    assert.equal(
      fullJitterMs(attempt, () => 1, maxWaitMs),
      high,
      `attempt ${attempt} max ${maxWaitMs} high`
    );
  }
  for (let i = 0; i < 200; i++) {
    const d = fullJitterMs(1);
    assert.ok(d >= 250 && d <= 2_000, String(d));
  }
});

// ─── Which statuses and errors are retried ───────────────────────────────────

test("429, 502, 503 and 504 are retried twice by default", async () => {
  for (const status of [429, 502, 503, 504]) {
    const { fetchImpl, calls } = scripted(status);
    const { waits, sleep } = recordingSleep();
    const res = await fetchWithRetry(() => fetchImpl("u"), { sleep, random: () => 0.5, ...quiet });
    assert.equal(res.status, status);
    assert.equal(calls.length, 3, `status ${status}`);
    assert.deepEqual(waits, [625, 1125]);
  }
});

test("a retry that succeeds returns the success", async () => {
  const { fetchImpl, calls } = scripted(502, 200);
  const res = await fetchWithRetry(() => fetchImpl("u"), { sleep: recordingSleep().sleep, ...quiet });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
});

test("400, 401, 402, 403, 404, 422 and 500 are never retried", async () => {
  const steps: Step[] = [400, 401, 402, 403, 404, 500, { status: 422, body: '{"code":"no_data_extracted"}' }];
  steps.push({ status: 422, body: '{"code":"RESP001"}' });
  for (const step of steps) {
    const { fetchImpl, calls } = scripted(step);
    const { waits, sleep } = recordingSleep();
    await fetchWithRetry(() => fetchImpl("u"), { sleep, ...quiet });
    assert.equal(calls.length, 1, `${JSON.stringify(step)} was retried`);
    assert.deepEqual(waits, []);
  }
});

test("only a connection that failed before sending is retried", async () => {
  for (const code of [
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
  ]) {
    assert.equal(failedBeforeSend(fetchFailed(code)), true, code);
    const { fetchImpl, calls } = scripted(fetchFailed(code), 200);
    const res = await fetchWithRetry(() => fetchImpl("u"), { sleep: recordingSleep().sleep, ...quiet });
    assert.equal(res.status, 200, code);
    assert.equal(calls.length, 2, code);
  }
  const final: Error[] = [
    fetchFailed("UND_ERR_SOCKET"),
    fetchFailed("ECONNRESET"),
    fetchFailed("UND_ERR_HEADERS_TIMEOUT"),
    fetchFailed("UND_ERR_BODY_TIMEOUT"),
    new TypeError("fetch failed"),
    new DOMException("This operation was aborted", "AbortError"),
    new DOMException("The operation timed out", "TimeoutError"),
  ];
  for (const error of final) {
    assert.equal(failedBeforeSend(error), false, error.message);
    const { fetchImpl, calls } = scripted(error, 200);
    await assert.rejects(
      fetchWithRetry(() => fetchImpl("u"), { sleep: recordingSleep().sleep, ...quiet }),
      error
    );
    assert.equal(calls.length, 1, `${(error as { cause?: { code?: string } }).cause?.code ?? error.name} was retried`);
  }
});

test("a connect timeout on every address family is retried; any other mix is not", async () => {
  const retried: Array<[string, TypeError]> = [
    ["refused x2", happyEyeballsFailed(["ECONNREFUSED", "connect"], ["ECONNREFUSED", "connect"])],
    ["connect timeout x2", happyEyeballsFailed(["ETIMEDOUT", "connect"], ["ETIMEDOUT", "connect"])],
    ["refused + connect timeout", happyEyeballsFailed(["ECONNREFUSED", "connect"], ["ETIMEDOUT", "connect"])],
    ["single connect timeout", fetchFailed("ETIMEDOUT", "connect")],
  ];
  for (const [name, error] of retried) {
    assert.equal(failedBeforeSend(error), true, name);
    const { fetchImpl, calls } = scripted(error, 200);
    const res = await fetchWithRetry(() => fetchImpl("u"), { sleep: recordingSleep().sleep, ...quiet });
    assert.equal(res.status, 200, name);
    assert.equal(calls.length, 2, name);
  }
  const final: Array<[string, TypeError]> = [
    ["read timeout", fetchFailed("ETIMEDOUT", "read")],
    ["read timeout x2", happyEyeballsFailed(["ETIMEDOUT", "read"], ["ETIMEDOUT", "read"])],
    ["refused + reset", happyEyeballsFailed(["ECONNREFUSED", "connect"], ["ECONNRESET", "read"])],
    ["ETIMEDOUT with no syscall", fetchFailed("ETIMEDOUT")],
    ["empty AggregateError", happyEyeballsFailed()],
  ];
  for (const [name, error] of final) {
    assert.equal(failedBeforeSend(error), false, name);
    const { fetchImpl, calls } = scripted(error, 200);
    await assert.rejects(
      fetchWithRetry(() => fetchImpl("u"), { sleep: recordingSleep().sleep, ...quiet }),
      error
    );
    assert.equal(calls.length, 1, `${name} was retried`);
  }
});

test("an abort is never retried, even when the attempt failed with a connect timeout", async () => {
  const controller = new AbortController();
  let calls = 0;
  const doFetch = async () => {
    calls++;
    controller.abort(new Error("client cancelled"));
    throw happyEyeballsFailed(["ETIMEDOUT", "connect"], ["ETIMEDOUT", "connect"]);
  };
  const { waits, sleep } = recordingSleep();
  await assert.rejects(fetchWithRetry(doFetch, { signal: controller.signal, sleep, ...quiet }), /client cancelled/);
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

// `localhost` can resolve to both ::1 and 127.0.0.1. Then Node tries each family and
// reports an AggregateError; with one address it reports a single error.
test("real connection refused on localhost is retried", async () => {
  const { server, base } = await listen(() => undefined);
  await close(server);
  const url = base.replace("127.0.0.1", "localhost");
  let calls = 0;
  const err = await fetchWithRetry(
    () => {
      calls++;
      return fetch(url);
    },
    { sleep: recordingSleep().sleep, ...quiet }
  ).catch((e: unknown) => e);
  const cause = (err as { cause?: { code?: string; errors?: Array<{ code?: string }> } }).cause;
  for (const inner of cause?.errors ?? [cause]) assert.equal(inner?.code, "ECONNREFUSED");
  assert.equal(calls, 3);
});

test("real connection refused is retried", async () => {
  const { server, base } = await listen(() => undefined);
  await close(server);
  let calls = 0;
  const err = await fetchWithRetry(
    () => {
      calls++;
      return fetch(base);
    },
    { sleep: recordingSleep().sleep, ...quiet }
  ).catch((e: unknown) => e);
  assert.equal((err as { cause?: { code?: string } }).cause?.code, "ECONNREFUSED");
  assert.equal(calls, 3);
});

test("a real reset after the request was sent is not retried", async () => {
  let hits = 0;
  const { server, base } = await listen((req) => {
    hits++;
    req.socket.destroy();
  });
  try {
    const err = await fetchWithRetry(() => fetch(base), { sleep: recordingSleep().sleep, ...quiet }).catch(
      (e: unknown) => e
    );
    assert.equal((err as { cause?: { code?: string } }).cause?.code, "UND_ERR_SOCKET");
    assert.equal(hits, 1);
  } finally {
    await close(server);
  }
});

test("a real invalid header value (TypeError with no cause) is not retried", async () => {
  let calls = 0;
  const { waits, sleep } = recordingSleep();
  await assert.rejects(
    fetchWithRetry(
      () => {
        calls++;
        return fetch("http://127.0.0.1:9/", { headers: { "x-mcp-client-name": "a\nb" } });
      },
      { sleep, ...quiet }
    ),
    /invalid header value/
  );
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test("a retried response body is cancelled before the wait", async () => {
  const cancelled: boolean[] = [];
  let n = 0;
  const doFetch = async () => {
    const i = n++;
    cancelled[i] = false;
    const body = new ReadableStream({ cancel: () => void (cancelled[i] = true) });
    return new Response(i === 0 ? body : "ok", { status: i === 0 ? 503 : 200 });
  };
  const res = await fetchWithRetry(doFetch, { sleep: recordingSleep().sleep, ...quiet });
  assert.equal(res.status, 200);
  assert.equal(cancelled[0], true);
});

// ─── Count and budget ────────────────────────────────────────────────────────

test("retries: 0 disables retrying", async () => {
  const { fetchImpl, calls } = scripted(503, 200);
  const res = await fetchWithRetry(() => fetchImpl("u"), { retries: 0, sleep: recordingSleep().sleep, ...quiet });
  assert.equal(res.status, 503);
  assert.equal(calls.length, 1);
});

/** A fake clock that the sleep advances, so a budget test takes no real time. */
function fakeClock() {
  let clock = 0;
  return { now: () => clock, sleep: async (ms: number) => void (clock += ms) };
}

test("no retry starts past the budget", async () => {
  const clock = fakeClock();
  const { fetchImpl, calls } = scripted({ status: 503, retryAfter: "30" });
  const res = await fetchWithRetry(() => fetchImpl("u"), { retries: 10, ...clock, ...quiet });
  assert.equal(res.status, 503);
  // A 30 s wait fits once in the budget; a second would start the next try at 60 s.
  assert.equal(calls.length, 2);
  assert.equal(clock.now(), 30_000);
  assert.ok(clock.now() <= FETCH_RETRY_BUDGET_MS);
});

// MCP clients cancel a tool call at about 60 s, and the hosted server never sees that
// cancel. The default budget must end before then, so no retry is sent to a gone client.
test("the default budget starts no retry at or after 60 s", async () => {
  const clock = fakeClock();
  const { fetchImpl, calls } = scripted({ status: 503, retryAfter: "20" });
  await fetchWithRetry(() => fetchImpl("u"), { retries: 10, ...clock, ...quiet });
  // Tries start at 0, 20 and 40 s. A try at 60 s would reach the API after the client left.
  assert.equal(calls.length, 3);
  assert.equal(clock.now(), 40_000);
});

test("extract uses the default budget", async () => {
  const clock = fakeClock();
  const { fetchImpl, calls } = scripted({ status: 503, retryAfter: "20" });
  const out = await runExtract(
    "k",
    { url: "https://example.com/p" },
    { fetchImpl, retry: { retries: 10, ...clock, ...quiet } }
  );
  assert.equal(out.ok, false);
  assert.equal(calls.length, 3);
  assert.equal(clock.now(), 40_000);
});

test(`${FETCH_RETRIES_ENV} sets the retry count and rejects a bad value`, () => {
  assert.equal(retriesFromEnv(undefined), 2);
  assert.equal(retriesFromEnv(""), 2);
  assert.equal(retriesFromEnv("0"), 0);
  assert.equal(retriesFromEnv(" 3 "), 3);
  for (const bad of ["-1", "1.5", "abc", "1e3"]) {
    assert.throws(() => retriesFromEnv(bad), new RegExp(FETCH_RETRIES_ENV), bad);
  }
});

test(`${FETCH_RETRIES_ENV}=0 turns retries off for the server process`, () => {
  const retryUrl = pathToFileURL(fileURLToPath(new URL("../src/retry.ts", import.meta.url))).href;
  const script = `
    const { fetchWithRetry } = await import(${JSON.stringify(retryUrl)});
    let calls = 0;
    await fetchWithRetry(async () => { calls++; return new Response("busy", { status: 503 }); },
      { sleep: async () => {}, log: () => {} });
    console.log(calls);`;
  const run = (value: string) =>
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, [FETCH_RETRIES_ENV]: value },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  assert.equal(run("0"), "1");
  assert.equal(run("4"), "5");
  assert.throws(() => run("many"), /must be a whole number/);
});

// ─── Cancellation ────────────────────────────────────────────────────────────

test("an abort during the wait rejects at once and sends nothing more", async () => {
  const { fetchImpl, calls } = scripted({ status: 503, retryAfter: "10" }, 200);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("client cancelled")), 30);
  const t0 = Date.now();
  await assert.rejects(
    fetchWithRetry(() => fetchImpl("u"), { signal: controller.signal, ...quiet }),
    /client cancelled/
  );
  assert.ok(Date.now() - t0 < 1_000, `took ${Date.now() - t0} ms`);
  assert.equal(calls.length, 1);
});

test("no attempt starts after an abort, even when the wait ignores the signal", async () => {
  const controller = new AbortController();
  const { fetchImpl, calls } = scripted(503, 200);
  const sleep = async () => void controller.abort(new Error("cancelled while waiting"));
  await assert.rejects(
    fetchWithRetry(() => fetchImpl("u"), { signal: controller.signal, sleep, ...quiet }),
    /cancelled while waiting/
  );
  assert.equal(calls.length, 1);
});

test("an already aborted signal sends nothing", async () => {
  const { fetchImpl, calls } = scripted(200);
  const signal = AbortSignal.abort(new Error("gone"));
  await assert.rejects(
    fetchWithRetry(() => fetchImpl("u"), { signal, ...quiet }),
    /gone/
  );
  assert.equal(calls.length, 0);
});

test("an abort that lands during an attempt rejects with the abort reason and starts no wait", async () => {
  for (const outcome of ["503", "refused", "reset"] as const) {
    const controller = new AbortController();
    let calls = 0;
    const doFetch = async () => {
      calls++;
      controller.abort(new Error("client cancelled"));
      if (outcome === "refused") throw fetchFailed("ECONNREFUSED");
      if (outcome === "reset") throw fetchFailed("UND_ERR_SOCKET");
      return new Response("busy", { status: 503 });
    };
    const lines: string[] = [];
    const { waits, sleep } = recordingSleep();
    await assert.rejects(
      fetchWithRetry(doFetch, { signal: controller.signal, sleep, log: (l) => lines.push(l) }),
      /client cancelled/
    );
    assert.equal(calls, 1, outcome);
    assert.deepEqual(waits, [], outcome);
    assert.deepEqual(lines, [], outcome);
  }
});

test("an abort during a real attempt ends it promptly and is not retried", async () => {
  let hits = 0;
  let closed = false;
  const { server, base } = await listen((req) => {
    hits++;
    req.socket.on("close", () => void (closed = true));
  });
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("client cancelled")), 50);
    const t0 = Date.now();
    await assert.rejects(
      fetchWithRetry((signal) => fetch(base, { signal }), { signal: controller.signal, ...quiet }),
      /client cancelled/
    );
    assert.ok(Date.now() - t0 < 1_000, `took ${Date.now() - t0} ms`);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(closed, true, "the attempt's connection was not closed");
    assert.equal(hits, 1);
  } finally {
    await close(server);
  }
});

test("abortableSleep resolves after the wait when nothing aborts", async () => {
  const t0 = Date.now();
  await abortableSleep(20, new AbortController().signal);
  assert.ok(Date.now() - t0 >= 15);
});

// ─── Logging ─────────────────────────────────────────────────────────────────

test("each retry logs one line with the status, attempt and wait", async () => {
  const lines: string[] = [];
  const { fetchImpl } = scripted({ status: 503, retryAfter: "2" }, fetchFailed("ECONNREFUSED"), 200);
  await fetchWithRetry(() => fetchImpl("https://api.example/?apikey=placeholder"), {
    sleep: recordingSleep().sleep,
    random: () => 0,
    label: "scrape",
    log: (l) => lines.push(l),
  });
  assert.deepEqual(lines, [
    "zenrows-mcp: scrape got 503 on attempt 1 of 3; retrying in 2000 ms",
    "zenrows-mcp: scrape got ECONNREFUSED on attempt 2 of 3; retrying in 250 ms",
  ]);
});

test("the default retry log goes to stderr, never stdout", async (t) => {
  const err = t.mock.method(process.stderr, "write", () => true);
  const out = t.mock.method(process.stdout, "write", () => true);
  const { fetchImpl } = scripted(503, 200);
  await fetchWithRetry(() => fetchImpl("u"), { sleep: recordingSleep().sleep });
  const stderrLines = err.mock.calls.map((c) => String(c.arguments[0]));
  t.mock.restoreAll();
  assert.equal(stderrLines.filter((l) => l.includes("got 503")).length, 1);
  assert.equal(out.mock.callCount(), 0);
});

// ─── Extract ─────────────────────────────────────────────────────────────────

test("runExtract retries a 503 and serves the retry", async () => {
  const { fetchImpl, calls } = scripted(503, 200);
  const outcome = await runExtract(
    "k",
    { url: "https://example.com" },
    { fetchImpl, retry: { sleep: recordingSleep().sleep, ...quiet } }
  );
  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 2);
});

test("runExtract sends no retry once the call is cancelled", async () => {
  const controller = new AbortController();
  const calls: number[] = [];
  const fetchImpl = (async () => {
    calls.push(calls.length);
    controller.abort(new Error("cancelled"));
    return new Response("busy", { status: 503 });
  }) as typeof fetch;
  await runExtract("k", { url: "https://example.com" }, { fetchImpl, signal: controller.signal, retry: quiet });
  assert.equal(calls.length, 1);
});
