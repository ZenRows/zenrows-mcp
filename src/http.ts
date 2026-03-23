import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "./server.js";

// ─── app ──────────────────────────────────────────────────────────────────────

const app = new Hono();

function extractApiKey(req: Request): string | undefined {
  const auth = req.headers.get("authorization");
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1];
  }
  return new URL(req.url).searchParams.get("apikey") ?? undefined;
}

app.all("/mcp", async (c) => {
  const apiKey = extractApiKey(c.req.raw);
  if (!apiKey) {
    return c.json(
      {
        error:
          "Missing API key. Use Authorization: Bearer <key> header or ?apikey=<key> query param.",
      },
      401
    );
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no session tracking between requests
    enableJsonResponse: true, // return JSON instead of SSE (simpler for Lambda + most MCP clients)
  });
  const server = createServer(apiKey);
  await server.connect(transport);
  const response = await transport.handleRequest(c.req.raw);
  await transport.close();
  return response;
});

app.get("/health", (c) => c.json({ ok: true }));

// ─── Lambda handler ───────────────────────────────────────────────────────────
// Expects Lambda Function URL payload format v2.0 (also compatible with API Gateway HTTP API v2).

interface LambdaEvent {
  requestContext: { http: { method: string } };
  rawPath: string;
  rawQueryString?: string;
  headers: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}

export const handler = async (event: LambdaEvent) => {
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const url = `https://mcp.zenrows.com${event.rawPath}${qs}`;
  const method = event.requestContext.http.method;

  let body: BodyInit | undefined;
  if (event.body && method !== "GET" && method !== "HEAD") {
    body = event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body;
  }

  const request = new Request(url, {
    method,
    headers: new Headers(event.headers),
    body,
  });

  const response = await app.fetch(request);
  const responseBody = await response.text();
  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    headers[k] = v;
  });

  return { statusCode: response.status, headers, body: responseBody };
};

// ─── Local dev ────────────────────────────────────────────────────────────────

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  const port = Number(process.env.PORT) || 3000;
  serve({ fetch: app.fetch, port }, () => {
    process.stderr.write(`ZenRows MCP HTTP server listening on http://localhost:${port}/mcp\n`);
  });
}
