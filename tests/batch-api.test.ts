import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BatchError,
  batchBase,
  createJob,
  getJob,
  listResults,
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
        latest_run: { status: "completed", stats: { total: 1, completed: 1, successful: 1, failed: 0 } },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const job = await getJob("job-1", { apiKey: "k", fetchImpl });
  assert.equal(job.job_id, "job-1");
  assert.equal(job.latest_run.status, "completed");
});

test("createJob maps 401 to AUTH_INVALID", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ detail: "bad key" }), { status: 401 })) as typeof fetch;
  await assert.rejects(
    () => createJob({ tasks: [{ url: "https://example.com" }] }, { apiKey: "bad", fetchImpl }),
    (e: unknown) => e instanceof BatchError && e.code === "AUTH_INVALID"
  );
});

test("createJob maps 404 to BATCH_NOT_FOUND", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ title: "not found" }), { status: 404 })) as typeof fetch;
  await assert.rejects(
    () => getJob("missing", { apiKey: "k", fetchImpl }),
    (e: unknown) => e instanceof BatchError && e.code === "BATCH_NOT_FOUND"
  );
});

test("createJob maps 429 to BATCH_QUOTA_EXCEEDED with a concurrency-specific message", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ title: "too many" }), { status: 429 })) as typeof fetch;
  await assert.rejects(
    () => createJob({ tasks: [] }, { apiKey: "k", fetchImpl }),
    (e: unknown) => {
      assert.ok(e instanceof BatchError);
      assert.equal(e.code, "BATCH_QUOTA_EXCEEDED");
      assert.match(e.message, /concurrent active jobs/);
      return true;
    }
  );
});

test("createJob maps 402 to BATCH_QUOTA_EXCEEDED with a billing-specific message", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ title: "no credit" }), { status: 402 })) as typeof fetch;
  await assert.rejects(
    () => createJob({ tasks: [] }, { apiKey: "k", fetchImpl }),
    (e: unknown) => {
      assert.ok(e instanceof BatchError);
      assert.equal(e.code, "BATCH_QUOTA_EXCEEDED");
      assert.match(e.message, /no credit/);
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
    new Response("not json", { status: 200, headers: { "content-type": "text/plain" } })) as typeof fetch;

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

  const results = await listResults("job-1", { apiKey: "k", fetchImpl });
  assert.deepEqual(results.map((r) => r.task_id), ["a", "b", "c"]);
  assert.deepEqual(seenCursors, [undefined, "page2"]);
});

test("waitForJob polls until a terminal status is reached", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    const status = calls < 3 ? "running" : "completed";
    return new Response(
      JSON.stringify({
        job_id: "job-1",
        latest_run: { status, stats: { total: 1, completed: calls >= 3 ? 1 : 0, successful: 0, failed: 0 } },
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
        latest_run: { status: "running", stats: { total: 1, completed: 0, successful: 0, failed: 0 } },
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
