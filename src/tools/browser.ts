import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { browserFetch, browserError } from "./browser-fetch.js";

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" };

function ok(): { content: TextContent[] } {
  return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
}

function err(msg: string): { content: TextContent[]; isError: true } {
  return { content: [{ type: "text" as const, text: msg }], isError: true as const };
}

function json(data: unknown): { content: TextContent[] } {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

const sessionId = z.string().describe("Session ID returned by browser_navigate");

export function registerBrowserTools(server: McpServer, apiKey: string, browserUrl: string, getClientName: () => string | undefined): void {
  const tfetch = (toolName: string) => (method: string, path: string, body?: unknown) =>
    browserFetch(method, path, apiKey, browserUrl, body, getClientName(), toolName);

  // ─── Session ─────────────────────────────────────────────────────────────

  server.registerTool(
    "browser_navigate",
    {
      annotations: { title: "Open Browser & Navigate", readOnlyHint: false, destructiveHint: false },
      description: `Open a ZenRows Scraping Browser session and navigate to a URL.

This is the entry point for all browser automation. It creates a new session backed by
ZenRows' anti-bot infrastructure and navigates to the given URL in one step.

Returns a session_id that must be passed to every subsequent browser_* tool call.
Always call browser_close when done to close the session and free resources.

When to use options:
- proxy_country: geo-restricted content (ISO 3166-1 alpha-2, e.g. "US", "DE")
- proxy_region: world region for geo-targeted proxy (eu, na, ap, sa, af, me)`,
      inputSchema: {
        url: z.string().url().describe("The URL to navigate to"),
        proxy_country: z
          .string()
          .optional()
          .describe("ISO 3166-1 alpha-2 country code for geo-targeted proxy (e.g. 'US', 'GB', 'DE')"),
        proxy_region: z.string().optional().describe("World region code for geo-targeted proxy (eu=Europe, na=North America, ap=Asia Pacific, sa=South America, af=Africa, me=Middle East)"),
      },
    },
    async (params) => {
      const fetch = tfetch("browser_navigate");
      let result;
      try {
        result = await fetch("POST", "/browser/sessions", {
          proxy_country: params.proxy_country,
          proxy_region: params.proxy_region,
        });
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!result.ok) return err(`Failed to create session: ${browserError(result)}`);
      const session = result.data as { session_id: string; expires_at: string };

      let navResult;
      try {
        navResult = await fetch("POST", `/browser/sessions/${session.session_id}/navigate`, { url: params.url });
      } catch (e) {
        // Best-effort cleanup — session was created but navigation failed, free the slot.
        void fetch("DELETE", `/browser/sessions/${session.session_id}`).catch(() => undefined);
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!navResult.ok) {
        void fetch("DELETE", `/browser/sessions/${session.session_id}`).catch(() => undefined);
        return err(`Navigation failed: ${browserError(navResult)}`);
      }
      const nav = navResult.data as { url: string; title: string };

      return json({ session_id: session.session_id, url: nav.url, title: nav.title, expires_at: session.expires_at });
    }
  );

  server.registerTool(
    "browser_close",
    {
      annotations: { title: "Close Browser Session", readOnlyHint: false, destructiveHint: false },
      description: "Close a browser session and free all associated resources. Always call this when done to release the browser slot.",
      inputSchema: { session_id: sessionId },
    },
    async ({ session_id }) => {
      const fetch = tfetch("browser_close");
      try {
        const result = await fetch("DELETE", `/browser/sessions/${session_id}`);
        if (!result.ok) return err(`Failed to close session: ${browserError(result)}`);
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
      return ok();
    }
  );

  // ─── Navigation ───────────────────────────────────────────────────────────

  server.registerTool(
    "browser_go_back",
    {
      annotations: { title: "Go Back", readOnlyHint: false, destructiveHint: false },
      description: "Navigate back to the previous page in the browser history.",
      inputSchema: { session_id: sessionId },
    },
    async ({ session_id }) => {
      const fetch = tfetch("browser_go_back");
      try {
        const result = await fetch("POST", `/browser/sessions/${session_id}/go_back`);
        if (!result.ok) return err(`Go back failed: ${browserError(result)}`);
        return json(result.data);
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.registerTool(
    "browser_go_forward",
    {
      annotations: { title: "Go Forward", readOnlyHint: false, destructiveHint: false },
      description: "Navigate forward to the next page in the browser history.",
      inputSchema: { session_id: sessionId },
    },
    async ({ session_id }) => {
      const fetch = tfetch("browser_go_forward");
      try {
        const result = await fetch("POST", `/browser/sessions/${session_id}/go_forward`);
        if (!result.ok) return err(`Go forward failed: ${browserError(result)}`);
        return json(result.data);
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.registerTool(
    "browser_reload",
    {
      annotations: { title: "Reload Page", readOnlyHint: false, destructiveHint: false },
      description: "Reload the current page.",
      inputSchema: { session_id: sessionId },
    },
    async ({ session_id }) => {
      const fetch = tfetch("browser_reload");
      try {
        const result = await fetch("POST", `/browser/sessions/${session_id}/reload`);
        if (!result.ok) return err(`Reload failed: ${browserError(result)}`);
        return json(result.data);
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  // ─── Interaction ──────────────────────────────────────────────────────────

  server.registerTool(
    "browser_click",
    {
      annotations: { title: "Click Element", readOnlyHint: false, destructiveHint: false },
      description: "Click an element on the page using a CSS selector. Use browser_get_accessibility_tree first to find the right selector.",
      inputSchema: {
        session_id: sessionId,
        selector: z.string().describe("CSS selector of the element to click"),
      },
    },
    async ({ session_id, selector }) => {
      const fetch = tfetch("browser_click");
      try {
        const result = await fetch("POST", `/browser/sessions/${session_id}/click`, { selector });
        if (!result.ok) return err(`Click failed: ${browserError(result)}`);
        return ok();
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.registerTool(
    "browser_hover",
    {
      annotations: { title: "Hover Element", readOnlyHint: false, destructiveHint: false },
      description: "Move the mouse cursor over an element to trigger hover effects.",
      inputSchema: {
        session_id: sessionId,
        selector: z.string().describe("CSS selector of the element to hover over"),
      },
    },
    async ({ session_id, selector }) => {
      const fetch = tfetch("browser_hover");
      try {
        const result = await fetch("POST", `/browser/sessions/${session_id}/hover`, { selector });
        if (!result.ok) return err(`Hover failed: ${browserError(result)}`);
        return ok();
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.registerTool(
    "browser_type",
    {
      annotations: { title: "Type Text", readOnlyHint: false, destructiveHint: false },
      description: "Type text into an input element. Appends to existing content unless clear_first is set.",
      inputSchema: {
        session_id: sessionId,
        selector: z.string().describe("CSS selector of the input element"),
        text: z.string().describe("Text to type"),
        clear_first: z.boolean().optional().describe("Clear existing content before typing (default false)"),
      },
    },
    async ({ session_id, selector, text, clear_first }) => {
      const fetch = tfetch("browser_type");
      try {
        const result = await fetch("POST", `/browser/sessions/${session_id}/type`, { selector, text, clear_first });
        if (!result.ok) return err(`Type failed: ${browserError(result)}`);
        return ok();
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.registerTool(
    "browser_fill",
    {
      annotations: { title: "Fill Input", readOnlyHint: false, destructiveHint: false },
      description: "Clear an input field and set its value. Preferred over browser_type when replacing the full value.",
      inputSchema: {
        session_id: sessionId,
        selector: z.string().describe("CSS selector of the input element"),
        value: z.string().describe("Value to fill in"),
      },
    },
    async ({ session_id, selector, value }) => {
      const fetch = tfetch("browser_fill");
      try {
        const result = await fetch("POST", `/browser/sessions/${session_id}/fill`, { selector, value });
        if (!result.ok) return err(`Fill failed: ${browserError(result)}`);
        return ok();
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.registerTool(
    "browser_select_option",
    {
      annotations: { title: "Select Option", readOnlyHint: false, destructiveHint: false },
      description: "Select an option from a <select> dropdown element.",
      inputSchema: {
        session_id: sessionId,
        selector: z.string().describe("CSS selector of the <select> element"),
        value: z.string().describe("Value of the option to select"),
      },
    },
    async ({ session_id, selector, value }) => {
      const fetch = tfetch("browser_select_option");
      try {
        const result = await fetch("POST", `/browser/sessions/${session_id}/select`, { selector, value });
        if (!result.ok) return err(`Select failed: ${browserError(result)}`);
        return ok();
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.registerTool(
    "browser_check",
    {
      annotations: { title: "Check Checkbox", readOnlyHint: false, destructiveHint: false },
      description: "Check a checkbox or radio button.",
      inputSchema: {
        session_id: sessionId,
        selector: z.string().describe("CSS selector of the checkbox or radio element"),
      },
    },
    async ({ session_id, selector }) => {
      const fetch = tfetch("browser_check");
      try {
        const result = await fetch("POST", `/browser/sessions/${session_id}/check`, { selector });
        if (!result.ok) return err(`Check failed: ${browserError(result)}`);
        return ok();
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.registerTool(
    "browser_uncheck",
    {
      annotations: { title: "Uncheck Checkbox", readOnlyHint: false, destructiveHint: false },
      description: "Uncheck a checkbox.",
      inputSchema: {
        session_id: sessionId,
        selector: z.string().describe("CSS selector of the checkbox element"),
      },
    },
    async ({ session_id, selector }) => {
      const fetch = tfetch("browser_uncheck");
      try {
        const result = await fetch("POST", `/browser/sessions/${session_id}/uncheck`, { selector });
        if (!result.ok) return err(`Uncheck failed: ${browserError(result)}`);
        return ok();
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.registerTool(
    "browser_focus",
    {
      annotations: { title: "Focus Element", readOnlyHint: false, destructiveHint: false },
      description: "Move focus to an element, triggering focus-dependent UI changes.",
      inputSchema: {
        session_id: sessionId,
        selector: z.string().describe("CSS selector of the element to focus"),
      },
    },
    async ({ session_id, selector }) => {
      const fetch = tfetch("browser_focus");
      try {
        const result = await fetch("POST", `/browser/sessions/${session_id}/focus`, { selector });
        if (!result.ok) return err(`Focus failed: ${browserError(result)}`);
        return ok();
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.registerTool(
    "browser_press_key",
    {
      annotations: { title: "Press Key", readOnlyHint: false, destructiveHint: false },
      description: 'Press a keyboard key. Examples: "Enter", "Tab", "Escape", "ArrowDown", "Control+a".',
      inputSchema: {
        session_id: sessionId,
        key: z.string().describe('Key to press (e.g. "Enter", "Tab", "Escape", "ArrowDown", "Control+a")'),
      },
    },
    async ({ session_id, key }) => {
      const fetch = tfetch("browser_press_key");
      try {
        const result = await fetch("POST", `/browser/sessions/${session_id}/press_key`, { key });
        if (!result.ok) return err(`Key press failed: ${browserError(result)}`);
        return ok();
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.registerTool(
    "browser_scroll",
    {
      annotations: { title: "Scroll Page", readOnlyHint: false, destructiveHint: false },
      description: "Scroll the page in a given direction.",
      inputSchema: {
        session_id: sessionId,
        direction: z.enum(["up", "down", "left", "right"]).describe("Scroll direction"),
        distance: z.number().int().positive().optional().describe("Pixels to scroll (default 500)"),
      },
    },
    async ({ session_id, direction, distance }) => {
      const fetch = tfetch("browser_scroll");
      try {
        const result = await fetch("POST", `/browser/sessions/${session_id}/scroll`, { direction, distance });
        if (!result.ok) return err(`Scroll failed: ${browserError(result)}`);
        return ok();
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.registerTool(
    "browser_drag",
    {
      annotations: { title: "Drag Element", readOnlyHint: false, destructiveHint: false },
      description: "Drag an element from its current position to a target element.",
      inputSchema: {
        session_id: sessionId,
        source_selector: z.string().describe("CSS selector of the element to drag"),
        target_selector: z.string().describe("CSS selector of the drop target"),
      },
    },
    async ({ session_id, source_selector, target_selector }) => {
      const fetch = tfetch("browser_drag");
      try {
        const result = await fetch("POST", `/browser/sessions/${session_id}/drag`, {
          source_selector,
          target_selector,
        });
        if (!result.ok) return err(`Drag failed: ${browserError(result)}`);
        return ok();
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  // ─── Extraction ───────────────────────────────────────────────────────────

  server.registerTool(
    "browser_get_accessibility_tree",
    {
      annotations: { title: "Get Accessibility Tree", readOnlyHint: true, destructiveHint: false },
      description: `Get the ARIA accessibility tree of the current page as readable text.

Call this first after browser_navigate to understand the page structure before
interacting with elements. More token-efficient than a screenshot for finding
selectors and understanding layout.

The tree shows all interactive elements (buttons, inputs, links) with their roles,
labels, and states — everything needed to drive browser interactions.`,
      inputSchema: { session_id: sessionId },
    },
    async ({ session_id }) => {
      const fetch = tfetch("browser_get_accessibility_tree");
      try {
        const result = await fetch("GET", `/browser/sessions/${session_id}/accessibility_tree`);
        if (!result.ok) return err(`Failed to get accessibility tree: ${browserError(result)}`);
        const data = result.data as { tree: string };
        return { content: [{ type: "text" as const, text: data.tree }] };
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.registerTool(
    "browser_get_url",
    {
      annotations: { title: "Get Current URL", readOnlyHint: true, destructiveHint: false },
      description: "Get the current URL of the browser session.",
      inputSchema: { session_id: sessionId },
    },
    async ({ session_id }) => {
      const fetch = tfetch("browser_get_url");
      try {
        const result = await fetch("GET", `/browser/sessions/${session_id}/url`);
        if (!result.ok) return err(`Failed to get URL: ${browserError(result)}`);
        return json(result.data);
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.registerTool(
    "browser_get_title",
    {
      annotations: { title: "Get Page Title", readOnlyHint: true, destructiveHint: false },
      description: "Get the title of the current page.",
      inputSchema: { session_id: sessionId },
    },
    async ({ session_id }) => {
      const fetch = tfetch("browser_get_title");
      try {
        const result = await fetch("GET", `/browser/sessions/${session_id}/title`);
        if (!result.ok) return err(`Failed to get title: ${browserError(result)}`);
        return json(result.data);
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.registerTool(
    "browser_get_text",
    {
      annotations: { title: "Get Text Content", readOnlyHint: true, destructiveHint: false },
      description: "Get the visible text content of an element or the entire page body.",
      inputSchema: {
        session_id: sessionId,
        selector: z.string().optional().describe("CSS selector of the element (omit for full page body text)"),
      },
    },
    async ({ session_id, selector }) => {
      const fetch = tfetch("browser_get_text");
      try {
        const result = await fetch("POST", `/browser/sessions/${session_id}/get_text`, { selector });
        if (!result.ok) return err(`Failed to get text: ${browserError(result)}`);
        const data = result.data as { text: string };
        return { content: [{ type: "text" as const, text: data.text }] };
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.registerTool(
    "browser_get_attribute",
    {
      annotations: { title: "Get Element Attribute", readOnlyHint: true, destructiveHint: false },
      description: "Get the value of a specific attribute on an element.",
      inputSchema: {
        session_id: sessionId,
        selector: z.string().describe("CSS selector of the element"),
        attribute: z.string().describe("Attribute name to retrieve (e.g. 'href', 'src', 'data-id')"),
      },
    },
    async ({ session_id, selector, attribute }) => {
      const fetch = tfetch("browser_get_attribute");
      try {
        const result = await fetch("POST", `/browser/sessions/${session_id}/get_attribute`, { selector, attribute });
        if (!result.ok) return err(`Failed to get attribute: ${browserError(result)}`);
        return json(result.data);
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.registerTool(
    "browser_get_html",
    {
      annotations: { title: "Get HTML", readOnlyHint: true, destructiveHint: false },
      description: "Get the HTML source of an element or the full page.",
      inputSchema: {
        session_id: sessionId,
        selector: z.string().optional().describe("CSS selector of the element (omit for full page HTML)"),
      },
    },
    async ({ session_id, selector }) => {
      const fetch = tfetch("browser_get_html");
      try {
        const result = await fetch("POST", `/browser/sessions/${session_id}/get_html`, { selector });
        if (!result.ok) return err(`Failed to get HTML: ${browserError(result)}`);
        const data = result.data as { html: string };
        return { content: [{ type: "text" as const, text: data.html }] };
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.registerTool(
    "browser_query_selector_all",
    {
      annotations: { title: "Query All Matching Elements", readOnlyHint: true, destructiveHint: false },
      description: "Find all elements matching a CSS selector and return their text, HTML, and attributes.",
      inputSchema: {
        session_id: sessionId,
        selector: z.string().describe("CSS selector to query"),
      },
    },
    async ({ session_id, selector }) => {
      const fetch = tfetch("browser_query_selector_all");
      try {
        const result = await fetch("POST", `/browser/sessions/${session_id}/query_selector_all`, { selector });
        if (!result.ok) return err(`Query failed: ${browserError(result)}`);
        return json(result.data);
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  // ─── Visual ───────────────────────────────────────────────────────────────

  server.registerTool(
    "browser_screenshot",
    {
      annotations: { title: "Take Screenshot", readOnlyHint: true, destructiveHint: false },
      description: "Take a screenshot of the current page or a specific element. Use for visual verification or when the accessibility tree is not sufficient.",
      inputSchema: {
        session_id: sessionId,
        full_page: z.boolean().optional().describe("Capture full page including content below the fold (default false)"),
        selector: z
          .string()
          .optional()
          .describe("CSS selector to capture only a specific element (overrides full_page)"),
      },
    },
    async ({ session_id, full_page, selector }) => {
      const fetch = tfetch("browser_screenshot");
      try {
        const result = await fetch("POST", `/browser/sessions/${session_id}/screenshot`, { full_page, selector });
        if (!result.ok) return err(`Screenshot failed: ${browserError(result)}`);
        const data = result.data as { data: string; mime_type: "image/png" | "image/jpeg" };
        return {
          content: [
            {
              type: "image" as const,
              data: data.data,
              mimeType: data.mime_type,
            } satisfies ImageContent,
          ],
        };
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.registerTool(
    "browser_generate_pdf",
    {
      annotations: { title: "Generate PDF", readOnlyHint: true, destructiveHint: false },
      description: "Render the current page as a PDF document.",
      inputSchema: {
        session_id: sessionId,
        print_background: z.boolean().optional().describe("Print background graphics (default false)"),
        landscape: z.boolean().optional().describe("Landscape orientation (default false)"),
        scale: z.number().min(0.1).max(2).optional().describe("Page scale factor (default 1)"),
      },
    },
    async ({ session_id, print_background, landscape, scale }) => {
      const fetch = tfetch("browser_generate_pdf");
      try {
        const result = await fetch("POST", `/browser/sessions/${session_id}/generate_pdf`, { print_background, landscape, scale });
        if (!result.ok) return err(`PDF generation failed: ${browserError(result)}`);
        const data = result.data as { data: string; mime_type: string };
        return {
          content: [
            {
              type: "resource" as const,
              resource: {
                uri: `data:${data.mime_type};base64,${data.data}`,
                mimeType: data.mime_type,
                blob: data.data,
              },
            },
          ],
        };
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  // ─── Wait ─────────────────────────────────────────────────────────────────

  server.registerTool(
    "browser_wait_for_selector",
    {
      annotations: { title: "Wait for Element", readOnlyHint: true, destructiveHint: false },
      description: "Wait until an element matching the CSS selector is stable in the DOM. Set visible=true to also require the element to be visible (not hidden).",
      inputSchema: {
        session_id: sessionId,
        selector: z.string().describe("CSS selector to wait for"),
        visible: z.boolean().optional().describe("Also require the element to be visible, not just present in the DOM (default false)"),
      },
    },
    async ({ session_id, selector, visible }) => {
      const fetch = tfetch("browser_wait_for_selector");
      try {
        const result = await fetch("POST", `/browser/sessions/${session_id}/wait_for_selector`, { selector, visible });
        if (!result.ok) return err(`Wait for selector failed: ${browserError(result)}`);
        return ok();
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.registerTool(
    "browser_wait_for_navigation",
    {
      annotations: { title: "Wait for Navigation", readOnlyHint: true, destructiveHint: false },
      description: "Wait for the page to navigate to a new URL. IMPORTANT: call this BEFORE the action that triggers navigation (e.g. before browser_click on a submit button), not after — the navigation event may already have fired and this will hang until timeout. If the page stays on the same URL (AJAX/SPA), skip this tool entirely. Optional timeout_ms (default 30000ms).",
      inputSchema: {
        session_id: sessionId,
        timeout_ms: z.number().int().min(1000).max(60000).optional().describe("How long to wait in milliseconds (default 30000, max 60000)"),
      },
    },
    async ({ session_id, timeout_ms }) => {
      const fetch = tfetch("browser_wait_for_navigation");
      try {
        const result = await fetch("POST", `/browser/sessions/${session_id}/wait_for_navigation`, timeout_ms ? { timeout_ms } : undefined);
        if (!result.ok) return err(`Wait for navigation failed: ${browserError(result)}`);
        return json(result.data);
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.registerTool(
    "browser_wait",
    {
      annotations: { title: "Wait", readOnlyHint: true, destructiveHint: false },
      description: "Wait for a fixed duration. Use sparingly — prefer browser_wait_for_selector when possible.",
      inputSchema: {
        session_id: sessionId,
        ms: z.number().int().min(0).max(30000).describe("Milliseconds to wait (max 30000)"),
      },
    },
    async ({ session_id, ms }) => {
      const fetch = tfetch("browser_wait");
      try {
        const result = await fetch("POST", `/browser/sessions/${session_id}/wait`, { ms });
        if (!result.ok) return err(`Wait failed: ${browserError(result)}`);
        return ok();
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  // ─── JavaScript ───────────────────────────────────────────────────────────

  server.registerTool(
    "browser_evaluate",
    {
      annotations: { title: "Evaluate JavaScript", readOnlyHint: false, destructiveHint: false },
      description: "Execute JavaScript in the browser context and return the result.",
      inputSchema: {
        session_id: sessionId,
        script: z.string().describe("JavaScript expression or function body to evaluate in the page context"),
      },
    },
    async ({ session_id, script }) => {
      const fetch = tfetch("browser_evaluate");
      try {
        const result = await fetch("POST", `/browser/sessions/${session_id}/evaluate`, { script });
        if (!result.ok) return err(`Evaluate failed: ${browserError(result)}`);
        return json(result.data);
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  // ─── Cookies ──────────────────────────────────────────────────────────────

  server.registerTool(
    "browser_get_cookies",
    {
      annotations: { title: "Get Cookies", readOnlyHint: true, destructiveHint: false },
      description: "Get all cookies for the current page.",
      inputSchema: { session_id: sessionId },
    },
    async ({ session_id }) => {
      const fetch = tfetch("browser_get_cookies");
      try {
        const result = await fetch("GET", `/browser/sessions/${session_id}/cookies`);
        if (!result.ok) return err(`Failed to get cookies: ${browserError(result)}`);
        return json(result.data);
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.registerTool(
    "browser_set_cookies",
    {
      annotations: { title: "Set Cookies", readOnlyHint: false, destructiveHint: false },
      description: "Set one or more cookies in the browser session.",
      inputSchema: {
        session_id: sessionId,
        cookies: z
          .array(
            z.object({
              name: z.string(),
              value: z.string(),
              domain: z.string().optional(),
              path: z.string().optional(),
              expires: z.number().optional().describe("Unix timestamp"),
              http_only: z.boolean().optional(),
              secure: z.boolean().optional(),
            })
          )
          .describe("Array of cookie objects to set"),
      },
    },
    async ({ session_id, cookies }) => {
      const fetch = tfetch("browser_set_cookies");
      try {
        // Remap http_only → httpOnly to match Chrome DevTools Protocol / Rod's JSON field names.
        const mapped = cookies.map(({ http_only, ...rest }) => ({ ...rest, httpOnly: http_only }));
        const result = await fetch("POST", `/browser/sessions/${session_id}/cookies`, { cookies: mapped });
        if (!result.ok) return err(`Failed to set cookies: ${browserError(result)}`);
        return ok();
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.registerTool(
    "browser_clear_cookies",
    {
      annotations: { title: "Clear Cookies", readOnlyHint: false, destructiveHint: false },
      description: "Clear all cookies for the current browser session.",
      inputSchema: { session_id: sessionId },
    },
    async ({ session_id }) => {
      const fetch = tfetch("browser_clear_cookies");
      try {
        const result = await fetch("DELETE", `/browser/sessions/${session_id}/cookies`);
        if (!result.ok) return err(`Failed to clear cookies: ${browserError(result)}`);
        return ok();
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  // ─── Local Storage ────────────────────────────────────────────────────────

  server.registerTool(
    "browser_local_storage",
    {
      annotations: { title: "Local Storage", readOnlyHint: false, destructiveHint: false },
      description: "Read, write, or clear localStorage in the current page context.",
      inputSchema: {
        session_id: sessionId,
        action: z.enum(["get", "set", "clear"]).describe("Operation: get a value, set a value, or clear all"),
        key: z.string().optional().describe("Storage key (required for get and set)"),
        value: z.string().optional().describe("Value to store (required for set)"),
      },
    },
    async ({ session_id, action, key, value }) => {
      const fetch = tfetch("browser_local_storage");
      try {
        const result = await fetch("POST", `/browser/sessions/${session_id}/local_storage`, { action, key, value });
        if (!result.ok) return err(`Local storage operation failed: ${browserError(result)}`);
        return json(result.data);
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  // ─── Tabs ─────────────────────────────────────────────────────────────────

  server.registerTool(
    "browser_new_tab",
    {
      annotations: { title: "Open New Tab", readOnlyHint: false, destructiveHint: false },
      description: "Open a new browser tab. Returns a tab_id to use with browser_switch_tab.",
      inputSchema: {
        session_id: sessionId,
        url: z.string().url().optional().describe("URL to open in the new tab (opens blank tab if omitted)"),
      },
    },
    async ({ session_id, url }) => {
      const fetch = tfetch("browser_new_tab");
      try {
        const result = await fetch("POST", `/browser/sessions/${session_id}/new_tab`, { url });
        if (!result.ok) return err(`Failed to open new tab: ${browserError(result)}`);
        return json(result.data);
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.registerTool(
    "browser_switch_tab",
    {
      annotations: { title: "Switch Tab", readOnlyHint: false, destructiveHint: false },
      description: "Switch focus to a different browser tab.",
      inputSchema: {
        session_id: sessionId,
        tab_id: z.string().describe("Tab ID returned by browser_new_tab"),
      },
    },
    async ({ session_id, tab_id }) => {
      const fetch = tfetch("browser_switch_tab");
      try {
        const result = await fetch("POST", `/browser/sessions/${session_id}/switch_tab`, { tab_id });
        if (!result.ok) return err(`Failed to switch tab: ${browserError(result)}`);
        return ok();
      } catch (e) {
        return err(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  // ─── Batch ────────────────────────────────────────────────────────────────

  const batchAction = z.discriminatedUnion("type", [
    z.object({ type: z.literal("navigate"), url: z.string().url() }),
    z.object({ type: z.literal("go_back") }),
    z.object({ type: z.literal("go_forward") }),
    z.object({ type: z.literal("reload") }),
    z.object({ type: z.literal("click"), selector: z.string() }),
    z.object({ type: z.literal("hover"), selector: z.string() }),
    z.object({ type: z.literal("type"), selector: z.string(), text: z.string(), clear_first: z.boolean().optional() }),
    z.object({ type: z.literal("fill"), selector: z.string(), value: z.string() }),
    z.object({ type: z.literal("select"), selector: z.string(), value: z.string() }),
    z.object({ type: z.literal("check"), selector: z.string() }),
    z.object({ type: z.literal("uncheck"), selector: z.string() }),
    z.object({ type: z.literal("focus"), selector: z.string() }),
    z.object({ type: z.literal("press_key"), key: z.string() }),
    z.object({ type: z.literal("scroll"), direction: z.enum(["up", "down", "left", "right"]), distance: z.number().optional() }),
    z.object({ type: z.literal("drag"), source_selector: z.string(), target_selector: z.string() }),
    z.object({ type: z.literal("get_accessibility_tree") }),
    z.object({ type: z.literal("get_url") }),
    z.object({ type: z.literal("get_title") }),
    z.object({ type: z.literal("get_text"), selector: z.string().optional() }),
    z.object({ type: z.literal("get_attribute"), selector: z.string(), attribute: z.string() }),
    z.object({ type: z.literal("get_html"), selector: z.string().optional() }),
    z.object({ type: z.literal("query_selector_all"), selector: z.string() }),
    z.object({ type: z.literal("screenshot"), full_page: z.boolean().optional(), selector: z.string().optional() }),
    z.object({ type: z.literal("wait_for_selector"), selector: z.string(), visible: z.boolean().optional() }),
    z.object({ type: z.literal("wait_for_navigation") }),
    z.object({ type: z.literal("wait"), ms: z.number().int().min(0).max(30000) }),
    z.object({ type: z.literal("evaluate"), script: z.string() }),
  ]);

  type BatchAction = z.infer<typeof batchAction>;

  async function runAction(action: BatchAction, session_id: string, fetch: ReturnType<typeof tfetch>): Promise<unknown> {
    const sid = session_id;
    switch (action.type) {
      case "navigate": {
        const r = await fetch("POST", `/browser/sessions/${sid}/navigate`, { url: action.url });
        if (!r.ok) throw new Error(browserError(r));
        return r.data;
      }
      case "go_back": {
        const r = await fetch("POST", `/browser/sessions/${sid}/go_back`);
        if (!r.ok) throw new Error(browserError(r));
        return r.data;
      }
      case "go_forward": {
        const r = await fetch("POST", `/browser/sessions/${sid}/go_forward`);
        if (!r.ok) throw new Error(browserError(r));
        return r.data;
      }
      case "reload": {
        const r = await fetch("POST", `/browser/sessions/${sid}/reload`);
        if (!r.ok) throw new Error(browserError(r));
        return r.data;
      }
      case "click": {
        const r = await fetch("POST", `/browser/sessions/${sid}/click`, { selector: action.selector });
        if (!r.ok) throw new Error(browserError(r));
        return { ok: true };
      }
      case "hover": {
        const r = await fetch("POST", `/browser/sessions/${sid}/hover`, { selector: action.selector });
        if (!r.ok) throw new Error(browserError(r));
        return { ok: true };
      }
      case "type": {
        const r = await fetch("POST", `/browser/sessions/${sid}/type`, { selector: action.selector, text: action.text, clear_first: action.clear_first });
        if (!r.ok) throw new Error(browserError(r));
        return { ok: true };
      }
      case "fill": {
        const r = await fetch("POST", `/browser/sessions/${sid}/fill`, { selector: action.selector, value: action.value });
        if (!r.ok) throw new Error(browserError(r));
        return { ok: true };
      }
      case "select": {
        const r = await fetch("POST", `/browser/sessions/${sid}/select`, { selector: action.selector, value: action.value });
        if (!r.ok) throw new Error(browserError(r));
        return { ok: true };
      }
      case "check": {
        const r = await fetch("POST", `/browser/sessions/${sid}/check`, { selector: action.selector });
        if (!r.ok) throw new Error(browserError(r));
        return { ok: true };
      }
      case "uncheck": {
        const r = await fetch("POST", `/browser/sessions/${sid}/uncheck`, { selector: action.selector });
        if (!r.ok) throw new Error(browserError(r));
        return { ok: true };
      }
      case "focus": {
        const r = await fetch("POST", `/browser/sessions/${sid}/focus`, { selector: action.selector });
        if (!r.ok) throw new Error(browserError(r));
        return { ok: true };
      }
      case "press_key": {
        const r = await fetch("POST", `/browser/sessions/${sid}/press_key`, { key: action.key });
        if (!r.ok) throw new Error(browserError(r));
        return { ok: true };
      }
      case "scroll": {
        const r = await fetch("POST", `/browser/sessions/${sid}/scroll`, { direction: action.direction, distance: action.distance });
        if (!r.ok) throw new Error(browserError(r));
        return { ok: true };
      }
      case "drag": {
        const r = await fetch("POST", `/browser/sessions/${sid}/drag`, { source_selector: action.source_selector, target_selector: action.target_selector });
        if (!r.ok) throw new Error(browserError(r));
        return { ok: true };
      }
      case "get_accessibility_tree": {
        const r = await fetch("GET", `/browser/sessions/${sid}/accessibility_tree`);
        if (!r.ok) throw new Error(browserError(r));
        return (r.data as { tree: string }).tree;
      }
      case "get_url": {
        const r = await fetch("GET", `/browser/sessions/${sid}/url`);
        if (!r.ok) throw new Error(browserError(r));
        return r.data;
      }
      case "get_title": {
        const r = await fetch("GET", `/browser/sessions/${sid}/title`);
        if (!r.ok) throw new Error(browserError(r));
        return r.data;
      }
      case "get_text": {
        const r = await fetch("POST", `/browser/sessions/${sid}/get_text`, { selector: action.selector });
        if (!r.ok) throw new Error(browserError(r));
        return (r.data as { text: string }).text;
      }
      case "get_attribute": {
        const r = await fetch("POST", `/browser/sessions/${sid}/get_attribute`, { selector: action.selector, attribute: action.attribute });
        if (!r.ok) throw new Error(browserError(r));
        return r.data;
      }
      case "get_html": {
        const r = await fetch("POST", `/browser/sessions/${sid}/get_html`, { selector: action.selector });
        if (!r.ok) throw new Error(browserError(r));
        return (r.data as { html: string }).html;
      }
      case "query_selector_all": {
        const r = await fetch("POST", `/browser/sessions/${sid}/query_selector_all`, { selector: action.selector });
        if (!r.ok) throw new Error(browserError(r));
        return r.data;
      }
      case "screenshot": {
        const r = await fetch("POST", `/browser/sessions/${sid}/screenshot`, { full_page: action.full_page, selector: action.selector });
        if (!r.ok) throw new Error(browserError(r));
        // Return as data URI string so it fits in the JSON result array.
        // For proper image rendering, use browser_screenshot directly.
        const d = r.data as { data: string; mime_type: string };
        return { mime_type: d.mime_type, data: d.data };
      }
      case "wait_for_selector": {
        const r = await fetch("POST", `/browser/sessions/${sid}/wait_for_selector`, { selector: action.selector, visible: action.visible });
        if (!r.ok) throw new Error(browserError(r));
        return { ok: true };
      }
      case "wait_for_navigation": {
        const r = await fetch("POST", `/browser/sessions/${sid}/wait_for_navigation`);
        if (!r.ok) throw new Error(browserError(r));
        return r.data;
      }
      case "wait": {
        const r = await fetch("POST", `/browser/sessions/${sid}/wait`, { ms: action.ms });
        if (!r.ok) throw new Error(browserError(r));
        return { ok: true };
      }
      case "evaluate": {
        const r = await fetch("POST", `/browser/sessions/${sid}/evaluate`, { script: action.script });
        if (!r.ok) throw new Error(browserError(r));
        return r.data;
      }
    }
  }

  server.registerTool(
    "browser_batch",
    {
      annotations: { title: "Run Batch of Browser Actions", readOnlyHint: false, destructiveHint: false },
      description: `Execute a sequence of browser actions in a single call against an existing session.

Use this when you already know the full sequence of steps — it reduces round trips and
is faster than calling each tool individually.

Actions run sequentially and stop at the first failure unless stop_on_error is false.
Each step result is returned in the results array at the same index.

Note: screenshots in batch results are returned as base64 strings inside the JSON.
For proper image rendering, use browser_screenshot directly.`,
      inputSchema: {
        session_id: sessionId,
        actions: z.array(batchAction).min(1).max(50).describe(
          "Ordered list of actions to perform. Each action has a 'type' field plus type-specific parameters."
        ),
        stop_on_error: z.boolean().optional().describe("Stop executing on the first failed action (default true)"),
      },
    },
    async ({ session_id, actions, stop_on_error = true }) => {
      const fetch = tfetch("browser_batch");
      const results: Array<{ step: number; type: string; result?: unknown; error?: string }> = [];

      for (let i = 0; i < actions.length; i++) {
        const action = actions[i];
        try {
          const result = await runAction(action, session_id, fetch);
          results.push({ step: i, type: action.type, result });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          results.push({ step: i, type: action.type, error: msg });
          if (stop_on_error) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ completed: i, total: actions.length, results }) }],
              isError: true as const,
            };
          }
        }
      }

      return json({ completed: actions.length, total: actions.length, results });
    }
  );
}
