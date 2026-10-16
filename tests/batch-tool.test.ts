import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JSONRPCMessage, Progress } from "@modelcontextprotocol/sdk/types.js";
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

type Out = { content: { type: string; text: string }[]; isError?: boolean };
type Handler = (p: unknown, extra?: unknown) => Promise<Out>;
type Config = {
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: { destructiveHint: boolean; readOnlyHint: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
};

function register(getClientName?: () => string | undefined) {
  const handlers: Record<string, Handler> = {};
  const configs: Record<string, Config> = {};
  registerBatchTools(
    {
      registerTool: (name: string, c: Config, h: Handler) => {
        handlers[name] = h;
        configs[name] = c;
      },
    } as never,
    "k",
    getClientName
  );
  return { handlers, configs };
}

type Seen = { url: string; method: string; headers: Headers; body?: unknown };

async function withFetch<T>(impl: (req: Seen) => Response, fn: (seen: Seen[]) => Promise<T>): Promise<T> {
  const seen: Seen[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (u: RequestInfo | URL, init?: RequestInit) => {
    const req = {
      url: String(u),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    seen.push(req);
    return impl(req);
  }) as typeof fetch;
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = orig;
  }
}

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const problem = (status: number, code: string, detail = "x") =>
  new Response(JSON.stringify({ code, status, detail, title: code }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
const run = (o: Record<string, unknown> = {}) => ({
  run_id: "R1",
  job_id: "J1",
  status: "running",
  stats: { total: 2, completed: 0, successful: 0, failed: 0 },
  ...o,
});
const parse = (out: Out) => JSON.parse(out.content[0]!.text);

test("every batch tool is registered with full annotations and crawl-style hints", () => {
  const { configs } = register();
  assert.deepEqual(Object.keys(configs).sort(), [
    "batch_cancel",
    "batch_content",
    "batch_create",
    "batch_delete",
    "batch_list",
    "batch_pause",
    "batch_rerun",
    "batch_results",
    "batch_resume",
    "batch_status",
    "batch_wait",
  ]);
  const a = (n: string) => configs[n]!.annotations;
  for (const n of ["batch_status", "batch_wait", "batch_results", "batch_content", "batch_list"]) {
    assert.equal(a(n).readOnlyHint, true, n);
    assert.equal(a(n).destructiveHint, false, n);
  }
  for (const n of ["batch_cancel", "batch_delete"]) {
    assert.equal(a(n).destructiveHint, true, n);
    assert.equal(a(n).idempotentHint, true, n);
  }
  for (const n of ["batch_pause", "batch_resume"]) {
    assert.equal(a(n).destructiveHint, false, n);
    assert.equal(a(n).idempotentHint, true, n);
  }
  for (const n of ["batch_create", "batch_rerun"]) {
    assert.equal(a(n).readOnlyHint, false, n);
    assert.equal(a(n).destructiveHint, false, n);
  }
});

test("descriptions state the URL TTL, retention, per-call task cap, shared job limit, costs and API-only features", () => {
  const { configs } = register();
  const create = configs.batch_create!.description;
  assert.match(create, /100,000 tasks per call/);
  assert.match(create, /3 active jobs per account by default, shared with Crawl/);
  assert.match(create, /1 for a basic request, 5 with js_render, 10 with premium_proxy, 25 with both/);
  assert.match(create, /Schedules, webhooks, exports, CSV inputs/);
  const results = configs.batch_results!.description;
  assert.match(results, /expires after 2 hours/);
  assert.match(results, /14 days/);
  assert.match(results, /"expired"/);
});

test("response_type offers only markdown, plaintext and pdf, the values the API accepts", () => {
  const { configs } = register();
  const schema = z.object(configs.batch_create!.inputSchema);
  for (const v of ["markdown", "plaintext", "pdf"])
    assert.equal(schema.safeParse({ response_type: v }).success, true, v);
  assert.equal(schema.safeParse({ response_type: "html" }).success, false);
});

test("a nested response_type html is never sent, and an html task keeps html under a pdf job", async () => {
  const { handlers } = register();
  await withFetch(
    () => jsonRes({ job_id: "J1", latest_run: run() }, 201),
    async (seen) => {
      await handlers.batch_create!({
        tasks: [{ url: "https://a.com", zenrows_params: { response_type: "html" } }, { url: "https://b.com" }],
        zenrows_params: { response_type: "pdf" },
        mode_auto: false,
      });
      await handlers.batch_create!({ urls: ["https://a.com"], zenrows_params: { response_type: "HTML" } });
      const first = seen[0]!.body as { tasks: { zenrows_params?: Record<string, string> }[]; zenrows_params?: object };
      assert.equal(first.zenrows_params, undefined);
      assert.equal(first.tasks[0]!.zenrows_params, undefined);
      assert.deepEqual(first.tasks[1]!.zenrows_params, { response_type: "pdf" });
      assert.equal((seen[1]!.body as { zenrows_params?: object }).zenrows_params, undefined);
    }
  );
});

test("keepHtmlTasksHtml leaves the job alone when no task asks for html", () => {
  const job: Record<string, unknown> = { response_type: "pdf" };
  const tasks = [{}];
  keepHtmlTasksHtml(job, tasks, [false]);
  assert.deepEqual(job, { response_type: "pdf" });
  assert.deepEqual(tasks, [{}]);
});

test("toTaskParams folds flat scrape params into zenrows_params; flat keys win; unknown keys are named", () => {
  assert.deepEqual(
    toTaskParams({ url: "u", extract: "auto", js_render: true, zenrows_params: { js_render: "false", wait: 5 } }),
    { params: { js_render: "true", wait: "5", extract: "auto" }, unknown: [] }
  );
  assert.deepEqual(toTaskParams({ url: "u", screenshot: "true" }).unknown, ["screenshot"]);
});

test("batch_create sends a flat extract param as zenrows_params and string metadata as is", async () => {
  const { handlers } = register();
  await withFetch(
    () => jsonRes({ job_id: "J1", latest_run: run() }, 201),
    async (seen) => {
      const out = await handlers.batch_create!({
        tasks: [{ url: "https://a.com", extract: "auto", metadata: { n: "1" }, external_id: "sku-1" }],
      });
      assert.equal(out.isError, undefined);
      const task = (seen[0]!.body as { tasks: Record<string, unknown>[] }).tasks[0]!;
      assert.deepEqual(task, {
        url: "https://a.com",
        external_id: "sku-1",
        metadata: { n: "1" },
        zenrows_params: { extract: "auto", mode: "auto" },
      });
    }
  );
});

test("batch_create rejects an unknown task field by name and sends nothing", async () => {
  const { handlers } = register();
  await withFetch(
    () => jsonRes({}, 500),
    async (seen) => {
      const out = await handlers.batch_create!({ tasks: [{ url: "https://a.com", screenshot: "true" }] });
      assert.equal(out.isError, true);
      assert.match(out.content[0]!.text, /INVALID_USAGE/);
      assert.match(out.content[0]!.text, /tasks\[0\]: screenshot/);
      assert.equal(seen.length, 0);
    }
  );
});

test("taskSchema: metadata is string-to-string with the API's limits, external_id has the API's pattern", () => {
  const ok = (t: unknown) => taskSchema.safeParse(t).success;
  assert.equal(ok({ url: "https://a.com", metadata: { a: "1" } }), true);
  assert.equal(ok({ url: "https://a.com", metadata: { a: 1 } }), false);
  assert.equal(ok({ url: "https://a.com", metadata: { "bad key": "1" } }), false);
  assert.equal(ok({ url: "https://a.com", metadata: { a: "x".repeat(1025) } }), false);
  const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, "v"]));
  assert.equal(ok({ url: "https://a.com", metadata: many }), false);
  assert.equal(ok({ url: "https://a.com", external_id: "best-running_shoes.1" }), true);
  assert.equal(ok({ url: "https://a.com", external_id: "best running shoes" }), false);
  assert.equal(ok({ url: "https://a.com", external_id: "x".repeat(129) }), false);
  // passthrough keeps flat params for toTaskParams
  assert.deepEqual(
    (taskSchema.parse({ url: "https://a.com", extract: "auto" }) as Record<string, unknown>).extract,
    "auto"
  );
});

