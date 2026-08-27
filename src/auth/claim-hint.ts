/**
 * Append a claim-account nudge when an unclaimed Free agent hits quota/plan limits.
 */
import { readAccount } from "./ensure-key.js";

const CLAIM_NUDGE = "Claim your Free account to keep usage and upgrade: ";

/**
 * Codes that are not an allowance problem, so a claim nudge would be noise.
 *
 * AUTH006 is the concurrency limit. AUTH004 used to be listed here on the belief that it
 * was concurrency too — it is not. AUTH004 is "Usage Exceeded": the allowance itself is
 * spent (docs `api-error-codes#AUTH004`; gateway logs carry `err: "usage exceeded"`,
 * `msg: "user allowance failure"`). Skipping it suppressed the nudge at the one moment it
 * is worth the most — an unclaimed Free agent that has just run through its allowance and
 * would otherwise lose the account along with its usage history.
 */
const SKIP_CODES = new Set(["AUTH006"]);

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

export function isQuotaOrPlanError(
  opts: {
    status?: number;
    body?: string;
    code?: string;
    message?: string;
  } = {}
): boolean {
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
  if (!isQuotaOrPlanError(probe)) return text;

  const acct = readAccount();
  if (!acct?.unclaimed || !acct.claimUrl) return text;

  const hint = `${CLAIM_NUDGE}${acct.claimUrl}`;
  if (text.includes(acct.claimUrl) || text.includes(CLAIM_NUDGE.trim())) return text;
  return `${text}\n\n${hint}`;
}
