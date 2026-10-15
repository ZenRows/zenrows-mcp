import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BatchError,
  batchBase,
  createJob,
  getJob,
  isPausedRun,
  listResults,
  MAX_RETRY_AFTER_SECONDS,
  retryDelayMs,
  stopJob,
  waitForJob,
} from "../src/batch-api.ts";

const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("createJob maps 403 problem+json to BATCH_ACCESS_DENIED", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ title: "Forbidden", detail: "no beta", code: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/problem+json" },
    })) as typeof fetch;

  await assert.rejects(
    () => createJob({ tasks: [{ url: "https://example.com" }] }, { apiKey: "k", fetchImpl }),
    (e: unknown) => {
      assert.ok(e instanceof BatchError);
      assert.equal(e.code, "BATCH_ACCESS_DENIED");
      assert.equal(e.status, 403);
      return true;
    }
  );
});

test("getJob returns parsed job on 200", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    assert.match(String(input), /\/jobs\/job-1$/);
    return new Response(
      JSON.stringify({
        job_id: "job-1",
        latest_run: {
          status: "completed",
          stats: { total: 1, completed: 1, successful: 1, failed: 0 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const job = await getJob("job-1", { apiKey: "k", fetchImpl });
  assert.equal(job.job_id, "job-1");
  assert.equal(job.latest_run.status, "completed");
});

test("createJob maps 401 to AUTH_INVALID", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ detail: "bad key" }), { status: 401 })) as typeof fetch;
  await assert.rejects(
    () => createJob({ tasks: [{ url: "https://example.com" }] }, { apiKey: "bad", fetchImpl }),
    (e: unknown) => e instanceof BatchError && e.code === "AUTH_INVALID"
  );
});

test("createJob maps 404 to BATCH_NOT_FOUND", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ title: "not found" }), { status: 404 })) as typeof fetch;
  await assert.rejects(
    () => getJob("missing", { apiKey: "k", fetchImpl }),
    (e: unknown) => e instanceof BatchError && e.code === "BATCH_NOT_FOUND"
  );
});

test("createJob keeps 429 as BATCH_QUOTA_EXCEEDED, adding reason too_many_jobs and the server code", async () => {
  const fetchImpl = (async () =>
    jsonRes(
      { code: "quota_exceeded", detail: "Account already has 3 active jobs; max 3 allowed." },
      429
    )) as typeof fetch;
  await assert.rejects(
    () => createJob({ tasks: [] }, { apiKey: "k", fetchImpl }),
    (e: unknown) => {
      assert.ok(e instanceof BatchError);
      assert.equal(e.code, "BATCH_QUOTA_EXCEEDED");
      assert.equal(e.reason, "too_many_jobs");
      assert.equal(e.toJSON().reason, "too_many_jobs");
      assert.equal(e.toJSON().server_code, "quota_exceeded");
      assert.match(e.message, /concurrent active jobs/);
      return true;
    }
  );
});

test("createJob keeps 402 as BATCH_QUOTA_EXCEEDED, adding reason insufficient_credits", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ title: "no credit" }), { status: 402 })) as typeof fetch;
  await assert.rejects(
    () => createJob({ tasks: [] }, { apiKey: "k", fetchImpl }),
    (e: unknown) => {
      assert.ok(e instanceof BatchError);
      assert.equal(e.code, "BATCH_QUOTA_EXCEEDED");
      assert.equal(e.reason, "insufficient_credits");
      assert.match(e.message, /no credit/);
      return true;
    }
  );
});

test("an unmapped problem keeps the Batch API's code as server_code", async () => {
  const fetchImpl = (async () =>
    jsonRes(
      { code: "run_not_stoppable", title: "Conflict", detail: "Run is already completed." },
      409
    )) as typeof fetch;
  await assert.rejects(
    () => stopJob("j1", { apiKey: "k", fetchImpl }),
    (e: unknown) => {
      assert.ok(e instanceof BatchError);
      assert.equal(e.code, "BATCH_FAILED");
      assert.equal(e.toJSON().server_code, "run_not_stoppable");
      assert.equal(e.message, "Batch request failed (HTTP 409).");
      return true;
    }
  );
});

