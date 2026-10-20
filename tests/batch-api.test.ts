import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BatchError,
  batchBase,
  createJob,
  decodeResultsCursor,
  deleteJob,
  getJob,
  findResultRow,
  getTaskContent,
  listJobs,
  readResults,
  rerunJob,
  runFailure,
  stopJob,
  waitForJob,
} from "../src/batch-api.ts";

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

test("createJob keeps the bad-key message for a 401 unauthenticated problem", async () => {
  const body = {
    title: "Unauthenticated (unauthenticated)",
    status: 401,
    code: "unauthenticated",
    detail: "Invalid API key.",
  };
  const fetchImpl = (async () => new Response(JSON.stringify(body), { status: 401 })) as typeof fetch;
  await assert.rejects(
    () => createJob({ tasks: [{ url: "https://example.com" }] }, { apiKey: "k", fetchImpl }),
    (e: unknown) =>
      e instanceof BatchError &&
      e.code === "AUTH_INVALID" &&
      e.message === "Zenrows rejected the API key for the Batch API."
  );
});

test("createJob keeps AUTH_INVALID for 401 subscription_inactive but points to Billing", async () => {
  const body = {
    title: "Subscription not active (subscription_inactive)",
    status: 401,
    code: "subscription_inactive",
    detail: "Subscription is not active.",
  };
  const fetchImpl = (async () => new Response(JSON.stringify(body), { status: 401 })) as typeof fetch;
  await assert.rejects(
    () => createJob({ tasks: [{ url: "https://example.com" }] }, { apiKey: "k", fetchImpl }),
    (e: unknown) =>
      e instanceof BatchError &&
      e.code === "AUTH_INVALID" &&
      e.status === 401 &&
      /app\.zenrows\.com\/billing/.test(e.message) &&
      /subscription_inactive/.test(e.detail ?? "")
  );
});

test("createJob maps 404 to BATCH_NOT_FOUND", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ title: "not found" }), { status: 404 })) as typeof fetch;
  await assert.rejects(
    () => getJob("missing", { apiKey: "k", fetchImpl }),
    (e: unknown) => e instanceof BatchError && e.code === "BATCH_NOT_FOUND"
  );
});

test("createJob maps 429 quota_exceeded to BATCH_QUOTA_EXCEEDED, naming the shared active-jobs limit", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        code: "quota_exceeded",
        detail: "Account already has 3 active jobs; max 3 allowed concurrently.",
      }),
      { status: 429 }
    )) as typeof fetch;
  await assert.rejects(
    () => createJob({ tasks: [] }, { apiKey: "k", fetchImpl }),
    (e: unknown) => {
      assert.ok(e instanceof BatchError);
      assert.equal(e.code, "BATCH_QUOTA_EXCEEDED");
      assert.equal(e.serverCode, "quota_exceeded");
      assert.match(e.message, /3 active jobs by default, shared with Crawl/);
      assert.doesNotMatch(e.message, /credit available/);
      return true;
    }
  );
});

test("a 429 without quota_exceeded is BATCH_RATE_LIMITED", async () => {
  const fetchImpl = (async () =>
    new Response("slow down", { status: 429, headers: { "retry-after": "7" } })) as typeof fetch;
  await assert.rejects(
    () => createJob({ tasks: [] }, { apiKey: "k", fetchImpl }),
    (e: unknown) => e instanceof BatchError && e.code === "BATCH_RATE_LIMITED" && e.retryAfter === 7
  );
});

test("createJob maps 402 payment_required to BATCH_INSUFFICIENT_CREDITS, a code apart from the 429 limit", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ code: "payment_required", detail: "No credit." }), { status: 402 })) as typeof fetch;
  await assert.rejects(
    () => createJob({ tasks: [] }, { apiKey: "k", fetchImpl }),
    (e: unknown) => {
      assert.ok(e instanceof BatchError);
      assert.equal(e.code, "BATCH_INSUFFICIENT_CREDITS");
      assert.equal(e.toJSON().server_code, "payment_required");
      assert.match(e.message, /no credits left/);
      return true;
    }
  );
});

test("a 400 is BATCH_INVALID_REQUEST with server_code and the invalid tasks as data", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        code: "invalid_argument",
        detail: "1 invalid task",
        invalid_tasks: [{ index: 0, reason: "invalid_external_id" }],
      }),
      { status: 400 }
    )) as typeof fetch;

  await assert.rejects(
    () => createJob({ tasks: [{}] }, { apiKey: "k", fetchImpl }),
    (e: unknown) => {
      assert.ok(e instanceof BatchError);
      assert.equal(e.code, "BATCH_INVALID_REQUEST");
      assert.match(e.message, /#0: invalid_external_id/);
      const j = e.toJSON();
      assert.equal(j.server_code, "invalid_argument");
      assert.deepEqual(j.invalid_tasks, [{ index: 0, reason: "invalid_external_id" }]);
      return true;
    }
  );
});

