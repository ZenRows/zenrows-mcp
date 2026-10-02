/**
 * Append a claim-account nudge when an unclaimed Free agent hits quota/plan limits.
 */
import { readAccount } from "./ensure-key.js";

const CLAIM_NUDGE = "Claim your Free account to keep usage and upgrade: ";

/**
 * Codes that are not an allowance problem, so a claim nudge would be noise.
 *
 * AUTH006 is the concurrency limit, and is belt-and-braces: it comes back as 429, so it
 * would not reach the 402 branch below in the first place. It is listed to keep the
 * intent legible rather than because anything depends on it.
 *
 * AUTH004 used to be listed here on the belief that it
 * was concurrency too — it is not. AUTH004 is "Usage Exceeded": the allowance itself is
 * spent (docs `api-error-codes#AUTH004`; gateway logs carry `err: "usage exceeded"`,
 * `msg: "user allowance failure"`). Skipping it suppressed the nudge at the one moment it
 * is worth the most — an unclaimed Free agent that has just run through its allowance and
 * would otherwise lose the account along with its usage history.
 */
const SKIP_CODES = new Set(["AUTH006"]);

/**
 * A per-key credit cap: Fetch, Extract and Browser answer 402 AUTH014, Batch answers
 * 402 `api_key_cap_reached`. The account still has credits and its other keys still
 * work, so "buy credits" or "claim your account" would send the user the wrong way.
 */
export const KEY_CAP_CODES: ReadonlySet<string> = new Set(["AUTH014", "api_key_cap_reached", "BATCH_KEY_CAP_REACHED"]);

export const KEY_CAP_NUDGE =
  "This API key reached one of its credit caps. The account's other API keys still work. Raise or remove the cap at https://app.zenrows.com/settings/api-keys, or wait until it resets (the error detail says when).";

function extractCode(body?: string, code?: string): string | undefined {
  if (code && typeof code === "string") return code;
  if (!body) return undefined;
  try {
    const j = JSON.parse(body) as { code?: string; error?: string };
    if (typeof j.code === "string") return j.code;
    const m = typeof j.error === "string" ? j.error.match(/\((AUTH\d+)\)/) : null;
    return m?.[1];
  } catch {
    const m = body.match(/\b(AUTH\d+|BATCH_QUOTA_EXCEEDED)\b/);
    return m?.[1];
  }
}

export function isKeyCapError(
  opts: {
    body?: string;
    code?: string;
    message?: string;
  } = {}
): boolean {
  const code = extractCode(opts.body, opts.code);
  if (code && KEY_CAP_CODES.has(code)) return true;
  return /\b(AUTH014|api_key_cap_reached)\b/.test(`${opts.message ?? ""} ${opts.body ?? ""}`);
}

export function isQuotaOrPlanError(
  opts: {
    status?: number;
    body?: string;
    code?: string;
    message?: string;
  } = {}
): boolean {
  if (isKeyCapError(opts)) return false;
  const code = extractCode(opts.body, opts.code);
  if (code && SKIP_CODES.has(code)) return false;

  if (opts.status === 402) return true;
  if (code === "BATCH_QUOTA_EXCEEDED") return true;

  const hay = `${opts.message ?? ""} ${opts.body ?? ""} ${code ?? ""}`;
  if (/\bHTTP\s*402\b/i.test(hay) || /\berror\s+402\b/i.test(hay)) return true;
  return /\b(no credit|credits?\s+(exhausted|exceeded|available)|quota exceeded|subscription has no credit)\b/i.test(
    hay
  );
}

/**
 * If the local agent account is still unclaimed and this looks like a quota/plan
 * failure, append the claim URL so agents can nudge the user.
 */
export function appendClaimHint(
  text: string,
  opts: { status?: number; body?: string; code?: string; message?: string } = {}
): string {
  const probe = {
    status: opts.status,
    body: opts.body ?? text,
    code: opts.code,
    message: opts.message ?? text,
  };
  if (isKeyCapError(probe)) {
    return text.includes(KEY_CAP_NUDGE) ? text : `${text}\n\n${KEY_CAP_NUDGE}`;
  }
  if (!isQuotaOrPlanError(probe)) return text;

  const acct = readAccount();
  if (!acct?.unclaimed || !acct.claimUrl) return text;

  const hint = `${CLAIM_NUDGE}${acct.claimUrl}`;
  if (text.includes(acct.claimUrl) || text.includes(CLAIM_NUDGE.trim())) return text;
  return `${text}\n\n${hint}`;
}
