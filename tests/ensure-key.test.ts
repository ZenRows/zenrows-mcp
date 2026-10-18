import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  AuthError,
  AUTO_SIGNUP_ENV,
  ENV_KEY,
  TELEMETRY_ENV,
  ZENROWS_HOME_ENV,
  _resetDiscoveryCache,
  detectClient,
  discoverSignupUrl,
  getOrCreateAgentId,
  cliAgentIdPath,
  isZenrowsHttpsUrl,
  provisionMessage,
  signupCandidates,
  ensureApiKey,
  resolveApiKey,
  signupAgent,
} from "../src/auth/ensure-key.ts";

let home: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "zr-mcp-auth-"));
  for (const k of [
    ENV_KEY,
    AUTO_SIGNUP_ENV,
    ZENROWS_HOME_ENV,
    TELEMETRY_ENV,
    "ZENROWS_AGENT_SIGNUP_URL",
    "ZENROWS_CONFIG_HOME",
    "XDG_CONFIG_HOME",
  ]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env[ZENROWS_HOME_ENV] = home;
  // Keep the CLI's machine id file inside the temp home too.
  process.env.XDG_CONFIG_HOME = join(home, "xdg");
  _resetDiscoveryCache();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetDiscoveryCache();
  rmSync(home, { recursive: true, force: true });
});

test("resolveApiKey prefers env over secrets file", async () => {
  process.env[ENV_KEY] = "env-key";
  const r = resolveApiKey();
  assert.equal(r.source, "env");
  assert.equal(r.key, "env-key");
});

test("ensureApiKey throws when auto-signup disabled and no key", async () => {
  process.env[AUTO_SIGNUP_ENV] = "false";
  await assert.rejects(
    () => ensureApiKey(),
    (e: unknown) => {
      assert.ok(e instanceof AuthError);
      assert.equal(e.code, "AUTH_MISSING");
      return true;
    }
  );
});

test("ensureApiKey provisions via signup and persists secrets + account", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        apiKey: "prov-key",
        accountId: "acct-1",
        claimUrl: "https://app.zenrows.com/claim/tok",
      }),
      { status: 201, headers: { "content-type": "application/json" } }
    )) as typeof fetch;

  process.env.ZENROWS_AGENT_SIGNUP_URL = "https://example.test/signup";
  const result = await ensureApiKey({ fetchImpl });
  assert.equal(result.apiKey, "prov-key");
  assert.equal(result.provisioned?.claimUrl, "https://app.zenrows.com/claim/tok");

  const secrets = JSON.parse(readFileSync(join(home, ".zenrows", "secrets.json"), "utf8"));
  const account = JSON.parse(readFileSync(join(home, ".zenrows", "account.json"), "utf8"));
  assert.equal(secrets.apiKey, "prov-key");
  assert.equal(account.accountId, "acct-1");
  assert.equal(account.unclaimed, true);

  // second call uses stored key without hitting signup again
  let calls = 0;
  const fetchOnce = (async () => {
    calls++;
    throw new Error("should not fetch");
  }) as typeof fetch;
  const again = await ensureApiKey({ fetchImpl: fetchOnce });
  assert.equal(again.apiKey, "prov-key");
  assert.equal(calls, 0);
});

test("signupAgent maps 429 to SIGNUP_RATE_LIMITED", async () => {
  process.env.ZENROWS_AGENT_SIGNUP_URL = "https://example.test/signup";
  const fetchImpl = (async () => new Response("slow down", { status: 429 })) as typeof fetch;
  await assert.rejects(
    () => signupAgent({ fetchImpl }),
    (e: unknown) => {
      assert.ok(e instanceof AuthError);
      assert.equal(e.code, "SIGNUP_RATE_LIMITED");
      assert.equal(e.retryAfterSec, undefined);
      return true;
    }
  );
});