test("createJob maps an unmapped status to BATCH_FAILED and surfaces invalid_tasks detail", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        title: "Bad Request",
        invalid_tasks: [{ index: 0, reason: "missing url" }],
      }),
      { status: 422 }
    )) as typeof fetch;

  await assert.rejects(
    () => createJob({ tasks: [{}] }, { apiKey: "k", fetchImpl }),
    (e: unknown) => {
      assert.ok(e instanceof BatchError);
      assert.equal(e.code, "BATCH_FAILED");
      assert.match(e.message, /#0: missing url/);
      return true;
    }
  );
});

test("problem response that isn't valid JSON still produces a BatchError using the raw body as detail", async () => {
  const fetchImpl = (async () =>
    new Response("<html>502 Bad Gateway</html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    })) as typeof fetch;

  await assert.rejects(
    () => getJob("job-1", { apiKey: "k", fetchImpl }),
    (e: unknown) => {
      assert.ok(e instanceof BatchError);
      assert.equal(e.code, "BATCH_FAILED");
      assert.match(e.detail ?? "", /502 Bad Gateway/);
      return true;
    }
  );
});

test("a network failure (fetch throws) becomes BACKEND_UNAVAILABLE, not an uncaught rejection", async () => {
  const fetchImpl = (async () => {
    throw new TypeError("fetch failed: getaddrinfo ENOTFOUND");
  }) as typeof fetch;

  await assert.rejects(
    () => getJob("job-1", { apiKey: "k", fetchImpl }),
    (e: unknown) => {
      assert.ok(e instanceof BatchError);
      assert.equal(e.code, "BACKEND_UNAVAILABLE");
      assert.match(e.message, /ENOTFOUND/);
      return true;
    }
  );
});

test("a 200 response with a non-JSON body raises BATCH_FAILED instead of throwing a raw SyntaxError", async () => {
  const fetchImpl = (async () =>
    new Response("not json", {
      status: 200,
      headers: { "content-type": "text/plain" },
    })) as typeof fetch;

  await assert.rejects(
    () => getJob("job-1", { apiKey: "k", fetchImpl }),
    (e: unknown) => {
      assert.ok(e instanceof BatchError);
      assert.equal(e.code, "BATCH_FAILED");
      assert.match(e.message, /not valid JSON/);
      return true;
    }
  );
});

test("a 204-style empty body on success resolves to null rather than throwing", async () => {
  const fetchImpl = (async () => new Response("", { status: 200 })) as typeof fetch;
  const result = await stopJob("job-1", { apiKey: "k", fetchImpl });
  assert.equal(result, null);
});

test("batchBase trims trailing slashes and defaults when the env override is unset/blank", () => {
  const original = process.env.ZENROWS_BATCH_API_BASE;
  try {
    delete process.env.ZENROWS_BATCH_API_BASE;
    assert.equal(batchBase(), "https://async.api.zenrows.com/v1");

    process.env.ZENROWS_BATCH_API_BASE = "   ";
    assert.equal(batchBase(), "https://async.api.zenrows.com/v1");

    process.env.ZENROWS_BATCH_API_BASE = "https://staging.example.com/v1//";
    assert.equal(batchBase(), "https://staging.example.com/v1");
  } finally {
    if (original === undefined) delete process.env.ZENROWS_BATCH_API_BASE;
    else process.env.ZENROWS_BATCH_API_BASE = original;
  }
});

test("listResults follows next_cursor across multiple pages and stops when it's null", async () => {
  const seenCursors: Array<string | undefined> = [];
  const pages: Record<string, { results: { task_id: string }[]; next_cursor: string | null }> = {
    start: { results: [{ task_id: "a" }, { task_id: "b" }], next_cursor: "page2" },
    page2: { results: [{ task_id: "c" }], next_cursor: null },
  };

  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const cursor = url.searchParams.get("cursor") ?? "start";
    seenCursors.push(url.searchParams.get("cursor") ?? undefined);
    return new Response(JSON.stringify(pages[cursor]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const page = await listResults("job-1", { apiKey: "k", fetchImpl });
  assert.deepEqual(
    page.results.map((r) => r.task_id),
    ["a", "b", "c"]
  );
  assert.equal(page.next_cursor, null);
  assert.deepEqual(seenCursors, [undefined, "page2"]);
});

test("listResults stops at the page boundary once limit is reached and returns next_cursor", async () => {
  const pages: Record<string, { results: { task_id: string }[]; next_cursor: string | null }> = {
    start: { results: [{ task_id: "a" }, { task_id: "b" }], next_cursor: "p2" },
    p2: { results: [{ task_id: "c" }, { task_id: "d" }], next_cursor: "p3" },
    p3: { results: [{ task_id: "e" }], next_cursor: null },
  };
  const seen: (string | null)[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    seen.push(url.searchParams.get("cursor"));
    return jsonRes(pages[url.searchParams.get("cursor") ?? "start"]);
  }) as typeof fetch;

  // limit 3 needs two pages; the second page is returned whole, never cut.
  const first = await listResults("job-1", { apiKey: "k", fetchImpl, limit: 3 });
  assert.deepEqual(
    first.results.map((r) => r.task_id),
    ["a", "b", "c", "d"]
  );
  assert.equal(first.next_cursor, "p3");

  const rest = await listResults("job-1", { apiKey: "k", fetchImpl, cursor: first.next_cursor!, limit: 3 });
  assert.deepEqual(
    rest.results.map((r) => r.task_id),
    ["e"]
  );
  assert.equal(rest.next_cursor, null);
  assert.deepEqual(seen, [null, "p2", "p3"]);
});

test("listResults sends the processing status filter", async () => {
  let status: string | null = null;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    status = new URL(String(input)).searchParams.get("status");
    return jsonRes({ results: [], next_cursor: null });
  }) as typeof fetch;
  await listResults("job-1", { apiKey: "k", fetchImpl, status: "processing" });
  assert.equal(status, "processing");
});

test("a GET retries a 503 (Retry-After: 0)", async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    return n === 1
      ? jsonRes({ code: "unavailable" }, 503, { "retry-after": "0" })
      : jsonRes({ job_id: "j1", latest_run: { status: "running", stats: {} } });
  }) as typeof fetch;
  const job = await getJob("j1", { apiKey: "k", fetchImpl });
  assert.equal(job.job_id, "j1");
  assert.equal(n, 2);
});

