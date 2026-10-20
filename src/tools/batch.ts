import { randomUUID } from "crypto";
import { createRequire } from "module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { keyOf, type KeyRef } from "../auth/key-ref.js";
import { appendClaimHint } from "../auth/claim-hint.js";
import {
  BatchError,
  CallOpts,
  createJob,
  DEFAULT_RESULTS_LIMIT,
  DEFAULT_WAIT_SECONDS,
  deleteJob,
  findResultRow,
  getJob,
  getTaskContent,
  isPausedRun,
  Job,
  JobRun,
  listJobs,
  pauseJob,
  readResults,
  rerunJob,
  resumeJob,
  runFailure,
  stopJob,
  TERMINAL_STATUSES,
  waitForJob,
} from "../batch-api.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

type TextContent = { type: "text"; text: string };
type ToolOut = { content: TextContent[]; isError?: true };

const BINARY_NOTE =
  "Binary result, not inlined. Download result_url within 2 hours; call batch_content again for a fresh one.";

/** Default cap on batch_content's text, in characters; a page can run to megabytes. */
export const DEFAULT_CONTENT_MAX_CHARS = 20_000;

/** Tasks per batch_create call, the Batch API's limit per submit. */
export const MAX_TASKS_PER_CALL = 100_000;

function err(data: unknown, hint?: { status?: number; code?: string; message?: string }): ToolOut & { isError: true } {
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

function json(data: unknown): ToolOut {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

/**
 * jobId: set on any call about one existing job, so the agent never takes a failed wait for a
 * failed create. extra: more fields for the error, e.g. the idempotency key to retry with.
 */
function batchErr(e: unknown, jobId?: string, extra: Record<string, unknown> = {}): ToolOut {
  const data =
    e instanceof BatchError
      ? e.toJSON()
      : { code: "BATCH_FAILED", message: e instanceof Error ? e.message : String(e) };
  const hint = e instanceof BatchError ? { status: e.status, code: e.code, message: e.message } : undefined;
  return err({ ...data, ...(jobId ? { job_id: jobId } : {}), ...extra }, hint);
}

const PAUSED_NOTE =
  "The run is paused: it picks up no new tasks until batch_resume. Tasks already in flight can still finish, and the run completes on its own if those were the last ones. Waiting does not move it forward.";
const INGEST_NOTE =
  "The run is still writing its tasks (ingest_status pending), so stats and results are partial. Call batch_wait before reading results.";
const WAIT_NOTE =
  "The wait ran out and the run has not ended. This is not a failure: call batch_wait again, read finished rows with batch_results, or stop the run with batch_cancel.";

/**
 * The one output shape of the tools that answer with a job or a run: batch_create, batch_status,
 * batch_wait, batch_cancel, batch_pause, batch_resume and batch_rerun. A run that ended `failed`
 * answers ok: false with an error naming its code, as crawl does, so an agent that reads only
 * `ok` does not take a failed run for a finished one. A run that credits, the subscription or
 * a key cap ended gets the code the matching HTTP error gets. Exported for tests.
 */
export function runOutcome(
  jobId: string,
  run: JobRun | undefined,
  extra: Record<string, unknown> = {},
  note?: string
): Record<string, unknown> {
  if (!run) {
    return {
      ok: true,
      job_id: jobId,
      status: null,
      note: "The job has no current run: its only run was deleted. There is nothing to wait for; batch_rerun cannot replay it either.",
      ...extra,
    };
  }
  const notes = [note];
  const paused = isPausedRun(run);
  const ingesting = run.ingest_status === "pending" && !TERMINAL_STATUSES.has(run.status);
  if (paused) notes.push(PAUSED_NOTE);
  if (ingesting) notes.push(INGEST_NOTE);
  const failed = run.status === "failed";
  const failure = failed ? runFailure(run.failure_reason) : undefined;
  const joined = notes.filter(Boolean).join(" ");
  return {
    ok: !failed,
    job_id: jobId,
    run_id: run.run_id,
    status: run.status,
    stats: run.stats,
    ...(paused ? { paused: true } : {}),
    ...(ingesting ? { ingesting: true } : {}),
    ...(failed
      ? {
          failure_reason: run.failure_reason,
          failure_detail: run.failure_detail,
          error: {
            code: failure!.code,
            message: `Batch job ${jobId} ${run.run_id ? `run ${run.run_id} ` : ""}failed${run.failure_reason ? ` (${run.failure_reason})` : ""}: ${(run.failure_detail ?? "no reason given").replace(/\.\s*$/, "")}. ${failure!.advice}`,
            server_code: run.failure_reason,
            detail: run.failure_detail,
            job_id: jobId,
          },
        }
      : {}),
    ...(joined ? { note: joined } : {}),
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

/** Exactly what the API accepts as true: it lowercases boolean params, so "TRUE" is true too. */
function isTruthyFlag(v: unknown): boolean {
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

/** Scrape params the Batch API accepts in zenrows_params. Screenshot params are not among them. */
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

const TASK_FIELDS: ReadonlySet<string> = new Set([
  "url",
  "external_id",
  "metadata",
  "zenrows_params",
  "method",
  "body",
]);

const ID_PATTERN = /^[A-Za-z0-9._-]+$/;

const paramsSchema = z.record(z.union([z.string(), z.number(), z.boolean()]));

// passthrough, not the default strip: a flat scrape param on a task (`{url, extract: "auto"}`)
// must reach toTaskParams, which folds it into zenrows_params or rejects it by name.
export const taskSchema = z
  .object({
    url: z.string().url().max(2048).describe("Target URL for this task: http or https, up to 2,048 characters"),
    external_id: z
      .string()
      .max(128)
      .regex(ID_PATTERN, "external_id may hold only letters, digits, '.', '_' and '-'")
      .nullish()
      .describe(
        "Optional id of your own, echoed back on results: up to 128 characters, letters, digits, '.', '_' and '-' only (no spaces). Need not be unique. Put free text in metadata instead."
      ),
    metadata: z
      .record(
        z.string().min(1).max(64).regex(ID_PATTERN, "metadata keys may hold only letters, digits, '.', '_' and '-'"),
        z.string({ invalid_type_error: "metadata values must be strings" }).max(1024)
      )
      .refine((m) => Object.keys(m).length <= 20, "metadata holds at most 20 entries")
      .nullish()
      .describe(
        "Optional string-to-string map echoed back on results: up to 20 entries; keys 1 to 64 characters of letters, digits, '.', '_' and '-'; values up to 1,024 characters; 4 KiB in all. Values must be strings: convert numbers and booleans first."
      ),
    method: z
      .enum(["GET", "POST"])
      .nullish()
      .describe(
        "HTTP method for this task (default GET). POST is for read-only queries such as search or GraphQL endpoints: the target can receive the same POST more than once. POST cannot be combined with js_render, js_instructions or json_response."
      ),
    body: z
      .unknown()
      .optional()
      .describe(
        "Request body, only with method POST, up to 16 KiB. An object or array is sent as JSON; a string is sent as is, form encoded."
      ),
    zenrows_params: paramsSchema
      .nullish()
      .describe(
        `Per-task scrape params, over the job's. Accepted: ${[...TASK_SCRAPE_PARAMS].join(", ")}. Booleans as true/false. Screenshot params are not supported in Batch.`
      ),
  })
  .passthrough()
  .describe(
    "A task. Scrape params may go in zenrows_params or flat on the task (e.g. extract, js_render); a flat key wins over the same key in zenrows_params."
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

const jobIdSchema = z.string().min(1).describe("Batch job id returned by batch_create or batch_list");
const runIdSchema = z
  .string()
  .min(1)
  .nullish()
  .describe("An earlier run's id (from batch_status or batch_rerun). Default: the job's latest run.");
const idempotencySchema = z
  .string()
  .min(1)
  .max(128)
  .nullish()
  .describe(
    "Sent as the Idempotency-Key header, up to 128 characters; generated per call when unset. Reusing a key with the identical request within 24 hours returns the original response instead of doing it again; with a different request it is BATCH_IDEMPOTENCY_CONFLICT."
  );
const waitSecondsSchema = z
  .number()
  .int()
  .min(1)
  .max(3600)
  .nullish()
  .describe(`Max wait in seconds (default ${DEFAULT_WAIT_SECONDS}). Many MCP clients cancel a call after 60 s.`);
const waitMsSchema = z
  .number()
  .int()
  .min(1000)
  .max(3_600_000)
  .nullish()
  .describe("Deprecated: the same wait in milliseconds. Use the seconds parameter instead.");

/** One line for a batch_wait progress notification, e.g. "running: 120/1000 done, 3 failed". */
function progressMessage(job: Job): string {
  const run = job.latest_run;
  const s = run?.stats;
  const paused = isPausedRun(run) ? " (paused)" : "";
  return `${run?.status ?? "no run"}${paused}: ${s?.completed ?? 0}/${s?.total ?? 0} done, ${s?.failed ?? 0} failed`;
}

type Extra = {
  _meta?: { progressToken?: string | number };
  sendNotification?: (n: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number; message?: string };
  }) => Promise<void>;
};

/** Progress goes only to a client that asked for it with a progressToken. */
function progressReporter(extra: Extra | undefined): ((job: Job, poll: number) => Promise<void>) | undefined {
  const progressToken = extra?._meta?.progressToken;
  if (progressToken === undefined || !extra?.sendNotification) return undefined;
  // progress is the poll's number, as crawl_wait sends it: it must grow with every notification,
  // and the run's own counts may not.
  return (job: Job, poll: number) =>
    extra.sendNotification!({
      method: "notifications/progress",
      params: { progressToken, progress: poll, message: progressMessage(job) },
    })
      // A lost progress notification must not end the wait.
      .catch(() => undefined);
}

const COSTS = `Cost: the same credits as the regular API, per successful task: 1 for a basic request, 5 with js_render, 10 with premium_proxy, 25 with both; mode=auto bills each task at the configuration that worked. Failed tasks are not billed, except target 404 and 410 answers, billed as on the regular API.`;

const LIMITS = `Limits: up to 100,000 tasks per call; 3 active jobs per account by default, shared with Crawl (BATCH_QUOTA_EXCEEDED past that); a job frees its slot when its run ends.`;

const RESULT_FACTS = `A result_url is presigned and expires after 2 hours: call batch_results again for a fresh one, or read the body with batch_content. Results are kept 14 days by default; after that a successful row reads as status "expired", with no result_url, and batch_content answers BATCH_RESULT_EXPIRED.`;

export function registerBatchTools(
  server: McpServer,
  apiKey: KeyRef,
  getClientName: () => string | undefined = () => undefined
): void {
  const ua = `zenrows/mcp ${pkg.version}`;
  /**
   * Per-tool request options: the same client and tool headers scrape and extract send. Built at
   * call time, so the key is the one the server holds when the tool runs (stdio may provision it
   * after the tools are registered).
   */
  const call = (tool: string): CallOpts => {
    const client = getClientName();
    return {
      apiKey: keyOf(apiKey),
      userAgent: ua,
      headers: { ...(client ? { "x-mcp-client-name": client } : {}), "x-mcp-tool": tool },
    };
  };

  /** Waits for a run and shapes the answer: a timeout returns the current state with ok:true. */
  async function waitAndAnswer(
    tool: string,
    jobId: string,
    timeout: number,
    extra: Extra | undefined,
    more: Record<string, unknown> = {}
  ): Promise<ToolOut> {
    const outcome = await waitForJob(jobId, { ...call(tool), timeout, onPoll: progressReporter(extra) });
    if (!outcome.job) {
      // Every poll failed with a transient error: there is no state to report.
      throw outcome.lastError ?? new BatchError({ code: "BACKEND_UNAVAILABLE", message: "No poll succeeded." });
    }
    const job = outcome.job;
    const note = outcome.timedOut ? WAIT_NOTE : undefined;
    return json(
      runOutcome(
        job.job_id ?? jobId,
        job.latest_run,
        { ...more, ...(outcome.timedOut ? { timed_out: true } : {}), job },
        note
      )
    );
  }

  const waitSeconds = (s?: number | null, ms?: number | null) =>
    s ?? (ms != null ? Math.ceil(ms / 1000) : DEFAULT_WAIT_SECONDS);

  server.registerTool(
    "batch_create",
    {
      annotations: { title: "Create Batch Job", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description: `Submit a Batch job: many URLs scraped asynchronously in the cloud (Zenrows Batch API). Suited to large URL lists; scrape and extract handle single pages. Not the same as browser_batch.

Tasks use automatic mode (mode=auto) by default: Zenrows enables JS rendering and premium proxies only on the pages that need them. Pass just the URLs. Set js_render or premium_proxy (job-level, or per task) only to force a fixed configuration; that turns automatic mode off for those tasks.

${COSTS}
${LIMITS}

Creates a closed job with every task in this one call. Each task takes a url plus optional external_id, metadata, method/body (POST tasks) and scrape params. Every call sends an Idempotency-Key, so the bounded retries on network errors and 5xx never create a second job; an error reply carries the key to retry with.

Returns job_id, status and stats at once; the job runs asynchronously. Then: batch_wait until it ends, batch_results to list rows (paged), batch_content to read one task's page. A run that ends failed (out of credits, inactive subscription, key cap) answers ok:false with error.code and server_code; batch_rerun recovers it. Submits of 10,000+ tasks keep writing tasks for a while (ingesting:true).
Errors: BATCH_INVALID_REQUEST (400, server_code and invalid_tasks say what), BATCH_INSUFFICIENT_CREDITS (402), BATCH_KEY_CAP_REACHED (402, this key's cap), BATCH_QUOTA_EXCEEDED (429, job limit), AUTH_INVALID (401; server_code subscription_inactive means fix Billing), BATCH_ACCESS_DENIED (403, do not retry), BACKEND_UNAVAILABLE.
Schedules, webhooks, exports, CSV inputs and open jobs are available through the Batch API and SDKs only.`,
      inputSchema: {
        tasks: z
          .array(taskSchema)
          .max(MAX_TASKS_PER_CALL)
          .nullish()
          .describe("Tasks (each needs a url), up to 100,000. Prefer this over urls when you need per-task params."),
        urls: z
          .array(z.string().url().max(2048))
          .max(MAX_TASKS_PER_CALL)
          .nullish()
          .describe("Shorthand: list of URLs (converted to tasks), up to 100,000. Ignored when tasks is provided."),
        js_render: z
          .boolean()
          .nullish()
          .describe(
            "Force js_render on all tasks (5 credits each). Overrides automatic mode (mode=auto), which already renders when needed."
          ),
        premium_proxy: z
          .boolean()
          .nullish()
          .describe(
            "Force premium_proxy on all tasks (10 credits each, 25 with js_render). Overrides automatic mode (mode=auto), which already uses premium proxies when a page needs them."
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
          .enum(["markdown", "plaintext", "pdf"])
          .nullish()
          .describe("Job-level output format. Leave unset for the raw HTML, the default."),
        zenrows_params: paramsSchema
          .nullish()
          .describe(
            `Additional job-level scrape params merged with the flags above. Accepted: ${[...TASK_SCRAPE_PARAMS].join(", ")}.`
          ),
        idempotency_key: idempotencySchema,
        wait: z
          .boolean()
          .nullish()
          .describe(
            "If true, poll before returning until the run ends or pauses, or wait_timeout passes; a timeout returns the current state with ok:true"
          ),
        wait_timeout: waitSecondsSchema.describe(
          `Max wait in seconds when wait=true (default ${DEFAULT_WAIT_SECONDS}). Many MCP clients cancel a call after 60 s.`
        ),
        wait_timeout_ms: waitMsSchema,
      },
    },
    async (params, extra) => {
      type TaskIn = {
        url: string;
        external_id?: string | null;
        metadata?: Record<string, string> | null;
        method?: "GET" | "POST" | null;
        body?: unknown;
        zenrows_params?: Record<string, string | number | boolean> | null;
        [k: string]: unknown;
      };
      const tasksIn: TaskIn[] =
        params.tasks && params.tasks.length > 0 ? params.tasks : (params.urls ?? []).map((url) => ({ url }));
      if (!tasksIn.length) {
        return err({ code: "INVALID_USAGE", message: "Provide tasks (preferred) or urls with at least one URL." });
      }

      const jobParams: Record<string, unknown> = { ...(params.zenrows_params ?? {}) };
      if (params.js_render) jobParams.js_render = true;
      if (params.premium_proxy) jobParams.premium_proxy = true;
      if (params.proxy_country) jobParams.proxy_country = params.proxy_country.toLowerCase();
      if (params.response_type) jobParams.response_type = params.response_type;
      // html is the API's default output and not a valid response_type value.
      dropHtmlResponseType(jobParams);

      type TaskOut = {
        url: string;
        external_id?: string;
        metadata?: Record<string, string>;
        method?: "POST";
        body?: unknown;
        zenrows_params?: Record<string, string>;
      };
      const tasks: TaskOut[] = [];
      const wantsHtml: boolean[] = [];
      const unknownFields: string[] = [];
      for (const [i, t] of tasksIn.entries()) {
        const { params: taskParams, unknown } = toTaskParams(t);
        if (unknown.length) unknownFields.push(`tasks[${i}]: ${unknown.join(", ")}`);
        if (t.body !== undefined && t.method !== "POST") {
          return err({ code: "INVALID_USAGE", message: `tasks[${i}]: body needs method POST.` });
        }
        const task: TaskOut = { url: t.url };
        if (t.external_id) task.external_id = t.external_id;
        if (t.metadata != null) task.metadata = t.metadata;
        if (t.method === "POST") task.method = "POST";
        if (t.body !== undefined) task.body = t.body;
        let html = false;
        if (taskParams) {
          html = dropHtmlResponseType(taskParams);
          if (Object.keys(taskParams).length) task.zenrows_params = taskParams;
        }
        wantsHtml.push(html);
        tasks.push(task);
      }
      if (unknownFields.length) {
        return err({
          code: "INVALID_USAGE",
          message: `Unknown task field(s), nothing was sent: ${unknownFields.slice(0, 10).join("; ")}. A task takes url, external_id, metadata, method, body, zenrows_params, and these scrape params flat or in zenrows_params: ${[...TASK_SCRAPE_PARAMS].join(", ")}.`,
        });
      }
      keepHtmlTasksHtml(jobParams, tasks, wantsHtml);
      if (params.mode_auto !== false) applyAdaptiveStealth(jobParams, tasks);

      const body = {
        type: "regular" as const,
        status: "closed" as const,
        tasks,
        ...(Object.keys(jobParams).length ? { zenrows_params: normalizeParams(jobParams) } : {}),
      };

      const idempotencyKey = params.idempotency_key ?? randomUUID();
      let job: Job;
      try {
        job = await createJob(body, { ...call("batch_create"), idempotencyKey });
      } catch (e) {
        return batchErr(e, undefined, { idempotency_key: idempotencyKey });
      }
      if (params.wait !== true) return json(runOutcome(job.job_id, job.latest_run, { job }));
      try {
        return await waitAndAnswer(
          "batch_create",
          job.job_id,
          waitSeconds(params.wait_timeout, params.wait_timeout_ms),
          extra as Extra
        );
      } catch (e) {
        // The job exists: say so, so the agent does not submit it again.
        return batchErr(e, job.job_id, {
          note: "The job was created; only the wait failed. Check it with batch_status.",
        });
      }
    }
  );

  server.registerTool(
    "batch_status",
    {
      annotations: { title: "Batch Job Status", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description: `Get a Batch job's latest run: job_id, run_id, status (pending, running, completed, stopped, failed), stats (total, completed, successful, failed) and the job.

A failed run answers ok:false with error.code BATCH_INSUFFICIENT_CREDITS, BATCH_KEY_CAP_REACHED, AUTH_INVALID (subscription_inactive) or BATCH_RUN_FAILED, error.server_code (the failure_reason) and failure_detail; batch_rerun recovers it once fixed. A paused run has paused:true; one still writing its tasks has ingesting:true.`,
      inputSchema: { job_id: jobIdSchema },
    },
    async ({ job_id }) => {
      try {
        const job = await getJob(job_id, call("batch_status"));
        return json(runOutcome(job.job_id ?? job_id, job.latest_run, { job }));
      } catch (e) {
        return batchErr(e, job_id);
      }
    }
  );

  server.registerTool(
    "batch_wait",
    {
      annotations: { title: "Wait for Batch Job", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description: `Poll a Batch job until its run ends (completed, stopped or failed) or pauses, and return its status and stats like batch_status. If the wait runs out first, it returns the current state with ok:true, timed_out:true and a note: call batch_wait again. A paused run returns at once with paused:true (it does not move until batch_resume). A failed run answers ok:false with error.code and server_code (insufficient_credits, subscription_inactive or api_key_cap_reached). Transient poll errors are retried. A call that carries a progressToken gets a progress notification after each poll.`,
      inputSchema: {
        job_id: jobIdSchema,
        timeout: waitSecondsSchema,
        timeout_ms: waitMsSchema,
      },
    },
    async ({ job_id, timeout, timeout_ms }, extra) => {
      try {
        return await waitAndAnswer("batch_wait", job_id, waitSeconds(timeout, timeout_ms), extra as Extra);
      } catch (e) {
        return batchErr(e, job_id);
      }
    }
  );

  server.registerTool(
    "batch_results",
    {
      annotations: { title: "Batch Job Results", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description: `List a Batch run's result rows, a page at a time: up to limit rows (default ${DEFAULT_RESULTS_LIMIT}, max 1000) and next_cursor. Pass next_cursor back as cursor to continue; it is null once every row was read.

Each row has task_id, external_id, url, metadata, status (successful, failed, pending, processing, expired), type, result_url when successful, and error when failed. ${RESULT_FACTS}

Filter with status: all (default), successful, failed, or processing (not finished yet). A sparse filter can return fewer rows than limit with next_cursor still set: keep paging. While the run is still running or writing its tasks, the list is partial.`,
      inputSchema: {
        job_id: jobIdSchema,
        run_id: runIdSchema,
        status: z
          .enum(["successful", "failed", "processing", "all"])
          .nullish()
          .describe(
            "Filter rows by status (default all). processing = tasks not finished yet. successful also returns expired rows."
          ),
        cursor: z.string().nullish().describe("next_cursor from a previous batch_results call"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .nullish()
          .describe(`Max rows to return (default ${DEFAULT_RESULTS_LIMIT}, max 1000)`),
      },
    },
    async ({ job_id, run_id, status, cursor, limit }) => {
      try {
        const read = await readResults(job_id, {
          ...call("batch_results"),
          status: status ?? undefined,
          cursor: cursor ?? undefined,
          limit: limit ?? undefined,
          runId: run_id ?? undefined,
        });
        const partial = read.next_cursor !== null;
        return json({
          ok: true,
          job_id,
          ...(run_id ? { run_id } : {}),
          count: read.results.length,
          next_cursor: read.next_cursor,
          partial,
          ...(partial ? { note: "More rows remain: call batch_results again with next_cursor." } : {}),
          results: read.results,
        });
      } catch (e) {
        return batchErr(e, job_id);
      }
    }
  );

  server.registerTool(
    "batch_content",
    {
      annotations: { title: "Batch Task Content", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description: `Read one Batch task's stored result, by job_id and task_id (from batch_results). A text result (HTML, Markdown, plain text, JSON) comes back inline, cut to max_chars (default ${DEFAULT_CONTENT_MAX_CHARS}); a final note says when it was cut. A binary result (a PDF) is not inlined: the reply gives its result_url, presigned for 2 hours. Finding that URL reads the run's results; on a large run one call may run out of time first and answer with lookup_cursor: call batch_content again with it to go on.

BATCH_TASK_NOT_READY: the task has not finished; BATCH_TASK_FAILED: it failed (task_error holds its error); BATCH_RESULT_EXPIRED: past the job's retention (14 days by default); rerun to scrape it again.`,
      inputSchema: {
        job_id: jobIdSchema,
        task_id: z.string().min(1).describe("task_id from a batch_results row"),
        run_id: runIdSchema,
        max_chars: z
          .number()
          .int()
          .min(1000)
          .max(10_000_000)
          .nullish()
          .describe(`Max characters of a text result to return (default ${DEFAULT_CONTENT_MAX_CHARS})`),
        lookup_cursor: z
          .string()
          .min(1)
          .nullish()
          .describe(
            "lookup_cursor from a previous batch_content reply on a binary result, to go on looking for its result_url"
          ),
      },
    },
    async ({ job_id, task_id, run_id, max_chars, lookup_cursor }) => {
      const opts = { ...call("batch_content"), runId: run_id ?? undefined };
      try {
        const content = await getTaskContent(job_id, task_id, opts);
        if (content.kind === "text") {
          const limit = max_chars ?? DEFAULT_CONTENT_MAX_CHARS;
          const out: TextContent[] = [{ type: "text", text: content.body.slice(0, limit) }];
          if (content.body.length > limit) {
            out.push({
              type: "text",
              text: `[truncated: returned ${limit} of ${content.body.length} characters. Raise max_chars for more.]`,
            });
          }
          return { content: out };
        }
        const base = {
          ok: true,
          job_id,
          task_id,
          content_type: content.contentType,
          ...(content.bytes !== undefined ? { bytes: content.bytes } : {}),
        };
        if (content.resultUrl) {
          return json({ ...base, result_url: content.resultUrl, note: BINARY_NOTE });
        }
        const found = await findResultRow(job_id, task_id, { ...opts, cursor: lookup_cursor ?? undefined });
        if ("row" in found && found.row.result_url) {
          return json({ ...base, result_url: found.row.result_url, note: BINARY_NOTE });
        }
        if ("cursor" in found) {
          return json({
            ...base,
            lookup_cursor: found.cursor,
            note: "Binary result, not inlined. Its result_url was not found yet in this large run's results: call batch_content again with lookup_cursor to go on looking.",
          });
        }
        return json({
          ...base,
          note: "Binary result, not inlined, and its row has no result_url in batch_results (status successful). Call batch_content again later.",
        });
      } catch (e) {
        return batchErr(e, job_id, { task_id });
      }
    }
  );

  server.registerTool(
    "batch_list",
    {
      annotations: { title: "List Batch Jobs", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description:
        "List this account's Batch jobs, newest first, each with its latest run's status and stats. Filter by status (open or closed) and type (regular or scheduled). Pass next_cursor as cursor for the next page; a page can hold fewer than limit jobs while next_cursor is still set, so keep paging until it is null. Deleted jobs are not listed.",
      inputSchema: {
        status: z.enum(["open", "closed"]).nullish().describe("Only jobs with this job status"),
        type: z.enum(["regular", "scheduled"]).nullish().describe("Only jobs of this type"),
        cursor: z.string().nullish().describe("next_cursor from a previous batch_list call"),
        limit: z.number().int().min(1).max(100).nullish().describe("Jobs per page (default 20, max 100)"),
      },
    },
    async ({ status, type, cursor, limit }) => {
      try {
        const page = await listJobs({
          ...call("batch_list"),
          status: status ?? undefined,
          type: type ?? undefined,
          cursor: cursor ?? undefined,
          limit: limit ?? 20,
        });
        const jobs = page?.jobs ?? [];
        return json({ ok: true, count: jobs.length, next_cursor: page?.next_cursor ?? null, jobs });
      } catch (e) {
        return batchErr(e);
      }
    }
  );

  /** Stop, pause and resume answer with the run; a run that already ended answers with its final state. */
  async function runControl(
    tool: string,
    jobId: string,
    action: (id: string, opts: CallOpts) => Promise<JobRun>,
    endedNote: string
  ): Promise<ToolOut> {
    try {
      const run = await action(jobId, call(tool));
      // `job` holds the run, as batch_cancel always answered; `run` is the same object by its name.
      return json(runOutcome(jobId, run ?? undefined, { run, job: run }));
    } catch (e) {
      if (!(e instanceof BatchError && e.serverCode === "run_not_stoppable")) return batchErr(e, jobId);
      try {
        const job = await getJob(jobId, call(tool));
        return json(runOutcome(jobId, job.latest_run, { already_ended: true, job }, endedNote));
      } catch (e2) {
        return batchErr(e2, jobId);
      }
    }
  }

  server.registerTool(
    "batch_cancel",
    {
      annotations: {
        title: "Cancel Batch Job",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      description:
        "Stop a Batch job's current run for good. No task still waiting is started or billed; tasks already in flight finish (and bill). Results so far stay readable with batch_results. Tasks that never started stay pending: batch_rerun (default failed and pending) runs them later. Idempotent: a run that already ended answers with its final status and already_ended:true. To halt without ending the run, use batch_pause.",
      inputSchema: { job_id: jobIdSchema },
    },
    async ({ job_id }) =>
      runControl("batch_cancel", job_id, stopJob, "The run had already ended, so there was nothing to stop.")
  );

  server.registerTool(
    "batch_pause",
    {
      annotations: {
        title: "Pause Batch Job",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      description:
        "Pause a Batch job's current run: it picks up no new tasks until batch_resume. Tasks already in flight still finish and bill; for a hard cost stop use batch_cancel. A paused run still counts as an active job. Idempotent; a run that already ended answers with its final status and already_ended:true.",
      inputSchema: { job_id: jobIdSchema },
    },
    async ({ job_id }) =>
      runControl("batch_pause", job_id, pauseJob, "The run had already ended, so there was nothing to pause.")
  );

  server.registerTool(
    "batch_resume",
    {
      annotations: {
        title: "Resume Batch Job",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      description:
        "Resume a paused Batch run: it picks up its remaining tasks again, billed as they finish. Idempotent on a run that is not paused; a run that already ended answers with its final status and already_ended:true. Needs credits: BATCH_INSUFFICIENT_CREDITS or BATCH_KEY_CAP_REACHED otherwise.",
      inputSchema: { job_id: jobIdSchema },
    },
    async ({ job_id }) =>
      runControl("batch_resume", job_id, resumeJob, "The run had already ended, so there was nothing to resume.")
  );

  server.registerTool(
    "batch_rerun",
    {
      annotations: { title: "Rerun Batch Job", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description: `Start a new run of a Batch job whose latest run ended (completed, stopped or failed). By default it reruns only the tasks that failed or never started (status ["failed", "pending"]), and carries the others' results over: the recovery after a run that failed on credits or was cancelled. Pass status to pick other task statuses, or full:true to scrape every task again. Rerun tasks are billed like new ones.

A rerun of only some tasks works up to 10 days after the run started (BATCH_RERUN_WINDOW_EXPIRED after that; full:true still works). BATCH_NO_MATCHING_TASKS: no task has those statuses. BATCH_RUN_NOT_FINISHED: the latest run is still in flight. Sends an Idempotency-Key, so a retry never starts two runs. Returns the new run at once (it writes its tasks first, ingesting:true); call batch_wait.`,
      inputSchema: {
        job_id: jobIdSchema,
        status: z
          .array(z.enum(["failed", "pending", "processing", "successful"]))
          .min(1)
          .nullish()
          .describe('Task statuses to rerun (default ["failed", "pending"]). Ignored with full:true.'),
        full: z.boolean().nullish().describe("Rerun every task, not only some (default false)"),
        idempotency_key: idempotencySchema,
      },
    },
    async ({ job_id, status, full, idempotency_key }) => {
      if (full && status?.length) {
        return err({ code: "INVALID_USAGE", message: "Pass full:true or status, not both.", job_id });
      }
      const statuses = full ? undefined : [...new Set(status ?? ["failed", "pending"])];
      const idempotencyKey = idempotency_key ?? randomUUID();
      try {
        const res = await rerunJob(job_id, { ...call("batch_rerun"), statuses, idempotencyKey });
        const { latest_run, ...rest } = res;
        return json(
          runOutcome(res.job_id ?? job_id, latest_run, {
            rerun_of: rest.rerun_of,
            retried_tasks: rest.retried_tasks,
            inherited_tasks: rest.inherited_tasks,
            rerun_statuses: statuses ?? "all",
            job: res,
          })
        );
      } catch (e) {
        return batchErr(e, job_id, { idempotency_key: idempotencyKey });
      }
    }
  );

  server.registerTool(
    "batch_delete",
    {
      annotations: {
        title: "Delete Batch Job",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      description:
        "Delete a Batch job with all its runs and results, for good. A run in flight stops picking up tasks at once, and the job frees its active-job slot. The job reads as not found right away; storage is cleaned up in the background. Idempotent. To keep the results, use batch_cancel instead.",
      inputSchema: { job_id: jobIdSchema },
    },
    async ({ job_id }) => {
      try {
        await deleteJob(job_id, call("batch_delete"));
        return json({ ok: true, job_id, deleted: true });
      } catch (e) {
        return batchErr(e, job_id);
      }
    }
  );
}
