import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  AUTO_SIGNUP_ENV,
  DISCOVERY_URL_ENV,
  ENV_KEY,
  SIGNUP_URL_ENV,
  TELEMETRY_ENV,
  ZENROWS_HOME_ENV,
  _resetDiscoveryCache,
} from "../src/auth/ensure-key.ts";
import { LazyApiKey } from "../src/auth/lazy-key.ts";
import { createServer } from "../src/server.ts";

/**
 * The stdio server with no key: it must start, list its tools, and sign up on the first
 * tool call. Every outbound request goes through a fake fetch keyed by URL path.
 */

const SIGNUP = "https://app.zenrows.com/api/agent/signup";
const DAY = 24 * 3600 * 1000;
const ENV_VARS = [
  ENV_KEY,
  AUTO_SIGNUP_ENV,
  ZENROWS_HOME_ENV,
  TELEMETRY_ENV,
  SIGNUP_URL_ENV,
  DISCOVERY_URL_ENV,
  "XDG_CONFIG_HOME",
  "CI",
  "GITHUB_ACTIONS",
];

type Route = (req: Request) => Response | Promise<Response>;

let home: string;
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
let routes: Record<string, Route>;
let hits: Record<string, number>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "zr-mcp-lazy-"));
  for (const k of ENV_VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env[ZENROWS_HOME_ENV] = home;
  process.env.XDG_CONFIG_HOME = join(home, "xdg");
  process.env[SIGNUP_URL_ENV] = SIGNUP;
  process.env[TELEMETRY_ENV] = "off";
  _resetDiscoveryCache();
  routes = {};
  hits = {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname;
    hits[path] = (hits[path] ?? 0) + 1;
    const route = routes[path];
    if (!route) throw new TypeError(`unexpected fetch ${req.method} ${req.url}`);
    return route(req);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetDiscoveryCache();
  rmSync(home, { recursive: true, force: true });
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function signupOk(key = "new-key"): Route {
  return () => json(201, { apiKey: key, accountId: "acct-1", claimUrl: "https://app.zenrows.com/claim/first" });
}

function usageOk(): Route {
  return () => json(200, { plan: "free" });
}

async function connect(key: LazyApiKey) {
  const server = createServer(key, undefined, { ensureKey: (n) => key.ensure(n) });
  const client = new Client({ name: "lazy-signup-test", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

function text(r: unknown): string {
  const c = (r as { content: Array<{ text?: string }> }).content;
  return c.map((x) => x.text ?? "").join("\n");
}

const callUsage = (client: Client) => client.callTool({ name: "account_usage", arguments: {} });

function zdir(): string {
  return join(home, ".zenrows");
}

function writeAgentAccount(acct: Record<string, unknown>, key = "stored-key"): void {
  mkdirSync(zdir(), { recursive: true, mode: 0o700 });
  writeFileSync(join(zdir(), "secrets.json"), JSON.stringify({ apiKey: key }), { mode: 0o600 });
  writeFileSync(join(zdir(), "account.json"), JSON.stringify({ accountId: "acct-1", unclaimed: true, ...acct }), {
    mode: 0o600,
  });
}

function readAcct(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(zdir(), "account.json"), "utf8"));
}

const usage402: Route = () => json(402, { code: "AUTH004", title: "Usage exceeded (AUTH004)" });

// ─── lazy signup ─────────────────────────────────────────────────────────────

test("with no key the server completes the handshake and lists tools without any request", async () => {
  const client = await connect(new LazyApiKey());
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === "scrape"));
    assert.deepEqual(hits, {});
  } finally {
    await client.close();
  }
});

