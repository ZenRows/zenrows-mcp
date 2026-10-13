// Helpers for the JavaScript checks (node, mcp, cli), mounted read-only at /harness.
// Node built-ins only, so they add nothing to the clean container.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";

export const SURFACE = process.env.SURFACE;
export const KEY = process.env.ZENROWS_API_KEY || "";
export const HAS_KEY = KEY.length > 0;
export const CRAWL_URL = process.env.CRAWL_URL;
export const INCLUDE = process.env.CRAWL_INCLUDE;
export const API_BASE = process.env.CRAWL_API_BASE || "https://api.zenrows.com/v1";
/** An include pattern no URL contains: the crawl keeps nothing and ends failed (check 19). */
export const NO_MATCH = "/crawl-acceptance-matches-nothing/";
/** The default every client documents for max_pages and max_items (check 21). */
export const DOCUMENTED_DEFAULT = 100;
export const PASS = "PASS";
export const FAIL = "FAIL";
export const SKIP = "SKIP";
export const TERMINAL = new Set(["completed", "stopped", "failed"]);
const RESULTS = "/results";
mkdirSync(`${RESULTS}/checks`, { recursive: true });

export const passIf = (ok) => (ok ? PASS : FAIL);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Replace the key, wherever it appears, before anything is written or printed. */
export function redact(value) {
  const s = typeof value === "string" ? value : JSON.stringify(value, null, 1) ?? String(value);
  return KEY ? s.split(KEY).join("<REDACTED>") : s;
}

/** Redact, then cut long output for the evidence field. */
export function trim(value, max = 1500) {
  const s = redact(value);
  return s.length > max ? `${s.slice(0, max)}… [${s.length - max} more chars]` : s;
}

let seq = 0;
/** Write one result: {surface, check, title, status, expected, actual, evidence}. */
export function record(check, title, status, expected, actual, evidence = "") {
  const r = {
    surface: SURFACE,
    check: String(check),
    title,
    status,
    expected,
    actual: trim(actual, 800),
    evidence: trim(evidence, 2500),
  };
  seq += 1;
  const name = `${String(seq).padStart(3, "0")}-${r.check.replace(/[^A-Za-z0-9_.-]+/g, "_")}.json`;
  writeFileSync(`${RESULTS}/checks/${name}`, `${JSON.stringify(r, null, 2)}\n`);
  console.log(
    `[${status}] ${SURFACE} ${r.check} ${title}: ${r.actual.split("\n")[0].slice(0, 200)}`,
  );
  return r;
}

/** Run one check; an unexpected throw is a FAIL with the error as evidence. */
export async function check(id, title, expected, fn) {
  try {
    const out = await fn();
    if (out?.status)
      return record(id, title, out.status, expected, out.actual ?? "", out.evidence ?? "");
    return record(id, title, PASS, expected, out?.actual ?? "ok", out?.evidence ?? "");
  } catch (e) {
    return record(
      id,
      title,
      FAIL,
      expected,
      `threw: ${e?.name ?? ""} ${e?.message ?? e}`,
      e?.stack ?? String(e),
    );
  }
}

/** A live check without a key is SKIP, not a failure. */
export async function liveCheck(id, title, expected, fn) {
  if (!HAS_KEY)
    return record(id, title, SKIP, expected, "ZENROWS_API_KEY not set (run without --no-key)");
  return check(id, title, expected, fn);
}

/** Resolve within `ms`, or reject: a check that pages forever fails instead of hanging the run. */
export function within(ms, promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not finish within ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Every crawl the checks create goes in the ledger, so clean-up can stop it and the report can count it. */
export function ledger(crawlId, purpose) {
  if (crawlId)
    appendFileSync(
      `${RESULTS}/crawls.jsonl`,
      `${JSON.stringify({ crawl_id: crawlId, purpose })}\n`,
    );
}

/** The names this surface uses, for check 17. */
export function naming(map) {
  writeFileSync(`${RESULTS}/naming.json`, `${JSON.stringify(map, null, 2)}\n`);
}

/** Run a command and wait. The env carries the key, never argv. */
export function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  return {
    code: r.status ?? (r.signal ? 128 : 1),
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? (r.error ? String(r.error) : ""),
    cmd: [cmd, ...args].join(" "),
  };
}

/** Plain call to the Crawl API, for setup only (finding the README run's crawls). */
export async function api(method, path) {
  const res = await fetch(`${API_BASE}${path}`, { method, headers: { "X-API-Key": KEY } });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

/** The crawls created at or after `since` (ms), newest first. */
export async function crawlsSince(since) {
  if (!HAS_KEY) return [];
  const r = await api("GET", "/crawls?limit=100");
  if (r.status !== 200) return [];
  return r.json.crawls.filter((c) => Date.parse(c.created_at) >= since).map((c) => c.crawl_id);
}

const runningCrawl = () => ({
  crawl_id: "c_running",
  status: "running",
  url: "https://example.com/",
  depth: 1,
  max_items: 10,
  max_pages: 10,
  coverage: { pages_fetched: 0, pages_failed: 0, items_found: 0 },
  created_at: new Date().toISOString(),
});

/**
 * A local stand-in for the Crawl API that records what the client sends. It answers a create
 * with a running crawl, `GET /crawls/c_running` with a crawl that never ends, `GET
 * /crawls/c_nobody` with a 502 that has no body, and anything else with a 404 problem.
 * Call the client asynchronously while it runs: a blocking call starves it.
 */
export async function captureServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.method === "POST" && req.url.replace(/\?.*$/, "").endsWith("/crawls")) {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...runningCrawl(), crawl_id: "c_capture", url: body?.url ?? "" }));
      } else if (req.url.includes("c_running")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...runningCrawl(), results: [], next_cursor: "n" }));
      } else if (req.url.includes("c_nobody")) {
        res.writeHead(502);
        res.end();
      } else {
        res.writeHead(404, { "Content-Type": "application/problem+json" });
        res.end(
          JSON.stringify({
            status: 404,
            title: "Not Found",
            code: "crawl_not_found",
            detail: "stand-in",
          }),
        );
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** True when `obj` has exactly these keys, in any order. */
export function sameKeys(obj, keys) {
  const got = Object.keys(obj ?? {}).sort();
  const want = [...keys].sort();
  return got.length === want.length && got.every((k, i) => k === want[i]);
}

/** Check 18 on a text: "new" not "beta" on Crawl lines, one "still evolving" line, the 429 wording. */
export function copyFindings(text) {
  const lines = text.split("\n");
  const beta = lines.filter((l) => /crawl/i.test(l) && /\bbeta\b/i.test(l));
  const evolving = lines.filter((l) => /still evolving/i.test(l));
  const limit = lines.filter((l) => /active jobs/i.test(l));
  const problems = [];
  if (beta.length) problems.push(`"beta" on a Crawl line: ${beta[0].trim().slice(0, 160)}`);
  if (evolving.length !== 1) problems.push(`${evolving.length} "still evolving" lines (want 1)`);
  if (!limit.some((l) => /batch/i.test(l)))
    problems.push("no line reads the 429 limit as the account's active jobs, shared with Batch");
  return { problems, evolving, limit };
}
