import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ZENROWS_HOME_ENV } from "../src/auth/ensure-key.ts";
import { registerAccountTools, runAccountUsage } from "../src/tools/account.ts";

/**
 * The endpoint itself cannot be exercised from here, so what these tests pin is
 * everything around it: that the request is addressed and authenticated the way the API
 * expects, and that a failure surfaces as an error an agent can act on rather than a
 * silent empty object.
 */

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "zr-mcp-account-"));
  savedHome = process.env[ZENROWS_HOME_ENV];
  process.env[ZENROWS_HOME_ENV] = home;
  mkdirSync(join(home, ".zenrows"), { mode: 0o700 });
});

afterEach(() => {
  if (savedHome === undefined) delete process.env[ZENROWS_HOME_ENV];
  else process.env[ZENROWS_HOME_ENV] = savedHome;
  rmSync(home, { recursive: true, force: true });
});

function writeUnclaimed(claimUrl = "https://app.zenrows.com/claim/tok"): void {
  writeFileSync(
    join(home, ".zenrows", "account.json"),
    JSON.stringify({
      accountId: "acct-1",
      unclaimed: true,
      claimUrl,
      createdAt: "2026-01-01T00:00:00.000Z",
    }) + "\n",
    { mode: 0o600 }
  );
}

function textOf(res: unknown): string {
  return (res as { content: Array<{ text: string }> }).content[0].text;
}

function isError(res: unknown): boolean {
  return (res as { isError?: boolean }).isError === true;
}

const OK_BODY = JSON.stringify({
  status: "TRIALING",
  usage: 4.755,
  usage_percent: 95.1,
  period_ends_at: "2026-09-14T00:00:00Z",
  plan: { name: "trial", price: 5 },
});

test("calls the documented endpoint with the header auth it expects", async () => {
  let seenUrl: string | undefined;
  let seenHeaders: Record<string, string> = {};

  await runAccountUsage("secret-key", {
    fetchImpl: (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(OK_BODY, { status: 200 });
    }) as unknown as typeof fetch,
  });

  // The scraper authenticates with an `apikey` query param; this endpoint does not.
  assert.equal(seenUrl, "https://api.zenrows.com/v1/subscriptions/self/details");
  assert.equal(seenHeaders["X-API-Key"], "secret-key");
  assert.match(seenHeaders["User-Agent"] ?? "", /^zenrows-mcp\//);
});

test("passes the response through unchanged rather than reshaping it", async () => {
  const res = await runAccountUsage("k", {
    fetchImpl: (async () => new Response(OK_BODY, { status: 200 })) as unknown as typeof fetch,
  });

  assert.equal(isError(res), false);
  // Field names are not a documented contract, so the tool must not rename or drop any.
  assert.deepEqual(JSON.parse(textOf(res)), JSON.parse(OK_BODY));
});

test("a non-JSON body is returned as raw text, not swallowed", async () => {
  const res = await runAccountUsage("k", {
    fetchImpl: (async () => new Response("<html>maintenance</html>", { status: 200 })) as unknown as typeof fetch,
  });

  assert.deepEqual(JSON.parse(textOf(res)), { raw: "<html>maintenance</html>" });
});

test("surfaces a failed status as an error, with the body kept for diagnosis", async () => {
  const res = await runAccountUsage("k", {
    fetchImpl: (async () => new Response('{"code":"AUTH003"}', { status: 401 })) as unknown as typeof fetch,
  });

  assert.equal(isError(res), true);
  assert.match(textOf(res), /401/);
  assert.match(textOf(res), /AUTH003/);
});

test("a network failure reports the cause instead of looking like an empty account", async () => {
  const res = await runAccountUsage("k", {
    fetchImpl: (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch,
  });

  assert.equal(isError(res), true);
  assert.match(textOf(res), /ECONNREFUSED/);
});

test("an unclaimed agent hitting the credit wall here still gets the claim nudge", async () => {
  // The same 402 that AUTH004 returns on a scrape can come back from this endpoint.
  // An unclaimed Free account is exactly who needs telling before they walk away.
  writeUnclaimed("https://app.zenrows.com/claim/abc");

  const res = await runAccountUsage("k", {
    fetchImpl: (async () =>
      new Response('{"code":"AUTH004","title":"Usage exceeded (AUTH004)"}', {
        status: 402,
      })) as unknown as typeof fetch,
  });

  assert.equal(isError(res), true);
  assert.match(textOf(res), /Claim your Free account/);
  assert.match(textOf(res), /https:\/\/app\.zenrows\.com\/claim\/abc/);
});

test("registers exactly one read-only tool named account_usage", () => {
  const registered: Array<{ name: string; config: { annotations?: Record<string, unknown> } }> = [];
  const server = {
    registerTool: (name: string, config: { annotations?: Record<string, unknown> }) => {
      registered.push({ name, config });
    },
  };

  registerAccountTools(server as never, "k");

  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, "account_usage");
  assert.equal(registered[0].config.annotations?.readOnlyHint, true);
});