test("signupAgent carries Retry-After on 429 and maps 503 to SIGNUP_DISABLED", async () => {
  process.env.ZENROWS_AGENT_SIGNUP_URL = "https://example.test/signup";
  const limited = (async () => new Response("{}", { status: 429, headers: { "Retry-After": "90" } })) as typeof fetch;
  await assert.rejects(
    () => signupAgent({ fetchImpl: limited }),
    (e: unknown) => e instanceof AuthError && e.retryAfterSec === 90
  );
  const off = (async () => new Response('{"error":"signup_disabled"}', { status: 503 })) as typeof fetch;
  await assert.rejects(
    () => signupAgent({ fetchImpl: off }),
    (e: unknown) => e instanceof AuthError && e.code === "SIGNUP_DISABLED"
  );
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("agent id is a random UUID persisted 0600 under ZENROWS_HOME and reused", () => {
  const first = getOrCreateAgentId();
  assert.match(first, UUID);
  const file = join(home, ".zenrows", "telemetry-id");
  assert.equal(readFileSync(file, "utf8").trim(), first);
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(getOrCreateAgentId(), first);
});

test("signup sends the stable agent id and the detected client", async () => {
  process.env.ZENROWS_AGENT_SIGNUP_URL = "https://example.test/signup";
  const seen: Record<string, string>[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    seen.push(init.headers as Record<string, string>);
    return new Response(JSON.stringify({ apiKey: "k", accountId: "a", claimUrl: "https://app.zenrows.com/claim/x" }), {
      status: 201,
    });
  }) as unknown as typeof fetch;
  await signupAgent({ fetchImpl });
  await signupAgent({ fetchImpl });
  assert.match(seen[0]["X-ZR-Agent-Id"], UUID);
  assert.equal(seen[1]["X-ZR-Agent-Id"], seen[0]["X-ZR-Agent-Id"]);
  assert.equal(seen[0]["X-ZR-Agent-Id"], readFileSync(join(home, ".zenrows", "telemetry-id"), "utf8").trim());
  assert.equal(seen[0]["X-ZR-Client"], detectClient());
  assert.equal(seen[0]["X-ZR-Source"], "mcp");
});

test("ZENROWS_TELEMETRY=off drops the attribution headers", async () => {
  process.env.ZENROWS_AGENT_SIGNUP_URL = "https://example.test/signup";
  process.env[TELEMETRY_ENV] = "off";
  let headers: Record<string, string> = {};
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    headers = init.headers as Record<string, string>;
    return new Response(JSON.stringify({ apiKey: "k", accountId: "a", claimUrl: "" }), { status: 201 });
  }) as unknown as typeof fetch;
  await signupAgent({ fetchImpl });
  assert.equal(headers["X-ZR-Agent-Id"], undefined);
  assert.equal(headers["X-ZR-Client"], undefined);
});

test("detectClient uses the CLI's vocabulary", () => {
  assert.equal(detectClient({ CLAUDECODE: "1" }), "claude-code");
  assert.equal(detectClient({ CURSOR_TRACE_ID: "x" }), "cursor");
  assert.equal(detectClient({ CODEX_THREAD_ID: "x" }), "openai-codex");
  assert.equal(detectClient({ TERM_PROGRAM: "vscode" }), "vscode");
  assert.equal(detectClient({}), "unknown");
});

test("detectClient ignores variables users set themselves", () => {
  assert.equal(detectClient({ OPENAI_API_KEY: "sk-x" }), "unknown");
  assert.equal(detectClient({ OPENAI_BASE_URL: "https://example.test" }), "unknown");
  assert.equal(detectClient({ CODEX_HOME: "/h/.codex" }), "unknown");
  assert.equal(detectClient({ CLAUDE_CONFIG_DIR: "/h/.claude", CLAUDE_MODEL: "x" }), "unknown");
  assert.equal(detectClient({ CLAUDECODE: "0" }), "unknown");
  assert.equal(detectClient({ CLAUDE_CODE_ENTRYPOINT: "cli" }), "claude-code");
  assert.equal(detectClient({ CODEX_SANDBOX: "seatbelt" }), "openai-codex");
  assert.equal(detectClient({ CODEX_SANDBOX_NETWORK_DISABLED: "1" }), "openai-codex");
  assert.equal(detectClient({ OPENAI_API_KEY: "sk-x", CODEX_THREAD_ID: "t" }), "openai-codex");
});

