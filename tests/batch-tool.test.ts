import assert from "node:assert/strict";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  applyAdaptiveStealth,
  keepHtmlTasksHtml,
  registerBatchTools,
  runOutcome,
  taskSchema,
  toTaskParams,
} from "../src/tools/batch.ts";

type Task = { zenrows_params?: Record<string, string> };

test("applyAdaptiveStealth adds mode=auto to every task by default", () => {
  const tasks: Task[] = [{}, { zenrows_params: { autoparse: "true" } }];
  applyAdaptiveStealth({}, tasks);
  assert.deepEqual(tasks, [
    { zenrows_params: { mode: "auto" } },
    { zenrows_params: { autoparse: "true", mode: "auto" } },
  ]);
});

test("applyAdaptiveStealth skips everything when the job forces js_render or premium_proxy", () => {
  for (const job of [{ js_render: true }, { premium_proxy: "true" }, { mode: "auto" }]) {
    const tasks: Task[] = [{}];
    applyAdaptiveStealth(job, tasks);
    assert.deepEqual(tasks, [{}], JSON.stringify(job));
  }
});

test("applyAdaptiveStealth skips only the tasks that force flags or set mode", () => {
  const tasks: Task[] = [
    { zenrows_params: { js_render: "true" } },
    { zenrows_params: { premium_proxy: "true" } },
    { zenrows_params: { mode: "auto" } },
    { zenrows_params: { js_render: "false" } },
  ];
  applyAdaptiveStealth({ proxy_country: "us" }, tasks);
  assert.deepEqual(
    tasks.map((t) => t.zenrows_params?.mode),
    [undefined, undefined, "auto", "auto"]
  );
});

test("batch_create sends mode=auto per task, and mode_auto=false opts out", async () => {
  let handler: ((p: unknown) => Promise<unknown>) | undefined;
  const fake = {
    registerTool: (name: string, _c: unknown, h: typeof handler) => {
      if (name === "batch_create") handler = h;
    },
  };
  registerBatchTools(fake as never, "k");
  const bodies: { tasks: Task[]; zenrows_params?: Record<string, string> }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ job_id: "j", latest_run: { status: "running" } }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await handler!({ urls: ["https://a.com", "https://b.com"] });
    await handler!({ urls: ["https://a.com"], mode_auto: false });
    await handler!({ urls: ["https://a.com"], premium_proxy: true });
  } finally {
    globalThis.fetch = orig;
  }
  assert.deepEqual(
    bodies[0]!.tasks.map((t) => t.zenrows_params?.mode),
    ["auto", "auto"]
  );
  assert.equal(bodies[0]!.zenrows_params, undefined);
  assert.equal(bodies[1]!.tasks[0]!.zenrows_params, undefined);
  assert.equal(bodies[2]!.tasks[0]!.zenrows_params, undefined);
  assert.equal(bodies[2]!.zenrows_params?.premium_proxy, "true");
});

test("batch_create: a default task and a js_render task in one job get mode=auto only on the default one", async () => {
  let handler: ((p: unknown) => Promise<unknown>) | undefined;
  registerBatchTools(
    {
      registerTool: (name: string, _c: unknown, h: typeof handler) => {
        if (name === "batch_create") handler = h;
      },
    } as never,
    "k"
  );
  const bodies: { tasks: Task[]; zenrows_params?: Record<string, string> }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ job_id: "j", latest_run: { status: "running" } }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await handler!({
      tasks: [{ url: "https://a.com" }, { url: "https://b.com", zenrows_params: { js_render: true } }],
      proxy_country: "GB",
    });
    await handler!({ urls: ["https://a.com"], js_render: true });
  } finally {
    globalThis.fetch = orig;
  }
  assert.deepEqual(
    bodies[0]!.tasks.map((t) => t.zenrows_params),
    [{ mode: "auto" }, { js_render: "true" }]
  );
  assert.deepEqual(bodies[0]!.zenrows_params, { proxy_country: "gb" });
  assert.equal(bodies[1]!.tasks[0]!.zenrows_params, undefined);
  assert.deepEqual(bodies[1]!.zenrows_params, { js_render: "true" });
});

