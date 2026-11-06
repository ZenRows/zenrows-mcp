import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { BUDGET_MS, failedBeforeSend, fetchWithRetry, jitterMs, parseRetries, retryAfterMs } from "../src/retry.ts";

const stderr = mock.method(process.stderr, "write", () => true);
const noSleep = async () => undefined;

/** A send that answers from a script (the last step repeats) and counts its calls. */
function scripted(...steps: Array<number | Error | Response>) {
  const send = async () => {
    const step = steps[Math.min(send.calls++, steps.length - 1)];
    if (step instanceof Error) throw step;
    return typeof step === "number" ? new Response("body", { status: step }) : step;
  };
  send.calls = 0;
  return send;
}

const busy = (retryAfter: string) => new Response("busy", { status: 503, headers: { "retry-after": retryAfter } });

/** undici's shape for a failed fetch: TypeError("fetch failed") with a coded cause. */
const fetchFailed = (code: string, syscall?: string) =>
  new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code, syscall }) });

/** Happy eyeballs: one error per address tried, in an AggregateError. */
const allAddressesFailed = (...inner: Array<[code: string, syscall: string]>) =>
  new TypeError("fetch failed", {
    cause: new AggregateError(inner.map(([code, syscall]) => Object.assign(new Error(code), { code, syscall }))),
  });

// Shared conformance vectors.

test("Retry-After: whole seconds clamped to 250 ms - 30 s; any other form is ignored", () => {
  const vectors: Array<[string | null, number | undefined]> = [
    ["5", 5_000],
    ["0", 250],
    [" 7 ", 7_000],
    ["99999", 30_000],
    ["1.5", undefined],
    ["-1", undefined],
    ["1e3", undefined],
    ["0x10", undefined],
    ["", undefined],
    [null, undefined],
    ["Wed, 21 Oct 2026 07:28:00 GMT", undefined],
  ];
  for (const [header, expected] of vectors) assert.equal(retryAfterMs(header), expected, String(header));
});

test("full jitter: uniform between 250 ms and min(30 s, 1 s x 2^attempt)", () => {
  const vectors: Array<[attempt: number, high: number]> = [
    [0, 1_000],
    [1, 2_000],
    [2, 4_000],
    [5, 30_000],
    [9, 30_000],
  ];
  for (const [attempt, high] of vectors) {
    assert.equal(
      jitterMs(attempt, () => 0),
      250,
      `attempt ${attempt}`
    );
    assert.equal(
      jitterMs(attempt, () => 1),
      high,
      `attempt ${attempt}`
    );
  }
});

// Policy.

test("429, 502, 503 and 504 are retried with jitter; every other status returns at once", async () => {
  for (const status of [200, 400, 401, 402, 403, 404, 422, 500, 429, 502, 503, 504]) {
    const send = scripted(status);
    const waits: number[] = [];
    const res = await fetchWithRetry(send, {
      label: "t",
      retries: 2,
      random: () => 0.5,
      sleep: async (ms) => void waits.push(ms),
    });
    const retried = [429, 502, 503, 504].includes(status);
    assert.equal(res.status, status);
    assert.equal(send.calls, retried ? 3 : 1, String(status));
    assert.deepEqual(waits, retried ? [625, 1_125] : [], String(status));
  }
});

test("a Retry-After in whole seconds replaces the jitter", async () => {
  const waits: number[] = [];
  await fetchWithRetry(scripted(busy("3"), 200), { label: "t", retries: 2, sleep: async (ms) => void waits.push(ms) });
  assert.deepEqual(waits, [3_000]);
});

test("only a connection that failed before the request was sent is retried", async () => {
  const cases: Array<[string, Error, boolean]> = [
    ...["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"].map(
      (code): [string, Error, boolean] => [code, fetchFailed(code), true]
    ),
    ["connect timeout", fetchFailed("ETIMEDOUT", "connect"), true],
    ["refused on every address", allAddressesFailed(["ECONNREFUSED", "connect"], ["ETIMEDOUT", "connect"]), true],
    ["refused, then reset", allAddressesFailed(["ECONNREFUSED", "connect"], ["ECONNRESET", "read"]), false],
    ["empty AggregateError", allAddressesFailed(), false],
    ["read timeout", fetchFailed("ETIMEDOUT", "read"), false],
    ["ETIMEDOUT without syscall", fetchFailed("ETIMEDOUT"), false],
    ["socket closed", fetchFailed("UND_ERR_SOCKET"), false],
    ["reset", fetchFailed("ECONNRESET"), false],
    ["headers timeout", fetchFailed("UND_ERR_HEADERS_TIMEOUT"), false],
    ["no cause", new TypeError("fetch failed"), false],
    ["abort", new DOMException("aborted", "AbortError"), false],
  ];
  for (const [name, error, retried] of cases) {
    assert.equal(failedBeforeSend(error), retried, name);
    const send = scripted(error, 200);
    const result = fetchWithRetry(send, { label: "t", retries: 2, sleep: noSleep });
    if (retried) assert.equal((await result).status, 200, name);
    else await assert.rejects(result, error, name);
    assert.equal(send.calls, retried ? 2 : 1, name);
  }
});

