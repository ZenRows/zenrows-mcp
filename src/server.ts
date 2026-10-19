import { createRequire } from "module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendClaimHint, claimLinkExpired, hasClaimHint, stripClaimHint } from "./auth/claim-hint.js";
import { refreshClaimState, usableClaimUrl } from "./auth/claim-refresh.js";
import { getZenrowsDir, readAccount } from "./auth/ensure-key.js";
import { keyOf, type KeyRef } from "./auth/key-ref.js";
import { registerAccountTools } from "./tools/account.js";
import { registerBatchTools } from "./tools/batch.js";
import { registerBrowserTools } from "./tools/browser.js";
import { registerCrawlTools } from "./tools/crawl.js";
import { registerExtractTool } from "./tools/extract.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const ZENROWS_API_URL = "https://api.zenrows.com/v1/";

const DEFAULT_JS_RENDER = process.env.ZENROWS_JS_RENDER === "true";
const DEFAULT_PREMIUM_PROXY = process.env.ZENROWS_PREMIUM_PROXY === "true";
const DEFAULT_RESPONSE_TYPE =
  (process.env.ZENROWS_RESPONSE_TYPE as "markdown" | "plaintext" | "html" | undefined) ?? "markdown";

// Sent in the initialize response; clients put it in the model's context, so it says
// which tool to reach for first, not what every tool does.
export const INSTRUCTIONS = [
  "Zenrows returns the content of public web pages.",
  "Start with scrape for one page's content, or extract for structured JSON fields.",
  "For many URLs use batch_create, then batch_wait until it ends, batch_results to page through its rows and batch_content to read one page; to discover the URLs behind a listing or section page, use crawl_create.",
  "Use the browser_* tools only when a page needs clicks, typing or several steps: browser_navigate opens a session, and browser_close frees it when done.",
  "Call account_usage (free) before a large job or after a 402.",
].join(" ");

export interface ScrapeParams {
  url: string;
  js_render?: boolean | null;
  premium_proxy?: boolean | null;
  proxy_country?: string | null;
  response_type?: "markdown" | "plaintext" | "pdf" | "html" | null;
  autoparse?: boolean | null;
  css_extractor?: string | null;
  wait_for?: string | null;
  wait?: number | null;
  js_instructions?: string | null;
  outputs?: string | null;
  screenshot?: boolean | null;
  screenshot_fullpage?: boolean | null;
  screenshot_selector?: string | null;
}

/**
 * Builds the Fetch query string. Uses Adaptive Stealth Mode (mode=auto) unless the
 * agent or the env forces js_render / premium_proxy, which the API won't combine
 * with mode=auto. Mirrors the CLI's defaultMode "auto".
 */
export function buildScrapeParams(apiKey: string, params: ScrapeParams): URLSearchParams {
  const searchParams = new URLSearchParams({
    apikey: apiKey,
    url: params.url,
  });

  const isScreenshot = !!(params.screenshot || params.screenshot_fullpage || params.screenshot_selector);
  const jsRender = !!params.js_render || DEFAULT_JS_RENDER;
  const premiumProxy = !!params.premium_proxy || DEFAULT_PREMIUM_PROXY;

  if (!jsRender && !premiumProxy) {
    searchParams.set("mode", "auto");
  } else {
    if (jsRender || isScreenshot) searchParams.set("js_render", "true");
    if (premiumProxy) searchParams.set("premium_proxy", "true");
  }
  if (params.proxy_country) searchParams.set("proxy_country", params.proxy_country.toUpperCase());
  if (params.autoparse) searchParams.set("autoparse", "true");
  if (params.css_extractor) searchParams.set("css_extractor", params.css_extractor);
  if (params.wait_for) searchParams.set("wait_for", params.wait_for);
  if (params.wait != null) searchParams.set("wait", String(params.wait));
  if (params.js_instructions) searchParams.set("js_instructions", params.js_instructions);
  if (params.outputs) searchParams.set("outputs", params.outputs);
  if (isScreenshot) searchParams.set("screenshot", "true");
  if (params.screenshot_fullpage) searchParams.set("screenshot_fullpage", "true");
  if (params.screenshot_selector) searchParams.set("screenshot_selector", params.screenshot_selector);

  const effectiveType = params.response_type ?? DEFAULT_RESPONSE_TYPE;
  if (!params.autoparse && !params.css_extractor && !params.outputs && !isScreenshot && effectiveType !== "html") {
    searchParams.set("response_type", effectiveType);
  }
  return searchParams;
}

