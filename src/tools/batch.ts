import { createRequire } from "module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendClaimHint } from "../auth/claim-hint.js";
import { BatchError, createJob, getJob, listResults, stopJob, waitForJob } from "../batch-api.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

type TextContent = { type: "text"; text: string };

function err(
  data: unknown,
  hint?: { status?: number; code?: string; message?: string }
): {
  content: TextContent[];
  isError: true;
} {
  const raw = typeof data === "string" ? data : JSON.stringify(data);
  return {
    content: [
      {
        type: "text" as const,
        text: appendClaimHint(raw, {
          status: hint?.status,
          code: hint?.code,
          message: hint?.message ?? raw,
          body: raw,
        }),
      },
    ],
    isError: true as const,
  };
}

function json(data: unknown): { content: TextContent[] } {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function batchErr(e: unknown): { content: TextContent[]; isError: true } {
  if (e instanceof BatchError) {
    return err(e.toJSON(), { status: e.status, code: e.code, message: e.message });
  }
  return err({
    code: "BATCH_FAILED",
    message: e instanceof Error ? e.message : String(e),
  });
}

function normalizeParams(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "boolean" || typeof v === "number") out[k] = String(v);
    else out[k] = JSON.stringify(v);
  }
  return out;
}

function isTruthyFlag(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

/**
 * Adds mode=auto (Adaptive Stealth Mode) to each task unless the job or the task
 * forces js_render / premium_proxy, or already sets mode. Applied per task, not per
 * job: the API rejects a task that combines a job-level mode=auto with its own
 * js_render or premium_proxy (REQS004). Exported for tests.
 */
export function applyAdaptiveStealth(
  jobParams: Record<string, unknown>,
  tasks: { zenrows_params?: Record<string, string> }[]
): void {
  const forced = (p: Record<string, unknown>) => isTruthyFlag(p.js_render) || isTruthyFlag(p.premium_proxy);
  if (forced(jobParams) || jobParams.mode != null) return;
  for (const task of tasks) {
    const own = task.zenrows_params ?? {};
    if (forced(own) || own.mode != null) continue;
    task.zenrows_params = { ...own, mode: "auto" };
  }
}

const taskSchema = z.object({
  url: z.string().url().describe("Target URL for this task"),
  external_id: z.string().nullish().describe("Optional stable id echoed back on results"),
  metadata: z.unknown().nullish().describe("Opaque per-task metadata carried through to results"),
  zenrows_params: z
    .record(z.union([z.string(), z.number(), z.boolean()]))
    .nullish()
    .describe("Per-task Zenrows scrape params (js_render, premium_proxy, extract, autoparse, …)"),
});

export function registerBatchTools(server: McpServer, apiKey: string): void {
  const ua = `zenrows/mcp ${pkg.version}`;
  const call = { apiKey, userAgent: ua };

  server.registerTool(
    "batch_create",
    {
      annotations: { title: "Create Batch Job", readOnlyHint: false, destructiveHint: false },
      description: `Submit a cloud Batch job that fans out many URLs asynchronously (Zenrows Batch API beta).

NOT the same as browser_batch — this hits https://async.api.zenrows.com/v1 with X-API-Key.
Use for large URL lists; prefer scrape/extract for one-off pages.

Tasks use Adaptive Stealth Mode (mode=auto) by default: Zenrows enables JS
rendering and premium proxies only on the pages that need them, and charges
only for the configuration that succeeds. Pass just the URLs for protected or
dynamic sites. Set js_render or premium_proxy (job-level or in a task's
zenrows_params) only to force a fixed configuration; that turns Adaptive Stealth
Mode off for the affected tasks and bills them at that configuration's cost.

Returns job_id + latest_run.status/stats. Poll with batch_status / batch_wait, then batch_results.
If you get BATCH_ACCESS_DENIED, the account lacks Batch beta access.`,
      inputSchema: {
        tasks: z
          .array(taskSchema)
          .nullish()
          .describe("List of tasks (each needs a url). Prefer this over urls when you need per-task params."),
        urls: z
          .array(z.string().url())
          .nullish()
          .describe("Shorthand: list of URLs (converted to tasks). Ignored when tasks is provided."),
        js_render: z
          .boolean()
          .nullish()
          .describe(
            "Force js_render on all tasks. Overrides Adaptive Stealth Mode, which already renders when needed."
          ),
        premium_proxy: z
          .boolean()
          .nullish()
          .describe(
            "Force premium_proxy on all tasks (10x cost). Overrides Adaptive Stealth Mode, which already escalates when a site blocks."
          ),
        mode_auto: z
          .boolean()
          .nullish()
          .describe(
            "Adaptive Stealth Mode (mode=auto) is on by default; leave unset. False sends plain requests without it."
          ),
        proxy_country: z
          .string()
          .nullish()
          .describe(
            "Job-level ISO country code. Works in Adaptive Stealth Mode; with js_render alone it requires premium_proxy."
          ),
        response_type: z.enum(["markdown", "plaintext", "html", "pdf"]).nullish().describe("Job-level response_type"),
        zenrows_params: z
          .record(z.union([z.string(), z.number(), z.boolean()]))
          .nullish()
          .describe("Additional job-level zenrows_params merged with the flags above"),
        wait: z.boolean().nullish().describe("If true, poll until the job reaches a terminal state before returning"),
        wait_timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(3_600_000)
          .nullish()
          .describe("Max wait time when wait=true (default 600000)"),
      },
    },
    async (params) => {
      type TaskIn = {
        url: string;
        external_id?: string;
        metadata?: unknown;
        zenrows_params?: Record<string, string | number | boolean>;
      };
      const tasksIn: TaskIn[] =
        params.tasks && params.tasks.length > 0 ? params.tasks : (params.urls ?? []).map((url) => ({ url }));
      if (!tasksIn.length) {
        return err({
          code: "INVALID_USAGE",
          message: "Provide tasks (preferred) or urls with at least one URL.",
        });
      }

      const jobParams: Record<string, unknown> = { ...(params.zenrows_params ?? {}) };
      if (params.js_render) jobParams.js_render = true;
      if (params.premium_proxy) jobParams.premium_proxy = true;
      if (params.proxy_country) jobParams.proxy_country = params.proxy_country.toLowerCase();
      if (params.response_type) jobParams.response_type = params.response_type;

      const tasks = tasksIn.map((t) => {
        const task: {
          url: string;
          external_id?: string;
          metadata?: unknown;
          zenrows_params?: Record<string, string>;
        } = { url: t.url };
        if (t.external_id) task.external_id = t.external_id;
        if (t.metadata != null) task.metadata = t.metadata;
        if (t.zenrows_params) task.zenrows_params = normalizeParams(t.zenrows_params);
        return task;
      });
      if (params.mode_auto !== false) applyAdaptiveStealth(jobParams, tasks);

      const body = {
        type: "regular" as const,
        status: "closed" as const,
        tasks,
        ...(Object.keys(jobParams).length ? { zenrows_params: normalizeParams(jobParams) } : {}),
      };

      try {
        const job = await createJob(body, call);
        const finished =
          params.wait === true
            ? await waitForJob(job.job_id, {
                ...call,
                pollTimeoutMs: params.wait_timeout_ms ?? 600_000,
              })
            : job;
        const run = finished.latest_run ?? {};
        return json({
          ok: true,
          job_id: finished.job_id,
          status: run.status,
          stats: run.stats,
          job: finished,
        });
      } catch (e) {
        return batchErr(e);
      }
    }
  );

  server.registerTool(
    "batch_status",
    {
      annotations: { title: "Batch Job Status", readOnlyHint: true, destructiveHint: false },
      description: "Get status and stats for a Zenrows Batch job (latest_run.status + latest_run.stats).",
      inputSchema: {
        job_id: z.string().describe("Batch job id returned by batch_create"),
      },
    },
    async ({ job_id }) => {
      try {
        const job = await getJob(job_id, call);
        const run = job.latest_run ?? {};
        return json({
          ok: true,
          job_id: job.job_id,
          status: run.status,
          stats: run.stats,
          job,
        });
      } catch (e) {
        return batchErr(e);
      }
    }
  );

  server.registerTool(
    "batch_results",
    {
      annotations: { title: "Batch Job Results", readOnlyHint: true, destructiveHint: false },
      description: `List result rows for a Batch job (cursor-paginated server-side; returns the full list).

Each row may include task_id, external_id, status, and a short-lived result_url for the body.
Download result_url soon — presigned links expire.`,
      inputSchema: {
        job_id: z.string().describe("Batch job id"),
        status: z.enum(["successful", "failed", "all"]).nullish().describe("Filter results by status (default: all)"),
      },
    },
    async ({ job_id, status }) => {
      try {
        const results = await listResults(job_id, { ...call, status: status ?? undefined });
        return json({ ok: true, job_id, count: results.length, results });
      } catch (e) {
        return batchErr(e);
      }
    }
  );

  server.registerTool(
    "batch_cancel",
    {
      annotations: { title: "Cancel Batch Job", readOnlyHint: false, destructiveHint: true },
      description: "Stop an in-flight Batch job run (POST /jobs/:id/stop).",
      inputSchema: {
        job_id: z.string().describe("Batch job id to stop"),
      },
    },
    async ({ job_id }) => {
      try {
        const job = await stopJob(job_id, call);
        const run = job.latest_run ?? {};
        return json({
          ok: true,
          job_id: job.job_id,
          status: run.status,
          stats: run.stats,
          job,
        });
      } catch (e) {
        return batchErr(e);
      }
    }
  );

  server.registerTool(
    "batch_wait",
    {
      annotations: { title: "Wait for Batch Job", readOnlyHint: true, destructiveHint: false },
      description:
        "Poll batch_status until the job reaches a terminal state (completed, failed, stopped, or deleted). A run that hits an API key credit cap ends as failed with failure_reason api_key_cap_reached.",
      inputSchema: {
        job_id: z.string().describe("Batch job id"),
        timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(3_600_000)
          .nullish()
          .describe("Max wait time in ms (default 600000)"),
      },
    },
    async ({ job_id, timeout_ms }) => {
      try {
        const job = await waitForJob(job_id, { ...call, pollTimeoutMs: timeout_ms ?? 600_000 });
        const run = job.latest_run ?? {};
        return json({
          ok: true,
          job_id: job.job_id,
          status: run.status,
          stats: run.stats,
          job,
        });
      } catch (e) {
        return batchErr(e);
      }
    }
  );
}