test("a GET retries a network error", async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    if (n === 1) throw new TypeError("fetch failed");
    return jsonRes({ job_id: "j1", latest_run: { status: "running", stats: {} } });
  }) as typeof fetch;
  await getJob("j1", { apiKey: "k", fetchImpl });
  assert.equal(n, 2);
});

test("a GET gives up after 3 retries", async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    return jsonRes({}, 502, { "retry-after": "0" });
  }) as typeof fetch;
  await assert.rejects(() => getJob("j1", { apiKey: "k", fetchImpl }), BatchError);
  assert.equal(n, 4);
});

test("createJob sends the Idempotency-Key and retries a 502 with the same key", async () => {
  const keys: (string | null)[] = [];
  const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    keys.push(new Headers(init?.headers).get("idempotency-key"));
    return keys.length === 1
      ? jsonRes({}, 502, { "retry-after": "0" })
      : jsonRes({ job_id: "j1", latest_run: { status: "running", stats: {} } }, 201);
  }) as typeof fetch;
  const job = await createJob({ tasks: [] }, { apiKey: "k", fetchImpl, idempotencyKey: "key-1" });
  assert.equal(job.job_id, "j1");
  assert.deepEqual(keys, ["key-1", "key-1"]);
});

test("createJob without an Idempotency-Key never retries, and a 429 is never retried", async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    return jsonRes({}, 502);
  }) as typeof fetch;
  await assert.rejects(() => createJob({ tasks: [] }, { apiKey: "k", fetchImpl }), BatchError);
  assert.equal(n, 1);

  n = 0;
  const tooMany = (async () => {
    n++;
    return jsonRes({ code: "quota_exceeded" }, 429, { "retry-after": "0" });
  }) as typeof fetch;
  await assert.rejects(
    () => createJob({ tasks: [] }, { apiKey: "k", fetchImpl: tooMany, idempotencyKey: "k1" }),
    (e: unknown) => e instanceof BatchError && e.code === "BATCH_QUOTA_EXCEEDED" && e.reason === "too_many_jobs"
  );
  assert.equal(n, 1);
});

