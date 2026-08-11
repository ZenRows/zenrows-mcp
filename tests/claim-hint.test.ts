import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ZENROWS_HOME_ENV } from "../src/auth/ensure-key.ts";
import {
  appendClaimHint,
  isQuotaOrPlanError,
} from "../src/auth/claim-hint.ts";

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "zr-mcp-claim-"));
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

test("isQuotaOrPlanError detects 402 and credit/quota signals", () => {
  assert.equal(isQuotaOrPlanError({ status: 402 }), true);
  assert.equal(
    isQuotaOrPlanError({
      status: 402,
      body: JSON.stringify({ code: "AUTH010", title: "Feature is not included in plan (AUTH010)" }),
    }),
    true
  );
  assert.equal(
    isQuotaOrPlanError({
      code: "BATCH_QUOTA_EXCEEDED",
      message: "Subscription has no credit available for the Batch API.",
    }),
    true
  );
  assert.equal(
    isQuotaOrPlanError({
      status: 422,
      body: JSON.stringify({ code: "RESP001", title: "Could not get content (RESP001)" }),
    }),
    false
  );
  assert.equal(
    isQuotaOrPlanError({
      status: 402,
      body: JSON.stringify({ code: "AUTH004", title: "Concurrency limit reached (AUTH004)" }),
    }),
    false
  );
});

test("appendClaimHint adds claim URL when unclaimed and quota/plan error", () => {
  writeUnclaimed("https://app.zenrows.com/claim/abc");
  const msg = "Zenrows error 402: {\"code\":\"AUTH001\"}";
  const out = appendClaimHint(msg, { status: 402, body: msg });
  assert.match(out, /Claim your Free account/);
  assert.match(out, /https:\/\/app\.zenrows\.com\/claim\/abc/);
  assert.ok(out.startsWith(msg));
});

test("appendClaimHint is a no-op when claimed or no account file", () => {
  const msg = "Zenrows error 402: no credit";
  assert.equal(appendClaimHint(msg, { status: 402 }), msg);

  writeFileSync(
    join(home, ".zenrows", "account.json"),
    JSON.stringify({
      accountId: "acct-1",
      unclaimed: false,
      claimUrl: "https://app.zenrows.com/claim/abc",
      createdAt: "2026-01-01T00:00:00.000Z",
    }) + "\n",
    { mode: 0o600 }
  );
  assert.equal(appendClaimHint(msg, { status: 402 }), msg);
});

test("appendClaimHint does not attach on unrelated errors", () => {
  writeUnclaimed();
  const msg = "Zenrows error 422: RESP001";
  assert.equal(appendClaimHint(msg, { status: 422, body: msg }), msg);
});
