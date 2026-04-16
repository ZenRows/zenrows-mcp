import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "./server.js";

// ─── app ──────────────────────────────────────────────────────────────────────

const app = new Hono();

// CORS — required for browser-side MCP clients (Claude.ai, Cursor web, etc.)
// All origins allowed: the API key is the auth mechanism, not the origin.
app.use(
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", "Accept", "Mcp-Session-Id"],
    exposeHeaders: ["WWW-Authenticate", "Mcp-Session-Id"],
    maxAge: 86_400,
  })
);

function extractApiKey(req: Request): string | undefined {
  const auth = req.headers.get("authorization");
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1];
  }
  return new URL(req.url).searchParams.get("apikey") ?? undefined;
}

const AUTH_SERVER = process.env.OAUTH_AUTH_SERVER ?? "https://app.zenrows.com";
const MCP_SERVER = process.env.MCP_SERVER ?? "https://mcp.zenrows.com";

app.get("/mcp/.well-known/oauth-authorization-server", (c) =>
  c.redirect("/.well-known/oauth-authorization-server", 301)
);

// RFC 9728 — OAuth Protected Resource Metadata
// MCP clients fetch this first to discover the authorization server(s) for this resource.
app.get("/.well-known/oauth-protected-resource", (c) =>
  c.json({
    resource: MCP_SERVER,
    authorization_servers: [MCP_SERVER],
    bearer_methods_supported: ["header", "query"],
    scopes_supported: [],
  })
);

// RFC 8414 — OAuth Authorization Server Metadata
// Issuer must match the URL of the server serving this document (MCP_SERVER, not AUTH_SERVER),
// because the MCP server acts as an authorization server proxy for client discovery purposes.
app.get("/.well-known/oauth-authorization-server", (c) =>
  c.json({
    issuer: MCP_SERVER,
    authorization_endpoint: `${AUTH_SERVER}/oauth/mcp/authorize`,
    token_endpoint: `${AUTH_SERVER}/oauth/mcp/token`,
    registration_endpoint: `${MCP_SERVER}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  })
);

// RFC 7591 — Dynamic Client Registration
// MCP clients (Claude.ai, Cursor, etc.) register themselves before initiating OAuth.
// Since ZenRows API keys are the real auth mechanism, client registration is stateless —
// we echo back a stable client_id derived from the request (or the one the client provides).
app.post("/register", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(
    {
      client_id: body.client_id ?? crypto.randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...body,
    },
    201
  );
});

// Proxy browser tool calls to internal service.
// npx clients default ZENROWS_BROWSER_URL to https://mcp.zenrows.com, so their
// /browser/* calls are forwarded here and proxied to the internal service.
const BROWSER_URL = process.env.ZENROWS_BROWSER_URL;
app.all("/browser/*", async (c) => {
  if (!BROWSER_URL) {
    return c.json({ error: "Browser service not available." }, 503);
  }
  const target = `${BROWSER_URL.replace(/\/$/, "")}${c.req.path}`;
  const req = new Request(target, {
    method: c.req.method,
    headers: c.req.raw.headers,
    body: c.req.raw.body,
    duplex: "half",
  } as RequestInit);
  const res = await fetch(req);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.all("/mcp", async (c) => {
  const apiKey = extractApiKey(c.req.raw);
  if (!apiKey) {
    return c.json(
      {
        error:
          "Missing API key. Use Authorization: Bearer <key> header or ?apikey=<key> query param.",
      },
      401,
      {
        "WWW-Authenticate": `Bearer realm="${AUTH_SERVER}", resource_metadata="${MCP_SERVER}/.well-known/oauth-protected-resource"`,
        // CloudFront strips WWW-Authenticate — add Link header as RFC 8615 fallback
        // so MCP clients can still discover the OAuth server
        "Link": `<${MCP_SERVER}/.well-known/oauth-protected-resource>; rel="oauth-protected-resource"`,
      }
    );
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no session tracking between requests
    enableJsonResponse: true, // return JSON instead of SSE (simpler for Lambda + most MCP clients)
  });
  const server = createServer(apiKey, c.req.raw.headers.get("user-agent") ?? undefined);
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