test("only https zenrows.com hosts count as ours", () => {
  for (const ok of ["https://app.zenrows.com/api/agent/signup", "https://zenrows.com/x", "https://a.b.zenrows.com/"]) {
    assert.equal(isZenrowsHttpsUrl(ok), true, ok);
  }
  for (const bad of [
    "http://app.zenrows.com/api/agent/signup",
    "https://evil.com/api/agent/signup",
    "https://zenrows.com.evil.com/",
    "https://evilzenrows.com/",
    "https://app.zenrows.com@evil.com/",
    "https://user:pw@app.zenrows.com/",
    "javascript:alert(1)",
    "",
    42,
  ]) {
    assert.equal(isZenrowsHttpsUrl(bad), false, String(bad));
  }
});

function discoveryReturning(endpoint: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ agent_auth: { signup_endpoint: endpoint } }), { status: 200 })) as typeof fetch;
}

test("discovery ignores a signup endpoint off zenrows.com", async () => {
  const fetchImpl = discoveryReturning("https://attacker.example/signup");
  assert.equal(await discoverSignupUrl({ fetchImpl }), null);
  assert.deepEqual(await signupCandidates({ fetchImpl }), ["https://app.zenrows.com/api/agent/signup"]);
});

test("discovery keeps a zenrows.com signup endpoint", async () => {
  const fetchImpl = discoveryReturning("https://api.zenrows.com/agent/signup");
  assert.deepEqual(await signupCandidates({ fetchImpl }), [
    "https://api.zenrows.com/agent/signup",
    "https://app.zenrows.com/api/agent/signup",
  ]);
});

test("a non-zenrows claim link from signup is not persisted", async () => {
  process.env.ZENROWS_AGENT_SIGNUP_URL = "https://example.test/signup";
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ apiKey: "k", accountId: "a", claimUrl: "https://phish.example/claim" }), {
      status: 201,
    })) as typeof fetch;
  const r = await ensureApiKey({ fetchImpl });
  assert.equal(r.provisioned?.claimUrl, "");
});

test("CLI id path follows ZENROWS_CONFIG_HOME, then XDG_CONFIG_HOME, like the CLI", () => {
  assert.equal(cliAgentIdPath(), join(home, "xdg", "zenrows", "telemetry-id"));
  process.env.ZENROWS_CONFIG_HOME = join(home, "cfg");
  assert.equal(cliAgentIdPath(), join(home, "cfg", "telemetry-id"));
});

test("an existing CLI machine id is reused, so the machine has one id", () => {
  const cliId = "11111111-2222-4333-8444-555555555555";
  mkdirSync(join(home, "xdg", "zenrows"), { recursive: true });
  writeFileSync(join(home, "xdg", "zenrows", "telemetry-id"), cliId + "\n");
  assert.equal(getOrCreateAgentId(), cliId);
});

test("a malformed CLI id is ignored in favour of ours", () => {
  mkdirSync(join(home, "xdg", "zenrows"), { recursive: true });
  writeFileSync(join(home, "xdg", "zenrows", "telemetry-id"), "not-a-uuid\n");
  const ours = getOrCreateAgentId();
  assert.match(ours, UUID);
  assert.notEqual(ours, "not-a-uuid");
});

test("a new id is written where the CLI would look for it", () => {
  const id = getOrCreateAgentId();
  assert.equal(readFileSync(join(home, "xdg", "zenrows", "telemetry-id"), "utf8").trim(), id);
});

test("startup notice drops an untrusted or missing claim link and says how to get one", () => {
  for (const claimUrl of ["", "https://phish.example/c"]) {
    const msg = provisionMessage({ claimUrl }, "/h/.zenrows");
    assert.ok(!msg.includes("phish"));
    assert.ok(!/: \n/.test(msg), "no empty URL");
    assert.match(msg, /POST https:\/\/app\.zenrows\.com\/api\/agent\/claim/);
  }
  assert.match(
    provisionMessage({ claimUrl: "https://app.zenrows.com/claim/t" }, "/h"),
    /keeps your usage\): https:\/\/app\.zenrows\.com\/claim\/t/
  );
});