test("409 codes map to their own MCP codes", async () => {
  const cases: Record<string, string> = {
    run_not_stoppable: "BATCH_RUN_ENDED",
    run_not_terminal: "BATCH_RUN_NOT_FINISHED",
    no_matching_tasks: "BATCH_NO_MATCHING_TASKS",
    partial_rerun_window_expired: "BATCH_RERUN_WINDOW_EXPIRED",
    idempotency_key_conflict: "BATCH_IDEMPOTENCY_CONFLICT",
    task_not_ready: "BATCH_TASK_NOT_READY",
    no_prior_run: "BATCH_NO_PRIOR_RUN",
    something_new: "BATCH_CONFLICT",
  };
  for (const [server, mcp] of Object.entries(cases)) {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ code: server, detail: "x" }), { status: 409 })) as typeof fetch;
    await assert.rejects(
      () => rerunJob("j", { apiKey: "k", fetchImpl }),
      (e: unknown) => e instanceof BatchError && e.code === mcp && e.serverCode === server,
      server
    );
  }
});

test("problem response that isn't valid JSON still produces a BatchError using the raw body as detail", async () => {
  const fetchImpl = (async () =>
    new Response("<html>502 Bad Gateway</html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    })) as typeof fetch;

  await assert.rejects(
    () => createJob({}, { apiKey: "k", fetchImpl }),
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
    () => stopJob("job-1", { apiKey: "k", fetchImpl }),
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

const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const run = (o: Record<string, unknown> = {}) => ({
  run_id: "R1",
  status: "running",
  stats: { total: 2, completed: 0, successful: 0, failed: 0 },
  ...o,
});

test("a create with an idempotency key retries a 503 with the same key, and a create without one never retries", async () => {
  const keys: (string | null)[] = [];
  const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    keys.push(new Headers(init?.headers).get("idempotency-key"));
    return keys.length === 1 ? jsonRes({ code: "internal" }, 503) : jsonRes({ job_id: "J1", latest_run: run() }, 201);
  }) as typeof fetch;
  const job = await createJob({}, { apiKey: "k", fetchImpl, idempotencyKey: "key-1" });
  assert.equal(job.job_id, "J1");
  assert.deepEqual(keys, ["key-1", "key-1"]);

  let calls = 0;
  const failing = (async () => {
    calls++;
    return jsonRes({ code: "internal" }, 503);
  }) as typeof fetch;
  await assert.rejects(
    () => createJob({}, { apiKey: "k", fetchImpl: failing }),
    (e: unknown) => e instanceof BatchError
  );
  assert.equal(calls, 1);
});

test("a create never retries the 429 job limit, which carries no Retry-After", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return jsonRes({ code: "quota_exceeded" }, 429);
  }) as typeof fetch;
  await assert.rejects(
    () => createJob({}, { apiKey: "k", fetchImpl, idempotencyKey: "x" }),
    (e: unknown) => e instanceof BatchError && e.code === "BATCH_QUOTA_EXCEEDED"
  );
  assert.equal(calls, 1);
});

test("requests carry the extra headers, the API key and the user agent", async () => {
  let seen: Headers | undefined;
  const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    seen = new Headers(init?.headers);
    return jsonRes({ job_id: "J1", latest_run: run() });
  }) as typeof fetch;
  await getJob("J1", {
    apiKey: "k",
    fetchImpl,
    userAgent: "ua",
    headers: { "x-mcp-client-name": "c", "x-mcp-tool": "batch_status" },
  });
  assert.equal(seen?.get("x-api-key"), "k");
  assert.equal(seen?.get("x-mcp-client-name"), "c");
  assert.equal(seen?.get("x-mcp-tool"), "batch_status");
  assert.equal(seen?.get("user-agent"), "ua");
});

/** Task ids sort like the API's ULIDs: fixed width. */
const tid = (n: number) => `T${String(n).padStart(6, "0")}`;

/** A results API with `pages` pages of `size` rows; cursors are page numbers. */
function resultsApi(pages: number, size: number, seen: (string | null)[] = []) {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const c = url.searchParams.get("cursor");
    seen.push(c);
    const p = Number(c ?? 0);
    const results = Array.from({ length: size }, (_, i) => ({ task_id: tid(p * size + i) }));
    return jsonRes({ results, next_cursor: p + 1 < pages ? String(p + 1) : null });
  }) as typeof fetch;
}

