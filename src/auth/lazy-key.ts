/**
 * The stdio server's API key, resolved on the first tool call that needs one.
 *
 * The server must answer the MCP handshake with no key at all, so nothing here runs at
 * startup. The first tool call resolves the key (env, then the secrets file) and, if there
 * is none, signs up once: concurrent first calls share one signup. A refused signup turns
 * into an actionable tool error and is retried on a later call, never before the server's
 * Retry-After.
 */
import { AuthError, autoSignupEnabled, ensureApiKey, getZenrowsDir, isCI, resolveApiKey } from "./ensure-key.js";
import type { AgentAccount } from "./ensure-key.js";

/** Wait after a failure that came with no Retry-After (network error, 5xx). */
const DEFAULT_BACKOFF_SEC = 60;
/** Wait after a 429 that came with no Retry-After. */
const DEFAULT_RATE_LIMIT_SEC = 15 * 60;
/** Signup turned off server-side: the human has to act, so do not ask again soon. */
const DISABLED_BACKOFF_SEC = 60 * 60;

export interface LazyKeyOptions {
  fetchImpl?: typeof fetch;
  userAgent?: string;
  onProvision?: (a: AgentAccount) => void;
  now?: () => number;
  env?: Record<string, string | undefined>;
}

export class LazyApiKey {
  current = "";
  private inflight?: Promise<string>;
  private lastError?: AuthError;
  private retryAt = 0;

  constructor(private readonly opts: LazyKeyOptions = {}) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** The key, signing up if needed. clientName is the MCP clientInfo.name from the handshake. Throws an AuthError whose message is ready to show the user. */
  async ensure(clientName?: string): Promise<string> {
    if (this.current) return this.current;

    // Re-read each time: the user may have set the key, or another process stored one.
    const existing = resolveApiKey();
    if (existing.key) return (this.current = existing.key);

    if (!autoSignupEnabled()) {
      throw new AuthError("AUTH_MISSING", missingKeyMessage());
    }
    if (this.inflight) return this.inflight;
    if (this.lastError && this.now() < this.retryAt) {
      throw new AuthError(this.lastError.code, this.describe(this.lastError), this.secondsLeft());
    }

    this.inflight = ensureApiKey({
      fetchImpl: this.opts.fetchImpl,
      userAgent: this.opts.userAgent,
      clientName,
      onProvision: this.opts.onProvision,
    })
      .then((r) => {
        this.lastError = undefined;
        this.retryAt = 0;
        return (this.current = r.apiKey);
      })
      .catch((err: unknown) => {
        const authErr =
          err instanceof AuthError
            ? err
            : new AuthError("SIGNUP_FAILED", err instanceof Error ? err.message : String(err));
        this.lastError = authErr;
        this.retryAt = this.now() + backoffSec(authErr) * 1000;
        throw new AuthError(authErr.code, this.describe(authErr), this.secondsLeft());
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  private secondsLeft(): number {
    return Math.max(0, Math.ceil((this.retryAt - this.now()) / 1000));
  }

  private describe(err: AuthError): string {
    return signupErrorMessage(err, { retryInSec: this.secondsLeft(), ci: isCI(this.opts.env ?? process.env) });
  }
}

function backoffSec(err: AuthError): number {
  if (err.code === "SIGNUP_RATE_LIMITED") return err.retryAfterSec ?? DEFAULT_RATE_LIMIT_SEC;
  if (err.code === "SIGNUP_DISABLED") return DISABLED_BACKOFF_SEC;
  return err.retryAfterSec ?? DEFAULT_BACKOFF_SEC;
}

function humanDuration(sec: number): string {
  if (sec < 90) return `${Math.max(1, sec)} seconds`;
  const min = Math.round(sec / 60);
  if (min < 90) return `${min} minutes`;
  const h = Math.round(min / 6) / 10;
  return `${h} hours`;
}

export function missingKeyMessage(): string {
  return (
    "This tool needs a Zenrows API key, and automatic signup is off (ZENROWS_AUTO_SIGNUP=false). " +
    "Set ZENROWS_API_KEY in this MCP server's environment and restart it. " +
    "Get a key at https://app.zenrows.com/register."
  );
}

/** The tool error text for a refused signup: why, when to retry, and how to fix it for good. */
export function signupErrorMessage(err: AuthError, opts: { retryInSec: number; ci: boolean }): string {
  const lines: string[] = [];
  if (opts.ci) {
    lines.push(
      "No Zenrows API key in this CI job. Each run starts with an empty home, so each run would create a new account and the per-network signup cap stops it. " +
        "Set ZENROWS_API_KEY as a CI secret, or persist ZENROWS_HOME (default ~/.zenrows) between runs so the first account is reused."
    );
  }
  const reason =
    err.code === "SIGNUP_RATE_LIMITED"
      ? err.message
      : err.code === "SIGNUP_DISABLED"
        ? err.message
        : `Could not create a Zenrows account automatically: ${err.message}`;
  lines.push(
    `${reason} Retry in ${humanDuration(opts.retryInSec)} (${opts.retryInSec}s); until then, tool calls return this error without asking Zenrows again.`
  );
  if (!opts.ci) {
    lines.push(
      "To fix it now: set ZENROWS_API_KEY to an existing key (https://app.zenrows.com/register) and restart this MCP server. " +
        "In CI, set it as a secret or persist ZENROWS_HOME between runs."
    );
  }
  lines.push(`To stop automatic signup, set ZENROWS_AUTO_SIGNUP=false. Key storage: ${getZenrowsDir()}`);
  return lines.join("\n");
}
