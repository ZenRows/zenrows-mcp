import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
 * The signup endpoint may answer 428 with a question for the agent. The server must pass
 * the question on, wait for the agent's answer through account_signup_answer, and never
 * apply the failure backoff to a question.
 */

const SIGNUP = "https://app.zenrows.com/api/agent/signup";
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
let bodies: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "zr-mcp-challenge-"));
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
  bodies = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname;
    hits[path] = (hits[path] ?? 0) + 1;
    if (path === "/api/agent/signup") bodies.push(await req.clone().text());
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

function challenge(id: string, prompt: string, wrong = false): Response {
  return json(428, {
    message: `${wrong ? "Wrong or expired. " : ""}To create a Zenrows account, answer: ${prompt} Run: curl -X POST ${SIGNUP} -d c=${id} -d a=ANSWER`,
    error: "challenge_required",
    next: "answer",
    challenge: { id, prompt, expires_in: 600 },
  });
}

const signupOk = () =>
  json(201, {
    apiKey: "new-key",
    accountId: "acct-1",
    claimUrl: "https://app.zenrows.com/claim/abc",
    trialEndsAt: null,
  });

async function connect(key: LazyApiKey) {
  const server = createServer(key, undefined, {
    ensureKey: (n) => key.ensure(n),
    answerSignup: (a, n) => key.answer(a, n),
  });
  const client = new Client({ name: "challenge-test", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

function text(r: unknown): string {
  return (r as { content: Array<{ text?: string }> }).content.map((x) => x.text ?? "").join("\n");
}

const callUsage = (client: Client) => client.callTool({ name: "account_usage", arguments: {} });
const answer = (client: Client, a: string) =>
  client.callTool({ name: "account_signup_answer", arguments: { answer: a } });

test("a 428 becomes a tool error with the question and how to answer, and the question is reused until it expires", async () => {
  let now = Date.parse("2026-06-01T00:00:00Z");
  routes["/api/agent/signup"] = () => challenge("aaaa1111", "which of norway, walrus, pear is a country?");
  const client = await connect(new LazyApiKey({ now: () => now }));
  try {
    const first = await callUsage(client);
    assert.equal(first.isError, true);
    const msg = text(first);
    assert.match(msg, /^Zenrows needs one quick answer before it creates a free account/);
    assert.match(msg, /Question: which of norway, walrus, pear is a country\?/);
    assert.match(msg, /call account_signup_answer with \{"answer": "<your answer>"\}/);
    assert.doesNotMatch(msg, /curl|—/);

    // Pending: same question, no new request.
    now += 60_000;
    assert.match(text(await callUsage(client)), /norway, walrus, pear/);
    assert.equal(hits["/api/agent/signup"], 1);

    // Expired: asks the server again right away, no backoff.
    now += 600_000;
    routes["/api/agent/signup"] = () => challenge("bbbb2222", "odd one out: gecko, chin, badger, ferret?");
    assert.match(text(await callUsage(client)), /gecko, chin/);
    assert.equal(hits["/api/agent/signup"], 2);
  } finally {
    await client.close();
  }
});

test("the right answer stores the key, returns the claim link, and the original tool call then works", async () => {
  routes["/api/agent/signup"] = () => challenge("aaaa1111", "which of norway, walrus, pear is a country?");
  routes["/v1/subscriptions/self/details"] = (req) => json(200, { key: req.headers.get("x-api-key") });
  const provisioned: string[] = [];
  const client = await connect(new LazyApiKey({ onProvision: (a) => provisioned.push(a.accountId) }));
  try {
    await callUsage(client);
    routes["/api/agent/signup"] = signupOk;
    const r = await answer(client, " norway ");
    assert.ok(!r.isError, text(r));
    assert.match(text(r), /Retry your original tool call now/);
    assert.match(text(r), /https:\/\/app\.zenrows\.com\/claim\/abc/);
    assert.deepEqual(JSON.parse(bodies[1]), { challenge_id: "aaaa1111", answer: "norway" });
    assert.equal(JSON.parse(readFileSync(join(home, ".zenrows", "secrets.json"), "utf8")).apiKey, "new-key");
    assert.equal(JSON.parse(readFileSync(join(home, ".zenrows", "account.json"), "utf8")).accountId, "acct-1");
    assert.deepEqual(provisioned, ["acct-1"]);

    const usage = await callUsage(client);
    assert.ok(!usage.isError, text(usage));
    assert.match(text(usage), /new-key/);
    assert.equal(hits["/api/agent/signup"], 2);

    assert.match(text(await answer(client, "x")), /already set up/);
  } finally {
    await client.close();
  }
});

test("a wrong answer returns the new question, and the next answer goes to it", async () => {
  routes["/api/agent/signup"] = () => challenge("aaaa1111", "which of norway, walrus, pear is a country?");
  const client = await connect(new LazyApiKey());
  try {
    await callUsage(client);
    routes["/api/agent/signup"] = () => challenge("bbbb2222", "odd one out: gecko, chin, badger, ferret?", true);
    const r = await answer(client, "pear");
    assert.equal(r.isError, true);
    assert.match(text(r), /^That answer was wrong or the question expired/);
    assert.match(text(r), /Question: odd one out: gecko, chin, badger, ferret\?/);
    // Gated tools now show the new question without asking the server.
    assert.match(text(await callUsage(client)), /gecko, chin/);
    assert.equal(hits["/api/agent/signup"], 2);
    routes["/api/agent/signup"] = signupOk;
    await answer(client, "chin");
    assert.equal(JSON.parse(bodies[2]).challenge_id, "bbbb2222");
  } finally {
    await client.close();
  }
});

test("challenge_locked says to wait an hour or set ZENROWS_API_KEY, and backs off", async () => {
  let now = 0;
  routes["/api/agent/signup"] = () => challenge("aaaa1111", "which of norway, walrus, pear is a country?");
  const client = await connect(new LazyApiKey({ now: () => now }));
  try {
    await callUsage(client);
    routes["/api/agent/signup"] = () =>
      json(429, { error: "challenge_locked", message: "Too many wrong answers" }, { "Retry-After": "3600" });
    const r = await answer(client, "walrus");
    assert.equal(r.isError, true);
    assert.match(text(r), /^Too many signup questions or wrong answers from this network/);
    assert.match(text(r), /Try again in 60 minutes/);
    assert.match(text(r), /set ZENROWS_API_KEY/);
    now += 60_000;
    assert.match(text(await callUsage(client)), /Too many signup questions or wrong answers/);
    assert.equal(hits["/api/agent/signup"], 2);
    assert.match(text(await answer(client, "norway")), /no signup question waiting/);
  } finally {
    await client.close();
  }
});

test("with no pending question the answer tool says so and sends nothing", async () => {
  const client = await connect(new LazyApiKey());
  try {
    const r = await answer(client, "norway");
    assert.equal(r.isError, true);
    assert.match(text(r), /There is no signup question waiting for an answer/);
    assert.equal(hits["/api/agent/signup"], undefined);
  } finally {
    await client.close();
  }
});

test("429 rate_limited and 503 keep their messages and backoff", async () => {
  routes["/api/agent/signup"] = () => json(429, { error: "rate_limited" }, { "Retry-After": "120" });
  let client = await connect(new LazyApiKey());
  try {
    const r = text(await callUsage(client));
    assert.match(r, /^Zenrows refused to create another account/);
    assert.match(r, /Retry in 2 minutes/);
    await callUsage(client);
    assert.equal(hits["/api/agent/signup"], 1);
  } finally {
    await client.close();
  }
  routes["/api/agent/signup"] = () => json(503, { error: "disabled" });
  client = await connect(new LazyApiKey());
  try {
    const r = text(await callUsage(client));
    assert.match(r, /automatic account creation turned off/);
    assert.match(r, /Retry in 60 minutes/);
  } finally {
    await client.close();
  }
});