test("batch_create sends POST tasks with their body, and a body without POST is a usage error", async () => {
  const { handlers } = register();
  await withFetch(
    () => jsonRes({ job_id: "J1", latest_run: run() }, 201),
    async (seen) => {
      await handlers.batch_create!({
        tasks: [{ url: "https://a.com/graphql", method: "POST", body: { q: 1 } }],
        mode_auto: false,
      });
      assert.deepEqual((seen[0]!.body as { tasks: unknown[] }).tasks[0], {
        url: "https://a.com/graphql",
        method: "POST",
        body: { q: 1 },
      });
      const out = await handlers.batch_create!({ tasks: [{ url: "https://a.com", body: "x" }] });
      assert.equal(out.isError, true);
      assert.equal(seen.length, 1);
    }
  );
});

test("batch_create sends an Idempotency-Key, a fresh one per call or the one given, plus the client and tool headers", async () => {
  const { handlers } = register(() => "example-client");
  await withFetch(
    () => jsonRes({ job_id: "J1", latest_run: run() }, 201),
    async (seen) => {
      await handlers.batch_create!({ urls: ["https://a.com"] });
      await handlers.batch_create!({ urls: ["https://a.com"] });
      await handlers.batch_create!({ urls: ["https://a.com"], idempotency_key: "mine" });
      const keys = seen.map((s) => s.headers.get("idempotency-key"));
      assert.ok(keys[0] && keys[1] && keys[0] !== keys[1]);
      assert.equal(keys[2], "mine");
      assert.equal(seen[0]!.headers.get("x-mcp-client-name"), "example-client");
      assert.equal(seen[0]!.headers.get("x-mcp-tool"), "batch_create");
    }
  );
});

