/**
 * Keep the local claim state honest before a claim hint is shown.
 *
 * A claim link expires 30 days after it is issued, and the human may already have claimed
 * the account from another machine. So, for an account still marked unclaimed:
 * - at most every STATUS_TTL, ask GET /api/agent/account whether it has been claimed;
 * - when the stored link is missing or older than LINK_REFRESH_AGE, mint a fresh one with
 *   POST /api/agent/claim (each call invalidates the previous link, so never more often
 *   than CLAIM_RETRY_GAP).
 * Every network failure is swallowed: the hint falls back to what account.json holds.
 */
import {
  CLAIM_API_URL,
  DISCOVERY_URL_ENV,
  isZenrowsHttpsUrl,
  readAccount,
  readStoredApiKey,
  writeAccount,
} from "./ensure-key.js";
import type { AgentAccount } from "./ensure-key.js";

const DAY = 24 * 60 * 60 * 1000;
export const LINK_TTL_MS = 30 * DAY;
export const LINK_REFRESH_AGE_MS = 25 * DAY;
export const STATUS_TTL_MS = 6 * 60 * 60 * 1000;
export const CLAIM_RETRY_GAP_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 5000;

function appBase(): string {
  const override = process.env[DISCOVERY_URL_ENV]?.trim();
  return (override || new URL(CLAIM_API_URL).origin).replace(/\/$/, "");
}

function ms(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}

/** When the stored claim link was issued; files from before refreshes existed fall back to createdAt. */
export function claimLinkIssuedAt(acct: AgentAccount): number | undefined {
  return ms(acct.claimUrlIssuedAt) ?? ms(acct.createdAt);
}

/** The stored claim link if it is ours and still inside its 30-day life, else undefined. */
export function usableClaimUrl(acct: AgentAccount, now = Date.now()): string | undefined {
  if (!isZenrowsHttpsUrl(acct.claimUrl)) return undefined;
  const issued = claimLinkIssuedAt(acct);
  if (issued === undefined || now - issued >= LINK_TTL_MS) return undefined;
  return acct.claimUrl;
}

async function call(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch
): Promise<{ status: number; json: Record<string, unknown> } | null> {
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      // non-JSON body: the status alone decides
    }
    return { status: res.status, json };
  } catch {
    return null;
  }
}

/**
 * Bring account.json up to date for an unclaimed account. Returns the account as it now
 * stands (or null when there is no local account). Never throws.
 */
export async function refreshClaimState(
  opts: { apiKey?: string; fetchImpl?: typeof fetch; now?: number } = {}
): Promise<AgentAccount | null> {
  const acct = readAccount();
  if (!acct?.unclaimed) return acct;
  // account.json describes the account behind secrets.json, which may differ from an env key.
  const key = readStoredApiKey() ?? opts.apiKey;
  if (!key) return acct;
  const now = opts.now ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers = { Accept: "application/json", "X-API-Key": key, "User-Agent": "zenrows/mcp" };
  let changed = false;

  const checked = ms(acct.statusCheckedAt);
  if (checked === undefined || now - checked >= STATUS_TTL_MS) {
    const r = await call(`${appBase()}/api/agent/account`, { method: "GET", headers }, fetchImpl);
    if (r?.status === 200) {
      acct.statusCheckedAt = new Date(now).toISOString();
      changed = true;
      if (r.json.claimed === true) {
        acct.unclaimed = false;
        writeAccount(acct);
        return acct;
      }
    }
  }

  const issued = claimLinkIssuedAt(acct);
  const linkStale = !isZenrowsHttpsUrl(acct.claimUrl) || issued === undefined || now - issued >= LINK_REFRESH_AGE_MS;
  const attempted = ms(acct.claimRefreshAttemptedAt);
  if (linkStale && (attempted === undefined || now - attempted >= CLAIM_RETRY_GAP_MS)) {
    acct.claimRefreshAttemptedAt = new Date(now).toISOString();
    changed = true;
    const r = await call(`${appBase()}/api/agent/claim`, { method: "POST", headers }, fetchImpl);
    if (r?.status === 200 && isZenrowsHttpsUrl(r.json.claimUrl)) {
      acct.claimUrl = r.json.claimUrl;
      acct.claimUrlIssuedAt = new Date(now).toISOString();
    } else if (r?.status === 409) {
      // already_claimed, or not an agent account: either way there is nothing to claim.
      acct.unclaimed = false;
    }
  }

  if (changed) writeAccount(acct);
  return acct;
}