async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const close = () => {
    server.closeAllConnections();
    return new Promise<void>((r) => server.close(() => r()));
  };
  return { port: (server.address() as AddressInfo).port, close };
}

test("a real refused connection is retried; a real reset after sending is not", async () => {
  const closed = await listen(() => undefined);
  await closed.close();
  let calls = 0;
  // localhost may resolve to ::1 and 127.0.0.1, which gives the AggregateError shape.
  const refused = () => {
    calls++;
    return fetch(`http://localhost:${closed.port}/`);
  };
  await assert.rejects(fetchWithRetry(refused, { label: "t", retries: 2, sleep: noSleep }), /fetch failed/);
  assert.equal(calls, 3);

  let hits = 0;
  const resetting = await listen((req) => {
    hits++;
    req.socket.destroy();
  });
  try {
    const reset = () => fetch(`http://127.0.0.1:${resetting.port}/`);
    await assert.rejects(fetchWithRetry(reset, { label: "t", retries: 2, sleep: noSleep }), /fetch failed/);
    assert.equal(hits, 1);
  } finally {
    await resetting.close();
  }
});

test("a retry starts only if its wait ends within 50 s of the first request", async () => {
  const cases: Array<[attemptMs: number, retryAfter: string, calls: number]> = [
    [0, "20", 3], // tries at 0, 20 and 40 s; one at 60 s would be too late
    [45_000, "5", 2], // the retry starts at exactly 50 s, and its attempt runs to the end
    [45_000, "6", 1],
  ];
  for (const [attemptMs, retryAfter, calls] of cases) {
    let clock = 0;
    const send = async () => {
      send.calls++;
      clock += attemptMs;
      return busy(retryAfter);
    };
    send.calls = 0;
    const res = await fetchWithRetry(send, {
      label: "t",
      retries: 10,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
    });
    assert.equal(res.status, 503);
    assert.equal(send.calls, calls, `attempt ${attemptMs} ms, Retry-After ${retryAfter}`);
  }
  assert.equal(BUDGET_MS, 50_000);
});

test("a cancel ends the wait at once and stops further retries", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  const send = scripted(busy("10"), 200);
  const t0 = Date.now();
  await assert.rejects(fetchWithRetry(send, { label: "t", retries: 2, signal: controller.signal }), {
    name: "AbortError",
  });
  assert.ok(Date.now() - t0 < 1_000);
  assert.equal(send.calls, 1);
});

test("a cancel during an attempt lets it finish and returns its answer without a retry", async () => {
  const controller = new AbortController();
  const send = scripted(busy("0"), 200);
  const cancelling = () => {
    controller.abort();
    return send();
  };
  const res = await fetchWithRetry(cancelling, { label: "t", retries: 2, signal: controller.signal, sleep: noSleep });
  assert.equal(res.status, 503);
  assert.equal(send.calls, 1);
});

test("each retry writes one line to stderr and nothing to stdout", async (t) => {
  const stdout = t.mock.method(process.stdout, "write", () => true);
  stderr.mock.resetCalls();
  await fetchWithRetry(scripted(busy("2"), fetchFailed("ECONNREFUSED"), 200), {
    label: "scrape",
    retries: 2,
    random: () => 0,
    sleep: noSleep,
  });
  t.mock.restoreAll();
  assert.deepEqual(
    stderr.mock.calls.map((c) => c.arguments[0]),
    [
      "zenrows-mcp: scrape got 503 on attempt 1 of 3; retrying in 2000 ms\n",
      "zenrows-mcp: scrape got ECONNREFUSED on attempt 2 of 3; retrying in 250 ms\n",
    ]
  );
  assert.equal(stdout.mock.callCount(), 0);
});

// Configuration.

test("ZENROWS_FETCH_RETRIES accepts a whole number of 0 or more; unset means 0", () => {
  assert.equal(parseRetries(undefined), 0);
  assert.equal(parseRetries(""), 0);
  assert.equal(parseRetries(" 3 "), 3);
  for (const bad of ["-1", "1.5", "abc", "1e3"]) assert.throws(() => parseRetries(bad), /ZENROWS_FETCH_RETRIES/);
});

test("an invalid ZENROWS_FETCH_RETRIES stops the stdio and the hosted server at startup", () => {
  for (const entry of ["index.ts", "http.ts"]) {
    const run = spawnSync(
      process.execPath,
      ["--import", "tsx", fileURLToPath(new URL(`../src/${entry}`, import.meta.url))],
      {
        env: { ...process.env, ZENROWS_FETCH_RETRIES: "many", ZENROWS_API_KEY: "k" },
        encoding: "utf8",
        timeout: 20_000,
      }
    );
    assert.equal(run.status, 1, entry);
    assert.match(run.stderr, /ZENROWS_FETCH_RETRIES must be a whole number/, entry);
  }
});
