import { createRequire } from "module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendClaimHint } from "../auth/claim-hint.js";
import { normalizeDomain, POLL_INTERVAL_SECONDS } from "./prepare.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

const ZENROWS_API_URL = "https://api.zenrows.com/v1/";

type TextContent = { type: "text"; text: string };

function err(text: string): { content: TextContent[]; isError: true } {
  return {
    content: [{ type: "text" as const, text: appendClaimHint(text, { body: text, message: text }) }],
    isError: true as const,
  };
}

function json(data: unknown): { content: TextContent[] } {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

export function zrErrorCode(body: string): string | undefined {
  try {
    const j = JSON.parse(body) as { code?: string; error?: string };
    if (typeof j.code === "string") return j.code;
    const m = typeof j.error === "string" ? j.error.match(/\((AUTH\d+)\)/) : null;
    return m?.[1];
  } catch {
    return undefined;
  }
}

/**
 * True when the result carries no usable value: null, "", or an array / object whose
 * every value is itself empty (e.g. `{ listings: [{ title: null }] }` from a page that
 * didn't load). Numbers and booleans are values, so 0 and false count as data.
 */
export function isEmptyData(data: unknown): boolean {
  if (data === null || data === undefined) return true;
  if (Array.isArray(data)) return data.every(isEmptyData);
  if (typeof data === "object") return Object.values(data as object).every(isEmptyData);
  if (typeof data === "string") return data.trim() === "";
  return false;
}

/** Extract has not prepared the domain yet: REQS007, or the legacy AUTH010. */
function isDomainNotPrepared(status: number, body: string): boolean {
  const code = zrErrorCode(body);
  // REQS007: domain not prepared for Extract yet. AUTH010: legacy domain-not-enabled code.
  return (status === 402 && code === "AUTH010") || (status === 403 && code === "REQS007");
}

/**
 * 422 `no_data_extracted` on extract=auto: Extract knows this kind of page but none
 * of the fields came back filled. It is an answer, not a failure to reach the site,
 * and the request is not charged.
 */
function isNoDataExtracted(status: number, body: string): boolean {
  return status === 422 && zrErrorCode(body)?.toLowerCase() === "no_data_extracted";
}

const NO_DATA_MESSAGE =
  "Extract found no data on this page (not charged). Check that the page rendered fully: " +
  "set js_render with wait_for, or premium_proxy on protected sites.";

/**
 * REQS007 has two causes, which the problem body tells apart: the domain is not prepared
 * ("Extract is not prepared for the requested domain (...)"), or it is prepared and Extract
 * did not recognise this page ("Extract did not recognise this page on ...", detail
 * "Extract serves ..."). Only the first is fixed by preparing the domain; preparing a
 * prepared domain returns its existing ready record, so pointing there would loop.
 */
export function isPageNotRecognised(body: string): boolean {
  try {
    const j = JSON.parse(body) as { title?: unknown; detail?: unknown };
    const title = typeof j.title === "string" ? j.title : "";
    const detail = typeof j.detail === "string" ? j.detail : "";
    return /did not recogni[sz]e this page/i.test(title) || /^Extract serves /.test(detail);
  } catch {
    return false;
  }
}

/**
 * The tool error for REQS007 / AUTH010 on mode=auto. It names the next step, because
 * agents copy it: prepare_domain for a domain not prepared yet, css for a page Extract
 * does not recognise on a prepared domain. It never offers autoparse.
 */
export function domainNotPreparedError(url: string, status: number, body: string): string {
  const domain = normalizeDomain(url);
  const common = { code: zrErrorCode(body) ?? "REQS007", status, detail: body.slice(0, 500) };
  if (isPageNotRecognised(body)) {
    return JSON.stringify({
      ...common,
      reason: "page_not_recognised",
      message:
        `Extract serves ${domain} but did not recognise this page. Preparing the domain again does not help. ` +
        "Use mode=css with a css_extractor, or contact Zenrows support with the URL.",
    });
  }
  return JSON.stringify({
    ...common,
    reason: "domain_not_prepared",
    message:
      `Extract hasn't prepared ${domain} yet. Call prepare_domain with domain "${domain}" and 1 to 5 example URLs ` +
      "(a few minutes, no credits), then retry once prepared_domain_status says ready; meanwhile use mode=css.",
    next_tool: { name: "prepare_domain", arguments: { domain, example_urls: [url] } },
    then:
      `Call prepared_domain_status with domain "${domain}" about every ${POLL_INTERVAL_SECONDS} seconds until status is ready, ` +
      "then call extract again. If prepare_domain answers already_prepared, do not retry: use mode=css.",
  });
}

export type ExtractMode = "auto" | "autoparse" | "css";

export type ExtractStealthOpts = {
  css_extractor?: string;
  js_render?: boolean;
  premium_proxy?: boolean;
  proxy_country?: string;
  mode_auto?: boolean;
  wait_for?: string;
  wait?: number;
};

export type ExtractInput = ExtractStealthOpts & {
  url: string;
  mode?: ExtractMode;
  fallback_autoparse?: boolean;
  include_html?: boolean;
};

export type ExtractSuccess = {
  ok: true;
  mode: ExtractMode;
  fellBackToAutoparse: boolean;
  empty: boolean;
  data: unknown;
  html?: string;
  raw?: string;
  /** Set when Extract answered 422 no_data_extracted; `empty` is true too. */
  noDataExtracted?: boolean;
  message?: string;
};

export type ExtractFailure = {
  ok: false;
  errorText: string;
};

export function buildExtractParams(
  apiKey: string,
  url: string,
  mode: ExtractMode,
  opts: ExtractStealthOpts
): URLSearchParams {
  const sp = new URLSearchParams({ apikey: apiKey, url });
  if (mode === "auto") sp.set("extract", "auto");
  if (mode === "autoparse") sp.set("autoparse", "true");
  if (mode === "css" && opts.css_extractor) sp.set("css_extractor", opts.css_extractor);
  // Adaptive Stealth Mode unless the caller forces js_render / premium_proxy (the API
  // won't combine them with mode=auto) or opts out with mode_auto=false. Same default
  // as scrape and the CLI.
  if (opts.js_render || opts.premium_proxy) {
    if (opts.js_render) sp.set("js_render", "true");
    if (opts.premium_proxy) sp.set("premium_proxy", "true");
  } else if (opts.mode_auto !== false) {
    sp.set("mode", "auto");
  }
  if (opts.proxy_country) sp.set("proxy_country", opts.proxy_country.toUpperCase());
  if (opts.wait_for) sp.set("wait_for", opts.wait_for);
  if (opts.wait != null) sp.set("wait", String(opts.wait));
  return sp;
}

async function callZenrows(
  apiKey: string,
  searchParams: URLSearchParams,
  getClientName: () => string | undefined,
  fetchImpl: typeof fetch
): Promise<{ ok: boolean; status: number; body: string }> {
  let response: Response;
  try {
    response = await fetchImpl(`${ZENROWS_API_URL}?${searchParams}`, {
      headers: {
        "User-Agent": `zenrows/mcp ${pkg.version}`,
        ...(getClientName() ? { "x-mcp-client-name": getClientName()! } : {}),
        "x-mcp-tool": "extract",
      },
    });
  } catch (e) {
    return {
      ok: false,
      status: 0,
      body: `Network error contacting Zenrows: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return { ok: response.ok, status: response.status, body: await response.text() };
}

/**
 * Core extract logic (testable). When Extract has not prepared the domain yet
 * (REQS007, or the legacy AUTH010), returns an error naming the prepare step. It
 * retries once with the deprecated autoparse only when fallback_autoparse is true.
 * The page HTML is returned only when include_html is true.
 */
export async function runExtract(
  apiKey: string,
  params: ExtractInput,
  options: {
    getClientName?: () => string | undefined;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<ExtractSuccess | ExtractFailure> {
  const getClientName = options.getClientName ?? (() => undefined);
  const fetchImpl = options.fetchImpl ?? fetch;
  const mode: ExtractMode = params.mode ?? "auto";

  if (mode === "css" && !params.css_extractor) {
    return {
      ok: false,
      errorText: JSON.stringify({
        code: "INVALID_USAGE",
        message: "mode=css requires css_extractor JSON selector map.",
      }),
    };
  }

  const opts: ExtractStealthOpts = {
    css_extractor: params.css_extractor,
    js_render: params.js_render,
    premium_proxy: params.premium_proxy,
    proxy_country: params.proxy_country,
    mode_auto: params.mode_auto,
    wait_for: params.wait_for,
    wait: params.wait,
  };

  let usedMode: ExtractMode = mode;
  let result = await callZenrows(apiKey, buildExtractParams(apiKey, params.url, mode, opts), getClientName, fetchImpl);

  let fellBackToAutoparse = false;
  if (
    !result.ok &&
    mode === "auto" &&
    params.fallback_autoparse === true &&
    isDomainNotPrepared(result.status, result.body)
  ) {
    usedMode = "autoparse";
    fellBackToAutoparse = true;
    result = await callZenrows(
      apiKey,
      buildExtractParams(apiKey, params.url, "autoparse", opts),
      getClientName,
      fetchImpl
    );
  }

  if (usedMode === "auto" && isNoDataExtracted(result.status, result.body)) {
    return {
      ok: true,
      mode: usedMode,
      fellBackToAutoparse,
      empty: true,
      data: null,
      noDataExtracted: true,
      message: NO_DATA_MESSAGE,
    };
  }

  if (!result.ok && usedMode === "auto" && isDomainNotPrepared(result.status, result.body)) {
    return { ok: false, errorText: domainNotPreparedError(params.url, result.status, result.body) };
  }

  if (!result.ok) {
    return {
      ok: false,
      errorText:
        result.status === 0
          ? result.body
          : JSON.stringify({
              code: zrErrorCode(result.body) ?? "EXTRACT_FAILED",
              message: `Zenrows error ${result.status}`,
              detail: result.body.slice(0, 500),
              mode: usedMode,
            }),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    return {
      ok: true,
      mode: usedMode,
      fellBackToAutoparse,
      empty: true,
      data: null,
      raw: result.body,
    };
  }

  let data: unknown = parsed;
  let html: string | undefined;
  if (usedMode === "auto" && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const envelope = parsed as { parsed?: unknown; html?: unknown };
    if ("parsed" in envelope) {
      data = envelope.parsed;
      // The page HTML is most of the response; return it only when asked for.
      html = params.include_html === true && typeof envelope.html === "string" ? envelope.html : undefined;
    }
  }

  return {
    ok: true,
    mode: usedMode,
    fellBackToAutoparse,
    empty: isEmptyData(data),
    data,
    ...(html !== undefined ? { html } : {}),
  };
}

/**
 * The tool schemas accept `null` for an unset optional parameter, because clients
 * that build their payload from a typed model (CrewAI, and anything else backed by
 * Pydantic) serialise "not set" as null rather than omitting the key. Everything
 * below this boundary still expects `undefined`, so the nulls are dropped once, here.
 */
type WithoutNulls<T> = { [K in keyof T]: Exclude<T[K], null> };

function withoutNulls<T extends Record<string, unknown>>(params: T): WithoutNulls<T> {
  return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== null)) as WithoutNulls<T>;
}

export function registerExtractTool(server: McpServer, apiKey: string, getClientName: () => string | undefined): void {
  server.registerTool(
    "extract",
    {
      annotations: {
        title: "Extract Structured Data",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      description: `Extract structured data from a webpage via Zenrows.

Returns JSON fields (products, articles, listings) in "data" rather than a full
page body. Set include_html to also get the page HTML.
Modes:
- auto (default): extract=auto, site-tailored Extract (currently free,
  billing may apply later). Works on any prepared domain, with any API key.
  On a domain not prepared yet it returns error REQS007 (reason
  domain_not_prepared). Then call prepare_domain with the domain and 1 to 5
  example URLs (a few minutes, no credits), poll prepared_domain_status until
  it says ready, and call extract again. REQS007 with reason
  page_not_recognised means the domain is prepared but this page is not
  covered: use mode=css, do not prepare again.
- autoparse: deprecated general-purpose structured JSON on any domain; use only
  when asked for
- css: css_extractor with an explicit selector map

Requests use automatic mode (mode=auto) by default: Zenrows enables JS rendering and
premium proxies only when the site needs them, and charges only for the
configuration that succeeds. Pass just the URL.
Set js_render or premium_proxy only to force a fixed configuration; that turns
automatic mode off and bills every request at that configuration's cost.

Check "empty" in the result: true means no field came back with a value.
"noDataExtracted": true means Extract processed the page and found nothing to
extract (not charged); retrying the same request returns the same answer.
Full-page markdown, HTML and screenshots come from scrape.`,
      inputSchema: {
        url: z.string().url().describe("The webpage URL to extract from"),
        mode: z
          .enum(["auto", "autoparse", "css"])
          .nullish()
          .default("auto")
          .describe(
            "Extraction mode: auto (extract=auto, default), css (requires css_extractor), or the deprecated autoparse"
          ),
        css_extractor: z
          .string()
          .nullish()
          .describe('Required when mode=css. JSON map of field→selector, e.g. \'{"title":"h1","price":".price"}\''),
        js_render: z
          .boolean()
          .nullish()
          .describe(
            "Force JS rendering on every request. Overrides automatic mode (mode=auto), which already renders when needed."
          ),
        premium_proxy: z
          .boolean()
          .nullish()
          .describe(
            "Force premium residential proxies on every request (10x cost). Overrides automatic mode (mode=auto), " +
              "which already uses premium proxies when a page needs them."
          ),
        proxy_country: z
          .string()
          .nullish()
          .describe(
            "ISO 3166-1 alpha-2 country code. Works in automatic mode (mode=auto); with js_render or mode_auto=false it requires premium_proxy."
          ),
        mode_auto: z
          .boolean()
          .nullish()
          .describe(
            "Automatic mode (mode=auto) is on by default; leave unset. False sends a plain request without it."
          ),
        wait_for: z
          .string()
          .nullish()
          .describe(
            "CSS selector to wait for before extracting. Requires js_render=true; without it, including in automatic mode, it may be ignored."
          ),
        wait: z
          .number()
          .int()
          .min(0)
          .max(30000)
          .nullish()
          .describe(
            "Milliseconds to wait after load. Requires js_render=true; without it, including in automatic mode, it may be ignored."
          ),
        fallback_autoparse: z
          .boolean()
          .nullish()
          .default(false)
          .describe(
            "Deprecated. When mode=auto and the domain isn't prepared yet (REQS007, or the legacy AUTH010), " +
              "retry once with autoparse instead of returning the error. Default false: prepare the domain instead."
          ),
        include_html: z
          .boolean()
          .nullish()
          .default(false)
          .describe(
            "mode=auto only: also return the full page HTML. Default false; the HTML is most of the response size."
          ),
      },
    },
    async (params) => {
      const outcome = await runExtract(apiKey, withoutNulls(params), { getClientName });
      if (!outcome.ok) return err(outcome.errorText);
      return json({
        ok: true,
        mode: outcome.mode,
        fellBackToAutoparse: outcome.fellBackToAutoparse,
        empty: outcome.empty,
        data: outcome.data,
        ...(outcome.html !== undefined ? { html: outcome.html } : {}),
        ...(outcome.raw !== undefined ? { raw: outcome.raw } : {}),
        ...(outcome.noDataExtracted ? { noDataExtracted: true, message: outcome.message } : {}),
      });
    }
  );
}
