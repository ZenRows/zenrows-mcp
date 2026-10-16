import { randomUUID } from "crypto";
import { createRequire } from "module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendClaimHint, KEY_CAP_NUDGE } from "../auth/claim-hint.js";
import {
  BatchError,
  createJob,
  getJob,
  isPausedRun,
  type JobRun,
  listResults,
  stopJob,
  waitForJob,
} from "../batch-api.js";

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

/** What to do next when a run ends as failed, keyed by its failure_reason. */
const FAILURE_NEXT_STEP: Record<string, string> = {
  insufficient_credits:
    "The account ran out of credits, so the run stopped. Add credits or upgrade at https://app.zenrows.com/billing, then submit the remaining URLs again (tasks that never started are still pending).",
  subscription_inactive:
    "The subscription is not active, so the run stopped. Fix it in Billing at https://app.zenrows.com/billing, then submit the remaining URLs again.",
  api_key_cap_reached: `The run stopped at the API key's credit cap. ${KEY_CAP_NUDGE}`,
};

/**
 * The tool payload for a run: ok:false with failure_reason/failure_detail when the run failed,
 * and a paused flag while the run is paused and has not ended. Exported for tests.
 */
export function runOutcome(jobId: string, run: JobRun | undefined, extra: Record<string, unknown> = {}) {
  if (!run) {
    return {
      ok: true,
      job_id: jobId,
      status: null,
      message:
        "The job has no current run: its only run was deleted, or a scheduled job has not run yet. There is nothing to wait for.",
      ...extra,
    };
  }
  const r = run;
  if (r.status === "failed") {
    return {
      ok: false,
      code: "BATCH_RUN_FAILED",
      job_id: jobId,
      run_id: r.run_id,
      status: r.status,
      failure_reason: r.failure_reason,
      failure_detail: r.failure_detail,
      message:
        FAILURE_NEXT_STEP[r.failure_reason ?? ""] ??
        "The run ended as failed. failure_reason and failure_detail say why.",
      stats: r.stats,
      ...extra,
    };
  }
  const paused = isPausedRun(r as JobRun);
  return {
    ok: true,
    job_id: jobId,
    run_id: r.run_id,
    status: r.status,
    ...(paused
      ? {
          paused: true,
          message:
            "The run is paused: it picks up no new tasks until it is resumed. Tasks already in flight can still finish, and the run completes on its own if those were the last ones. Resume it through the Batch API (POST /v1/jobs/{job_id}/resume); this MCP server has no resume tool.",
        }
      : {}),
    stats: r.stats,
    ...extra,
  };
}

/**
 * Removes response_type when it is html, the default output, which the API rejects as a value.
 * Returns whether it did, so the caller knows the task asked for html. Exported for tests.
 */
export function dropHtmlResponseType(params: Record<string, unknown>): boolean {
  if (typeof params.response_type === "string" && params.response_type.toLowerCase() === "html") {
    delete params.response_type;
    return true;
  }
  return false;
}

/**
 * The API fills a task's missing params from the job's, so a task that asked for html (by sending
 * no response_type) would still get the job's pdf or markdown. When any task asks for html, the
 * job-level response_type moves down to the tasks that set none, and the job keeps none.
 * Exported for tests.
 */
