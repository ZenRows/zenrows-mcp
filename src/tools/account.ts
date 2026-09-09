import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRequire } from "module";
import { appendClaimHint } from "../auth/claim-hint.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

/**
 * Let an agent read its own allowance before it runs out of it.
 *
 * Until now nothing on this server could answer "how many credits do I have left?".
 * Responses carry `X-Request-Cost` and `X-Request-Credits` — what a call *cost*, after
 * the fact — but no counterpart to `Concurrency-Limit` / `Concurrency-Remaining`, so an
 * agent could total its own spend and still not know the ceiling. It found out by
 * hitting a 402 telling it to buy a subscription (ACT-1581, ACT-1577).
 *
 * `/v1/subscriptions/self/details` has always had the answer. It does not count against
 * concurrency, which is what makes it safe to call before a batch or on a retry.
 */

const SUBSCRIPTION_DETAILS_URL = "https://api.zenrows.com/v1/subscriptions/self/details";

type TextContent = { type: "text"; text: string };

function err(text: string, opts: { status?: number; body?: string } = {}) {
  return {
    content: [
      {
        type: "text" as const,
        text: appendClaimHint(text, {
          status: opts.status,
          body: opts.body ?? text,
          message: text,
        }),
      },
    ],
    isError: true as const,
  };
}

function json(data: unknown): { content: TextContent[] } {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

export type AccountOpts = { fetchImpl?: typeof fetch };

/**
 * Read the plan's usage. Split out from the handler so it can be exercised without an
 * MCP server or a live account — the endpoint is the one thing here we cannot try
 * against production from a test.
 */
export async function runAccountUsage(apiKey: string, opts: AccountOpts = {}) {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(SUBSCRIPTION_DETAILS_URL, {
      headers: {
        "X-API-Key": apiKey,
        "User-Agent": `zenrows-mcp/${pkg.version}`,
      },
    });
  } catch (e) {
    return err(`Could not reach the Zenrows subscription endpoint: ${(e as Error).message}`);
  }

  const body = await res.text();

  if (!res.ok) {
    return err(`Zenrows returned ${res.status} for the subscription details endpoint.\n${body}`, {
      status: res.status,
      body,
    });
  }

  // Passed through verbatim. The response shape is not part of any documented contract,
  // so reshaping it here would mean inventing field names that could drift away from
  // what the API actually sends.
  try {
    return json(JSON.parse(body));
  } catch {
    return json({ raw: body });
  }
}

export function registerAccountTools(server: McpServer, apiKey: string, opts: AccountOpts = {}): void {
  server.registerTool(
    "account_usage",
    {
      annotations: {
        title: "Check Credit Usage",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      description: `Read the current plan's credit allowance and how much of it is spent.

Call this BEFORE a large batch, and after any 402 / AUTH004, to find out whether the
account is out of credits and when the allowance renews. It is free and does not consume
a concurrency slot, so it is safe to poll between runs.

Credit costs per request: 1 basic, 5 js_render, 10 premium_proxy, 25 both. On a small
plan a few hundred protected requests can exhaust a month, so check before fanning out.

AUTH004 ("usage exceeded") means this allowance is spent. It renews at the end of the
billing period, so it is not a permanent block: never retry-loop against it. If the
human does not want to wait for the renewal, relay the way to continue now: add a
credit pack at https://app.zenrows.com/billing?topup=open (opens the purchase
directly) or upgrade at https://app.zenrows.com/plans. Prices are per plan; quote them
only from this tool's response, never from memory.
AUTH006 is the concurrency limit, which is a different thing entirely.`,
      inputSchema: {},
    },
    async () => runAccountUsage(apiKey, opts)
  );
}