test("readResults returns limit rows and a cursor that resumes mid-page without skipping or repeating", async () => {
  const fetchImpl = resultsApi(3, 1000);
  const ids: string[] = [];
  let cursor: string | undefined;
  let calls = 0;
  for (;;) {
    const read = await readResults("J1", { apiKey: "k", fetchImpl, limit: 400, cursor });
    calls++;
    assert.ok(read.results.length <= 400);
    ids.push(...read.results.map((r) => r.task_id));
    if (read.next_cursor === null) break;
    cursor = read.next_cursor;
  }
  assert.equal(ids.length, 3000);
  assert.equal(new Set(ids).size, 3000);
  assert.equal(ids[0], tid(0));
  assert.equal(ids[2999], tid(2999));
  assert.equal(calls, 8);
});

test("readResults defaults to 100 rows, never the whole job", async () => {
  const read = await readResults("J1", { apiKey: "k", fetchImpl: resultsApi(10, 1000) });
  assert.equal(read.results.length, 100);
  assert.notEqual(read.next_cursor, null);
});

test("readResults stops after 10 pages of a sparse filter and hands back a cursor", async () => {
  const read = await readResults("J1", { apiKey: "k", fetchImpl: resultsApi(50, 0), status: "processing", limit: 10 });
  assert.equal(read.results.length, 0);
  assert.equal(read.pages, 10);
  assert.notEqual(read.next_cursor, null);
});

test("readResults sends the status filter and reads an explicit run", async () => {
  let url = "";
  const fetchImpl = (async (input: RequestInfo | URL) => {
    url = String(input);
    return jsonRes({ results: [], next_cursor: null });
  }) as typeof fetch;
  await readResults("J1", { apiKey: "k", fetchImpl, status: "processing", runId: "R0" });
  assert.match(url, /\/jobs\/J1\/runs\/R0\/results\?status=processing$/);
});

test("a cursor this server did not make is INVALID_USAGE", () => {
  assert.throws(
    () => decodeResultsCursor("not-a-cursor"),
    (e: unknown) => e instanceof BatchError && e.code === "INVALID_USAGE"
  );
});

test("waitForJob returns the current state, not an error, when the wait runs out", async () => {
  const fetchImpl = (async () => jsonRes({ job_id: "J1", latest_run: run() })) as typeof fetch;
  const out = await waitForJob("J1", { apiKey: "k", fetchImpl, timeout: 1, pollDelayMs: 50 });
  assert.equal(out.timedOut, true);
  assert.equal(out.job?.latest_run?.status, "running");
});

test("waitForJob returns at once on a paused run instead of polling to the deadline", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return jsonRes({ job_id: "J1", latest_run: run({ pause_state: "paused" }) });
  }) as typeof fetch;
  const t0 = Date.now();
  const out = await waitForJob("J1", { apiKey: "k", fetchImpl, timeout: 30 });
  assert.equal(out.timedOut, false);
  assert.equal(calls, 1);
  assert.ok(Date.now() - t0 < 1000);
});

test("waitForJob does not treat pause_state left on a completed run as paused", async () => {
  const fetchImpl = (async () =>
    jsonRes({ job_id: "J1", latest_run: run({ status: "completed", pause_state: "paused" }) })) as typeof fetch;
  const out = await waitForJob("J1", { apiKey: "k", fetchImpl, timeout: 5 });
  assert.equal(out.job?.latest_run?.status, "completed");
});

test("waitForJob polls through transient errors and returns on a terminal run", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) throw new TypeError("socket hang up");
    if (calls === 2) return jsonRes({ code: "internal" }, 503);
    return jsonRes({ job_id: "J1", latest_run: run({ status: calls < 4 ? "running" : "completed" }) });
  }) as typeof fetch;
  const polls: number[] = [];
  const out = await waitForJob("J1", {
    apiKey: "k",
    fetchImpl,
    timeout: 20,
    pollDelayMs: 20,
    onPoll: (_j, n) => void polls.push(n),
  });
  assert.equal(out.job?.latest_run?.status, "completed");
  assert.equal(out.timedOut, false);
  assert.ok(polls.length >= 1);
});

test("waitForJob ends at once on a 404", async () => {
  const fetchImpl = (async () => jsonRes({ code: "not_found" }, 404)) as typeof fetch;
  await assert.rejects(
    () => waitForJob("J1", { apiKey: "k", fetchImpl, timeout: 20 }),
    (e: unknown) => e instanceof BatchError && e.code === "BATCH_NOT_FOUND"
  );
});

