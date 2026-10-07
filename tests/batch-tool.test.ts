import assert from "node:assert/strict";
import { test } from "node:test";
import { applyAdaptiveStealth, registerBatchTools } from "../src/tools/batch.ts";

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
