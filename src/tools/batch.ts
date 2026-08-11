import { createRequire } from "module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendClaimHint } from "../auth/claim-hint.js";
import {
  BatchError,
  createJob,
  getJob,
  listResults,
  stopJob,
  waitForJob,
} from "../batch-api.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

type TextContent = { type: "text"; text: string };

function err(data: unknown, hint?: { status?: number; code?: string; message?: string }): {
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

const taskSchema = z.object({
  url: z.string().url().describe("Target URL for this task"),
  external_id: z.string().optional().describe("Optional stable id echoed back on results"),
  metadata: z.unknown().optional().describe("Opaque per-task metadata carried through to results"),
  zenrows_params: z
    .record(z.union([z.string(), z.number(), z.boolean()]))
    .optional()
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

Returns job_id + latest_run.status/stats. Poll with batch_status / batch_wait, then batch_results.
If you get BATCH_ACCESS_DENIED, the account lacks Batch beta access.`,
      inputSchema: {
        tasks: z
          .array(taskSchema)
          .optional()
          .describe("List of tasks (each needs a url). Prefer this over urls when you need per-task params."),
        urls: z
          .array(z.string().url())
          .optional()
          .describe("Shorthand: list of URLs (converted to tasks). Ignored when tasks is provided."),
        js_render: z.boolean().optional().describe("Job-level js_render for all tasks"),
        premium_proxy: z.boolean().optional().describe("Job-level premium_proxy for all tasks"),
        proxy_country: z
          .string()
          .optional()
          .describe("Job-level ISO country code (requires premium_proxy or mode=auto)"),
        response_type: z
          .enum(["markdown", "plaintext", "html", "pdf"])
          .optional()
          .describe("Job-level response_type"),
        zenrows_params: z
          .record(z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Additional job-level zenrows_params merged with the flags above"),
        wait: z
          .boolean()
          .optional()
          .describe("If true, poll until the job reaches a terminal state before returning"),
        wait_timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(3_600_000)
          .optional()
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
        params.tasks && params.tasks.length > 0
          ? params.tasks
          : (params.urls ?? []).map((url) => ({ url }));
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

      const body = {
        type: "regular" as const,
        status: "closed" as const,
        tasks: tasksIn.map((t) => {
          const task: {
            url: string;
            external_id?: string;
            metadata?: unknown;
            zenrows_params?: Record<string, string>;
          } = { url: t.url };
          if (t.external_id) task.external_id = t.external_id;
          if (t.metadata !== undefined) task.metadata = t.metadata;
          if (t.zenrows_params) task.zenrows_params = normalizeParams(t.zenrows_params);
          return task;
        }),
        ...(Object.keys(jobParams).length
          ? { zenrows_params: normalizeParams(jobParams) }
          : {}),
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
      description:
        "Get status and stats for a Zenrows Batch job (latest_run.status + latest_run.stats).",
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
        status: z
          .enum(["successful", "failed", "all"])
          .optional()
          .describe("Filter results by status (default: all)"),
      },
    },
    async ({ job_id, status }) => {
      try {
        const results = await listResults(job_id, { ...call, status });
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
        "Poll batch_status until the job reaches a terminal state (completed, stopped, or deleted).",
      inputSchema: {
        job_id: z.string().describe("Batch job id"),
        timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(3_600_000)
          .optional()
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