test("waitForJob returns a paused run instead of polling to the deadline", async () => {
  let polls = 0;
  const fetchImpl = (async () => {
    polls++;
    return jsonRes({ job_id: "j1", latest_run: { status: "running", pause_state: "paused", stats: {} } });
  }) as typeof fetch;
  const job = await waitForJob("j1", { apiKey: "k", fetchImpl, pollTimeoutMs: 60_000 });
  assert.equal(job.latest_run.pause_state, "paused");
  assert.equal(polls, 1);
});

test("waitForJob polls until a terminal status is reached", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    const status = calls < 3 ? "running" : "completed";
    return new Response(
      JSON.stringify({
        job_id: "job-1",
        latest_run: {
          status,
          stats: { total: 1, completed: calls >= 3 ? 1 : 0, successful: 0, failed: 0 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const job = await waitForJob("job-1", { apiKey: "k", fetchImpl, pollTimeoutMs: 5000 });
  assert.equal(job.latest_run.status, "completed");
  assert.equal(calls, 3);
});

test("waitForJob raises BATCH_FAILED once the poll deadline passes without a terminal status", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        job_id: "job-1",
        latest_run: {
          status: "running",
          stats: { total: 1, completed: 0, successful: 0, failed: 0 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;

  await assert.rejects(
    () => waitForJob("job-1", { apiKey: "k", fetchImpl, pollTimeoutMs: 1 }),
    (e: unknown) => {
      assert.ok(e instanceof BatchError);
      assert.equal(e.code, "BATCH_FAILED");
      assert.match(e.message, /Timed out/);
      return true;
    }
  );
});

test("waitForJob returns on a failed run instead of polling to the deadline", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        job_id: "job-1",
        latest_run: {
          status: "failed",
          failure_reason: "api_key_cap_reached",
          stats: { total: 2, completed: 1, successful: 1, failed: 0 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const job = await waitForJob("job-1", { apiKey: "k", fetchImpl, pollTimeoutMs: 2000 });
  assert.equal(job.latest_run.status, "failed");
  assert.equal(calls, 1);
});

test("createJob maps 402 api_key_cap_reached to BATCH_KEY_CAP_REACHED, not out of credits", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        code: "api_key_cap_reached",
        status: 402,
        detail: "This API key has reached its daily cap of 200 credits. The cap resets on 2026-10-03 at 00:00 UTC.",
      }),
      { status: 402, headers: { "content-type": "application/problem+json" } }
    )) as typeof fetch;
  await assert.rejects(
    () => createJob({ tasks: [{ url: "https://example.com" }] }, { apiKey: "k", fetchImpl }),
    (e: unknown) =>
      e instanceof BatchError &&
      e.code === "BATCH_KEY_CAP_REACHED" &&
      /credit caps/.test(e.message) &&
      !/no credit available/.test(e.message) &&
      /2026-10-03/.test(e.detail ?? "")
  );
});

test("retryDelayMs uses Retry-After seconds or an HTTP-date, capped at 30 s, else backoff", () => {
  assert.equal(retryDelayMs(0, "5"), 5000);
  assert.equal(retryDelayMs(0, "0"), 0);
  assert.equal(retryDelayMs(0, "120"), MAX_RETRY_AFTER_SECONDS * 1000);
  const date = new Date(Date.now() + 10_000).toUTCString();
  const fromDate = retryDelayMs(0, date);
  assert.ok(fromDate > 8000 && fromDate <= 11_000, String(fromDate));
  for (let i = 0; i < 20; i++) {
    const b = retryDelayMs(0, null);
    assert.ok(b >= 200 && b <= 300, String(b));
  }
});

test("a GET waits for a positive Retry-After before retrying", async () => {
  const at: number[] = [];
  const fetchImpl = (async () => {
    at.push(Date.now());
    return at.length === 1
      ? jsonRes({}, 503, { "retry-after": "1" })
      : jsonRes({ job_id: "j1", latest_run: { status: "running", stats: {} } });
  }) as typeof fetch;
  await getJob("j1", { apiKey: "k", fetchImpl });
  assert.equal(at.length, 2);
  assert.ok(at[1]! - at[0]! >= 950, String(at[1]! - at[0]!));
});

test("a retry whose wait would end past the deadline is not made", async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    return jsonRes({}, 503, { "retry-after": "30" });
  }) as typeof fetch;
  const t0 = Date.now();
  await assert.rejects(() => getJob("j1", { apiKey: "k", fetchImpl, deadline: Date.now() + 500 }), BatchError);
  assert.equal(n, 1);
  assert.ok(Date.now() - t0 < 400);
});

