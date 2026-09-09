import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  AuthError,
  AUTO_SIGNUP_ENV,
  ENV_KEY,
  ZENROWS_HOME_ENV,
  _resetDiscoveryCache,
  ensureApiKey,
  resolveApiKey,
  signupAgent,
} from "../src/auth/ensure-key.ts";

let home: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "zr-mcp-auth-"));
  for (const k of [ENV_KEY, AUTO_SIGNUP_ENV, ZENROWS_HOME_ENV, "ZENROWS_AGENT_SIGNUP_URL"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env[ZENROWS_HOME_ENV] = home;
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
      return true;
    }
  );
});