test("a create error carries the idempotency key to retry with", async () => {
  const { handlers } = register();
  await withFetch(
    () => problem(402, "payment_required", "No credit."),
    async () => {
      const out = await handlers.batch_create!({ urls: ["https://a.com"], idempotency_key: "k1" });
      assert.equal(out.isError, true);
      const body = JSON.parse(out.content[0]!.text.split("\n\n")[0]!);
      assert.equal(body.code, "BATCH_INSUFFICIENT_CREDITS");
      assert.equal(body.server_code, "payment_required");
      assert.equal(body.idempotency_key, "k1");
    }
  );
});

test("a 429 job limit is BATCH_QUOTA_EXCEEDED with no claim nudge, apart from the 402 credits code", async () => {
  const { handlers } = register();
  await withFetch(
    () => problem(429, "quota_exceeded", "Account already has 3 active jobs; max 3 allowed concurrently."),
    async () => {
      const out = await handlers.batch_create!({ urls: ["https://a.com"] });
      const text = out.content[0]!.text;
      assert.equal(JSON.parse(text).code, "BATCH_QUOTA_EXCEEDED");
      assert.doesNotMatch(text, /Claim your Free account/);
    }
  );
});

test("runOutcome: a failed run answers ok:false with crawl's error shape, server_code and job_id", () => {
  for (const [reason, code] of [
    ["insufficient_credits", "BATCH_INSUFFICIENT_CREDITS"],
    ["api_key_cap_reached", "BATCH_KEY_CAP_REACHED"],
    ["subscription_inactive", "AUTH_INVALID"],
    ["other", "BATCH_RUN_FAILED"],
  ] as const) {
    const out = runOutcome("J1", run({ status: "failed", failure_reason: reason, failure_detail: "Out." }) as never);
    assert.equal(out.ok, false, reason);
    const error = out.error as Record<string, unknown>;
    assert.equal(error.code, code);
    assert.equal(error.server_code, reason);
    assert.equal(error.detail, "Out.");
    assert.equal(error.job_id, "J1");
    assert.match(String(error.message), /batch_rerun/);
  }
});

