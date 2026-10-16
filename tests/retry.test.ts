import assert from "node:assert/strict";
import { test } from "node:test";
import { FETCH_RETRY_BUDGET_MS, fetchWithRetry, fullJitterMs } from "../src/retry.ts";
import { runExtract } from "../src/tools/extract.ts";

/** A fetch that answers from a script of statuses (or thrown errors) and records each call. */
function scripted(...steps: Array<number | Error | { status: number; retryAfter: string }>) {
  const calls: number[] = [];
  const fetchImpl = (async () => {
    const step = steps[Math.min(calls.length, steps.length - 1)];
    calls.push(calls.length);
    if (step instanceof Error) throw step;
    if (typeof step === "number") return new Response(step === 200 ? '{"title":"x"}' : "busy", { status: step });
    return new Response("busy", { status: step.status, headers: { "retry-after": step.retryAfter } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function recordingSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

test("fullJitterMs stays within [250 ms, min(30 s, 1 s x 2^attempt)]", () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const ceiling = Math.min(30_000, 1000 * 2 ** attempt);
    assert.equal(fullJitterMs(attempt, () => 0), 250);
    assert.equal(fullJitterMs(attempt, () => 1), Math.max(250, ceiling));
    for (let i = 0; i < 50; i++) {
      const d = fullJitterMs(attempt);
      assert.ok(d >= 250 && d <= ceiling, `attempt ${attempt}: ${d}`);
    }
  }
});

test("a 503 is retried with jittered backoff, twice by default", async () => {
  const { fetchImpl, calls } = scripted(503, 503, 503);
  const { waits, sleep } = recordingSleep();
  const res = await fetchWithRetry(() => fetchImpl("u"), { sleep, random: () => 0.5 });
  assert.equal(res.status, 503);
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [625, 1125]);
});

test("a retry that succeeds returns the success", async () => {
  const { fetchImpl, calls } = scripted(502, 200);
  const { sleep } = recordingSleep();
  const res = await fetchWithRetry(() => fetchImpl("u"), { sleep });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
});

test("Retry-After replaces the backoff and is capped at 30 s", async () => {
  const { fetchImpl } = scripted({ status: 503, retryAfter: "7" }, { status: 429, retryAfter: "120" }, 200);
  const { waits, sleep } = recordingSleep();
  await fetchWithRetry(() => fetchImpl("u"), { sleep, budgetMs: 10 * 60_000 });
  assert.deepEqual(waits, [7_000, 30_000]);
});

test("400, 422 and other non-retryable statuses are never retried", async () => {
  for (const status of [400, 401, 402, 403, 404, 422, 500]) {
    const { fetchImpl, calls } = scripted(status);
    const { waits, sleep } = recordingSleep();
    const res = await fetchWithRetry(() => fetchImpl("u"), { sleep });
    assert.equal(res.status, status);
    assert.equal(calls.length, 1, `status ${status} was retried`);
    assert.deepEqual(waits, []);
  }
});

test("a network error is retried; an abort or timeout is not", async () => {
  const net = scripted(new TypeError("fetch failed"), 200);
  const { sleep } = recordingSleep();
  assert.equal((await fetchWithRetry(() => net.fetchImpl("u"), { sleep })).status, 200);
  assert.equal(net.calls.length, 2);

  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  const aborted = scripted(timeout, 200);
  await assert.rejects(fetchWithRetry(() => aborted.fetchImpl("u"), { sleep }), /timed out/);
  assert.equal(aborted.calls.length, 1);
});

test("retries: 0 disables retrying", async () => {
  const { fetchImpl, calls } = scripted(503, 200);
  const res = await fetchWithRetry(() => fetchImpl("u"), { retries: 0, sleep: recordingSleep().sleep });
  assert.equal(res.status, 503);
  assert.equal(calls.length, 1);
});

test("no retry starts past the total budget", async () => {
  let clock = 0;
  const { fetchImpl, calls } = scripted({ status: 503, retryAfter: "30" });
  const sleep = async (ms: number) => void (clock += ms);
  const res = await fetchWithRetry(() => fetchImpl("u"), { retries: 10, sleep, now: () => clock });
  assert.equal(res.status, 503);
  // 30 s waits fit three times in the 90 s budget; the fourth would exceed it.
  assert.equal(calls.length, FETCH_RETRY_BUDGET_MS / 30_000 + 1);
  assert.ok(clock <= FETCH_RETRY_BUDGET_MS);
});

test("runExtract retries a 503 and serves the retry", async () => {
  const { fetchImpl, calls } = scripted(503, 200);
  const outcome = await runExtract("k", { url: "https://example.com" }, { fetchImpl, retry: { sleep: recordingSleep().sleep } });
  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 2);
});