test("waitForJob returns on a failed run instead of polling to the deadline", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return jsonRes({ job_id: "J1", latest_run: run({ status: "failed", failure_reason: "api_key_cap_reached" }) });
  }) as typeof fetch;
  const out = await waitForJob("J1", { apiKey: "k", fetchImpl, timeout: 5 });
  assert.equal(out.job?.latest_run?.status, "failed");
  assert.equal(calls, 1);
});

test("runFailure gives each failure_reason the code of the matching HTTP error", () => {
  assert.equal(runFailure("insufficient_credits").code, "BATCH_INSUFFICIENT_CREDITS");
  assert.equal(runFailure("api_key_cap_reached").code, "BATCH_KEY_CAP_REACHED");
  assert.equal(runFailure("subscription_inactive").code, "AUTH_INVALID");
  assert.match(runFailure("subscription_inactive").advice, /billing/i);
  assert.equal(runFailure("something_else").code, "BATCH_RUN_FAILED");
  assert.equal(runFailure(undefined).code, "BATCH_RUN_FAILED");
});

test("getTaskContent reads a text body", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    assert.match(String(input), /\/jobs\/J1\/tasks\/T1\/content$/);
    return new Response("<html>hi</html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }) as typeof fetch;
  const c = await getTaskContent("J1", "T1", { apiKey: "k", fetchImpl });
  assert.deepEqual(c, { kind: "text", contentType: "text/html; charset=utf-8", body: "<html>hi</html>" });
});

test("getTaskContent does not read a binary body", async () => {
  const fetchImpl = (async () =>
    new Response(new Uint8Array([37, 80, 68, 70]), {
      status: 200,
      headers: { "content-type": "application/pdf", "content-length": "4" },
    })) as typeof fetch;
  const c = await getTaskContent("J1", "T1", { apiKey: "k", fetchImpl, runId: "R0" });
  assert.deepEqual(c, { kind: "binary", contentType: "application/pdf", bytes: 4 });
});

test("getTaskContent follows a redirect to the presigned URL without the API key", async () => {
  const calls: { url: string; key: string | null }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), key: new Headers(init?.headers).get("x-api-key") });
    if (calls.length === 1) {
      assert.equal(init?.redirect, "manual");
      return new Response(null, { status: 302, headers: { location: "https://s3.example/obj?sig=1" } });
    }
    return new Response("%PDF", { status: 200, headers: { "content-type": "application/pdf" } });
  }) as typeof fetch;
  const c = await getTaskContent("J1", "T1", { apiKey: "k", fetchImpl });
  assert.deepEqual(c, { kind: "binary", contentType: "application/pdf", resultUrl: "https://s3.example/obj?sig=1" });
  assert.equal(calls[0]!.key, "k");
  assert.equal(calls[1]!.key, null);
});

test("getTaskContent maps 410 to BATCH_RESULT_EXPIRED and 422 to BATCH_TASK_FAILED with the stored error", async () => {
  const expired = (async () => jsonRes({ code: "result_expired", detail: "Result has expired" }, 410)) as typeof fetch;
  await assert.rejects(
    () => getTaskContent("J1", "T1", { apiKey: "k", fetchImpl: expired }),
    (e: unknown) => e instanceof BatchError && e.code === "BATCH_RESULT_EXPIRED" && /14 days/.test(e.message)
  );
  const failed = (async () =>
    jsonRes({ code: "RESP001", status: 422, detail: "Could not get content" }, 422)) as typeof fetch;
  await assert.rejects(
    () => getTaskContent("J1", "T1", { apiKey: "k", fetchImpl: failed }),
    (e: unknown) =>
      e instanceof BatchError &&
      e.code === "BATCH_TASK_FAILED" &&
      (e.toJSON().task_error as { code: string }).code === "RESP001"
  );
});

test("rerunJob sends the status filter and the idempotency key; no filter is a full rerun", async () => {
  const seen: { url: string; key: string | null; method?: string }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), key: new Headers(init?.headers).get("idempotency-key"), method: init?.method });
    return jsonRes({ job_id: "J1", latest_run: run({ run_id: "R2" }), retried_tasks: 1, inherited_tasks: 1 }, 202);
  }) as typeof fetch;
  await rerunJob("J1", { apiKey: "k", fetchImpl, statuses: ["failed", "pending"], idempotencyKey: "rk" });
  await rerunJob("J1", { apiKey: "k", fetchImpl });
  assert.equal(seen[0]!.method, "POST");
  assert.match(seen[0]!.url, /\/jobs\/J1\/rerun\?status=failed%2Cpending$/);
  assert.equal(seen[0]!.key, "rk");
  assert.match(seen[1]!.url, /\/jobs\/J1\/rerun$/);
});