test("runOutcome flags a paused run and an ingesting run, never a paused run that ended", () => {
  const paused = runOutcome("J1", run({ pause_state: "paused" }) as never);
  assert.equal(paused.ok, true);
  assert.equal(paused.paused, true);
  assert.match(String(paused.note), /batch_resume/);
  assert.equal(runOutcome("J1", run({ status: "stopped", pause_state: "paused" }) as never).paused, undefined);
  const ingest = runOutcome("J1", run({ ingest_status: "pending" }) as never);
  assert.equal(ingest.ingesting, true);
  assert.match(String(ingest.note), /partial/);
  assert.equal(runOutcome("J1", undefined).status, null);
});

test("batch_status and batch_wait on a run that failed for credits answer ok:false", async () => {
  const { handlers } = register();
  await withFetch(
    () =>
      jsonRes({
        job_id: "JFAIL",
        latest_run: run({
          job_id: "JFAIL",
          status: "failed",
          failure_reason: "insufficient_credits",
          failure_detail: "Out of credits",
        }),
      }),
    async () => {
      for (const out of [
        await handlers.batch_status!({ job_id: "JFAIL" }),
        await handlers.batch_wait!({ job_id: "JFAIL", timeout: 5 }),
      ]) {
        assert.equal(out.isError, undefined);
        const body = parse(out);
        assert.equal(body.ok, false);
        assert.equal(body.error.code, "BATCH_INSUFFICIENT_CREDITS");
        assert.equal(body.error.server_code, "insufficient_credits");
        assert.equal(body.error.job_id, "JFAIL");
      }
    }
  );
});

test("batch_wait returns at once on a paused run with paused:true", async () => {
  const { handlers } = register();
  await withFetch(
    () => jsonRes({ job_id: "JP", latest_run: run({ pause_state: "paused" }) }),
    async (seen) => {
      const t0 = Date.now();
      const body = parse(await handlers.batch_wait!({ job_id: "JP", timeout: 30 }));
      assert.ok(Date.now() - t0 < 1000);
      assert.equal(seen.length, 1);
      assert.equal(body.ok, true);
      assert.equal(body.paused, true);
    }
  );
});

test("a batch_wait that runs out returns the current state with ok:true, not an error", async () => {
  const { handlers } = register();
  await withFetch(
    () => jsonRes({ job_id: "J1", latest_run: run() }),
    async () => {
      const out = await handlers.batch_wait!({ job_id: "J1", timeout: 1 });
      assert.equal(out.isError, undefined);
      const body = parse(out);
      assert.equal(body.ok, true);
      assert.equal(body.timed_out, true);
      assert.equal(body.status, "running");
      assert.match(body.note, /not a failure/);
    }
  );
});

test("batch_wait defaults to 50 seconds and takes the deprecated timeout_ms", () => {
  const { configs } = register();
  const schema = z.object(configs.batch_wait!.inputSchema);
  assert.equal(schema.safeParse({ job_id: "J", timeout: 3600 }).success, true);
  assert.equal(schema.safeParse({ job_id: "J", timeout: 3601 }).success, false);
  assert.equal(schema.safeParse({ job_id: "J", timeout_ms: 5000 }).success, true);
  assert.match(String(configs.batch_wait!.inputSchema.timeout!.description), /default 50/);
});

/** batch_wait through a real MCP client: the run is running for two polls, then completes. */
async function batchWaitOverMcp(t: TestContext, onprogress?: (p: Progress) => void) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerBatchTools(server, "k");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const sent: JSONRPCMessage[] = [];
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = (message, options) => {
    sent.push(message);
    return send(message, options);
  };
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  let polls = 0;
  try {
    await withFetch(
      () => {
        polls++;
        return jsonRes({
          job_id: "J1",
          latest_run: run({
            status: polls <= 2 ? "running" : "completed",
            stats: { total: 10, completed: polls * 3, successful: polls * 3, failed: 0 },
          }),
        });
      },
      async () => {
        let done = false;
        const call = client.callTool({ name: "batch_wait", arguments: { job_id: "J1", timeout: 60 } }, undefined, {
          onprogress,
        });
        call.finally(() => (done = true)).catch(() => undefined);
        while (!done) {
          for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
          t.mock.timers.tick(1_000);
        }
        const out = (await call) as { content: { text: string }[] };
        assert.equal(JSON.parse(out.content[0]!.text).status, "completed");
      }
    );
  } finally {
    await client.close();
  }
  return sent.filter((m) => "method" in m && m.method === "notifications/progress");
}

