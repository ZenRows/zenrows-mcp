/**
 * Resolve-or-provision the Zenrows API key for stdio MCP.
 *
 * Persistence lives under ~/.zenrows/ (secrets.json + account.json, mode 0600).
 * Remote HTTP transport must NOT call this — Bearer/OAuth only.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const ENV_KEY = "ZENROWS_API_KEY";
export const AUTO_SIGNUP_ENV = "ZENROWS_AUTO_SIGNUP";
export const SIGNUP_URL_ENV = "ZENROWS_AGENT_SIGNUP_URL";
export const DISCOVERY_URL_ENV = "ZENROWS_DISCOVERY_URL";
/** `off` suppresses the anonymous attribution headers on signup (same switch as the Zenrows CLI). */
export const TELEMETRY_ENV = "ZENROWS_TELEMETRY";

export const AGENT_SIGNUP_API_URL = "https://app.zenrows.com/api/agent/signup";
export const WELL_KNOWN_PROTECTED_RESOURCE = "/.well-known/oauth-protected-resource";

export interface AgentAccount {
  accountId: string;
  unclaimed: boolean;
  claimUrl: string;
  createdAt: string;
}

export interface SignupResponse {
  apiKey: string;
  accountId: string;
  claimUrl: string;
}

export class AuthError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

/** Override home for tests / custom installs (absolute path to the `.zenrows` dir parent, or the dir itself if it ends with `.zenrows`). */
export const ZENROWS_HOME_ENV = "ZENROWS_HOME";

function zenrowsDir(): string {
  const override = process.env[ZENROWS_HOME_ENV]?.trim();
  if (override) {
    return override.endsWith(".zenrows") ? override : join(override, ".zenrows");
  }
  return join(homedir(), ".zenrows");
}

/** Test-only: clear discovery cache between cases. */
export function _resetDiscoveryCache(): void {
  discoveredSignupUrl = undefined;
}

export function getZenrowsDir(): string {
  return zenrowsDir();
}

function secretsPath(): string {
  return join(zenrowsDir(), "secrets.json");
}

function accountPath(): string {
  return join(zenrowsDir(), "account.json");
}

function agentIdPath(): string {
  return join(zenrowsDir(), "telemetry-id");
}

function ensureDir(): void {
  const dir = zenrowsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readJsonFile<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonSecure(file: string, data: unknown): void {
  ensureDir();
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // best-effort on platforms without POSIX permissions
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Stable anonymous id for this machine, sent as X-ZR-Agent-Id on signup so the backend
 * can tell one machine retrying from many machines signing up. A random UUID, nothing
 * derived from the user or host. Shared with the Zenrows CLI so a machine has one id.
 */
export function getOrCreateAgentId(): string {
  // One id per machine: prefer the CLI's, then ours.
  const existing = readUuidFile(cliAgentIdPath()) ?? readUuidFile(agentIdPath());
  if (existing) return existing;
  const id = randomUUID();
  // The CLI persists a new id to its machine file; do the same so it adopts ours.
  writeUuidFile(cliAgentIdPath(), id);
  writeUuidFile(agentIdPath(), id);
  return id;
}

/** Where the Zenrows CLI keeps its machine id (its machineConfigDir() + telemetry-id). */
export function cliAgentIdPath(): string {
  const override = process.env.ZENROWS_CONFIG_HOME?.trim();
  if (override) return join(override, "telemetry-id");
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "zenrows", "telemetry-id");
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(homedir(), ".config"), "zenrows", "telemetry-id");
}

function readUuidFile(file: string): string | undefined {
  try {
    const id = readFileSync(file, "utf8").trim();
    return UUID_RE.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function writeUuidFile(file: string, id: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${id}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {
    // unwritable: the id is still sent, it just may not be stable
  }
}

type Env = Record<string, string | undefined>;

function hasPrefix(env: Env, prefix: string): boolean {
  return Object.keys(env).some((k) => k.startsWith(prefix));
}

/**
 * Best-effort guess at the agent hosting this process. Signup runs before the MCP
 * handshake, so clientInfo is not known yet. Mirrors the Zenrows CLI's detectClient so
 * the app sees one vocabulary: claude-code, cursor, openai-codex, windsurf, vscode, unknown.
 */
export function detectClient(env: Env = process.env): string {
  const term = env.TERM_PROGRAM;
  if (env.CLAUDECODE || hasPrefix(env, "CLAUDE_CODE") || hasPrefix(env, "CLAUDE_")) return "claude-code";
  if (env.CURSOR_TRACE_ID || hasPrefix(env, "CURSOR_") || term === "cursor") return "cursor";
  if (hasPrefix(env, "OPENAI_") || hasPrefix(env, "CODEX_")) return "openai-codex";
  if (hasPrefix(env, "WINDSURF")) return "windsurf";
  if (term === "vscode" || hasPrefix(env, "VSCODE_")) return "vscode";
  return "unknown";
}

/**
 * The only signup hosts we accept from discovery: https on zenrows.com or a subdomain.
 * Discovery is an unauthenticated fetch, so without this a tampered response could
 * point the key-minting POST anywhere.
 */
export function isZenrowsHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase();
    return (
      u.protocol === "https:" && !u.username && !u.password && (host === "zenrows.com" || host.endsWith(".zenrows.com"))
    );
  } catch {
    return false;
  }
}

export function readStoredApiKey(): string | undefined {
  const stored = readJsonFile<{ apiKey?: string }>(secretsPath());
  const key = stored?.apiKey?.trim();
  return key || undefined;
}

export function readAccount(): AgentAccount | null {
  return readJsonFile<AgentAccount>(accountPath());
}

