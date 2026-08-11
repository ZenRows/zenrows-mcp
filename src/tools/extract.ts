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

function isEmptyData(data: unknown): boolean {
  if (data === null || data === undefined) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data === "object") return Object.keys(data as object).length === 0;
  if (typeof data === "string") return data.trim() === "";
  return false;
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
  if (opts.mode_auto) sp.set("mode", "auto");
  if (opts.js_render) sp.set("js_render", "true");
  if (opts.premium_proxy) sp.set("premium_proxy", "true");
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
 * Core extract logic (testable). AUTH010 on mode=auto retries once with autoparse
 * unless fallback_autoparse is false — same behavior as the CLI extract adapter.
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
  let result = await callZenrows(
    apiKey,
    buildExtractParams(apiKey, params.url, mode, opts),
    getClientName,
    fetchImpl
  );

  let fellBackToAutoparse = false;
  if (
    !result.ok &&
    mode === "auto" &&
    params.fallback_autoparse !== false &&
    result.status === 402 &&
    zrErrorCode(result.body) === "AUTH010"
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

export function registerExtractTool(
  server: McpServer,
  apiKey: string,
  getClientName: () => string | undefined
): void {
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
  billing may apply later; may fall back to autoparse if the domain is not enabled)
- autoparse: general-purpose structured JSON on any domain
- css: css_extractor with an explicit selector map

Stealth: js_render, premium_proxy, proxy_country, or mode_auto (Adaptive Stealth Mode).
For full-page markdown/HTML/screenshots, use scrape instead.`,
      inputSchema: {
        url: z.string().url().describe("The webpage URL to extract from"),
        mode: z
          .enum(["auto", "autoparse", "css"])
          .optional()
          .default("auto")
          .describe(
            "Extraction mode: auto (extract=auto, default), autoparse, or css (requires css_extractor)"
          ),
        css_extractor: z
          .string()
          .optional()
          .describe(
            'Required when mode=css. JSON map of field→selector, e.g. \'{"title":"h1","price":".price"}\''
          ),
        js_render: z
          .boolean()
          .optional()
          .describe("Enable headless JS rendering (SPAs / dynamic content)"),
        premium_proxy: z
          .boolean()
          .optional()
          .describe("Use premium residential proxies (anti-bot). Higher credit cost."),
        proxy_country: z
          .string()
          .optional()
          .describe("ISO 3166-1 alpha-2 country code. Requires premium_proxy or mode_auto."),
        mode_auto: z
          .boolean()
          .optional()
          .describe("Enable Adaptive Stealth Mode (mode=auto) for tougher sites"),
        wait_for: z
          .string()
          .optional()
          .describe("CSS selector to wait for before extracting. Requires js_render."),
        wait: z
          .number()
          .int()
          .min(0)
          .max(30000)
          .optional()
          .describe("Milliseconds to wait after load. Requires js_render."),
        fallback_autoparse: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            "When mode=auto and the domain is not in Extract open beta (AUTH010), retry once with autoparse (default true)"
          ),
      },
    },
    async (params) => {
      const outcome = await runExtract(apiKey, params, { getClientName });
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