test("batch_wait sends a progress notification after each poll when the call carries a progressToken", async (t) => {
  const seen: Progress[] = [];
  const sent = await batchWaitOverMcp(t, (p) => seen.push(p));
  assert.equal(sent.length, 3);
  assert.deepEqual(
    seen.map((p) => p.progress),
    [1, 2, 3]
  );
  assert.equal(seen[0]!.message, "running: 3/10 done, 0 failed");
});

test("batch_wait sends no progress notification without a progressToken", async (t) => {
  assert.equal((await batchWaitOverMcp(t)).length, 0);
});

test("batch_results returns limit rows (default 100) and a next_cursor that resumes, never the whole job", async () => {
  const { handlers } = register();
  const page = (c: number) => ({
    results: Array.from({ length: 1000 }, (_, i) => ({
      task_id: `T${String(c * 1000 + i).padStart(6, "0")}`,
      status: "successful",
    })),
    next_cursor: c < 9 ? String(c + 1) : null,
  });
  await withFetch(
    (req) => jsonRes(page(Number(new URL(req.url).searchParams.get("cursor") ?? 0))),
    async () => {
      const first = parse(await handlers.batch_results!({ job_id: "J1" }));
      assert.equal(first.count, 100);
      assert.equal(first.partial, true);
      assert.ok(first.next_cursor);
      const second = parse(await handlers.batch_results!({ job_id: "J1", cursor: first.next_cursor, limit: 1000 }));
      assert.equal(second.results[0].task_id, "T000100");
      assert.equal(second.count, 1000);
      assert.equal(second.results[999].task_id, "T001099");
    }
  );
});

test("batch_results accepts the processing filter and caps limit at 1000", async () => {
  const { handlers, configs } = register();
  const schema = z.object(configs.batch_results!.inputSchema);
  assert.equal(schema.safeParse({ job_id: "J", status: "processing" }).success, true);
  assert.equal(schema.safeParse({ job_id: "J", limit: 1001 }).success, false);
  await withFetch(
    () => jsonRes({ results: [], next_cursor: null }),
    async (seen) => {
      const body = parse(await handlers.batch_results!({ job_id: "J1", status: "processing" }));
      assert.equal(body.next_cursor, null);
      assert.equal(body.partial, false);
      assert.match(seen[0]!.url, /status=processing/);
    }
  );
});

test("batch_cancel reads the stopped Run that the stop endpoint returns", async () => {
  const { handlers } = register();
  await withFetch(
    () => jsonRes(run({ status: "stopped", stats: { total: 2, completed: 1, successful: 1, failed: 0 } })),
    async (seen) => {
      const body = parse(await handlers.batch_cancel!({ job_id: "J1" }));
      assert.equal(body.ok, true);
      assert.equal(body.status, "stopped");
      assert.equal(body.run_id, "R1");
      assert.equal(body.stats.completed, 1);
      assert.equal(body.run.status, "stopped");
      assert.equal(body.job.status, "stopped");
      assert.match(seen[0]!.url, /\/jobs\/J1\/stop$/);
    }
  );
});

test("batch_cancel on a run that already ended answers with its final state, not an error", async () => {
  const { handlers } = register();
  await withFetch(
    (req) =>
      req.method === "POST"
        ? problem(409, "run_not_stoppable", "Run is not in a stoppable state.")
        : jsonRes({ job_id: "JDONE", latest_run: run({ job_id: "JDONE", status: "completed" }) }),
    async () => {
      const out = await handlers.batch_cancel!({ job_id: "JDONE" });
      assert.equal(out.isError, undefined);
      const body = parse(out);
      assert.equal(body.ok, true);
      assert.equal(body.status, "completed");
      assert.equal(body.already_ended, true);
    }
  );
});

