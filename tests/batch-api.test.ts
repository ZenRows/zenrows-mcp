import assert from "node:assert/strict";
import { test } from "node:test";
import { BatchError, createJob, getJob } from "../src/batch-api.ts";

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
