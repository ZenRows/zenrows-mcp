import { createRequire } from "module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendClaimHint } from "../auth/claim-hint.js";

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
 * True when the result carries no usable value: null, "", [], {}, or an object whose
 * every field is itself empty (e.g. `{ listings: [] }` from a page that didn't load).
 */
export function isEmptyData(data: unknown): boolean {
  if (data === null || data === undefined) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data === "object") return Object.values(data as object).every(isEmptyData);
  if (typeof data === "string") return data.trim() === "";
  return false;
}

/** Errors on extract=auto that the autoparse fallback can recover from. */
function isExtractUnavailable(status: number, body: string): boolean {
  const code = zrErrorCode(body);
  // AUTH010: domain not in the Extract open beta. REQS007: domain not prepared yet.
  return (status === 402 && code === "AUTH010") || (status === 403 && code === "REQS007");
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
};

export type ExtractSuccess = {
  ok: true;
  mode: ExtractMode;
  fellBackToAutoparse: boolean;
  empty: boolean;
  data: unknown;
  html?: string;
  raw?: string;
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
 * Core extract logic (testable). When extract=auto isn't available for the domain
 * (AUTH010 or REQS007), retries once with autoparse unless fallback_autoparse is false.
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
    params.fallback_autoparse !== false &&
    isExtractUnavailable(result.status, result.body)
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
      html = typeof envelope.html === "string" ? envelope.html : undefined;
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
      },
      description: `Extract structured data from a webpage via Zenrows.

Prefer this over scrape when you need JSON fields (products, articles, listings)
rather than a full page body.
Modes:
- auto (default): extract=auto — site-tailored Extract (open beta; currently free,
  billing may apply later; falls back to autoparse when the domain isn't enabled
  or prepared for Extract yet)
- autoparse: general-purpose structured JSON on any domain
- css: css_extractor with an explicit selector map

Requests use Adaptive Stealth Mode by default: Zenrows enables JS rendering and
premium proxies only when the site needs them, and charges only for the
configuration that succeeds. Pass just the URL for protected or dynamic pages.
Set js_render or premium_proxy only to force a fixed configuration; that turns
Adaptive Stealth Mode off and bills every request at that configuration's cost.

Check "empty" in the result: true means no field came back with a value.
For full-page markdown/HTML/screenshots, use scrape instead.`,
      inputSchema: {
        url: z.string().url().describe("The webpage URL to extract from"),
        mode: z
          .enum(["auto", "autoparse", "css"])
          .nullish()
          .default("auto")
          .describe("Extraction mode: auto (extract=auto, default), autoparse, or css (requires css_extractor)"),
        css_extractor: z
          .string()
          .nullish()
          .describe('Required when mode=css. JSON map of field→selector, e.g. \'{"title":"h1","price":".price"}\''),
        js_render: z
          .boolean()
          .nullish()
          .describe(
            "Force JS rendering on every request. Overrides Adaptive Stealth Mode, which already renders when needed."
          ),
        premium_proxy: z
          .boolean()
          .nullish()
          .describe(
            "Force premium residential proxies on every request (10x cost). Overrides Adaptive Stealth Mode, " +
              "which already escalates to premium proxies when a site blocks."
          ),
        proxy_country: z
          .string()
          .nullish()
          .describe(
            "ISO 3166-1 alpha-2 country code. Works in Adaptive Stealth Mode; with js_render or mode_auto=false it requires premium_proxy."
          ),
        mode_auto: z
          .boolean()
          .nullish()
          .describe(
            "Adaptive Stealth Mode (mode=auto) is on by default; leave unset. False sends a plain request without it."
          ),
        wait_for: z
          .string()
          .nullish()
          .describe(
            "CSS selector to wait for before extracting. Requires js_render=true; without it, including in Adaptive Stealth Mode, it may be ignored."
          ),
        wait: z
          .number()
          .int()
          .min(0)
          .max(30000)
          .nullish()
          .describe(
            "Milliseconds to wait after load. Requires js_render=true; without it, including in Adaptive Stealth Mode, it may be ignored."
          ),
        fallback_autoparse: z
          .boolean()
          .nullish()
          .default(true)
          .describe(
            "When mode=auto and the domain isn't enabled (AUTH010) or prepared (REQS007) for Extract, retry once with autoparse (default true)"
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
      });
    }
  );
}