type Handler = (p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function captureTool(name: string): Handler {
  let handler: Handler | undefined;
  registerBatchTools(
    {
      registerTool: (n: string, _c: unknown, h: Handler) => {
        if (n === name) handler = h;
      },
    } as never,
    "k"
  );
  return handler!;
}

async function withFetch<T>(
  respond: (url: string, init?: RequestInit) => Response,
  fn: () => Promise<T>
): Promise<{ result: T; calls: { url: string; body?: unknown; headers: Headers }[] }> {
  const calls: { url: string; body?: unknown; headers: Headers }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
    calls.push({
      url: String(u),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init?.headers),
    });
    return respond(String(u), init);
  }) as typeof fetch;
  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.fetch = orig;
  }
}

const created = () =>
  new Response(JSON.stringify({ job_id: "j", latest_run: { status: "running" } }), {
    status: 201,
    headers: { "content-type": "application/json" },
  });

test("toTaskParams folds flat scrape params into zenrows_params, flat keys win", () => {
  assert.deepEqual(
    toTaskParams({
      url: "https://a.com",
      extract: "auto",
      js_render: true,
      zenrows_params: { js_render: false, wait: 5 },
    }),
    { params: { js_render: "true", wait: "5", extract: "auto" }, unknown: [] }
  );
  assert.deepEqual(toTaskParams({ url: "https://a.com" }), { params: undefined, unknown: [] });
  assert.deepEqual(toTaskParams({ url: "https://a.com", extrct: "auto" }).unknown, ["extrct"]);
});

test("taskSchema keeps flat keys instead of stripping them", () => {
  assert.deepEqual(taskSchema.parse({ url: "https://a.com", extract: "auto" }), {
    url: "https://a.com",
    extract: "auto",
  });
});

test("batch_create sends a task's flat extract param as zenrows_params", async () => {
  const { calls } = await withFetch(created, () =>
    captureTool("batch_create")({ tasks: [{ url: "https://a.com", extract: "auto" }], mode_auto: false })
  );
  const body = calls[0]!.body as { tasks: Task[] };
  assert.deepEqual(body.tasks[0]!.zenrows_params, { extract: "auto" });
});

test("batch_create ignores an unknown task field, as before, and names it in warnings", async () => {
  const { result, calls } = await withFetch(created, () =>
    captureTool("batch_create")({ tasks: [{ url: "https://a.com", extrct: "auto" }], mode_auto: false })
  );
  assert.notEqual(result.isError, true);
  assert.equal(calls.length, 1);
  assert.equal((calls[0]!.body as { tasks: Task[] }).tasks[0]!.zenrows_params, undefined);
  const out = JSON.parse(result.content[0]!.text);
  assert.equal(out.ok, true);
  assert.match(out.warnings[0], /tasks\[0\]: ignored unknown field\(s\) extrct/);
});

test("batch_create adds no warnings key when every task field is known", async () => {
  const { result } = await withFetch(created, () => captureTool("batch_create")({ urls: ["https://a.com"] }));
  assert.equal("warnings" in JSON.parse(result.content[0]!.text), false);
});

test("batch_create treats response_type html as the default and sends no response_type", async () => {
  const { calls } = await withFetch(created, async () => {
    const h = captureTool("batch_create");
    await h({ urls: ["https://a.com"], response_type: "html", mode_auto: false });
    await h({ urls: ["https://a.com"], response_type: "markdown", mode_auto: false });
  });
  assert.equal((calls[0]!.body as { zenrows_params?: unknown }).zenrows_params, undefined);
  assert.deepEqual((calls[1]!.body as { zenrows_params?: unknown }).zenrows_params, { response_type: "markdown" });
});