test("concurrent first tool calls trigger a single signup and all use its key", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const seenKeys: string[] = [];
  routes["/api/agent/signup"] = async () => {
    await gate;
    return signupOk("prov-key")();
  };
  routes["/v1/subscriptions/self/details"] = (req) => {
    seenKeys.push(req.headers.get("x-api-key") ?? "");
    return usageOk()();
  };
  const provisioned: string[] = [];
  const client = await connect(new LazyApiKey({ onProvision: (a) => provisioned.push(a.accountId) }));
  try {
    const calls = Promise.all([callUsage(client), callUsage(client), callUsage(client), callUsage(client)]);
    setTimeout(release, 20);
    const results = await calls;
    for (const r of results) assert.ok(!r.isError, text(r));
    assert.equal(hits["/api/agent/signup"], 1);
    assert.deepEqual(provisioned, ["acct-1"]);
    assert.deepEqual(seenKeys, ["prov-key", "prov-key", "prov-key", "prov-key"]);
    const secrets = join(zdir(), "secrets.json");
    assert.equal(JSON.parse(readFileSync(secrets, "utf8")).apiKey, "prov-key");
    assert.equal(statSync(secrets).mode & 0o777, 0o600);
  } finally {
    await client.close();
  }
});

test("a 429 becomes a tool error with the wait and the CI fix; the server lives and retries after the window", async () => {
  process.env.CI = "true";
  let now = Date.parse("2026-06-01T00:00:00Z");
  routes["/api/agent/signup"] = () =>
    json(429, { error: "rate_limited", message: "Too many" }, { "Retry-After": "120" });
  routes["/v1/subscriptions/self/details"] = usageOk();
  const client = await connect(new LazyApiKey({ now: () => now }));
  try {
    const first = await callUsage(client);
    assert.equal(first.isError, true);
    const msg = text(first);
    assert.match(msg, /^No Zenrows API key in this CI job/);
    assert.match(msg, /ZENROWS_API_KEY as a CI secret/);
    assert.match(msg, /ZENROWS_HOME/);
    assert.match(msg, /Retry in 2 minutes \(120s\)/);
    assert.match(msg, /ZENROWS_AUTO_SIGNUP=false/);
    assert.equal(hits["/api/agent/signup"], 1);

    // Inside the window: no new signup request, same advice.
    now += 60_000;
    const second = await callUsage(client);
    assert.equal(second.isError, true);
    assert.match(text(second), /\(60s\)/);
    assert.equal(hits["/api/agent/signup"], 1);

    // The server is still serving.
    assert.ok((await client.listTools()).tools.length > 0);

    // After the window: one retry, and this time it works.
    now += 61_000;
    routes["/api/agent/signup"] = signupOk();
    const third = await callUsage(client);
    assert.ok(!third.isError, text(third));
    assert.equal(hits["/api/agent/signup"], 2);
  } finally {
    await client.close();
  }
});

test("outside CI a 429 leads with the reason and the ZENROWS_API_KEY fix", async () => {
  routes["/api/agent/signup"] = () => json(429, { error: "rate_limited" }, { "Retry-After": "3600" });
  const client = await connect(new LazyApiKey());
  try {
    const msg = text(await callUsage(client));
    assert.match(msg, /^Zenrows refused to create another account/);
    assert.match(msg, /Retry in 60 minutes \(3600s\)/);
    assert.match(msg, /set ZENROWS_API_KEY/);
  } finally {
    await client.close();
  }
});

test("a network failure is a tool error too, and is retried on a later call after the backoff", async () => {
  let now = 0;
  routes["/api/agent/signup"] = () => {
    throw new TypeError("connect ECONNREFUSED");
  };
  const client = await connect(new LazyApiKey({ now: () => now }));
  try {
    const r = await callUsage(client);
    assert.equal(r.isError, true);
    assert.match(text(r), /ECONNREFUSED/);
    await callUsage(client);
    assert.equal(hits["/api/agent/signup"], 1);
    now += 61_000;
    await callUsage(client);
    assert.equal(hits["/api/agent/signup"], 2);
  } finally {
    await client.close();
  }
});

test("ZENROWS_AUTO_SIGNUP=false: tools say a key is needed, nothing is signed up, the server stays up", async () => {
  process.env[AUTO_SIGNUP_ENV] = "false";
  const client = await connect(new LazyApiKey());
  try {
    const r = await callUsage(client);
    assert.equal(r.isError, true);
    assert.match(text(r), /needs a Zenrows API key/);
    assert.match(text(r), /ZENROWS_API_KEY/);
    assert.equal(hits["/api/agent/signup"], undefined);
    assert.ok((await client.listTools()).tools.length > 0);
  } finally {
    await client.close();
  }
});