export interface ServerOptions {
  /** Served over HTTP (hosted): tools that would write to this machine's disk answer differently. */
  hosted?: boolean;
  /**
   * stdio: resolve (or provision) the key before each tool call. Gets the MCP client's
   * name; throws an error whose message is the tool error to return.
   */
  ensureKey?: (clientName?: string) => Promise<string>;
}

export function createServer(apiKey: KeyRef, clientName?: string, options: ServerOptions = {}): McpServer {
  const server = new McpServer(
    {
      name: "zenrows",
      version: pkg.version,
    },
    { instructions: INSTRUCTIONS }
  );

  // Resolve client name: prefer explicit value (HTTP stateless path),
  // fall back to MCP handshake (stdio/persistent connection path).
  const getClientName = () => clientName ?? server.server.getClientVersion()?.name;

  if (options.ensureKey) gateTools(server, options.ensureKey, getClientName, () => keyOf(apiKey));

  // ─── scrape ────────────────────────────────────────────────────────────────

  server.registerTool(
    "scrape",
    {
      annotations: {
        title: "Scrape Webpage",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      description: `Scrape any webpage and return its content using Zenrows (Fetch).

Returns full-page content (markdown/HTML/PDF/screenshot). For structured JSON
fields (products, articles, listings), the extract tool returns parsed fields
instead of a full page body.

By default the request uses automatic mode (mode=auto): Zenrows adds JS rendering
or premium proxies per page only when a plain request does not return the page,
and charges only for the configuration that succeeds. Pass just the URL.

Set js_render or premium_proxy only to force a fixed configuration. Doing so
switches off automatic mode, and every request is billed at that
configuration's cost (premium_proxy with js_render is 25x a basic request).

Examples:
  Default:  { url: "https://example.com" }
  Geo:      { url: "https://example.com", proxy_country: "US" }
  Forced:   { url: "https://spa.com", js_render: true }`,
      inputSchema: {
        url: z.string().url().describe("The webpage URL to scrape"),

        js_render: z
          .boolean()
          .nullish()
          .describe(
            "Force JavaScript rendering on every request. Overrides automatic mode (mode=auto), " +
              "which already renders JavaScript when a page needs it. Leave unset unless you need a fixed configuration."
          ),

        premium_proxy: z
          .boolean()
          .nullish()
          .describe(
            "Force premium residential proxies on every request (10x credit cost). Overrides " +
              "automatic mode (mode=auto), which already uses premium proxies when a page needs them. " +
              "Leave unset unless you need a fixed configuration."
          ),

        proxy_country: z
          .string()
          .nullish()
          .describe(
            "Country for geo-targeted scraping. ISO 3166-1 alpha-2 code (e.g. 'US', 'GB', 'DE'). " +
              "Works in automatic mode (mode=auto); if you set js_render without premium_proxy, it requires premium_proxy=true."
          ),

        response_type: z
          .enum(["markdown", "plaintext", "pdf", "html"])
          .nullish()
          .default("markdown")
          .describe(
            "Output format. 'markdown' (default) preserves structure and is ideal for LLMs. " +
              "'plaintext' strips all formatting for pure text extraction. " +
              "'pdf' returns a PDF of the page. " +
              "'html' returns the raw HTML source (omits the response_type param; Zenrows default). " +
              "Ignored when autoparse, css_extractor, outputs, or screenshot params are set."
          ),

        autoparse: z
          .boolean()
          .nullish()
          .describe(
            "Automatically extract structured data from the page into JSON. " +
              "Best for product pages, articles, and listings."
          ),

        css_extractor: z
          .string()
          .nullish()
          .describe(
            "Extract specific elements using CSS selectors. " +
              'JSON object mapping names to selectors, e.g. \'{"title":"h1","price":".price-tag"}\'. ' +
              "Returns JSON instead of full page content."
          ),

        wait_for: z
          .string()
          .nullish()
          .describe(
            "CSS selector to wait for before capturing. Use when key content loads " +
              "after the initial page render. Requires js_render=true; without it, including in automatic mode, it may be ignored."
          ),

        wait: z
          .number()
          .int()
          .min(0)
          .max(30000)
          .nullish()
          .describe(
            "Milliseconds to wait after page load before capturing content. " +
              "Max 30000 (30s). Requires js_render=true; without it, including in automatic mode, it may be ignored."
          ),

        js_instructions: z
          .string()
          .nullish()
          .describe(
            "JSON array of browser interactions to run before scraping. Works in automatic mode (mode=auto), which then " +
              "renders the page and bills it at the JS rendering rate, or with js_render=true. " +
              'Example: [{"click":"#load-more"},{"wait":1000},{"wait_for":".results"}]'
          ),

        outputs: z
          .string()
          .nullish()
          .describe(
            "Comma-separated list of data types to extract as structured JSON. " +
              "Available: emails, headings, links, menus, images, videos, audios. " +
              "Use '*' for all types. Returns JSON instead of full page content."
          ),

        screenshot: z
          .boolean()
          .nullish()
          .describe(
            "Capture an above-the-fold screenshot of the page. " +
              "Returns an image instead of text content. Useful for visual verification or debugging."
          ),

        screenshot_fullpage: z
          .boolean()
          .nullish()
          .describe(
            "Capture a full-page screenshot including content below the fold. " +
              "Returns an image instead of text content."
          ),

        screenshot_selector: z
          .string()
          .nullish()
          .describe(
            "Capture a screenshot of a specific element using a CSS selector. " +
              'Example: ".product-card". Returns an image instead of text content.'
          ),
      },
    },
    async (params) => {
      const searchParams = buildScrapeParams(keyOf(apiKey), params);

      let response: Response;
      try {
        response = await fetch(`${ZENROWS_API_URL}?${searchParams}`, {
          headers: {
            "User-Agent": `zenrows/mcp ${pkg.version}`,
            ...(getClientName() ? { "x-mcp-client-name": getClientName()! } : {}),
            "x-mcp-tool": "scrape",
          },
        });
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Network error contacting Zenrows: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }

      if (!response.ok) {
        const body = await response.text();
        const text = appendClaimHint(`Zenrows error ${response.status}: ${body}`, {
          status: response.status,
          body,
        });
        return {
          content: [{ type: "text" as const, text }],
          isError: true,
        };
      }

      const contentType = response.headers.get("content-type") ?? "";
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
      const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
      if (contentType.startsWith("image/") || isPng || isJpeg) {
        const mimeType = isPng
          ? "image/png"
          : isJpeg
            ? "image/jpeg"
            : (contentType.split(";")[0].trim() as "image/png" | "image/jpeg");
        const base64 = Buffer.from(buffer).toString("base64");
        return {
          content: [{ type: "image" as const, data: base64, mimeType }],
        };
      }

      return {
        content: [{ type: "text" as const, text: new TextDecoder().decode(buffer) }],
      };
    }
  );

  // ─── prompts ───────────────────────────────────────────────────────────────

  server.registerPrompt(
    "scrape_and_summarize",
    {
      title: "Scrape and Summarize",
      description: "Scrape a webpage and return a concise summary of its content.",
      argsSchema: {
        url: z.string().url().describe("The webpage URL to scrape and summarize"),
      },
    },
    ({ url }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Scrape ${url} using the Zenrows MCP scrape tool and provide a concise summary of the main content. Include key points, headings, and any important data found on the page.`,
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "extract_structured_data",
    {
      title: "Extract Structured Data",
      description: "Extract specific structured data from a webpage using CSS selectors.",
      argsSchema: {
        url: z.string().url().describe("The webpage URL to extract data from"),
        fields: z
          .string()
          .describe('JSON object mapping field names to CSS selectors, e.g. \'{"title":"h1","price":".price"}\''),
      },
    },
    ({ url, fields }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Use the Zenrows MCP extract tool on ${url} with mode=css and css_extractor set to ${fields}. Return the extracted data as a clean JSON object.`,
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "scrape_js_page",
    {
      title: "Scrape JavaScript-Rendered Page",
      description: "Scrape a page that requires JavaScript rendering (React, Vue, Angular, or any SPA).",
      argsSchema: {
        url: z.string().url().describe("The JavaScript-rendered page URL to scrape"),
      },
    },
    ({ url }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Scrape ${url} using the Zenrows MCP scrape tool. Pass only the URL: automatic mode (mode=auto) renders JavaScript when the page needs it. Return the full rendered content in markdown format.`,
          },
        },
      ],
    })
  );

  registerExtractTool(server, apiKey, getClientName);
  registerBatchTools(server, apiKey, getClientName);
  registerCrawlTools(server, apiKey, { hosted: options.hosted });
  registerAccountTools(server, apiKey);

  const BROWSER_URL = process.env.ZENROWS_BROWSER_URL ?? "https://mcp.zenrows.com";
  registerBrowserTools(server, apiKey, BROWSER_URL, getClientName);

  // The handler re-reads disk so ZENROWS_HOME is visible. The account file lives on the user's machine. A hosted server would read its own
  // disk instead, which never holds the caller's account, so it does not offer this.
  if (!options.hosted) registerAccountResource(server, () => keyOf(apiKey));

  return server;
}

type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

/**
 * Wrap every tool registered from here on: resolve the key first (a refused signup becomes
 * the tool's error, and the server keeps running), and refresh claim state before a claim
 * hint leaves the server, so the hint never carries a dead link or nags a claimed account.
 */
function gateTools(
  server: McpServer,
  ensureKey: (clientName?: string) => Promise<string>,
  getClientName: () => string | undefined,
  currentKey: () => string
): void {
  const register = server.registerTool.bind(server) as (...a: unknown[]) => unknown;
  type Handler = (...args: unknown[]) => Promise<ToolResult> | ToolResult;
  const wrapped = (name: unknown, config: unknown, cb: Handler) =>
    register(name, config, async (...args: unknown[]) => {
      try {
        await ensureKey(getClientName());
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
      const result = await cb(...args);
      if (!result?.isError || !result.content?.some((c) => c.type === "text" && c.text && hasClaimHint(c.text))) {
        return result;
      }
      await refreshClaimState({ apiKey: currentKey() });
      return {
        ...result,
        content: result.content.map((c) => {
          if (c.type !== "text" || !c.text || !hasClaimHint(c.text)) return c;
          const base = stripClaimHint(c.text);
          return { ...c, text: appendClaimHint(base, { status: 402, body: base, message: base }) };
        }),
      };
    });
  (server as unknown as { registerTool: typeof wrapped }).registerTool = wrapped;
}

function registerAccountResource(server: McpServer, currentKey: () => string) {
  server.registerResource(
    "zenrows-account",
    "zenrows://account",
    {
      description:
        "Local Zenrows agent account metadata (claim URL for unclaimed Free plans). Re-reads ~/.zenrows or $ZENROWS_HOME on each read.",
      mimeType: "application/json",
    },
    async () => {
      // Claimed elsewhere, or link past its life: fix account.json before reporting it.
      if (readAccount()?.unclaimed) await refreshClaimState({ apiKey: currentKey() || undefined });
      const acct = readAccount();
      const home = getZenrowsDir();
      const claimUrl = acct?.unclaimed ? (usableClaimUrl(acct) ?? null) : null;
      const body = acct
        ? {
            accountId: acct.accountId,
            unclaimed: acct.unclaimed,
            claimUrl,
            ...(acct.unclaimed && !claimUrl ? { claimHelp: claimLinkExpired() } : {}),
            claimUrlIssuedAt: acct.claimUrlIssuedAt ?? acct.createdAt,
            createdAt: acct.createdAt,
            zenrowsHome: home,
          }
        : {
            unclaimed: false,
            message: "No local agent account file (key from env or missing).",
            zenrowsHome: home,
          };
      return {
        contents: [
          {
            uri: "zenrows://account",
            mimeType: "application/json",
            text: JSON.stringify(body, null, 2),
          },
        ],
      };
    }
  );
}
