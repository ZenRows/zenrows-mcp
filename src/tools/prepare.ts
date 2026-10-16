import { createRequire } from "module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendClaimHint } from "../auth/claim-hint.js";

/**
 * Prepare a domain for Extract (`extract=auto`) and follow its progress.
 *
 * `extract` answers REQS007 on a domain Extract has not prepared yet. These tools are
 * the way out: `prepare_domain` submits the domain with a few example URLs and returns
 * at once (preparation takes a few minutes and costs no credits), and
 * `prepared_domain_status` reports progress plus the account's monthly allowance.
 */

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

export const DEFAULT_EXTRACT_API_BASE = "https://api.zenrows.com/v1";
export const EXTRACT_API_BASE_ENV = "ZENROWS_EXTRACT_API_BASE";

export function extractApiBase(): string {
  const env = process.env[EXTRACT_API_BASE_ENV];
  const base = env && env.trim() ? env.trim() : DEFAULT_EXTRACT_API_BASE;
  return base.replace(/\/+$/, "");
}

export const MAX_EXAMPLE_URLS = 5;

/** status: preparing | ready | failed. state adds the step: received, discovering, preparing, verifying. */
export interface PreparedDomain {
  domain: string;
  status: string;
  state?: string;
  roles?: { role: string; status: string; url?: string; detail?: string }[];
  failure?: { code: string; detail?: string; slot_consumed?: boolean };
  submitted_at?: string;
  updated_at?: string;
  [k: string]: unknown;
}

export interface Allowance {
  used: number;
  limit: number;
  remaining: number;
  month?: string;
  [k: string]: unknown;
}

export type PrepareError = {
  code: string;
  message: string;
  status?: number;
  detail?: string;
  [k: string]: unknown;
};

type ApiResult<T> = { ok: true; data: T } | { ok: false; error: PrepareError };

type TextContent = { type: "text"; text: string };

function err(error: PrepareError): { content: TextContent[]; isError: true } {
  const raw = JSON.stringify(error);
  return {
    content: [
      {
        type: "text" as const,
        text: appendClaimHint(raw, { status: error.status, code: error.code, message: error.message, body: raw }),
      },
    ],
    isError: true as const,
  };
}

function json(data: unknown): { content: TextContent[] } {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

/**
 * A domain as the API keys it: the host, no scheme, path or leading `www.`. Accepts a URL too.
 *
 * Deliberately not the registrable domain: Extract prepares and serves each host on its
 * own. A prepared `es.wikipedia.org` does not cover `pt.wikipedia.org` (REQS007 names
 * `pt.wikipedia.org`), and `wikipedia.org` has no record of its own. The API itself folds
 * `www.` into the bare host, so dropping it here matches what it stores.
 */
export function normalizeDomain(input: string): string {
  const trimmed = input.trim();
  let host = trimmed;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    // Leave it as given; the API answers invalid_argument.
  }
  return host.toLowerCase().replace(/^www\./, "");
}

/** How often an agent should poll prepared_domain_status. */
export const POLL_INTERVAL_SECONDS = 30;

/** Whether a failed preparation used an allowance slot, from the record's failure.slot_consumed. */
function slotSentence(slotConsumed: boolean | undefined): string {
  if (slotConsumed === true) return " This attempt used an allowance slot.";
  if (slotConsumed === false) return " This attempt did not use an allowance slot.";
  return "";
}

/** What to do after a failed preparation, by failure.code (docs.zenrows.com extract/endpoints). */
export function failureNextStep(failure: PreparedDomain["failure"]): string {
  let step: string;
  switch (failure?.code) {
    case "interrupted":
    case "preparation_exhausted":
      step = "Call prepare_domain again with the same domain and example URLs.";
      break;
    case "discovery_failed":
      step = "Call prepare_domain again with example_urls (1 to 5 page URLs).";
      break;
    case "unpreparable":
      step = "Call prepare_domain again with different example URLs from the same site; the same URLs fail again.";
      break;
    case "preparation_failed":
      step = "Try other example URLs, or contact Zenrows support.";
      break;
    default:
      step = "Contact Zenrows support before preparing this domain again. Meanwhile use extract with mode=css.";
  }
  return step + slotSentence(failure?.slot_consumed);
}

/**
 * What to do when a page on a prepared domain answers REQS007 with reason page_not_recognised,
 * in the gateway's own order. On a prepared domain Extract learns a new kind of page on its
 * first request, so that answer means this page is not one Extract extracts (a page with
 * nothing to extract, such as a home page) or a transient failure kept it from trying, never that the domain
 * needs preparing again: resubmitting returns the existing ready record, so pointing there
 * would loop.
 */
export const PAGE_NOT_RECOGNISED_STEPS =
  "Try a product, article or listing page on the same site instead. If this page should work, retry it once in a " +
  "few minutes; do not retry in a loop. Otherwise use mode=css with a css_extractor. Preparing the domain again " +
  "does not change this.";