export function saveApiKey(apiKey: string): void {
  writeJsonSecure(secretsPath(), { apiKey: apiKey.trim() });
}

export function writeAccount(acct: AgentAccount): void {
  writeJsonSecure(accountPath(), acct);
}

/** Resolve key: env → ~/.zenrows/secrets.json. Does not signup. */
export function resolveApiKey(): { key?: string; source: "env" | "secrets-file" | "none" } {
  const env = process.env[ENV_KEY]?.trim();
  if (env) return { key: env, source: "env" };
  const stored = readStoredApiKey();
  if (stored) return { key: stored, source: "secrets-file" };
  return { source: "none" };
}

export function autoSignupEnabled(): boolean {
  return process.env[AUTO_SIGNUP_ENV] !== "false";
}

let discoveredSignupUrl: string | null | undefined;

export async function discoverSignupUrl(opts: { fetchImpl?: typeof fetch } = {}): Promise<string | null> {
  try {
    const base = process.env[DISCOVERY_URL_ENV]?.trim() || new URL(AGENT_SIGNUP_API_URL).origin;
    const url = base.replace(/\/$/, "") + WELL_KNOWN_PROTECTED_RESOURCE;
    const doFetch = opts.fetchImpl ?? fetch;
    const res = await doFetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "zenrows/mcp" },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { agent_auth?: { signup_endpoint?: unknown } };
    const endpoint = json?.agent_auth?.signup_endpoint;
    if (typeof endpoint === "string" && isZenrowsHttpsUrl(endpoint.trim())) return endpoint.trim();
    return null;
  } catch {
    return null;
  }
}

export async function signupCandidates(opts: { fetchImpl?: typeof fetch } = {}): Promise<string[]> {
  const fromEnv = process.env[SIGNUP_URL_ENV];
  if (fromEnv && fromEnv.trim()) return [fromEnv.trim()];
  if (discoveredSignupUrl === undefined) {
    discoveredSignupUrl = await discoverSignupUrl(opts);
  }
  const urls: string[] = [];
  if (discoveredSignupUrl && discoveredSignupUrl !== AGENT_SIGNUP_API_URL) {
    urls.push(discoveredSignupUrl);
  }
  urls.push(AGENT_SIGNUP_API_URL);
  return urls;
}

export async function signupAgent(
  opts: { url?: string; fetchImpl?: typeof fetch; userAgent?: string } = {}
): Promise<SignupResponse> {
  const urls = opts.url ? [opts.url] : await signupCandidates({ fetchImpl: opts.fetchImpl });
  const doFetch = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "User-Agent": opts.userAgent ?? "zenrows/mcp",
    "X-ZR-Source": "mcp",
  };
  if (process.env[TELEMETRY_ENV] !== "off") {
    headers["X-ZR-Agent-Id"] = getOrCreateAgentId();
    headers["X-ZR-Client"] = detectClient();
  }

  let lastMessage = "No signup endpoint was reachable.";
  for (const url of urls) {
    let res: Response;
    try {
      res = await doFetch(url, { method: "POST", headers });
    } catch (err) {
      lastMessage = err instanceof Error ? err.message : String(err);
      continue;
    }
    if (res.status === 201) return (await res.json()) as SignupResponse;
    const body = await res.text();
    if (res.status === 429) {
      throw new AuthError(
        "SIGNUP_RATE_LIMITED",
        "Zenrows blocked auto-signup: too many new accounts from this network. Wait and retry, or set ZENROWS_API_KEY."
      );
    }
    lastMessage = `HTTP ${res.status}: ${body.slice(0, 240)}`;
  }
  throw new AuthError("SIGNUP_FAILED", `Automatic account provisioning failed. ${lastMessage}`);
}

/**
 * Ensure an API key is available for stdio.
 * Returns the key and optional claim metadata when a new account was provisioned.
 */
export async function ensureApiKey(
  opts: {
    fetchImpl?: typeof fetch;
    userAgent?: string;
    onProvision?: (a: AgentAccount) => void;
  } = {}
): Promise<{ apiKey: string; provisioned?: AgentAccount }> {
  const existing = resolveApiKey();
  if (existing.key) return { apiKey: existing.key };

  if (!autoSignupEnabled()) {
    throw new AuthError(
      "AUTH_MISSING",
      "ZENROWS_API_KEY is required (auto-signup disabled via ZENROWS_AUTO_SIGNUP=false)."
    );
  }

  const res = await signupAgent({ fetchImpl: opts.fetchImpl, userAgent: opts.userAgent });
  saveApiKey(res.apiKey);
  const account: AgentAccount = {
    accountId: res.accountId,
    unclaimed: true,
    // Only keep a claim link we would be willing to show the user.
    claimUrl: isZenrowsHttpsUrl(res.claimUrl) ? res.claimUrl : "",
    createdAt: new Date().toISOString(),
  };
  writeAccount(account);
  opts.onProvision?.(account);
  return { apiKey: res.apiKey, provisioned: account };
}

export const CLAIM_API_URL = "https://app.zenrows.com/api/agent/claim";

/** Stderr notice after auto-signup. Never prints a claim link we would not trust. */
export function provisionMessage(acct: Pick<AgentAccount, "claimUrl">, dir: string): string {
  const claim = isZenrowsHttpsUrl(acct.claimUrl)
    ? `Claim it anytime (keeps your usage): ${acct.claimUrl}\n`
    : `Claim it anytime (keeps your usage): request a claim link with\n` +
      `  curl -X POST ${CLAIM_API_URL} -H "X-API-Key: <key from ${dir}/secrets.json>"\n`;
  return `Created a Zenrows Free plan account.\n` + claim + `Key stored in ${dir}/secrets.json\n`;
}
