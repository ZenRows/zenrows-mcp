import { createRequire } from "module";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "./server.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

// ─── app ──────────────────────────────────────────────────────────────────────

const app = new Hono();

// ─── request log ──────────────────────────────────────────────────────────────
// One JSON line per request on stdout, picked up by the host's log collector. It records
// what was asked of the server, never who asked or with what: no key (not even a
// prefix), no IP, no tool arguments, no URLs being fetched.

type AuthKind = "bearer" | "query" | "none";

export interface RequestLogLine {
  ts: string;
  path: string;
  http_method: string;
  rpc_methods?: string[];
  tool?: string[];
  client_name?: string;
  client_version?: string;
  authenticated: boolean;
  // OAuth clients send the access token as a Bearer header, and that token is the API
  // key itself, so an OAuth connection and a pasted key look the same here: both "bearer".
  auth_kind: AuthKind;
  origin_verified: boolean;
  status: number;
  duration_ms: number;
  user_agent?: string;
}

let logSink: (line: string) => void = (line) => process.stdout.write(line + "\n");

/** Test-only: capture request log lines instead of writing them to stdout. */
export function _setRequestLogSink(sink: (line: string) => void): void {
  logSink = sink;
}

const MAX_FIELD = 128;
const MAX_LOGGED_BODY = 64 * 1024;

function short(v: unknown): string | undefined {
  return typeof v === "string" && v ? v.slice(0, MAX_FIELD) : undefined;
}

function authKind(req: Request): AuthKind {
  if (/^Bearer\s+\S/i.test(req.headers.get("authorization") ?? "")) return "bearer";
  if (new URL(req.url).searchParams.get("apikey")) return "query";
  return "none";
}

async function rpcSummary(req: Request): Promise<Partial<RequestLogLine>> {
  if (req.method !== "POST") return {};
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_LOGGED_BODY) return {};
  try {
    const body = await req.clone().json();
    const msgs = (Array.isArray(body) ? body : [body]).slice(0, 20);
    const out: Partial<RequestLogLine> = { rpc_methods: [], tool: [] };
    for (const m of msgs) {
      const method = short(m?.method);
      if (!method) continue;
      out.rpc_methods!.push(method);
      if (method === "tools/call") {
        const name = short(m?.params?.name);
        if (name) out.tool!.push(name);
      }
      if (method === "initialize") {
        out.client_name = short(m?.params?.clientInfo?.name);
        out.client_version = short(m?.params?.clientInfo?.version);
      }
    }
    if (!out.tool!.length) delete out.tool;
    return out;
  } catch {
    return {};
  }
}

/**
 * The hosting edge adds X-Origin-Verify with a shared secret, so a request that
 * reaches the server any other way is refused. Off when
 * MCP_ORIGIN_SECRET is unset (local dev, tests). Read per request so tests can toggle it.
 */
function originVerified(req: Request): boolean {
  const secret = process.env.MCP_ORIGIN_SECRET;
  if (!secret) return true;
  const got = Buffer.from(req.headers.get("x-origin-verify") ?? "");
  const want = Buffer.from(secret);
  return got.length === want.length && timingSafeEqual(got, want);
}

app.use("*", async (c, next) => {
  const started = Date.now();
  const req = c.req.raw;
  const kind = authKind(req);
  const verified = originVerified(req);
  const rpc = verified && c.req.path === "/mcp" ? await rpcSummary(req) : {};
  if (verified) await next();
  else c.res = c.json({ error: "Forbidden" }, 403);
  const line: RequestLogLine = {
    ts: new Date(started).toISOString(),
    path: c.req.path.slice(0, MAX_FIELD),
    http_method: req.method,
    ...rpc,
    authenticated: kind !== "none",
    auth_kind: kind,
    origin_verified: verified,
    status: c.res.status,
    duration_ms: Date.now() - started,
    user_agent: short(req.headers.get("user-agent")),
  };
  try {
    logSink(JSON.stringify(line));
  } catch {
    // logging must never fail a request
  }
});

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

/**
 * The scope this resource issues, named after what it actually grants.
 *
 * The access token IS the account's Zenrows API key: the authorization server hands
 * the key back at /oauth/mcp/token, and every tool here calls the API with it. So an
 * approved client can do anything the key can do, and one scope named `api` is the
 * whole truth.
 *
 * It used to be declared as `[]`, which is worse than saying nothing: an empty list
 * reads to a least-privilege client as "this resource has no scopes", when what we
 * meant was "we never wrote them down".
 *
 * Splitting this — reading a page under one scope, spending credits on a
 * 100,000-URL batch under another — is not an edit to this array. The token would
 * have to carry the grant, and today it cannot: it is an opaque API key, minted by
 * app.zenrows.com, and a raw key pasted straight into the Authorization header is a
 * supported way to connect. Until the token can say what it was granted, this list
 * must not claim more than one, because a scope we do not enforce is a lie told to
 * exactly the clients careful enough to read it.
 */
const SCOPES_SUPPORTED = ["api"];

app.get("/mcp/.well-known/oauth-authorization-server", (c) =>
  c.redirect("/.well-known/oauth-authorization-server", 301)
);

// RFC 9728 — OAuth Protected Resource Metadata
// MCP clients fetch this first to discover the authorization server(s) for this resource.
//
// `resource` must equal the identifier the well-known path was built from (RFC 9728
// §3.3), so each URL names its own: the origin at the root, and the endpoint MCP
// clients actually call, /mcp, at the path-suffixed URL (§3.1). Clients try the
// suffixed one first and fall back to the root on a 404.
//
// `bearer_methods_supported` lists RFC 6750 methods only. The key is read from
// `Authorization: Bearer` (6750 §2.1, "header"). The `?apikey=` query parameter is
// not 6750's `access_token` (§2.3, "query"), and `access_token` is not read.
const MCP_ENDPOINT = `${MCP_SERVER}/mcp`;
const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