/** Said once a domain is ready, so an agent that then meets page_not_recognised does not resubmit. */
const IF_PAGE_NOT_RECOGNISED = `If extract then answers REQS007 with reason page_not_recognised, Extract did not recognise that page. ${PAGE_NOT_RECOGNISED_STEPS}`;

/**
 * The next step for a status record, so an agent never has to infer it. `alreadyReady` is
 * set when a submit answered ready at once: the domain was prepared before this call.
 */
export function statusNextStep(record: PreparedDomain, opts: { alreadyReady?: boolean } = {}): string {
  if (record.status === "ready") {
    return opts.alreadyReady
      ? `${record.domain} is already prepared, so nothing new was submitted: call extract. ${IF_PAGE_NOT_RECOGNISED}`
      : `${record.domain} is ready: call extract again. ${IF_PAGE_NOT_RECOGNISED}`;
  }
  if (record.status === "failed") return failureNextStep(record.failure);
  return `Preparation is running and takes a few minutes. Call prepared_domain_status again in about ${POLL_INTERVAL_SECONDS} seconds; call extract once status is ready.`;
}

function problem(body: string): { code?: string; detail?: string; title?: string; [k: string]: unknown } {
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    return j && typeof j === "object" ? (j as { code?: string; detail?: string }) : {};
  } catch {
    return {};
  }
}

/** Map a non-2xx prepared-domains answer to an error that names the next step. */
export function prepareError(status: number, body: string, domain: string): PrepareError {
  const p = problem(body);
  const code = typeof p.code === "string" ? p.code.toLowerCase() : undefined;
  const detail = typeof p.detail === "string" ? p.detail : body.slice(0, 500) || undefined;
  if (code === "invalid_argument" || status === 400) {
    return {
      code: "invalid_argument",
      message: `The request to prepare ${domain} was rejected. Send the domain without scheme or path and 1 to ${MAX_EXAMPLE_URLS} full page URLs from that site.`,
      status,
      detail,
      ...(p.reason ? { reason: p.reason } : {}),
    };
  }
  if (code === "not_found" || status === 404) {
    return {
      code: "not_found",
      message: `This account has not submitted ${domain} for preparation. Call prepare_domain with the domain and 1 to ${MAX_EXAMPLE_URLS} example URLs.`,
      status,
      detail,
    };
  }
  if (code === "in_progress") {
    return {
      code: "in_progress",
      message: `${domain} is already being prepared. Do not resubmit: call prepared_domain_status until status is ready, then call extract again.`,
      status,
      detail,
    };
  }
  if (code === "idempotency_conflict") {
    return {
      code: "idempotency_conflict",
      message:
        "This idempotency_key was already used with a different request. Use a new key, or resend the original request.",
      status,
      detail,
    };
  }
  if (code === "out_of_allowance" || status === 429) {
    return {
      code: "out_of_allowance",
      message:
        "This account has used its monthly allowance of new domains to prepare. Do not retry this month; use extract with mode=css meanwhile.",
      status,
      detail,
      ...(p.used !== undefined ? { used: p.used } : {}),
      ...(p.limit !== undefined ? { limit: p.limit } : {}),
      ...(p.month !== undefined ? { month: p.month } : {}),
    };
  }
  if (code === "overloaded" || code === "disabled" || status === 503) {
    return {
      code: code ?? "unavailable",
      message:
        "Domain preparation is unavailable right now. Retry in a few minutes; do not loop. Meanwhile use extract with mode=css.",
      status,
      detail,
    };
  }
  if (status === 401 || status === 403) {
    return { code: code ?? "unauthenticated", message: "Zenrows rejected the API key.", status, detail };
  }
  return { code: code ?? "PREPARE_FAILED", message: `Zenrows error ${status}`, status, detail };
}

type Opts = { fetchImpl?: typeof fetch };