test("batch_cancel reads the stopped Run that the stop endpoint returns", async () => {
  const run = {
    run_id: "r1",
    job_id: "j1",
    run_sequence: 1,
    status: "stopped",
    stats: { total: 10, completed: 4, successful: 3, failed: 1 },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:01:00Z",
  };
  const { result, calls } = await withFetch(
    () => new Response(JSON.stringify(run), { status: 200, headers: { "content-type": "application/json" } }),
    () => captureTool("batch_cancel")({ job_id: "j1" })
  );
  assert.match(calls[0]!.url, /\/jobs\/j1\/stop$/);
  const out = JSON.parse(result.content[0]!.text);
  assert.equal(out.job_id, "j1");
  assert.equal(out.run_id, "r1");
  assert.equal(out.status, "stopped");
  assert.deepEqual(out.stats, run.stats);
});

test("through a real MCP client, a flat per-task param reaches the request", async () => {
  const server = new McpServer({ name: "t", version: "0" });
  registerBatchTools(server, "k");
  const client = new Client({ name: "c", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const { calls } = await withFetch(created, () =>
      client.callTool({
        name: "batch_create",
        arguments: { tasks: [{ url: "https://a.com", extract: "auto" }], mode_auto: false },
      })
    );
    assert.deepEqual((calls[0]!.body as { tasks: Task[] }).tasks[0]!.zenrows_params, { extract: "auto" });
  } finally {
    await client.close();
    await server.close();
  }
});

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

test("batch_create sends a fresh Idempotency-Key per call, or the one given", async () => {
  const { calls } = await withFetch(created, async () => {
    const h = captureTool("batch_create");
    await h({ urls: ["https://a.com"] });
    await h({ urls: ["https://a.com"] });
    await h({ urls: ["https://a.com"], idempotency_key: "my-key" });
  });
  const keys = calls.map((c) => c.headers.get("idempotency-key"));
  assert.ok(keys[0] && keys[1]);
  assert.notEqual(keys[0], keys[1]);
  assert.equal(keys[2], "my-key");
});

test("taskSchema rejects non-string metadata values with a clear message", () => {
  const bad = taskSchema.safeParse({ url: "https://a.com", metadata: { sku: 123 } });
  assert.equal(bad.success, false);
  assert.match(JSON.stringify(bad.error?.issues), /metadata values must be strings/);
  assert.equal(taskSchema.safeParse({ url: "https://a.com", metadata: { sku: "123" } }).success, true);
  assert.equal(taskSchema.safeParse({ url: "https://a.com", metadata: { nested: { a: "b" } } }).success, false);
});

test("runOutcome reports a failed run as ok:false with its failure_reason and next step", () => {
  const out = runOutcome("j1", {
    run_id: "r1",
    status: "failed",
    failure_reason: "insufficient_credits",
    failure_detail: "No credits left.",
    stats: { total: 10, completed: 4, successful: 4, failed: 0 },
  });
  assert.equal(out.ok, false);
  assert.equal((out as { code?: string }).code, "BATCH_RUN_FAILED");
  assert.equal((out as { failure_reason?: string }).failure_reason, "insufficient_credits");
  assert.equal((out as { failure_detail?: string }).failure_detail, "No credits left.");
  assert.match(String((out as { message?: string }).message), /billing/);

  const cap = runOutcome("j1", { status: "failed", failure_reason: "api_key_cap_reached", stats: {} as never });
  assert.match(String((cap as { message?: string }).message), /credit caps/);
});

test("runOutcome flags a paused run and leaves a normal run ok:true", () => {
  const paused = runOutcome("j1", { status: "running", pause_state: "paused", stats: {} as never });
  assert.equal(paused.ok, true);
  assert.equal((paused as { paused?: boolean }).paused, true);
  const running = runOutcome("j1", { status: "running", stats: {} as never });
  assert.equal((running as { paused?: boolean }).paused, undefined);
});

for (const [tool, args, body] of [
  [
    "batch_status",
    { job_id: "j1" },
    { job_id: "j1", latest_run: { status: "failed", failure_reason: "subscription_inactive", stats: {} } },
  ],
  [
    "batch_wait",
    { job_id: "j1", timeout_ms: 5000 },
    { job_id: "j1", latest_run: { status: "failed", failure_reason: "subscription_inactive", stats: {} } },
  ],
] as const) {
  test(`${tool} returns ok:false for a failed run`, async () => {
    const { result } = await withFetch(
      () => ok(body),
      () => captureTool(tool)(args)
    );
    const out = JSON.parse(result.content[0]!.text);
    assert.equal(out.ok, false);
    assert.equal(out.failure_reason, "subscription_inactive");
  });
}

test("batch_wait returns at once on a paused run, with paused:true", async () => {
  const { result, calls } = await withFetch(
    () => ok({ job_id: "j1", latest_run: { status: "running", pause_state: "paused", stats: {} } }),
    () => captureTool("batch_wait")({ job_id: "j1", timeout_ms: 60_000 })
  );
  assert.equal(calls.length, 1);
  const out = JSON.parse(result.content[0]!.text);
  assert.equal(out.paused, true);
  assert.match(out.message, /paused/);
});

test("batch_results returns one page with next_cursor and resumes from cursor", async () => {
  const { result, calls } = await withFetch(
    (url) =>
      new URL(url).searchParams.get("cursor") === "c2"
        ? ok({ results: [{ task_id: "b" }], next_cursor: null })
        : ok({ results: [{ task_id: "a" }], next_cursor: "c2" }),
    async () => {
      const h = captureTool("batch_results");
      const first = JSON.parse((await h({ job_id: "j1", limit: 1 })).content[0]!.text);
      const second = JSON.parse(
        (await h({ job_id: "j1", cursor: first.next_cursor, status: "processing" })).content[0]!.text
      );
      return { first, second };
    }
  );
  assert.equal(result.first.count, 1);
  assert.equal(result.first.next_cursor, "c2");
  assert.equal(result.second.next_cursor, null);
  assert.deepEqual(result.second.results, [{ task_id: "b" }]);
  assert.equal(new URL(calls[1]!.url).searchParams.get("status"), "processing");
});

test("batch_cancel on a completed or failed run reports run_not_stoppable (409)", async () => {
  const { result } = await withFetch(
    () =>
      new Response(
        JSON.stringify({ code: "run_not_stoppable", title: "Conflict", detail: "Run is not in a stoppable state." }),
        { status: 409, headers: { "content-type": "application/problem+json" } }
      ),
    () => captureTool("batch_cancel")({ job_id: "j1" })
  );
  assert.equal(result.isError, true);
  const out = JSON.parse(result.content[0]!.text);
  assert.equal(out.code, "BATCH_FAILED");
  assert.equal(out.server_code, "run_not_stoppable");
});

test("batch_status on a 401 subscription_inactive keeps AUTH_INVALID, points to Billing, and adds server_code", async () => {
  const { result } = await withFetch(
    () =>
      new Response(
        JSON.stringify({
          title: "Subscription not active (subscription_inactive)",
          status: 401,
          code: "subscription_inactive",
          detail: "Subscription is not active.",
        }),
        { status: 401, headers: { "content-type": "application/problem+json" } }
      ),
    () => captureTool("batch_status")({ job_id: "j1" })
  );
  assert.equal(result.isError, true);
  const out = JSON.parse(result.content[0]!.text);
  assert.equal(out.code, "AUTH_INVALID");
  assert.equal(out.status, 401);
  assert.equal(out.server_code, "subscription_inactive");
  assert.match(out.message, /app\.zenrows\.com\/billing/);
});

test("runOutcome never reports a run that stopped or completed while paused as paused", () => {
  for (const status of ["stopped", "completed", "deleted"]) {
    const out = runOutcome("j1", { status, pause_state: "paused", stats: {} as never });
    assert.equal((out as { paused?: boolean }).paused, undefined, status);
  }
  const pending = runOutcome("j1", { status: "pending", pause_state: "paused", stats: {} as never });
  assert.equal((pending as { paused?: boolean }).paused, true);
});

test("batch_wait returns a run that stopped while paused as stopped, not paused", async () => {
  const { result } = await withFetch(
    () => ok({ job_id: "j1", latest_run: { status: "stopped", pause_state: "paused", stats: {} } }),
    () => captureTool("batch_wait")({ job_id: "j1", timeout_ms: 5000 })
  );
  const out = JSON.parse(result.content[0]!.text);
  assert.equal(out.status, "stopped");
  assert.equal(out.paused, undefined);
});

test("response_type html wins over a nested response_type, and a nested html is never sent", async () => {
  const { calls } = await withFetch(created, async () => {
    const h = captureTool("batch_create");
    await h({
      urls: ["https://a.com"],
      response_type: "html",
      zenrows_params: { response_type: "pdf" },
      mode_auto: false,
    });
    await h({ urls: ["https://a.com"], zenrows_params: { response_type: "html", autoparse: true }, mode_auto: false });
    await h({ urls: ["https://a.com"], zenrows_params: { response_type: "pdf" }, mode_auto: false });
    await h({
      tasks: [
        { url: "https://a.com", response_type: "html" },
        { url: "https://b.com", zenrows_params: { response_type: "HTML", wait: 1 } },
      ],
      mode_auto: false,
    });
  });
  const jobParams = calls.map((c) => (c.body as { zenrows_params?: Record<string, string> }).zenrows_params);
  assert.equal(jobParams[0], undefined);
  assert.deepEqual(jobParams[1], { autoparse: "true" });
  assert.deepEqual(jobParams[2], { response_type: "pdf" });
  const tasks = (calls[3]!.body as { tasks: Task[] }).tasks;
  assert.equal(tasks[0]!.zenrows_params, undefined);
  assert.deepEqual(tasks[1]!.zenrows_params, { wait: "1" });
});

test("batch_cancel on an already-stopped run returns the run unchanged, ok:true", async () => {
  const run = {
    run_id: "r1",
    job_id: "j1",
    status: "stopped",
    stats: { total: 5, completed: 2, successful: 2, failed: 0 },
  };
  const { result } = await withFetch(
    () => ok(run),
    async () => {
      const h = captureTool("batch_cancel");
      await h({ job_id: "j1" });
      return h({ job_id: "j1" });
    }
  );
  assert.notEqual(result.isError, true);
  const out = JSON.parse(result.content[0]!.text);
  assert.equal(out.ok, true);
  assert.equal(out.status, "stopped");
  assert.deepEqual(out.stats, run.stats);
});

test("a per-task html never inherits the job's pdf or markdown", async () => {
  const { calls } = await withFetch(created, () =>
    captureTool("batch_create")({
      response_type: "pdf",
      tasks: [
        { url: "https://a.com", response_type: "html" },
        { url: "https://b.com" },
        { url: "https://c.com", zenrows_params: { response_type: "markdown" } },
      ],
      mode_auto: false,
    })
  );
  const body = calls[0]!.body as { tasks: Task[]; zenrows_params?: Record<string, string> };
  // The job sends no response_type, so the API has nothing to fill the html task with.
  assert.equal(body.zenrows_params?.response_type, undefined);
  assert.equal(body.tasks[0]!.zenrows_params?.response_type, undefined);
  assert.equal(body.tasks[1]!.zenrows_params?.response_type, "pdf");
  assert.equal(body.tasks[2]!.zenrows_params?.response_type, "markdown");
});

test("keepHtmlTasksHtml leaves the job alone when no task asks for html", () => {
  const job: Record<string, unknown> = { response_type: "markdown" };
  const tasks: Task[] = [{}, { zenrows_params: { wait: "1" } }];
  keepHtmlTasksHtml(job, tasks, [false, false]);
  assert.equal(job.response_type, "markdown");
  assert.deepEqual(tasks, [{}, { zenrows_params: { wait: "1" } }]);
});

test("applyAdaptiveStealth treats js_render and premium_proxy as on in any case, flat or nested", async () => {
  const forcing = ["TRUE", "True", "true", true];
  for (const v of forcing) {
    for (const key of ["js_render", "premium_proxy"]) {
      const { calls } = await withFetch(created, async () => {
        const h = captureTool("batch_create");
        await h({ tasks: [{ url: "https://a.com", [key]: v }] });
        await h({ tasks: [{ url: "https://a.com", zenrows_params: { [key]: v } }] });
        await h({ urls: ["https://a.com"], zenrows_params: { [key]: v } });
      });
      for (const [i, c] of calls.entries()) {
        const body = c.body as { tasks: Task[] };
        assert.equal(body.tasks[0]!.zenrows_params?.mode, undefined, `${key}=${JSON.stringify(v)} call ${i}`);
      }
    }
  }
  // "FALSE" is off, so automatic mode still applies.
  const { calls } = await withFetch(created, () =>
    captureTool("batch_create")({ tasks: [{ url: "https://a.com", js_render: "FALSE" }] })
  );
  assert.equal((calls[0]!.body as { tasks: Task[] }).tasks[0]!.zenrows_params?.mode, "auto");
});

test("a padded flag is not a valid boolean, so it does not force, and it is sent unchanged", async () => {
  const { calls } = await withFetch(created, () =>
    captureTool("batch_create")({ tasks: [{ url: "https://a.com", js_render: " TRUE " }] })
  );
  const params = (calls[0]!.body as { tasks: Task[] }).tasks[0]!.zenrows_params;
  // The API lowercases booleans without trimming and rejects " true ", with or without this tool.
  assert.deepEqual(params, { js_render: " TRUE ", mode: "auto" });
});

test("runOutcome for a job with no run says there is nothing to wait for", () => {
  const out = runOutcome("j1", undefined);
  assert.equal(out.ok, true);
  assert.equal(out.status, null);
  assert.match(String((out as { message?: string }).message), /no current run/);
});

test("batch_results with neither limit nor cursor returns every row, as before", async () => {
  const { result, calls } = await withFetch(
    (url) => {
      const c = new URL(url).searchParams.get("cursor");
      return c === null
        ? ok({ results: [{ task_id: "a" }], next_cursor: "c2" })
        : c === "c2"
          ? ok({ results: [{ task_id: "b" }], next_cursor: "c3" })
          : ok({ results: [{ task_id: "c" }], next_cursor: null });
    },
    () => captureTool("batch_results")({ job_id: "j1" })
  );
  const out = JSON.parse(result.content[0]!.text);
  assert.equal(calls.length, 3);
  assert.equal(out.count, 3);
  assert.deepEqual(
    out.results.map((r: { task_id: string }) => r.task_id),
    ["a", "b", "c"]
  );
  assert.equal(out.next_cursor, null);
});

test("batch_results with only a cursor pages from it (1000-row default)", async () => {
  const { result, calls } = await withFetch(
    (url) =>
      new URL(url).searchParams.get("cursor") === "c2"
        ? ok({ results: Array.from({ length: 1000 }, (_, i) => ({ task_id: `r${i}` })), next_cursor: "c3" })
        : ok({ results: [{ task_id: "x" }], next_cursor: null }),
    () => captureTool("batch_results")({ job_id: "j1", cursor: "c2" })
  );
  const out = JSON.parse(result.content[0]!.text);
  assert.equal(calls.length, 1);
  assert.equal(out.count, 1000);
  assert.equal(out.next_cursor, "c3");
});

test("batch_cancel still returns the run under job, and also under run", async () => {
  const run = {
    run_id: "r1",
    job_id: "j1",
    status: "stopped",
    stats: { total: 1, completed: 1, successful: 1, failed: 0 },
  };
  const { result } = await withFetch(
    () => ok(run),
    () => captureTool("batch_cancel")({ job_id: "j1" })
  );
  const out = JSON.parse(result.content[0]!.text);
  assert.deepEqual(out.job, run);
  assert.deepEqual(out.run, run);
});

test("batch_create with neither tasks nor urls is a usage error and sends nothing", async () => {
  const { result, calls } = await withFetch(created, () => captureTool("batch_create")({ tasks: [], urls: [] }));
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /INVALID_USAGE/);
  assert.equal(calls.length, 0);
});