test("deleteJob accepts an empty 202, and listJobs sends its filters", async () => {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(`${init?.method} ${String(input)}`);
    return init?.method === "DELETE" ? new Response(null, { status: 202 }) : jsonRes({ jobs: [], next_cursor: null });
  }) as typeof fetch;
  await deleteJob("J1", { apiKey: "k", fetchImpl });
  await listJobs({ apiKey: "k", fetchImpl, limit: 5, status: "closed", type: "regular", cursor: "c1" });
  assert.match(urls[0]!, /^DELETE .*\/jobs\/J1$/);
  assert.match(urls[1]!, /^GET .*\/jobs\?cursor=c1&limit=5&status=closed&type=regular$/);
});

test("readResults resumes mid-page by task id, so rows that leave a processing filter do not hide the rest", async () => {
  // A, B, C are processing; after the first call A and B finish and drop out of the filter.
  let finished: string[] = [];
  const fetchImpl = (async () =>
    jsonRes({
      results: ["A", "B", "C"].filter((t) => !finished.includes(t)).map((task_id) => ({ task_id })),
      next_cursor: null,
    })) as typeof fetch;
  const first = await readResults("J1", { apiKey: "k", fetchImpl, status: "processing", limit: 2 });
  assert.deepEqual(
    first.results.map((r) => r.task_id),
    ["A", "B"]
  );
  assert.notEqual(first.next_cursor, null);
  finished = ["A", "B"];
  const second = await readResults("J1", { apiKey: "k", fetchImpl, status: "processing", cursor: first.next_cursor! });
  assert.deepEqual(
    second.results.map((r) => r.task_id),
    ["C"]
  );
  assert.equal(second.next_cursor, null);
});

test("GETs and polls retry a 500, which the API sends when a storage read fails", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return calls === 1
      ? jsonRes({ code: "internal" }, 500)
      : jsonRes({ job_id: "J1", latest_run: run({ status: "completed" }) });
  }) as typeof fetch;
  const out = await waitForJob("J1", { apiKey: "k", fetchImpl, timeout: 20 });
  assert.equal(out.job?.latest_run?.status, "completed");
  assert.equal(calls, 2);
});

test("getTaskContent keeps the request timeout armed while the body is read", async () => {
  const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    const signal = init!.signal!;
    // Headers arrive at once; the body never does, until the signal aborts it.
    const body = new ReadableStream({
      start(controller) {
        signal.addEventListener("abort", () => controller.error(new Error("aborted")));
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  const t0 = Date.now();
  await assert.rejects(
    () => getTaskContent("J1", "T1", { apiKey: "k", fetchImpl, timeoutMs: 50, deadline: Date.now() + 400 }),
    (e: unknown) => e instanceof BatchError && e.code === "BACKEND_UNAVAILABLE"
  );
  assert.ok(Date.now() - t0 < 2000);
});

test("getTaskContent retries a body that broke off mid-read", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("<html>"));
          controller.error(new Error("socket hang up"));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    }
    return new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  const c = await getTaskContent("J1", "T1", { apiKey: "k", fetchImpl });
  assert.deepEqual(c, { kind: "text", contentType: "text/html", body: "<html>ok</html>" });
  assert.equal(calls, 2);
});

test("findResultRow finds a row past the tenth page, and hands back a cursor when its budget runs out", async () => {
  const fetchImpl = resultsApi(15, 1000);
  const found = await findResultRow("J1", tid(11_500), { apiKey: "k", fetchImpl });
  assert.deepEqual(found, { row: { task_id: tid(11_500) } });
  const partial = await findResultRow("J1", tid(11_500), { apiKey: "k", fetchImpl, budgetMs: 0 });
  assert.ok("cursor" in partial);
  const resumed = await findResultRow("J1", tid(11_500), {
    apiKey: "k",
    fetchImpl,
    cursor: (partial as { cursor: string }).cursor,
  });
  assert.ok("row" in resumed);
  assert.deepEqual(await findResultRow("J1", "nope", { apiKey: "k", fetchImpl }), { notFound: true });
});

test("the idempotency conflict advice keeps the key for the same request", async () => {
  const fetchImpl = (async () => jsonRes({ code: "idempotency_key_conflict" }, 409)) as typeof fetch;
  await assert.rejects(
    () => createJob({}, { apiKey: "k", fetchImpl, idempotencyKey: "x" }),
    (e: unknown) =>
      e instanceof BatchError &&
      e.code === "BATCH_IDEMPOTENCY_CONFLICT" &&
      /keep this key/.test(e.message) &&
      /batch_list/.test(e.message) &&
      !/or none/.test(e.message)
  );
});
