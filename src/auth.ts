/**
 * Per-tool scope enforcement for scoped ZenRows agent credentials.
 *
 * The ZenRows app issues scoped, revocable agent credentials and exposes an
 * introspection endpoint (`GET /me/credential`). This module asks that endpoint
 * what a presented credential is allowed to do and gates tool calls accordingly.
 *
 * Backwards compatible by design:
 *   - 200 from introspection  → a scoped agent credential; enforce its scopes.
 *   - 401 (legacy user API key, or revoked/invalid) → no scope data; pass through
 *     unchanged. A truly invalid key is still rejected by the Scraper API on use.
 *   - introspection outage    → fail open to pass-through (availability over a
 *     check the Scraper API ultimately backstops).
 */

const INTROSPECTION_URL =
  process.env.ZENROWS_INTROSPECTION_URL ?? "https://api.zenrows.com/me/credential";

const CACHE_TTL_MS = 60_000;

interface Introspection {
  /** True only when the credential is a scoped agent credential. */
  scoped: boolean;
  scopes: Set<string>;
}

const cache = new Map<string, { at: number; value: Introspection }>();

/** Resolve (and briefly cache) what a credential is allowed to do. */
export async function introspect(apiKey: string): Promise<Introspection> {
  const hit = cache.get(apiKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  let value: Introspection = { scoped: false, scopes: new Set() };
  try {
    const res = await fetch(INTROSPECTION_URL, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      const body = (await res.json()) as { data?: { scopes?: string[] } };
      value = { scoped: true, scopes: new Set(body.data?.scopes ?? []) };
    }
    // Any non-200 (incl. 401 for legacy keys) → pass-through (scoped: false).
  } catch {
    // Introspection unreachable → fail open to pass-through.
  }

  cache.set(apiKey, { at: Date.now(), value });
  return value;
}

/**
 * Returns a human/agent-readable denial message when a scoped credential lacks
 * the required scopes, or `null` when the call is allowed (including all legacy
 * keys, which carry no scope restrictions).
 */
export async function guardScopes(apiKey: string, required: string[]): Promise<string | null> {
  const { scoped, scopes } = await introspect(apiKey);
  if (!scoped) return null;

  const missing = required.filter((s) => !scopes.has(s));
  if (missing.length === 0) return null;

  return (
    `insufficient_scope: this agent credential is missing ${missing.join(", ")}. ` +
    `Grant it in Settings → Agents (some scopes require admin approval), ` +
    `or connect a credential that already has it.`
  );
}

/** Scopes required by the browser automation tools (a production capability). */
export const BROWSER_SCOPES = ["scrape:write", "browser:session_write"];

/** Scopes required by the `scrape` tool, given its parameters. */
export function scrapeScopes(params: {
  autoparse?: boolean;
  css_extractor?: string;
  outputs?: string;
}): string[] {
  const scopes = ["scrape:write"];
  if (params.autoparse || params.css_extractor || params.outputs) {
    scopes.push("extract:json");
  }
  return scopes;
}

/** Test seam: clear the introspection cache. */
export function clearIntrospectionCache(): void {
  cache.clear();
}