test("batch_pause and batch_resume post to their endpoints and return the run", async () => {
  const { handlers } = register();
  await withFetch(
    (req) => jsonRes(run({ pause_state: req.url.endsWith("/pause") ? "paused" : "active" })),
    async (seen) => {
      const paused = parse(await handlers.batch_pause!({ job_id: "J1" }));
      assert.equal(paused.paused, true);
      const resumed = parse(await handlers.batch_resume!({ job_id: "J1" }));
      assert.equal(resumed.paused, undefined);
      assert.deepEqual(
        seen.map((s) => `${s.method} ${new URL(s.url).pathname}`),
        ["POST /v1/jobs/J1/pause", "POST /v1/jobs/J1/resume"]
      );
    }
  );
});

test("batch_rerun defaults to the failed and pending tasks, full:true reruns all, and it sends an Idempotency-Key", async () => {
  const { handlers } = register();
  await withFetch(
    () =>
      jsonRes(
        {
          job_id: "J1",
          status: "closed",
          latest_run: run({ run_id: "R2", ingest_status: "pending" }),
          rerun_of: "R1",
          retried_tasks: 3,
          inherited_tasks: 7,
        },
        202
      ),
    async (seen) => {
      const body = parse(await handlers.batch_rerun!({ job_id: "J1" }));
      assert.equal(body.ok, true);
      assert.equal(body.run_id, "R2");
      assert.equal(body.rerun_of, "R1");
      assert.equal(body.retried_tasks, 3);
      assert.equal(body.ingesting, true);
      assert.equal(new URL(seen[0]!.url).searchParams.get("status"), "failed,pending");
      assert.ok(seen[0]!.headers.get("idempotency-key"));
      await handlers.batch_rerun!({ job_id: "J1", full: true });
      assert.equal(new URL(seen[1]!.url).searchParams.get("status"), null);
      await handlers.batch_rerun!({ job_id: "J1", status: ["failed"] });
      assert.equal(new URL(seen[2]!.url).searchParams.get("status"), "failed");
      const both = await handlers.batch_rerun!({ job_id: "J1", full: true, status: ["failed"] });
      assert.equal(both.isError, true);
      assert.equal(seen.length, 3);
    }
  );
});

test("batch_rerun past the 10-day window says to rerun in full", async () => {
  const { handlers } = register();
  await withFetch(
    () => problem(409, "partial_rerun_window_expired"),
    async () => {
      const out = await handlers.batch_rerun!({ job_id: "J1" });
      const body = JSON.parse(out.content[0]!.text);
      assert.equal(body.code, "BATCH_RERUN_WINDOW_EXPIRED");
      assert.equal(body.job_id, "J1");
      assert.match(body.message, /full: true/);
    }
  );
});

test("batch_list pages the account's jobs with its filters, default 20", async () => {
  const { handlers } = register();
  await withFetch(
    () => jsonRes({ jobs: [{ job_id: "J1", latest_run: run() }], next_cursor: "n" }),
    async (seen) => {
      const body = parse(await handlers.batch_list!({ status: "closed" }));
      assert.equal(body.count, 1);
      assert.equal(body.next_cursor, "n");
      const q = new URL(seen[0]!.url).searchParams;
      assert.equal(q.get("limit"), "20");
      assert.equal(q.get("status"), "closed");
    }
  );
});

test("batch_delete deletes the job and answers ok", async () => {
  const { handlers } = register();
  await withFetch(
    () => new Response(null, { status: 202 }),
    async (seen) => {
      const body = parse(await handlers.batch_delete!({ job_id: "J1" }));
      assert.deepEqual(body, { ok: true, job_id: "J1", deleted: true });
      assert.equal(seen[0]!.method, "DELETE");
    }
  );
});