// Timers may fire a few ms late; this is the slack allowed past a deadline in the tests below.
const SCHEDULING_TOLERANCE_MS = 100;

test("waitForJob ends at its 1.5 s budget, not before and not past it, when Retry-After points past it", async () => {
  const t0 = Date.now();
  const starts: number[] = [];
  const fetchImpl = (async () => {
    starts.push(Date.now() - t0);
    return jsonRes({}, 503, { "retry-after": "30" });
  }) as typeof fetch;
  await assert.rejects(
    () => waitForJob("j1", { apiKey: "k", fetchImpl, pollTimeoutMs: 1500 }),
    (e: unknown) => e instanceof BatchError && /Timed out/.test(e.message) && /Last poll failed/.test(e.detail ?? "")
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 1500 - SCHEDULING_TOLERANCE_MS, `ended early at ${elapsed} ms`);
  assert.ok(elapsed <= 1500 + SCHEDULING_TOLERANCE_MS, `ended late at ${elapsed} ms`);
  // The API asked for 30 s, past the deadline, so no second request is made at all.
  assert.equal(starts.length, 1, `expected one request, got ${starts}`);
});

test("waitForJob makes real retries that fit, and none that would cross the deadline", async () => {
  const t0 = Date.now();
  const starts: number[] = [];
  const fetchImpl = (async () => {
    starts.push(Date.now() - t0);
    return jsonRes({}, 503, { "retry-after": "1" });
  }) as typeof fetch;
  await assert.rejects(
    () => waitForJob("j1", { apiKey: "k", fetchImpl, pollTimeoutMs: 1500 }),
    (e: unknown) => e instanceof BatchError && /Timed out/.test(e.message)
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed <= 1500 + SCHEDULING_TOLERANCE_MS, `ended late at ${elapsed} ms`);
  // The first poll's 1 s Retry-After fits inside the budget, so it really is retried at about 1 s.
  assert.ok(
    starts.some((t) => t >= 950 && t < 1500),
    `expected a retry about 1 s after the first request: ${starts}`
  );
  assert.ok(
    starts.every((t) => t < 1500),
    `a request started after the deadline: ${starts}`
  );
});

test("a retry wait that overruns the deadline (a stalled event loop) starts no request", async () => {
  const t0 = Date.now();
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    // Queue a task that blocks the event loop for 400 ms, past the 200 ms deadline, so the
    // retry's sleep(0) resolves late, after the deadline.
    setTimeout(() => {
      while (Date.now() - t0 < 400) {
        /* busy */
      }
    }, 0);
    return jsonRes({}, 503, { "retry-after": "0" });
  }) as typeof fetch;
  await assert.rejects(
    () => getJob("j1", { apiKey: "k", fetchImpl, deadline: t0 + 200 }),
    (e: unknown) => e instanceof BatchError && e.status === 503
  );
  assert.equal(n, 1);
});

test("a request is not sent at all once the deadline has passed", async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    return jsonRes({ job_id: "j1", latest_run: { status: "running", stats: {} } });
  }) as typeof fetch;
  await assert.rejects(() => getJob("j1", { apiKey: "k", fetchImpl, deadline: Date.now() - 1 }), BatchError);
  assert.equal(n, 0);
});