function protectedResourceMetadata(resource: string) {
  return {
    resource,
    authorization_servers: [MCP_SERVER],
    bearer_methods_supported: ["header"],
    scopes_supported: SCOPES_SUPPORTED,
    resource_documentation: "https://docs.zenrows.com/mcp/overview",
  };
}

app.get(PROTECTED_RESOURCE_PATH, (c) => c.json(protectedResourceMetadata(MCP_SERVER)));
app.get(`${PROTECTED_RESOURCE_PATH}/mcp`, (c) => c.json(protectedResourceMetadata(MCP_ENDPOINT)));

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
    scopes_supported: SCOPES_SUPPORTED,
  })
);

// MCP Server Card (SEP-2127 canonical + SEP-1649 legacy paths).
// Lets agents discover this remote MCP before connecting.
function mcpServerCard() {
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    name: "io.zenrows/mcp",
    version: pkg.version,
    description:
      "Zenrows MCP — scrape and extract from protected sites via Fetch (anti-bot bypass, JS rendering, proxies).",
    websiteUrl: "https://www.zenrows.com/mcp",
    remotes: [
      {
        type: "streamable-http",
        url: `${MCP_SERVER}/mcp`,
        headers: {
          Authorization: "Bearer ${ZENROWS_API_KEY}",
        },
      },
    ],
    // Older SEP-1649-shaped fields some scanners still expect.
    protocolVersion: "2025-06-18",
    serverInfo: {
      name: "Zenrows",
      version: pkg.version,
      description: "Zenrows Fetch API via MCP",
      homepage: "https://www.zenrows.com/mcp",
    },
    transport: {
      type: "streamable-http",
      url: `${MCP_SERVER}/mcp`,
    },
    capabilities: {
      tools: true,
      resources: false,
      prompts: false,
    },
  };
}

app.get("/.well-known/mcp.json", (c) =>
  c.json(mcpServerCard(), 200, {
    "Cache-Control": "public, max-age=300",
    "X-Content-Type-Options": "nosniff",
  })
);
app.get("/.well-known/mcp/server-card.json", (c) =>
  c.json(mcpServerCard(), 200, {
    "Cache-Control": "public, max-age=300",
    "X-Content-Type-Options": "nosniff",
  })
);
app.get("/.well-known/mcp/server-cards.json", (c) =>
  c.json(mcpServerCard(), 200, {
    "Cache-Control": "public, max-age=300",
    "X-Content-Type-Options": "nosniff",
  })
);

// RFC 7591 — Dynamic Client Registration
// MCP clients (Claude.ai, Cursor, etc.) register themselves before initiating OAuth.
// Since Zenrows API keys are the real auth mechanism, client registration is stateless —
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

// Read-only discovery methods answered without a key, so registries and scanners can
// see what the server offers. Anything else, tools/call included, still gets the 401
// challenge, which is where an OAuth client starts sign-in.
const PUBLIC_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
]);

async function isDiscoveryOnly(req: Request): Promise<boolean> {
  if (req.method !== "POST") return false;
  try {
    const body = await req.clone().json();
    const msgs = Array.isArray(body) ? body : [body];
    return msgs.length > 0 && msgs.every((m) => typeof m?.method === "string" && PUBLIC_METHODS.has(m.method));
  } catch {
    return false;
  }
}

app.all("/mcp", async (c) => {
  const apiKey = extractApiKey(c.req.raw) ?? ((await isDiscoveryOnly(c.req.raw)) ? "" : undefined);
  if (apiKey === undefined) {
    return c.json(
      {
        error: "Missing API key. Use Authorization: Bearer <key> header or ?apikey=<key> query param.",
      },
      401,
      {
        // RFC 6750: name the scope in the challenge too, so a client learns what it is
        // being asked for without a second fetch of the metadata document.
        // resource_metadata is the /mcp document: RFC 9728 §3.3 wants its `resource`
        // to equal the URL the client just called.
        "WWW-Authenticate": `Bearer realm="${AUTH_SERVER}", scope="${SCOPES_SUPPORTED.join(
          " "
        )}", resource_metadata="${MCP_SERVER}${PROTECTED_RESOURCE_PATH}/mcp"`,
        // In production the hosting layer rewrites this header and the edge sends a
        // fixed WWW-Authenticate instead, so keep that value in step with this one.
        // The Link header is a fallback for clients that ignore the challenge.
        Link: `<${MCP_SERVER}${PROTECTED_RESOURCE_PATH}/mcp>; rel="oauth-protected-resource"`,
      }
    );
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no session tracking between requests
    enableJsonResponse: true, // return JSON instead of SSE (simpler for the hosted runtime and most MCP clients)
  });
  const server = createServer(apiKey, c.req.raw.headers.get("user-agent") ?? undefined, { hosted: true });
  await server.connect(transport);
  const response = await transport.handleRequest(c.req.raw);
  await transport.close();
  return response;
});

app.get("/health", (c) => c.json({ ok: true }));

// ─── hosted handler ───────────────────────────────────────────────────────────
// Expects an HTTP API payload format v2.0 event.

interface HostedEvent {
  requestContext: { http: { method: string } };
  rawPath: string;
  rawQueryString?: string;
  headers: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}

export const handler = async (event: HostedEvent) => {
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

// Listen only when this file is run directly (npm run dev:http); importers such as
// the hosted runtime and the tests just use the exported handler.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 3000;
  serve({ fetch: app.fetch, port }, () => {
    process.stderr.write(`Zenrows MCP HTTP server listening on http://localhost:${port}/mcp\n`);
  });
}