test("the stdio entry point starts with no key and auto-signup off, and does not promise a signup", async () => {
  const env = { ...process.env, [AUTO_SIGNUP_ENV]: "false" };
  const child = spawn(process.execPath, ["--import", "tsx", join(import.meta.dirname, "..", "src", "index.ts")], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  const timers: NodeJS.Timeout[] = [];
  const started = await Promise.race([
    new Promise<boolean>((r) => {
      timers.push(
        setInterval(() => {
          if (stderr.includes("running on stdio")) r(true);
        }, 20)
      );
    }),
    exited.then(() => false),
    new Promise<boolean>((r) => timers.push(setTimeout(() => r(false), 15_000))),
  ]);
  for (const t of timers) clearTimeout(t);
  child.kill();
  await exited;
  assert.ok(started, `server did not start:\n${stderr}`);
  assert.match(stderr, /ZENROWS_AUTO_SIGNUP=false/);
  assert.doesNotMatch(stderr, /auto-signup via|creates a Free account/);
});

// ─── claim link refresh ──────────────────────────────────────────────────────

test("a claim link older than 25 days is replaced before the hint is shown, and stored 0600", async () => {
  writeAgentAccount({
    claimUrl: "https://app.zenrows.com/claim/old",
    createdAt: new Date(Date.now() - 26 * DAY).toISOString(),
  });
  let claimKey = "";
  routes["/v1/subscriptions/self/details"] = usage402;
  routes["/api/agent/account"] = () => json(200, { accountId: "acct-1", claimed: false, isAgent: true });
  routes["/api/agent/claim"] = (req) => {
    claimKey = req.headers.get("x-api-key") ?? "";
    return json(200, {
      status: "unclaimed",
      claimUrl: "https://app.zenrows.com/claim/fresh?utm_source=agent",
      expiresAt: "x",
    });
  };
  const client = await connect(new LazyApiKey());
  try {
    const msg = text(await callUsage(client));
    assert.match(msg, /claim\/fresh/);
    assert.doesNotMatch(msg, /claim\/old/);
    assert.equal(claimKey, "stored-key");
    const acct = readAcct();
    assert.equal(acct.claimUrl, "https://app.zenrows.com/claim/fresh?utm_source=agent");
    assert.ok(Date.now() - Date.parse(acct.claimUrlIssuedAt as string) < 60_000);
    assert.equal(statSync(join(zdir(), "account.json")).mode & 0o777, 0o600);
  } finally {
    await client.close();
  }
});

test("a fresh link is not re-minted, and claim status is checked at most every 6 hours", async () => {
  writeAgentAccount({ claimUrl: "https://app.zenrows.com/claim/cur", createdAt: new Date().toISOString() });
  routes["/v1/subscriptions/self/details"] = usage402;
  routes["/api/agent/account"] = () => json(200, { claimed: false });
  routes["/api/agent/claim"] = () => json(500, {});
  const client = await connect(new LazyApiKey());
  try {
    assert.match(text(await callUsage(client)), /claim\/cur/);
    assert.match(text(await callUsage(client)), /claim\/cur/);
    assert.equal(hits["/api/agent/account"], 1);
    assert.equal(hits["/api/agent/claim"], undefined);
  } finally {
    await client.close();
  }
});

test("an account claimed elsewhere stops the claim hints and is recorded as claimed", async () => {
  writeAgentAccount({ claimUrl: "https://app.zenrows.com/claim/cur", createdAt: new Date().toISOString() });
  routes["/v1/subscriptions/self/details"] = usage402;
  routes["/api/agent/account"] = () => json(200, { accountId: "acct-1", claimed: true, isAgent: true });
  const client = await connect(new LazyApiKey());
  try {
    const r = await callUsage(client);
    assert.equal(r.isError, true);
    assert.match(text(r), /AUTH004/);
    assert.doesNotMatch(text(r), /Claim your Free account/);
    assert.equal(readAcct().unclaimed, false);

    const { contents } = await client.readResource({ uri: "zenrows://account" });
    const body = JSON.parse(String((contents[0] as { text: string }).text));
    assert.equal(body.unclaimed, false);
    assert.equal(body.claimUrl, null);
  } finally {
    await client.close();
  }
});

test("network failure keeps a link that is still inside its 30 days", async () => {
  writeAgentAccount({
    claimUrl: "https://app.zenrows.com/claim/aging",
    createdAt: new Date(Date.now() - 27 * DAY).toISOString(),
  });
  routes["/v1/subscriptions/self/details"] = usage402;
  routes["/api/agent/account"] = () => {
    throw new TypeError("offline");
  };
  routes["/api/agent/claim"] = () => {
    throw new TypeError("offline");
  };
  const client = await connect(new LazyApiKey());
  try {
    assert.match(text(await callUsage(client)), /claim\/aging/);
    assert.equal(readAcct().unclaimed, true);
  } finally {
    await client.close();
  }
});

test("network failure with an expired link omits the link and says how to request one", async () => {
  writeAgentAccount({
    claimUrl: "https://app.zenrows.com/claim/dead",
    createdAt: new Date(Date.now() - 31 * DAY).toISOString(),
  });
  routes["/v1/subscriptions/self/details"] = usage402;
  routes["/api/agent/account"] = () => {
    throw new TypeError("offline");
  };
  routes["/api/agent/claim"] = () => {
    throw new TypeError("offline");
  };
  const client = await connect(new LazyApiKey());
  try {
    const msg = text(await callUsage(client));
    assert.doesNotMatch(msg, /claim\/dead/);
    assert.match(msg, /curl -X POST https:\/\/app\.zenrows\.com\/api\/agent\/claim/);

    const { contents } = await client.readResource({ uri: "zenrows://account" });
    const body = JSON.parse(String((contents[0] as { text: string }).text));
    assert.equal(body.claimUrl, null);
    assert.match(body.claimHelp, /api\/agent\/claim/);
  } finally {
    await client.close();
  }
});

test("a refreshed claim URL that is not https on zenrows.com is never stored or shown", async () => {
  writeAgentAccount({ claimUrl: "", createdAt: new Date().toISOString() });
  routes["/v1/subscriptions/self/details"] = usage402;
  routes["/api/agent/account"] = () => json(200, { claimed: false });
  routes["/api/agent/claim"] = () => json(200, { claimUrl: "https://phish.example/claim/x" });
  const client = await connect(new LazyApiKey());
  try {
    assert.doesNotMatch(text(await callUsage(client)), /phish/);
    assert.equal(readAcct().claimUrl, "");
  } finally {
    await client.close();
  }
});

// ─── audit follow-ups ────────────────────────────────────────────────────────

test("parallel quota errors mint one claim link, and the stored link is the one minted", async () => {
  writeAgentAccount({
    claimUrl: "https://app.zenrows.com/claim/old",
    createdAt: new Date(Date.now() - 26 * DAY).toISOString(),
  });
  let n = 0;
  routes["/v1/subscriptions/self/details"] = usage402;
  routes["/api/agent/account"] = () => json(200, { claimed: false });
  routes["/api/agent/claim"] = async () => {
    n++;
    await new Promise((r) => setTimeout(r, 20));
    return json(200, { claimUrl: `https://app.zenrows.com/claim/minted${n}` });
  };
  const client = await connect(new LazyApiKey());
  try {
    const out = await Promise.all([callUsage(client), callUsage(client), callUsage(client)]);
    assert.equal(hits["/api/agent/claim"], 1);
    for (const r of out) assert.match(text(r), /claim\/minted1/);
    assert.equal(readAcct().claimUrl, "https://app.zenrows.com/claim/minted1");
  } finally {
    await client.close();
  }
});

test("a fresh link stored by another process before the POST is kept, not replaced", async () => {
  writeAgentAccount({
    claimUrl: "https://app.zenrows.com/claim/old",
    createdAt: new Date(Date.now() - 26 * DAY).toISOString(),
  });
  routes["/v1/subscriptions/self/details"] = usage402;
  routes["/api/agent/account"] = () => {
    // Another process (the CLI, a second server) refreshes the link meanwhile.
    writeAgentAccount({
      claimUrl: "https://app.zenrows.com/claim/other",
      createdAt: new Date(Date.now() - 26 * DAY).toISOString(),
      claimUrlIssuedAt: new Date().toISOString(),
    });
    return json(200, { claimed: false });
  };
  routes["/api/agent/claim"] = () => json(200, { claimUrl: "https://app.zenrows.com/claim/mine" });
  const client = await connect(new LazyApiKey());
  try {
    assert.match(text(await callUsage(client)), /claim\/other/);
    assert.equal(hits["/api/agent/claim"], undefined);
    assert.equal(readAcct().claimUrl, "https://app.zenrows.com/claim/other");
  } finally {
    await client.close();
  }
});

test("the API key is never sent to a discovery override outside zenrows.com or loopback", async () => {
  process.env[DISCOVERY_URL_ENV] = "https://attacker.example";
  writeAgentAccount({
    claimUrl: "https://app.zenrows.com/claim/old",
    createdAt: new Date(Date.now() - 31 * DAY).toISOString(),
  });
  routes["/v1/subscriptions/self/details"] = usage402;
  const seen: string[] = [];
  routes["/api/agent/account"] = (req) => (seen.push(req.url), json(200, { claimed: false }));
  routes["/api/agent/claim"] = (req) => (seen.push(req.url), json(200, {}));
  const client = await connect(new LazyApiKey());
  try {
    await callUsage(client);
    assert.deepEqual(seen, []);
  } finally {
    await client.close();
  }
});

test("a loopback override is used for the requests and named in the expired-link hint", async () => {
  process.env[DISCOVERY_URL_ENV] = "http://127.0.0.1:9";
  writeAgentAccount({
    claimUrl: "https://app.zenrows.com/claim/dead",
    createdAt: new Date(Date.now() - 31 * DAY).toISOString(),
  });
  routes["/v1/subscriptions/self/details"] = usage402;
  const hosts: string[] = [];
  routes["/api/agent/account"] = (req) => (hosts.push(new URL(req.url).host), json(200, { claimed: false }));
  routes["/api/agent/claim"] = (req) => (hosts.push(new URL(req.url).host), json(500, {}));
  const client = await connect(new LazyApiKey());
  try {
    const msg = text(await callUsage(client));
    assert.deepEqual(hosts, ["127.0.0.1:9", "127.0.0.1:9"]);
    assert.match(msg, /curl -X POST http:\/\/127\.0\.0\.1:9\/api\/agent\/claim/);
    assert.doesNotMatch(msg, /app\.zenrows\.com\/api\/agent\/claim/);
  } finally {
    await client.close();
  }
});

test("account.json is replaced atomically: a symlink in its place is replaced, not written through", async () => {
  const { symlinkSync, lstatSync, readdirSync } = await import("node:fs");
  const { writeAccount } = await import("../src/auth/ensure-key.ts");
  mkdirSync(zdir(), { recursive: true });
  const target = join(home, "elsewhere.json");
  writeFileSync(target, "untouched");
  symlinkSync(target, join(zdir(), "account.json"));
  writeAccount({ accountId: "a", unclaimed: true, claimUrl: "", createdAt: new Date().toISOString() });
  assert.equal(readFileSync(target, "utf8"), "untouched");
  assert.ok(lstatSync(join(zdir(), "account.json")).isFile());
  assert.equal(statSync(join(zdir(), "account.json")).mode & 0o777, 0o600);
  assert.deepEqual(
    readdirSync(zdir()).filter((f) => f.endsWith(".tmp")),
    []
  );
});