async function call<T>(
  apiKey: string,
  method: "GET" | "POST",
  path: string,
  domain: string,
  opts: Opts & { body?: unknown; headers?: Record<string, string> } = {}
): Promise<ApiResult<T>> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${extractApiBase()}/extract/prepared-domains${path}`, {
      method,
      headers: {
        "X-API-Key": apiKey,
        "User-Agent": `zenrows/mcp ${pkg.version}`,
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...opts.headers,
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  } catch (e) {
    return {
      ok: false,
      error: {
        code: "NETWORK_ERROR",
        message: `Network error contacting Zenrows: ${e instanceof Error ? e.message : String(e)}`,
      },
    };
  }
  const text = await res.text();
  if (!res.ok) return { ok: false, error: prepareError(res.status, text, domain) };
  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch {
    return {
      ok: false,
      error: {
        code: "PREPARE_FAILED",
        message: "Zenrows returned a non-JSON answer.",
        status: res.status,
        detail: text.slice(0, 500),
      },
    };
  }
}

export function getPreparedDomain(apiKey: string, domain: string, opts: Opts = {}) {
  return call<PreparedDomain>(apiKey, "GET", `/${encodeURIComponent(domain)}`, domain, opts);
}

export function getAllowance(apiKey: string, opts: Opts = {}) {
  return call<Allowance>(apiKey, "GET", "/allowance", "", opts);
}

export type PrepareInput = { domain: string; example_urls: string[]; idempotency_key?: string };

/**
 * Submit a domain. Returns the status record at once; never waits for the preparation.
 * A 409 in_progress (already being prepared) answers with the current status instead of
 * an error, so the agent simply polls.
 */
export async function runPrepareDomain(apiKey: string, input: PrepareInput, opts: Opts = {}) {
  const domain = normalizeDomain(input.domain);
  const submitted = await call<PreparedDomain>(apiKey, "POST", "", domain, {
    ...opts,
    body: { domain, example_urls: input.example_urls },
    headers: input.idempotency_key ? { "Idempotency-Key": input.idempotency_key } : undefined,
  });
  if (submitted.ok) {
    // A submit that answers ready at once found the domain already prepared.
    const alreadyReady = submitted.data.status === "ready";
    return {
      ok: true as const,
      data: {
        ...submitted.data,
        ...(alreadyReady ? { already_prepared: true } : {}),
        next: statusNextStep(submitted.data, { alreadyReady }),
      },
    };
  }
  if (submitted.error.code === "in_progress") {
    const current = await getPreparedDomain(apiKey, domain, opts);
    if (current.ok) {
      return {
        ok: true as const,
        data: { ...current.data, already_in_progress: true, next: statusNextStep(current.data) },
      };
    }
  }
  return submitted;
}

/** Status of one domain plus the account's allowance; an allowance failure never hides the status. */
export async function runPreparedDomainStatus(apiKey: string, rawDomain: string, opts: Opts = {}) {
  const domain = normalizeDomain(rawDomain);
  const [record, allowance] = await Promise.all([getPreparedDomain(apiKey, domain, opts), getAllowance(apiKey, opts)]);
  if (!record.ok) {
    return allowance.ok ? { ok: false as const, error: { ...record.error, allowance: allowance.data } } : record;
  }
  return {
    ok: true as const,
    data: {
      ...record.data,
      ...(allowance.ok ? { allowance: allowance.data } : {}),
      next: statusNextStep(record.data),
    },
  };
}

export function registerPrepareTools(server: McpServer, apiKey: string): void {
  server.registerTool(
    "prepare_domain",
    {
      annotations: {
        title: "Prepare a Domain for Extract",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      description: `Prepare a domain so extract (mode=auto) works on it.

Use this when extract returns error REQS007 with reason domain_not_prepared. Send the
domain (the host, e.g. shop.example.com; a leading www. is dropped, and each host is
prepared separately) and 1 to 5 example URLs: real pages you want extracted, one per page
kind (for example one product page and one listing page). It returns at once with status
"preparing" and never waits; preparation takes a few minutes and costs no credits. Then
call prepared_domain_status about every 30 seconds until status is "ready", and call
extract again. Each new domain uses one slot of the account's monthly allowance
(prepared_domain_status shows it). A domain already being prepared returns its current
status; a domain already prepared returns "ready" at once with already_prepared: true and
uses no slot.

Do not call this for REQS007 with reason page_not_recognised: the domain is already
prepared and preparing again does not change that answer.`,
      inputSchema: {
        domain: z
          .string()
          .min(1)
          .describe("The host to prepare, e.g. shop.example.com (a URL is accepted; a leading www. is dropped)"),
        example_urls: z
          .array(z.string().url())
          .min(1)
          .max(MAX_EXAMPLE_URLS)
          .describe("1 to 5 full URLs of real pages on this domain that you want to extract, one per page kind"),
        idempotency_key: z
          .string()
          .nullish()
          .describe("Optional. Resending the same key with the same body returns the original submission"),
      },
    },
    async (params) => {
      const outcome = await runPrepareDomain(apiKey, {
        domain: params.domain,
        example_urls: params.example_urls,
        idempotency_key: params.idempotency_key ?? undefined,
      });
      return outcome.ok ? json(outcome.data) : err(outcome.error);
    }
  );

  server.registerTool(
    "prepared_domain_status",
    {
      annotations: {
        title: "Prepared Domain Status",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      description: `Check a domain submitted with prepare_domain, and the account's monthly allowance.

Returns status (preparing, ready or failed), state (the current step), roles (one per page
kind), a failure code and detail when it failed, the allowance (used, limit, remaining) and
"next": what to do now. Poll about every 30 seconds; preparation takes a few minutes. Call
extract again once status is "ready". Costs no credits.`,
      inputSchema: {
        domain: z.string().min(1).describe("The domain passed to prepare_domain, e.g. example.com"),
      },
    },
    async (params) => {
      const outcome = await runPreparedDomainStatus(apiKey, params.domain);
      return outcome.ok ? json(outcome.data) : err(outcome.error);
    }
  );
}
