#!/usr/bin/env node
import { createRequire } from "module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const ZENROWS_API_URL = "https://api.zenrows.com/v1/";

const apiKey = process.env.ZENROWS_API_KEY;
if (!apiKey) {
  process.stderr.write("Error: ZENROWS_API_KEY environment variable is required\n");
  process.exit(1);
}

const server = new McpServer({
  name: "zenrows",
  version: pkg.version,
});

// ─── scrape ──────────────────────────────────────────────────────────────────

server.registerTool(
  "scrape",
  {
  description: `Scrape any webpage and return its content using ZenRows.

Use this tool to fetch webpage content for analysis. By default it returns clean
markdown, which is ideal for LLM processing.

When to enable options:
- js_render: page uses React/Vue/Angular, loads content dynamically, or content
  appears missing on the first attempt
- premium_proxy: site returns 403/blocked errors even with js_render enabled
- wait_for: specific content loads after initial render (requires js_render)
- css_extractor: you only need specific elements, not the whole page
- autoparse: structured data pages like products or articles

Examples:
  Basic:    { url: "https://example.com" }
  Dynamic:  { url: "https://spa.com", js_render: true }
  Protected:{ url: "https://protected.com", js_render: true, premium_proxy: true }
  Extract:  { url: "https://shop.com", css_extractor: '{"title":"h1","price":".price"}' }`,
  inputSchema: {
    url: z
      .string()
      .url()
      .describe("The webpage URL to scrape"),

    js_render: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Enable JavaScript rendering via headless browser. Required for SPAs " +
        "(React, Vue, Angular) and pages that load content dynamically."
      ),

    premium_proxy: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Use premium residential proxies to bypass anti-bot protection. " +
        "Required for heavily protected sites. Implies higher credit cost."
      ),

    proxy_country: z
      .string()
      .optional()
      .describe(
        "Country for geo-targeted scraping. ISO 3166-1 alpha-2 code (e.g. 'US', 'GB', 'DE'). " +
        "Requires premium_proxy=true."
      ),

    response_type: z
      .enum(["markdown", "plaintext", "pdf", "html"])
      .optional()
      .default("markdown")
      .describe(
        "Output format. 'markdown' (default) preserves structure and is ideal for LLMs. " +
        "'plaintext' strips all formatting for pure text extraction. " +
        "'pdf' returns a PDF of the page. " +
        "'html' returns the raw HTML source (omits the response_type param; ZenRows default). " +
        "Ignored when autoparse, css_extractor, outputs, or screenshot params are set."
      ),

    autoparse: z
      .boolean()
      .optional()
      .describe(
        "Automatically extract structured data from the page into JSON. " +
        "Best for product pages, articles, and listings."
      ),

    css_extractor: z
      .string()
      .optional()
      .describe(
        "Extract specific elements using CSS selectors. " +
        'JSON object mapping names to selectors, e.g. \'{"title":"h1","price":".price-tag"}\'. ' +
        "Returns JSON instead of full page content."
      ),

    wait_for: z
      .string()
      .optional()
      .describe(
        "CSS selector to wait for before capturing. Use when key content loads " +
        "after the initial page render. Requires js_render=true."
      ),

    wait: z
      .number()
      .int()
      .min(0)
      .max(30000)
      .optional()
      .describe(
        "Milliseconds to wait after page load before capturing content. " +
        "Max 30000 (30s). Requires js_render=true."
      ),

    js_instructions: z
      .string()
      .optional()
      .describe(
        "JSON array of browser interactions to run before scraping. Requires js_render=true. " +
        'Example: [{"click":"#load-more"},{"wait":1000},{"wait_for":".results"}]'
      ),

    outputs: z
      .string()
      .optional()
      .describe(
        "Comma-separated list of data types to extract as structured JSON. " +
        "Available: emails, headings, links, menus, images, videos, audios. " +
        "Use '*' for all types. Returns JSON instead of full page content."
      ),

    screenshot: z
      .boolean()
      .optional()
      .describe(
        "Capture an above-the-fold screenshot of the page. " +
        "Returns an image instead of text content. Useful for visual verification or debugging."
      ),

    screenshot_fullpage: z
      .boolean()
      .optional()
      .describe(
        "Capture a full-page screenshot including content below the fold. " +
        "Returns an image instead of text content."
      ),

    screenshot_selector: z
      .string()
      .optional()
      .describe(
        "Capture a screenshot of a specific element using a CSS selector. " +
        'Example: ".product-card". Returns an image instead of text content.'
      ),
  },
  },
  async (params) => {
    const searchParams = new URLSearchParams({
      apikey: apiKey,
      url: params.url,
    });

    if (params.js_render || params.screenshot || params.screenshot_fullpage || params.screenshot_selector) searchParams.set("js_render", "true");
    if (params.premium_proxy) searchParams.set("premium_proxy", "true");
    if (params.proxy_country) searchParams.set("proxy_country", params.proxy_country.toUpperCase());
    if (params.autoparse) searchParams.set("autoparse", "true");
    if (params.css_extractor) searchParams.set("css_extractor", params.css_extractor);
    if (params.wait_for) searchParams.set("wait_for", params.wait_for);
    if (params.wait != null) searchParams.set("wait", String(params.wait));
    if (params.js_instructions) searchParams.set("js_instructions", params.js_instructions);
    if (params.outputs) searchParams.set("outputs", params.outputs);
    if (params.screenshot || params.screenshot_fullpage || params.screenshot_selector) searchParams.set("screenshot", "true");
    if (params.screenshot_fullpage) searchParams.set("screenshot_fullpage", "true");
    if (params.screenshot_selector) searchParams.set("screenshot_selector", params.screenshot_selector);

    // response_type is mutually exclusive with autoparse, css_extractor, outputs, and screenshot params.
    // 'html' is the ZenRows default (no param); all other values are passed through.
    const isScreenshot = params.screenshot || params.screenshot_fullpage || params.screenshot_selector;
    const effectiveType = params.response_type ?? "markdown";
    if (!params.autoparse && !params.css_extractor && !params.outputs && !isScreenshot && effectiveType !== "html") {
      searchParams.set("response_type", effectiveType);
    }

    let response: Response;
    try {
      response = await fetch(`${ZENROWS_API_URL}?${searchParams}`, {
        headers: { "User-Agent": `zenrows/mcp ${pkg.version}` },
      });
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Network error contacting ZenRows: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }

    if (!response.ok) {
      const body = await response.text();
      return {
        content: [{ type: "text" as const, text: `ZenRows error ${response.status}: ${body}` }],
        isError: true,
      };
    }

    const contentType = response.headers.get("content-type") ?? "";
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    if (contentType.startsWith("image/") || isPng || isJpeg) {
      const mimeType = isPng ? "image/png" : isJpeg ? "image/jpeg" : contentType.split(";")[0].trim() as "image/png" | "image/jpeg";
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

// ─── boot ─────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ZenRows MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