export function keepHtmlTasksHtml(
  jobParams: Record<string, unknown>,
  tasks: { zenrows_params?: Record<string, string> }[],
  wantsHtml: boolean[]
): void {
  const jobType = jobParams.response_type;
  if (jobType === undefined || !wantsHtml.some(Boolean)) return;
  delete jobParams.response_type;
  tasks.forEach((task, i) => {
    if (wantsHtml[i] || task.zenrows_params?.response_type !== undefined) return;
    task.zenrows_params = { ...(task.zenrows_params ?? {}), response_type: String(jobType) };
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

/** The API reads boolean params case-insensitively ("TRUE" is true), so this does too. */
function isTruthyFlag(v: unknown): boolean {
  // Exactly what the API accepts as true: lowercased, not trimmed. A padded " TRUE " is not a
  // valid boolean there, so it does not count as forcing here either.
  return v === true || (typeof v === "string" && v.toLowerCase() === "true");
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

/** Scrape params the Batch API accepts in a task's zenrows_params. */
export const TASK_SCRAPE_PARAMS: ReadonlySet<string> = new Set([
  "allowed_status_codes",
  "autoparse",
  "block_resources",
  "css_extractor",
  "custom_headers",
  "extract",
  "extract_fields",
  "js_instructions",
  "js_render",
  "json_response",
  "mode",
  "original_status",
  "outputs",
  "premium_proxy",
  "proxy_country",
  "response_type",
  "session_id",
  "wait",
  "wait_for",
]);

const TASK_FIELDS: ReadonlySet<string> = new Set(["url", "external_id", "metadata", "zenrows_params"]);

// passthrough, not the default strip: a flat scrape param on a task (`{url, extract: "auto"}`)
// must reach toTaskParams, which folds it into zenrows_params or rejects it by name.
export const taskSchema = z
  .object({
    url: z.string().url().describe("Target URL for this task"),
    external_id: z.string().nullish().describe("Optional stable id echoed back on results"),
    metadata: z
      .record(z.string(), z.string({ invalid_type_error: "metadata values must be strings" }))
      .nullish()
      .describe(
        "Optional string-to-string map echoed back on results: up to 20 keys; keys use letters, digits, '.', '_' and '-', up to 64 characters; each value up to 1,024 bytes of UTF-8; keys and values 4,096 bytes in all. Values must be strings: convert numbers and booleans first."
      ),
    zenrows_params: z
      .record(z.union([z.string(), z.number(), z.boolean()]))
      .nullish()
      .describe("Per-task Zenrows scrape params (js_render, premium_proxy, extract, autoparse, …)"),
  })
  .passthrough()
  .describe(
    "A task. Scrape params may go in zenrows_params or flat on the task (e.g. extract, js_render); flat keys win."
  );

/**
 * Merges a task's flat scrape params over its nested zenrows_params (flat wins, as in the CLI's
 * JSONL format). Returns the unknown keys instead of dropping them, so the caller can fail loudly.
 * Exported for tests.
 */
export function toTaskParams(task: Record<string, unknown>): {
  params?: Record<string, string>;
  unknown: string[];
} {
  const merged: Record<string, unknown> = { ...((task.zenrows_params as Record<string, unknown>) ?? {}) };
  const unknown: string[] = [];
  for (const [k, v] of Object.entries(task)) {
    if (TASK_FIELDS.has(k)) continue;
    if (TASK_SCRAPE_PARAMS.has(k)) merged[k] = v;
    else unknown.push(k);
  }
  const params = normalizeParams(merged);
  return { params: Object.keys(params).length ? params : undefined, unknown };
}

export function registerBatchTools(server: McpServer, apiKey: string): void {
  const ua = `zenrows/mcp ${pkg.version}`;
  const call = { apiKey, userAgent: ua };

  server.registerTool(
    "batch_create",
    {
      annotations: { title: "Create Batch Job", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description: `Submit a cloud Batch job that fans out many URLs asynchronously (Zenrows Batch API).

NOT the same as browser_batch — this hits https://async.api.zenrows.com/v1 with X-API-Key.
Suited to large URL lists; scrape and extract handle single pages.

Tasks use automatic mode (mode=auto) by default: Zenrows enables JS
rendering and premium proxies only on the pages that need them, and charges
only for the configuration that succeeds. Pass just the URLs. Set js_render or
premium_proxy (job-level or in a task's zenrows_params) only to force a fixed
configuration; that turns automatic mode off for the affected tasks and bills
them at that configuration's cost.

Creates a closed job: all tasks are sent in this one call (up to 100,000).
Every call sends an Idempotency-Key (generated unless idempotency_key is set).
A repeat with the same key and the same body, after the first call finished,
returns the original response instead of creating a second job. A different
body, or a repeat while the first call is still being processed, gets
BATCH_FAILED with server_code idempotency_key_conflict (409). Keys are kept 24 hours.

Returns job_id + latest_run.status/stats. batch_status and batch_wait report progress; batch_results pages the results.
Errors: BATCH_ACCESS_DENIED (Batch is not enabled for this account or API key),
BATCH_QUOTA_EXCEEDED (402 with reason insufficient_credits, or 429 with reason
too_many_jobs: 3 active jobs by default), BATCH_KEY_CAP_REACHED (402, this key's
credit cap), AUTH_INVALID (401: a rejected key, or server_code
subscription_inactive when the subscription needs fixing in Billing),
BATCH_FAILED (any other HTTP error; server_code carries the Batch
API's own code when it sent one), and BACKEND_UNAVAILABLE (the API could not be
reached, after retries).

Unknown task fields are ignored, as before, and listed in \`warnings\`.`,
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
            "Force js_render on all tasks. Overrides automatic mode (mode=auto), which already renders when needed."
          ),
        premium_proxy: z
          .boolean()
          .nullish()
          .describe(
            "Force premium_proxy on all tasks (10x cost). Overrides automatic mode (mode=auto), which already uses premium proxies when a page needs them."
          ),
        mode_auto: z
          .boolean()
          .nullish()
          .describe("Automatic mode (mode=auto) is on by default; leave unset. False sends plain requests without it."),
        proxy_country: z
          .string()
          .nullish()
          .describe(
            "Job-level ISO country code. Works in automatic mode (mode=auto); with js_render alone it requires premium_proxy."
          ),
        response_type: z
          .enum(["markdown", "plaintext", "html", "pdf"])
          .nullish()
          .describe(
            "Job-level output format. html is the default (raw HTML): choosing it sends no response_type, even if zenrows_params sets one."
          ),
        zenrows_params: z
          .record(z.union([z.string(), z.number(), z.boolean()]))
          .nullish()
          .describe("Additional job-level zenrows_params merged with the flags above"),
        idempotency_key: z
          .string()
          .min(1)
          .max(128)
          .nullish()
          .describe(
            "Optional Idempotency-Key (up to 128 characters). Reuse it with the identical request to retry across calls: once the first call has finished, the API returns its original response (kept 24 hours). Generated per call when unset."
          ),
        wait: z
          .boolean()
          .nullish()
          .describe(
            "If true, poll before returning until the run ends (completed, failed, stopped or deleted) or pauses (paused:true), or wait_timeout_ms passes"
          ),
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
        external_id?: string | null;
        metadata?: Record<string, string> | null;
        zenrows_params?: Record<string, string | number | boolean> | null;
        [k: string]: unknown;
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
      // html is the API's default output and not a valid response_type value. An explicit html
      // choice wins over a response_type nested in zenrows_params.
      if (params.response_type === "html") delete jobParams.response_type;
      else if (params.response_type) jobParams.response_type = params.response_type;
      dropHtmlResponseType(jobParams);

      const tasks: {
        url: string;
        external_id?: string;
        metadata?: Record<string, string>;
        zenrows_params?: Record<string, string>;
      }[] = [];
      const wantsHtml: boolean[] = [];
      // Unknown task fields were always dropped without a word; they still are not sent, so a
      // call that worked keeps working, but each one is now named in `warnings`.
      const warnings: string[] = [];
      for (const [i, t] of tasksIn.entries()) {
        const { params: taskParams, unknown } = toTaskParams(t);
        if (unknown.length) {
          warnings.push(
            `tasks[${i}]: ignored unknown field(s) ${unknown.join(", ")}. Scrape params go in zenrows_params or flat on the task; supported: ${[...TASK_SCRAPE_PARAMS].join(", ")}.`
          );
        }
        const task: (typeof tasks)[number] = { url: t.url };
        if (t.external_id) task.external_id = t.external_id;
        if (t.metadata != null) task.metadata = t.metadata;
        let html = false;
        if (taskParams) {
          html = dropHtmlResponseType(taskParams);
          if (Object.keys(taskParams).length) task.zenrows_params = taskParams;
        }
        wantsHtml.push(html);
        tasks.push(task);
      }
      keepHtmlTasksHtml(jobParams, tasks, wantsHtml);
      if (params.mode_auto !== false) applyAdaptiveStealth(jobParams, tasks);

      const body = {
        type: "regular" as const,
        status: "closed" as const,
        tasks,
        ...(Object.keys(jobParams).length ? { zenrows_params: normalizeParams(jobParams) } : {}),
      };

      try {
        const job = await createJob(body, { ...call, idempotencyKey: params.idempotency_key ?? randomUUID() });
        const finished =
          params.wait === true
            ? await waitForJob(job.job_id, {
                ...call,
                pollTimeoutMs: params.wait_timeout_ms ?? 600_000,
              })
            : job;
        return json(
          runOutcome(finished.job_id, finished.latest_run, { job: finished, ...(warnings.length ? { warnings } : {}) })
        );
      } catch (e) {
        return batchErr(e);
      }
    }
  );

  server.registerTool(
    "batch_status",
    {
      annotations: { title: "Batch Job Status", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description:
        "Get status and stats for a Zenrows Batch job (latest_run.status + latest_run.stats). A failed run returns ok:false with failure_reason (insufficient_credits, subscription_inactive or api_key_cap_reached) and failure_detail; a paused run returns paused:true.",
      inputSchema: {
        job_id: z.string().describe("Batch job id returned by batch_create"),
      },
    },
    async ({ job_id }) => {
      try {
        const job = await getJob(job_id, call);
        return json(runOutcome(job.job_id, job.latest_run, { job }));
      } catch (e) {
        return batchErr(e);
      }
    }
  );

  server.registerTool(
    "batch_results",
    {
      annotations: { title: "Batch Job Results", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description: `List result rows for a Batch job's latest run.

Without limit or cursor it returns every row, as before. To page instead, pass
\`limit\` and/or \`cursor\`: it returns whole API pages (about 1,000 rows each)
until at least \`limit\` rows are collected (default 1000 when paging), plus
next_cursor. Pass next_cursor back as \`cursor\` to continue; next_cursor is null
on the last page. A call can overshoot \`limit\` by up to one page.

Each row may include task_id, external_id, status, and a result_url for the body.
result_url expires after 2 hours: download it soon, or call batch_results again for a fresh one.
A successful task's body is kept 14 days by default, counted from when the result was stored (the
row's updated_at; a partial rerun re-stamps the rows it copies). After that the row's
status is "expired" and it has no result_url. Failed rows keep their error.`,
      inputSchema: {
        job_id: z.string().describe("Batch job id"),
        status: z
          .enum(["successful", "failed", "processing", "all"])
          .nullish()
          .describe("Filter results by status (default: all). processing = tasks not finished yet."),
        cursor: z.string().nullish().describe("next_cursor from a previous batch_results call"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10_000)
          .nullish()
          .describe(
            "Page through results: rows to collect before stopping at a page boundary (max 10000). Unset with no cursor: every row."
          ),
      },
    },
    async ({ job_id, status, cursor, limit }) => {
      try {
        const page = await listResults(job_id, {
          ...call,
          status: status ?? undefined,
          cursor: cursor ?? undefined,
          // Paging is opt-in: with neither limit nor cursor, every row, as before.
          limit: limit ?? (cursor ? 1000 : undefined),
        });
        return json({
          ok: true,
          job_id,
          count: page.results.length,
          next_cursor: page.next_cursor,
          results: page.results,
        });
      } catch (e) {
        return batchErr(e);
      }
    }
  );

  server.registerTool(
    "batch_cancel",
    {
      annotations: { title: "Cancel Batch Job", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      description:
        "Stop an in-flight Batch job run (POST /jobs/:id/stop). Returns the stopped run's status and stats; stopping an already-stopped run is a no-op. A run that already completed or failed cannot be stopped (BATCH_FAILED, server_code run_not_stoppable). Tasks that never started stay pending; this MCP server cannot rerun them (the Batch API's rerun with status=failed,pending can).",
      inputSchema: {
        job_id: z.string().describe("Batch job id to stop"),
      },
    },
    async ({ job_id }) => {
      try {
        // The stop endpoint returns the stopped Run itself, not a Job with latest_run.
        const run = await stopJob(job_id, call);
        // `job` holds the run, as it always has; `run` is the same object under its real name.
        return json(runOutcome(job_id, run ?? undefined, { job: run, run }));
      } catch (e) {
        return batchErr(e);
      }
    }
  );

  server.registerTool(
    "batch_wait",
    {
      annotations: { title: "Wait for Batch Job", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description:
        "Poll batch_status until the job's run ends (completed, failed, stopped or deleted) or pauses (paused:true), or timeout_ms passes. A failed run returns ok:false with failure_reason (insufficient_credits, subscription_inactive or api_key_cap_reached) and failure_detail. If the job has no run left (its only run was deleted), it returns at once with status null; a deleted job ends the wait with BATCH_NOT_FOUND. Polls honor the API's Retry-After.",
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
        return json(runOutcome(job.job_id, job.latest_run, { job }));
      } catch (e) {
        return batchErr(e);
      }
    }
  );
}