test("a short wait uses its whole budget and polls again before timing out", async () => {
  for (const budget of [400, 1000]) {
    const t0 = Date.now();
    let polls = 0;
    const fetchImpl = (async () => {
      polls++;
      return jsonRes({ job_id: "j1", latest_run: { status: "running", stats: {} } });
    }) as typeof fetch;
    await assert.rejects(
      () => waitForJob("j1", { apiKey: "k", fetchImpl, pollTimeoutMs: budget }),
      (e: unknown) => e instanceof BatchError && /Timed out/.test(e.message)
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= budget - SCHEDULING_TOLERANCE_MS, `budget ${budget}: timed out early at ${elapsed} ms`);
    assert.ok(elapsed <= budget + SCHEDULING_TOLERANCE_MS, `budget ${budget}: timed out late at ${elapsed} ms`);
    assert.ok(polls >= 2, `budget ${budget}: expected a second poll, got ${polls}`);
  }
});

test("a short wait still sees a run that finishes on the second poll", async () => {
  let polls = 0;
  const fetchImpl = (async () => {
    polls++;
    return jsonRes({ job_id: "j1", latest_run: { status: polls === 1 ? "running" : "completed", stats: {} } });
  }) as typeof fetch;
  const job = await waitForJob("j1", { apiKey: "k", fetchImpl, pollTimeoutMs: 1000 });
  assert.equal(job.latest_run.status, "completed");
});

test("isPausedRun is false once the run has ended, even with pause_state kept", () => {
  assert.equal(isPausedRun({ status: "running", pause_state: "paused", stats: {} as never }), true);
  assert.equal(isPausedRun({ status: "pending", pause_state: "paused", stats: {} as never }), true);
  for (const status of ["stopped", "completed", "failed", "deleted"]) {
    assert.equal(isPausedRun({ status, pause_state: "paused", stats: {} as never }), false, status);
  }
});

test("waitForJob treats a transient failure as a missed poll and keeps waiting", async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    // The first poll and its 3 retries fail (no Retry-After, so backoff); the next poll succeeds.
    return n <= 4 ? jsonRes({}, 503) : jsonRes({ job_id: "j1", latest_run: { status: "completed", stats: {} } });
  }) as typeof fetch;
  const job = await waitForJob("j1", { apiKey: "k", fetchImpl, pollTimeoutMs: 8000 });
  assert.equal(job.latest_run.status, "completed");
  assert.equal(n, 5);
});

test("waitForJob honors Retry-After between polls, not only between retries", async () => {
  const t0 = Date.now();
  const starts: number[] = [];
  const fetchImpl = (async () => {
    starts.push(Date.now() - t0);
    // The first poll and its 3 retries get 429 with Retry-After: 1 (at about 0, 1, 2 and 3 s).
    // With 1.5 s left and a 1 s final-poll reserve, the waiter's own delay would be 500 ms; only
    // honoring Retry-After makes the next poll wait the full second.
    return starts.length <= 4
      ? jsonRes({}, 429, { "retry-after": "1" })
      : jsonRes({ job_id: "j1", latest_run: { status: "completed", stats: {} } });
  }) as typeof fetch;
  const job = await waitForJob("j1", { apiKey: "k", fetchImpl, pollTimeoutMs: 4500 });
  assert.equal(job.latest_run.status, "completed");
  assert.equal(starts.length, 5);
  const gaps = starts.slice(1).map((t, i) => t - starts[i]!);
  assert.ok(
    gaps.every((g) => g >= 950),
    `a request came sooner than Retry-After: ${starts}`
  );
});

test("waitForJob returns at once when the job has no run left", async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    return jsonRes({ job_id: "j1", status: "closed" });
  }) as typeof fetch;
  const job = await waitForJob("j1", { apiKey: "k", fetchImpl, pollTimeoutMs: 8000 });
  assert.equal(job.latest_run, undefined);
  assert.equal(n, 1);
});

test("waitForJob ends at once on a non-transient error such as 404", async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    return jsonRes({ code: "not_found" }, 404);
  }) as typeof fetch;
  await assert.rejects(
    () => waitForJob("j1", { apiKey: "k", fetchImpl, pollTimeoutMs: 8000 }),
    (e: unknown) => e instanceof BatchError && e.code === "BATCH_NOT_FOUND"
  );
  assert.equal(n, 1);
});
