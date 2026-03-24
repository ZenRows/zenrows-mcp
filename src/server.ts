import { createRequire } from "module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const ZENROWS_API_URL = "https://api.zenrows.com/v1/";

const DEFAULT_JS_RENDER = process.env.ZENROWS_JS_RENDER === "true";
const DEFAULT_PREMIUM_PROXY = process.env.ZENROWS_PREMIUM_PROXY === "true";
const DEFAULT_RESPONSE_TYPE =
  (process.env.ZENROWS_RESPONSE_TYPE as "markdown" | "plaintext" | "html" | undefined) ?? "markdown";

export function createServer(apiKey: string): McpServer {
  const server = new McpServer({
    name: "zenrows",
    version: pkg.version,
  });

  // ─── scrape ────────────────────────────────────────────────────────────────

  server.registerTool(
    "scrape",
    {
      annotations: {
        title: "Scrape Webpage",
        readOnlyHint: true,
        destructiveHint: false,
      },
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
        url: z.string().url().describe("The webpage URL to scrape"),

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

      if (
        params.js_render ||
        DEFAULT_JS_RENDER ||
        params.screenshot ||
        params.screenshot_fullpage ||
        params.screenshot_selector
      )
        searchParams.set("js_render", "true");
      if (params.premium_proxy || DEFAULT_PREMIUM_PROXY) searchParams.set("premium_proxy", "true");
      if (params.proxy_country)
        searchParams.set("proxy_country", params.proxy_country.toUpperCase());
      if (params.autoparse) searchParams.set("autoparse", "true");
      if (params.css_extractor) searchParams.set("css_extractor", params.css_extractor);
      if (params.wait_for) searchParams.set("wait_for", params.wait_for);
      if (params.wait != null) searchParams.set("wait", String(params.wait));
      if (params.js_instructions) searchParams.set("js_instructions", params.js_instructions);
      if (params.outputs) searchParams.set("outputs", params.outputs);
      if (params.screenshot || params.screenshot_fullpage || params.screenshot_selector)
        searchParams.set("screenshot", "true");
      if (params.screenshot_fullpage) searchParams.set("screenshot_fullpage", "true");
      if (params.screenshot_selector)
        searchParams.set("screenshot_selector", params.screenshot_selector);

      // response_type is mutually exclusive with autoparse, css_extractor, outputs, and screenshot params.
      // 'html' is the ZenRows default (no param); all other values are passed through.
      const isScreenshot =
        params.screenshot || params.screenshot_fullpage || params.screenshot_selector;
      const effectiveType = params.response_type ?? DEFAULT_RESPONSE_TYPE;
      if (
        !params.autoparse &&
        !params.css_extractor &&
        !params.outputs &&
        !isScreenshot &&
        effectiveType !== "html"
      ) {
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
      const isPng =
        bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
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
            text: `Scrape ${url} using the ZenRows MCP scrape tool and provide a concise summary of the main content. Include key points, headings, and any important data found on the page.`,
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "extract_structured_data",
    {
      title: "Extract Structured Data",
      description: "Scrape a webpage and extract specific structured data using CSS selectors.",
      argsSchema: {
        url: z.string().url().describe("The webpage URL to extract data from"),
        fields: z
          .string()
          .describe(
            'JSON object mapping field names to CSS selectors, e.g. \'{"title":"h1","price":".price"}\''
          ),
      },
    },
    ({ url, fields }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Scrape ${url} using the ZenRows MCP scrape tool with css_extractor set to ${fields}. Return the extracted data as a clean JSON object.`,
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "scrape_js_page",
    {
      title: "Scrape JavaScript-Rendered Page",
      description:
        "Scrape a page that requires JavaScript rendering (React, Vue, Angular, or any SPA).",
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
            text: `Scrape ${url} using the ZenRows MCP scrape tool with js_render set to true. The page requires JavaScript execution to load its content. Return the full rendered content in markdown format.`,
          },
        },
      ],
    })
  );

  return server;
}