test("batch_content returns a text result inline, cut to max_chars with a note", async () => {
  const { handlers } = register();
  await withFetch(
    () => new Response("a".repeat(5000), { status: 200, headers: { "content-type": "text/markdown" } }),
    async () => {
      const out = await handlers.batch_content!({ job_id: "J1", task_id: "T1", max_chars: 1000 });
      assert.equal(out.content[0]!.text.length, 1000);
      assert.match(out.content[1]!.text, /truncated: returned 1000 of 5000/);
    }
  );
});

test("batch_content returns a binary result as its presigned result_url, not inline", async () => {
  const { handlers } = register();
  await withFetch(
    (req) =>
      req.url.includes("/content")
        ? new Response("%PDF", { status: 200, headers: { "content-type": "application/pdf" } })
        : jsonRes({
            results: [{ task_id: "T0" }, { task_id: "T1", result_url: "https://s3.example/T1?sig" }],
            next_cursor: null,
          }),
    async () => {
      const body = parse(await handlers.batch_content!({ job_id: "J1", task_id: "T1" }));
      assert.equal(body.ok, true);
      assert.equal(body.content_type, "application/pdf");
      assert.equal(body.result_url, "https://s3.example/T1?sig");
      assert.match(body.note, /2 hours/);
    }
  );
});

test("batch_content maps a not-ready, failed or expired task to its own code", async () => {
  const { handlers } = register();
  for (const [res, code] of [
    [() => problem(409, "task_not_ready"), "BATCH_TASK_NOT_READY"],
    [() => problem(410, "result_expired"), "BATCH_RESULT_EXPIRED"],
    [() => problem(422, "RESP001", "Could not get content"), "BATCH_TASK_FAILED"],
  ] as const) {
    await withFetch(res, async () => {
      const out = await handlers.batch_content!({ job_id: "J1", task_id: "T1" });
      assert.equal(out.isError, true);
      const body = JSON.parse(out.content[0]!.text);
      assert.equal(body.code, code);
      assert.equal(body.job_id, "J1");
      assert.equal(body.task_id, "T1");
    });
  }
});

test("an error about an existing job carries job_id and server_code", async () => {
  const { handlers } = register();
  await withFetch(
    () => problem(404, "not_found", "Job not found."),
    async () => {
      const body = JSON.parse((await handlers.batch_status!({ job_id: "nope" })).content[0]!.text);
      assert.equal(body.code, "BATCH_NOT_FOUND");
      assert.equal(body.server_code, "not_found");
      assert.equal(body.job_id, "nope");
    }
  );
});

test("batch_create with wait returns the finished run", async () => {
  const { handlers } = register();
  await withFetch(
    (req) =>
      req.method === "POST"
        ? jsonRes({ job_id: "J1", latest_run: run() }, 201)
        : jsonRes({ job_id: "J1", latest_run: run({ status: "completed" }) }),
    async () => {
      const body = parse(await handlers.batch_create!({ urls: ["https://a.com"], wait: true, wait_timeout: 10 }));
      assert.equal(body.status, "completed");
      assert.equal(body.ok, true);
    }
  );
});

test("batch_content on a binary result in a large run hands back lookup_cursor and resumes with it", async () => {
  const { handlers } = register();
  let page = 0;
  await withFetch(
    (req) => {
      if (req.url.includes("/content")) {
        return new Response("%PDF", { status: 200, headers: { "content-type": "application/pdf" } });
      }
      const c = Number(new URL(req.url).searchParams.get("cursor") ?? 0);
      page = c;
      const rows = c === 1 ? [{ task_id: "TX", result_url: "https://s3.example/TX?sig" }] : [{ task_id: `A${c}` }];
      return jsonRes({ results: rows, next_cursor: c < 1 ? String(c + 1) : null });
    },
    async () => {
      const done = parse(await handlers.batch_content!({ job_id: "J1", task_id: "TX", lookup_cursor: "1" }));
      assert.equal(done.result_url, "https://s3.example/TX?sig");
      assert.equal(page, 1);
    }
  );
});
