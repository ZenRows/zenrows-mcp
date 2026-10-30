// MCP server (`@zenrows/mcp`): the README walk-through, checks 1-21 and the MCP extra checks.
// Starts the stdio server from the installed tarball the way the README's config does
// (`npx -y @zenrows/mcp`) and drives it with the official MCP client SDK.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import * as H from "/harness/harness.mjs";

const {
  PASS,
  FAIL,
  SKIP,
  passIf,
  record,
  check,
  liveCheck,
  ledger,
  sh,
  KEY,
  HAS_KEY,
  CRAWL_URL,
  INCLUDE,
} = H;
const APP = "/work/app";
const SDK = process.env.MCP_SDK_VERSION;
const tarball = `/artifact/${readdirSync("/artifact").find((f) => f.endsWith(".tgz"))}`;
const CRAWL_TOOLS = [
  "crawl_create",
  "crawl_get",
  "crawl_list",
  "crawl_results",
  "crawl_content",
  "crawl_download",
  "crawl_stop",
  "crawl_wait",
];

// ---------- README: install ----------
mkdirSync(APP, { recursive: true });
sh("npm", ["init", "-y"], { cwd: APP });
const install = sh("npm", ["install", tarball, `@modelcontextprotocol/sdk@${SDK}`], { cwd: APP });
record(
  "readme-1",
  "Install (README: `npx -y @zenrows/mcp` from npm; here the release tarball)",
  passIf(install.code === 0),
  "the package installs",
  `exit ${install.code}`,
  `${install.cmd}\n${install.stdout}${install.stderr}`,
);
if (install.code !== 0) process.exit(1);
const pkgDir = `${APP}/node_modules/@zenrows/mcp`;
const pkgReadme = readFileSync(`${pkgDir}/README.md`, "utf8");
const pkgJson = JSON.parse(readFileSync(`${pkgDir}/package.json`, "utf8"));
const require = createRequire(`${APP}/x.js`);
const { Client } = await import(require.resolve("@modelcontextprotocol/sdk/client/index.js"));
const { StdioClientTransport } = await import(
  require.resolve("@modelcontextprotocol/sdk/client/stdio.js")
);

/** Start the server as the README's stdio config does: command npx, args ["-y", "@zenrows/mcp"]. */
async function startServer(key, extraEnv = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: `/work/home-${randomUUID()}`, // a fresh HOME: nothing from an earlier server
    ZENROWS_API_KEY: key,
    ZENROWS_AUTO_SIGNUP: "false", // a safety net: a test never creates an account
    ...extraEnv,
  };
  mkdirSync(env.HOME, { recursive: true });
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@zenrows/mcp"],
    env,
    cwd: APP,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (d) => {
    stderr += d;
  });
  const client = new Client({ name: "crawl-acceptance", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr: () => stderr, close: () => client.close() };
}

/** Call a tool: {isError, data (the first text, parsed), texts}. A protocol error comes back as isError too. */
async function call(client, name, args) {
  try {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 15 * 60_000 });
    const texts = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text);
    let data;
    for (const candidate of [texts[0], texts[0]?.split("\n")[0]]) {
      try {
        data = JSON.parse(candidate);
        break;
      } catch {}
    }
    return { isError: Boolean(r.isError), data, texts };
  } catch (e) {
    return { isError: true, data: undefined, texts: [String(e?.message ?? e)] };
  }
}
const show = (r) => H.trim(r.data ?? r.texts?.join("\n"), 700);

let srv;
await check(
  "readme-2",
  "Start the server from the README's stdio config",
  "the server starts and answers tools/list",
  async () => {
    // The server reads its own variable, not CRAWL_API_BASE: without this it would
    // reach production whatever the run targets.
    srv = await startServer(HAS_KEY ? KEY : "invalid", { ZENROWS_CRAWL_API_BASE: H.API_BASE });
    const t = await srv.client.listTools();
    return {
      status: passIf(t.tools.length > 0),
      actual: `${t.tools.length} tools; ${pkgJson.name}@${pkgJson.version}, bin ${JSON.stringify(pkgJson.bin)}`,
      evidence: `npx -y @zenrows/mcp (in a project with the tarball installed)\nstderr: ${srv.stderr()}`,
    };
  },
);
if (!srv) process.exit(1);
const tools = (await srv.client.listTools()).tools;
const S = srv.client;

// ---------- the README's flow: crawl_create → crawl_wait → crawl_results ----------
await liveCheck(
  "readme-3",
  "Follow the README: crawl_create, then crawl_wait, then crawl_results",
  "each call succeeds; results come back",
  async () => {
    const c = await call(S, "crawl_create", {
      url: CRAWL_URL,
      depth: 1,
      max_items: 5,
      max_pages: 10,
      include_patterns: [INCLUDE],
    });
    if (c.data?.crawl_id) ledger(c.data.crawl_id, "README quickstart");
    if (c.isError) return { status: FAIL, actual: `crawl_create: ${show(c)}` };
    const w = await call(S, "crawl_wait", { crawl_id: c.data.crawl_id });
    const r = await call(S, "crawl_results", { crawl_id: c.data.crawl_id });
    return {
      status: passIf(!w.isError && !r.isError && r.data?.count > 0),
      actual: `${c.data.crawl_id}: wait ${w.data?.status}; ${r.data?.count} results`,
      evidence: `crawl_create ${show(c)}\ncrawl_wait ${show(w)}\ncrawl_results ${show(r)}`,
    };
  },
);

// ---------- extras: tools/list and annotations ----------
await check(
  "x-mcp-tools",
  "tools/list shows exactly the eight crawl tools",
  CRAWL_TOOLS.join(", "),
  async () => {
    const names = tools.map((t) => t.name).filter((n) => n.startsWith("crawl"));
    const ok = names.length === CRAWL_TOOLS.length && CRAWL_TOOLS.every((n) => names.includes(n));
    return {
      status: passIf(ok),
      actual: names.join(", "),
      evidence: `tools/list: ${tools.length} tools in all`,
    };
  },
);
await check(
  "x-mcp-destructive",
  "Only crawl_stop is destructive",
  "destructiveHint true on crawl_stop only",
  async () => {
    const crawlTools = tools.filter((t) => t.name.startsWith("crawl"));
    const destructive = crawlTools
      .filter((t) => t.annotations?.destructiveHint === true)
      .map((t) => t.name);
    return {
      status: passIf(destructive.length === 1 && destructive[0] === "crawl_stop"),
      actual: destructive.join(", ") || "none",
      evidence: JSON.stringify(
        crawlTools.map((t) => ({ name: t.name, annotations: t.annotations })),
      ),
    };
  },
);

// ---------- check 1, offline half: what the server sends ----------
const cap = await H.captureServer();
const capSrv = await startServer("capture-key", { ZENROWS_CRAWL_API_BASE: cap.base });
// depth is optional: left out, it is not sent, and the crawl has no depth limit.
await call(capSrv.client, "crawl_create", { url: "https://example.com/" });
await call(capSrv.client, "crawl_create", {
  url: "https://example.com/",
  depth: 1,
  max_items: 5,
  max_pages: 10,
  include_patterns: ["/p/"],
  idempotency_key: "idem-1",
});
const sent = { minimal: cap.requests[0]?.body, full: cap.requests[1]?.body };
const sentOk =
  H.sameKeys(sent.minimal, ["url"]) &&
  H.sameKeys(sent.full, ["url", "depth", "max_items", "max_pages", "include_patterns"]);
const sentLine = `sent (stand-in server): minimal=${JSON.stringify(sent.minimal)} full=${JSON.stringify(sent.full)}`;
await capSrv.close();
await cap.close();

// ---------- live ----------
const base = { url: CRAWL_URL, depth: 1, max_items: 5, max_pages: 10, include_patterns: [INCLUDE] };
async function create(args) {
  for (let i = 0; i < 10; i++) {
    const r = await call(S, "crawl_create", args);
    if (r.data?.code === "CRAWL_TOO_MANY_CRAWLS") {
      await H.sleep((r.data.retry_after ?? 30) * 1000); // the account's active jobs are shared: wait as told
      continue;
    }
    if (r.data?.crawl_id) ledger(r.data.crawl_id, "check");
    return r;
  }
  throw new Error("still 429 after 10 tries");
}
/** crawl_wait until the crawl ends; each call waits at most the tool's default. */
async function waitEnd(id) {
  let r;
  for (let i = 0; i < 12; i++) {
    r = await call(S, "crawl_wait", { crawl_id: id });
    if (r.isError || r.data?.status !== "running") break;
  }
  return r;
}
const isEnvelope = (d) =>
  d?.ok === true &&
  typeof d.crawl_id === "string" &&
  typeof d.status === "string" &&
  typeof d.crawl === "object";

let A;
let B;
let C;
let F;
let ended;
await check(
  "1",
  "Create",
  "returns at once: {ok, crawl_id, status: running, crawl}; only the fields set are sent",
  async () => {
    if (!HAS_KEY) {
      return {
        status: sentOk ? SKIP : FAIL,
        actual: `live part skipped (no key); only set fields sent: ${sentOk}`,
        evidence: sentLine,
      };
    }
    const r = await create(base);
    A = r.data;
    const c = A?.crawl ?? {};
    const echo = JSON.stringify([c.url, c.depth, c.max_items, c.max_pages, c.include_patterns]);
    const ok =
      sentOk &&
      !r.isError &&
      isEnvelope(A) &&
      A.status === "running" &&
      echo === JSON.stringify([CRAWL_URL, 1, 5, 10, [INCLUDE]]);
    return {
      status: passIf(ok),
      actual: `${A?.crawl_id} ${A?.status}; envelope ${isEnvelope(A)}; only set fields sent: ${sentOk}`,
      evidence: `${show(r)}\n${sentLine}`,
    };
  },
);
await liveCheck(
  "5",
  "Wait runs out",
  "crawl_wait timeout 1 on a running crawl → running and a note, no error",
  async () => {
    if (!A) return { status: SKIP, actual: "no crawl from check 1" };
    const t0 = Date.now();
    const r = await call(S, "crawl_wait", { crawl_id: A.crawl_id, timeout: 1 });
    if (r.data?.status && r.data.status !== "running")
      return { status: SKIP, actual: `the crawl had already ended (${r.data.status})` };
    return {
      status: passIf(
        !r.isError && r.data?.status === "running" && typeof r.data?.note === "string",
      ),
      actual: `${r.data?.status} after ${Date.now() - t0} ms; note: ${r.data?.note ?? "none"}`,
      evidence: show(r),
    };
  },
);
const partial = A ? await call(S, "crawl_results", { crawl_id: A.crawl_id }) : undefined;

await liveCheck(
  "3",
  "Idempotency",
  "same key + body → same crawl_id; different body → CRAWL_INVALID_REQUEST and the advice to send a new key",
  async () => {
    const body = { ...base, max_items: 3, max_pages: 3, idempotency_key: `acc-${randomUUID()}` };
    const r1 = await create(body);
    C = r1.data;
    const r2 = await create(body);
    const r3 = await call(S, "crawl_create", { ...body, max_items: 4 });
    if (!r3.isError && r3.data?.crawl_id)
      ledger(r3.data.crawl_id, "idempotency, different body (unexpected create)");
    const ok =
      Boolean(r1.data?.crawl_id) &&
      r1.data.crawl_id === r2.data?.crawl_id &&
      r3.isError &&
      r3.data?.code === "CRAWL_INVALID_REQUEST" &&
      r3.data?.server_code === "idempotency_key_reused" &&
      /new idempotency_key/i.test(r3.data?.message ?? "");
    return {
      status: passIf(ok),
      actual: `first ${r1.data?.crawl_id}, second ${r2.data?.crawl_id}; different body → ${r3.data?.code} (${r3.data?.server_code}): ${r3.data?.message}`,
      evidence: show(r3),
    };
  },
);
await liveCheck(
  "11",
  "Stop",
  "running → stopped, stop_reason user; ended → answers as it ended, no error",
  async () => {
    if (!C) return { status: SKIP, actual: "no crawl from check 3" };
    const s1 = await call(S, "crawl_stop", { crawl_id: C.crawl_id });
    if (s1.data?.status === "completed" && s1.data?.crawl?.stop_reason !== "user") {
      return {
        status: SKIP,
        actual: `the crawl had already ended on its own (${s1.data.status}/${s1.data.crawl?.stop_reason})`,
      };
    }
    const s2 = await call(S, "crawl_stop", { crawl_id: C.crawl_id });
    const ok =
      !s1.isError &&
      s1.data?.status === "stopped" &&
      s1.data?.crawl?.stop_reason === "user" &&
      !s2.isError &&
      s2.data?.status === s1.data?.status;
    return {
      status: passIf(ok),
      actual: `first: ${s1.data?.status}/${s1.data?.crawl?.stop_reason}; second: ${s2.isError ? `error ${show(s2)}` : s2.data?.status}`,
      evidence: `${show(s1)}\n${show(s2)}`,
    };
  },
);
await liveCheck(
  "4",
  "Wait",
  "crawl_wait returns the ended crawl; failed is returned, not an error",
  async () => {
    if (!A) return { status: SKIP, actual: "no crawl from check 1" };
    const r = await waitEnd(A.crawl_id);
    ended = r.data;
    return {
      status: passIf(!r.isError && H.TERMINAL.has(r.data?.status)),
      actual: `${r.data?.status}/${r.data?.crawl?.stop_reason ?? "-"}; coverage ${JSON.stringify(r.data?.crawl?.coverage)}`,
      evidence: show(r),
    };
  },
);
await liveCheck(
  "x-mcp-wait-preview",
  "An ended crawl_wait carries counts and at most 20 first_urls, not the results",
  "first_urls: 1 to 20 URLs, one per kept URL up to 20; no results field",
  async () => {
    const found = ended?.crawl?.coverage?.items_found;
    if (!ended || !H.TERMINAL.has(ended.status) || !found)
      return { status: SKIP, actual: `nothing kept (${ended?.status ?? "no wait"})` };
    const urls = ended.first_urls ?? [];
    const ok =
      Array.isArray(ended.first_urls) &&
      urls.length === Math.min(found, 20) &&
      urls.every((u) => typeof u === "string") &&
      !("results" in ended);
    return {
      status: passIf(ok),
      actual: `${urls.length} first_urls of ${found} kept; results field ${"results" in ended ? "present" : "absent"}; note: ${ended.note ?? "none"}`,
    };
  },
);
await liveCheck(
  "6",
  "Get",
  "crawl_get limit 2 then the cursor: one page each; next_cursor moves on and is null on the last page",
  async () => {
    if (!ended) return { status: SKIP, actual: "no ended crawl" };
    const pages = [];
    let cursor;
    for (let i = 0; i < 20; i++) {
      const r = await call(S, "crawl_get", {
        crawl_id: A.crawl_id,
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      if (r.isError) return { status: FAIL, actual: show(r) };
      pages.push({
        n: r.data.results.length,
        next: r.data.next_cursor,
        urls: r.data.results.map((x) => x.url),
      });
      if (r.data.next_cursor === null) break;
      cursor = r.data.next_cursor;
    }
    const urls = pages.flatMap((p) => p.urls);
    const curs = pages.map((p) => p.next).filter((c) => c !== null);
    const ok =
      pages.every((p) => p.n <= 2) &&
      pages.at(-1).next === null &&
      new Set(curs).size === curs.length &&
      new Set(urls).size === urls.length &&
      (pages.length >= 2 || ended.crawl.coverage.items_found <= 2);
    return {
      status: passIf(ok),
      actual: `${pages.length} pages of ${pages.map((p) => p.n).join(",")}; last next_cursor ${pages.at(-1).next}`,
    };
  },
);
await liveCheck(
  "7",
  "List",
  "crawl_list limit 2 then the next page: newest first; next_cursor null on the last page",
  async () => {
    const p1 = await call(S, "crawl_list", { limit: 2 });
    const p2 = p1.data?.next_cursor
      ? await call(S, "crawl_list", { limit: 2, cursor: p1.data.next_cursor })
      : { data: { crawls: [] } };
    const all = [...(p1.data?.crawls ?? []), ...(p2.data?.crawls ?? [])];
    const t = all.map((c) => Date.parse(c.created_at));
    const newest = t.every((x, i) => i === 0 || t[i - 1] >= x);
    let cursor = p2.data?.next_cursor;
    let pages = 2;
    while (cursor && pages < 60) {
      cursor = (await call(S, "crawl_list", { limit: 100, cursor })).data?.next_cursor;
      pages++;
    }
    const ok =
      p1.data?.crawls?.length === 2 &&
      newest &&
      new Set(all.map((c) => c.crawl_id)).size === all.length &&
      !cursor;
    return {
      status: passIf(ok),
      actual: `newest first ${newest}; last page after ${pages} pages: next_cursor ${JSON.stringify(cursor ?? null)}`,
    };
  },
);
await liveCheck(
  "8",
  "Results",
  "every kept URL once, each matching CRAWL_INCLUDE; partial: true on a running crawl",
  async () => {
    if (!ended) return { status: SKIP, actual: "no ended crawl" };
    const r = await call(S, "crawl_results", { crawl_id: A.crawl_id });
    const urls = (r.data?.results ?? []).map((x) => x.url);
    const ok =
      !r.isError &&
      urls.length === ended.crawl.coverage.items_found &&
      new Set(urls).size === urls.length &&
      urls.every((u) => u.includes(INCLUDE)) &&
      r.data.partial === false;
    const run = partial
      ? `while running: ${partial.data?.status}, partial ${partial.data?.partial}, ${partial.data?.count} URLs`
      : "not read";
    const partialOk =
      !partial || partial.data?.status !== "running" || partial.data?.partial === true;
    return {
      status: passIf(ok && partialOk),
      actual: `${urls.length} URLs (items_found ${ended.crawl.coverage.items_found}), partial ${r.data?.partial}; ${run}`,
      evidence: urls.join("\n"),
    };
  },
);
// ---------- the html crawl (checks 20, 2, 9): stopped with pages in flight, read, then settled ----------
let stopInfo;
/** Poll until no result is still `pending` (the pages in flight finished), at most 90 s. */
async function settle(id) {
  for (let i = 0; i < 45; i++) {
    const g = await call(S, "crawl_get", { crawl_id: id, limit: 100 });
    if (!(g.data?.results ?? []).some((r) => r.content_status === "pending")) return "settled";
    await H.sleep(2000);
  }
  return "still pending after 90 s";
}
if (HAS_KEY) {
  const r = await create({ ...base, output_format: "html" });
  B = r.data;
  if (r.isError || !B?.crawl_id) stopInfo = { error: show(r) };
  else {
    // Stop as soon as the crawl has kept URLs: their pages are then still being fetched.
    let g;
    for (let i = 0; i < 100; i++) {
      g = await call(S, "crawl_get", { crawl_id: B.crawl_id, limit: 1 });
      if (g.data?.status !== "running" || g.data?.crawl?.coverage?.items_found > 0) break;
      await H.sleep(150);
    }
    const st = await call(S, "crawl_stop", { crawl_id: B.crawl_id });
    stopInfo = { items: g.data?.crawl?.coverage?.items_found, status: st.data?.status };
  }
}
await liveCheck(
  "20",
  "Results after stop",
  "crawl_results on a crawl stopped with pages in flight: no URL lost; partial follows next_cursor, and while it is set a note says to call again",
  async () => {
    if (!B || stopInfo?.error) return { status: FAIL, actual: `setup failed: ${stopInfo?.error}` };
    if (stopInfo.status !== "stopped") {
      return {
        status: SKIP,
        actual: `the crawl had already ended (${stopInfo.status}) before the stop`,
      };
    }
    const now = await call(S, "crawl_results", { crawl_id: B.crawl_id });
    const d = now.data ?? {};
    const settled = await settle(B.crawl_id);
    const settledNote =
      settled === "settled"
        ? settled
        : `${settled} (an API issue: the stop left these pages pending on an ended crawl)`;
    const later = (await call(S, "crawl_results", { crawl_id: B.crawl_id })).data?.results ?? [];
    const urls = (rows) => JSON.stringify((rows ?? []).map((x) => x.url).sort());
    const same = urls(d.results) === urls(later);
    const pending = (d.results ?? []).filter((x) => x.content_status === "pending").length;
    const ok = !now.isError && same && d.partial === (d.next_cursor != null) && (!d.partial || Boolean(d.note));
    return {
      status: passIf(ok),
      actual: `stopped with ${stopInfo.items} kept; first read: ${d.count} URLs (${pending} pending), partial ${d.partial}, next_cursor ${d.next_cursor === null ? "null" : "set"}, note: ${d.note ?? "none"}; then ${settledNote}: ${later.length} URLs, same set ${same}`,
      evidence: show(now),
    };
  },
);
await liveCheck(
  "2",
  "Create with html",
  "results get content_status and, once fetched, content_url",
  async () => {
    if (!B?.crawl_id) return { status: SKIP, actual: "no html crawl" };
    if (stopInfo?.status === "stopped") await settle(B.crawl_id);
    const rs = (await call(S, "crawl_results", { crawl_id: B.crawl_id })).data?.results ?? [];
    const ok =
      B.crawl?.output_format === "html" &&
      rs.length > 0 &&
      rs.every((x) => x.content_status && (x.content_status !== "fetched" || x.content_url));
    return {
      status: passIf(ok),
      actual: `${B.crawl_id} (${stopInfo?.status ?? "-"}); ${rs.length} results; with content_url ${rs.filter((x) => x.content_url).length}`,
    };
  },
);
let content;
await liveCheck(
  "9",
  "Content",
  "crawl_content by content id, then by content_url: the same HTML",
  async () => {
    if (!B) return { status: SKIP, actual: "no html crawl" };
    const firstFetched = async (id) =>
      ((await call(S, "crawl_results", { crawl_id: id })).data?.results ?? []).find(
        (x) => x.content_url,
      );
    // The stop in check 20 can land before any page is fetched. Then read a
    // one-item html crawl that runs to the end instead.
    let src = B.crawl_id;
    let row = await firstFetched(src);
    if (!row) {
      const own = await create({ ...base, max_items: 1, output_format: "html" });
      if (!own.data?.crawl_id) return { status: FAIL, actual: `create: ${H.trim(own.texts.join(" "), 300)}` };
      await waitEnd(own.data.crawl_id);
      src = own.data.crawl_id;
      row = await firstFetched(src);
    }
    if (!row) return { status: FAIL, actual: `no result with content_url on ${src}` };
    const a = await call(S, "crawl_content", {
      crawl_id: src,
      content_id: row.content_url.split("/").pop(),
    });
    const b = await call(S, "crawl_content", { crawl_id: src, content_id: row.content_url });
    content = a;
    const ok =
      !a.isError && !b.isError && a.texts[0] === b.texts[0] && /<html|<!doctype/i.test(a.texts[0]);
    return {
      status: passIf(ok),
      actual: `by id ${a.texts[0]?.length} chars, by content_url ${b.texts[0]?.length} chars, equal ${a.texts[0] === b.texts[0]}`,
    };
  },
);
await liveCheck(
  "x-mcp-content-cap",
  "A default crawl_content output is at most 20,000 characters",
  "the HTML text is at most 20,000 characters",
  async () => {
    if (!content) return { status: SKIP, actual: "no content read" };
    const html = content.texts[0] ?? "";
    return {
      status: passIf(html.length <= 20_000),
      actual: `HTML ${html.length} chars; note: ${content.texts[1] ?? "none"}`,
    };
  },
);
await liveCheck(
  "10",
  "Download",
  "crawl_download saves one line per result (url, content_status, content once fetched), keeps an existing file",
  async () => {
    if (!B) return { status: SKIP, actual: "no html crawl" };
    const path = `crawl-acceptance/${B.crawl_id}.jsonl`;
    const r = await call(S, "crawl_download", { crawl_id: B.crawl_id, path });
    if (r.isError || !r.data?.path) return { status: FAIL, actual: r.texts.join(" ").slice(0, 300) };
    const lines = readFileSync(r.data.path, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    const fetched = lines.filter((l) => l.content_status === "fetched");
    const again = await call(S, "crawl_download", { crawl_id: B.crawl_id, path });
    const ok =
      typeof r.data.status === "string" &&
      lines.length > 0 &&
      r.data.lines === lines.length &&
      lines.every((l) => l.url && l.content_status) &&
      fetched.every((l) => typeof l.content === "string" && l.content.length > 0) &&
      again.isError &&
      again.data?.code === "FILE_EXISTS";
    return {
      status: passIf(ok),
      actual: `status ${r.data.status}; ${lines.length} lines (reply says ${r.data.lines}); ${fetched.length} with content; content_status ${JSON.stringify(r.data.content_status ?? {})}; second call ${again.data?.code ?? "no error"}${r.data.note ? `; note: ${r.data.note}` : ""}`,
    };
  },
);

const errs = {};
await liveCheck("12", "Not found", "CRAWL_NOT_FOUND, with crawl_id and server_code", async () => {
  const r = await call(S, "crawl_get", { crawl_id: "c_does_not_exist" });
  errs.notFound = r.data;
  const ok =
    r.isError &&
    r.data?.code === "CRAWL_NOT_FOUND" &&
    r.data?.crawl_id === "c_does_not_exist" &&
    r.data?.server_code === "crawl_not_found";
  return { status: passIf(ok), actual: show(r) };
});
await liveCheck(
  "13",
  "Invalid input",
  "crawl_create with depth 0 → CRAWL_INVALID_REQUEST",
  async () => {
    const r = await call(S, "crawl_create", { ...base, depth: 0 });
    if (!r.isError && r.data?.crawl_id) {
      ledger(r.data.crawl_id, "depth 0 (unexpected create)");
      await call(S, "crawl_stop", { crawl_id: r.data.crawl_id });
    }
    errs.invalid = r.data;
    const ok = r.isError && r.data?.code === "CRAWL_INVALID_REQUEST";
    return {
      status: passIf(ok),
      actual: ok ? show(r) : `rejected before the API: ${H.trim(r.texts.join(" "), 400)}`,
    };
  },
);
await liveCheck("14", "Gated option", "output_format json is refused: by the input schema, or by the API with 422 invalid_parameter", async () => {
  const r = await call(S, "crawl_create", { ...base, output_format: "json" });
  if (!r.isError && r.data?.crawl_id) {
    ledger(r.data.crawl_id, "output_format json (accepted)");
    await call(S, "crawl_stop", { crawl_id: r.data.crawl_id });
    return {
      status: PASS,
      actual: `accepted (${r.data.crawl_id}): the key is in a beta segment, not a bug; stopped it`,
    };
  }
  // Refusing a gated value before it reaches the API is the behavior we want.
  const text = r.texts.join(" ");
  const bySchema = r.isError && /-32602|input validation/i.test(text);
  const byApi = r.data?.code === "CRAWL_INVALID_REQUEST";
  return {
    status: passIf(bySchema || byApi),
    actual: bySchema
      ? `refused before the API: the input schema takes "html" or "markdown" (${H.trim(text, 200)})`
      : H.trim(show(r), 300),
  };
});
await liveCheck(
  "22",
  "Markdown output",
  'crawl_create with output_format "markdown" is accepted and echoed back',
  async () => {
    const r = await call(S, "crawl_create", { ...base, max_items: 1, max_pages: 1, output_format: "markdown" });
    if (r.isError || !r.data?.crawl_id) {
      return { status: FAIL, actual: H.trim(show(r), 400) };
    }
    ledger(r.data.crawl_id, "output_format markdown");
    await call(S, "crawl_stop", { crawl_id: r.data.crawl_id });
    return {
      status: passIf(r.data.crawl?.output_format === "markdown"),
      actual: `${r.data.crawl_id}: output_format ${r.data.crawl?.output_format}`,
    };
  },
);
await liveCheck(
  "23",
  "Discovery",
  'crawl_create with discovery ["links"] is echoed back; a create without it reads ["links"]; pagination is refused before the API',
  async () => {
    const given = await create({ ...base, max_items: 1, max_pages: 1, discovery: ["links"] });
    const leftOut = await create({ ...base, max_items: 1, max_pages: 1 });
    for (const c of [given, leftOut]) {
      if (c?.data?.crawl_id) await call(S, "crawl_stop", { crawl_id: c.data.crawl_id });
    }
    const refused = await call(S, "crawl_create", { ...base, discovery: ["pagination"] });
    if (!refused.isError && refused.data?.crawl_id) {
      ledger(refused.data.crawl_id, "discovery pagination (accepted)");
      await call(S, "crawl_stop", { crawl_id: refused.data.crawl_id });
    }
    const one = JSON.stringify(["links"]);
    const asked = given?.data?.crawl?.discovery;
    const omitted = leftOut?.data?.crawl?.discovery;
    const ok = JSON.stringify(asked) === one && JSON.stringify(omitted) === one && refused.isError;
    return {
      status: passIf(ok),
      actual: JSON.stringify({ given: asked, leftOut: omitted, paginationRefused: refused.isError }),
    };
  },
);
await liveCheck(
  "24",
  "Webhook",
  "crawl_create with a webhook returns the crawl with that webhook: its url, the events asked for and the metadata",
  async () => {
    const webhook = {
      url: "https://example.com/zenrows-hook",
      events: ["crawl.completed"],
      metadata: { k: "v" },
    };
    const r = await create({ url: CRAWL_URL, depth: 1, max_items: 1, max_pages: 1, webhook });
    if (r.isError || !r.data?.crawl_id) return { status: FAIL, actual: H.trim(show(r), 400) };
    await call(S, "crawl_stop", { crawl_id: r.data.crawl_id });
    const got = r.data.crawl?.webhook;
    return {
      status: passIf(JSON.stringify(got) === JSON.stringify(webhook)),
      actual: `${r.data.crawl_id}: webhook ${JSON.stringify(got ?? null)}`,
      evidence: show(r),
    };
  },
);
await check("15", "Bad key", "AUTH_INVALID", async () => {
  const bad = await startServer("invalid");
  const r = await call(bad.client, "crawl_get", { crawl_id: "c_does_not_exist" });
  await bad.close();
  errs.badKey = r.data;
  return { status: passIf(r.isError && r.data?.code === "AUTH_INVALID"), actual: show(r) };
});
await check(
  "16",
  "Errors carry the server code",
  "server_code on CRAWL_NOT_FOUND, CRAWL_INVALID_REQUEST and AUTH_INVALID",
  async () => {
    // Only an error that came from the API can carry its code; a call rejected before the API is judged in 13.
    const rows = {
      notFound: errs.notFound?.server_code,
      invalid: errs.invalid?.code
        ? errs.invalid.server_code
        : "n/a: rejected before the API (see 13)",
      badKey: errs.badKey?.server_code,
    };
    const liveOk =
      !HAS_KEY ||
      (rows.notFound === "crawl_not_found" &&
        (!errs.invalid?.code || rows.invalid === "invalid_parameter"));
    const ok = liveOk && Boolean(rows.badKey);
    return { status: ok ? (HAS_KEY ? PASS : SKIP) : FAIL, actual: JSON.stringify(rows) };
  },
);

// ---------- 19-21: a crawl that matches nothing, results after a stop, the documented defaults ----------
await liveCheck(
  "19",
  "No match",
  "a crawl whose pattern matches nothing ends completed with 0 results and no error; crawl_wait says ok: true",
  async () => {
    const r = await create({ url: CRAWL_URL, depth: 1, include_patterns: [H.NO_MATCH] });
    F = r.data;
    if (r.isError) return { status: FAIL, actual: show(r) };
    const w = await waitEnd(F.crawl_id);
    const d = w.data ?? {};
    const empty =
      d.status === "completed" &&
      d.crawl?.coverage?.items_found === 0 &&
      d.crawl?.error === undefined &&
      d.error === undefined;
    const ok = empty && d.ok === true && d.crawl_id === F.crawl_id;
    return {
      status: passIf(ok),
      actual: `${F.crawl_id}: status ${d.status}, ok ${d.ok}, items ${d.crawl?.coverage?.items_found}, error ${JSON.stringify(d.crawl?.error ?? d.error ?? null)}`,
      evidence: show(w),
    };
  },
);
await liveCheck(
  "21",
  "Documented defaults",
  `a create without max_pages and max_items echoes the documented default (${H.DOCUMENTED_DEFAULT})`,
  async () => {
    if (!F?.crawl) return { status: SKIP, actual: "no crawl from check 19" };
    const ok =
      F.crawl.max_pages === H.DOCUMENTED_DEFAULT && F.crawl.max_items === H.DOCUMENTED_DEFAULT;
    const create = tools.find((t) => t.name === "crawl_create");
    const doc = JSON.stringify(create?.inputSchema?.properties?.max_pages?.description ?? "");
    return {
      status: passIf(ok),
      actual: `the API applied max_pages ${F.crawl.max_pages}, max_items ${F.crawl.max_items}; documented ${H.DOCUMENTED_DEFAULT}`,
      evidence: `crawl_create max_pages description: ${doc}`,
    };
  },
);

H.naming({
  operations: {
    create: "crawl_create",
    get: "crawl_get",
    list: "crawl_list",
    results: "crawl_results",
    content: "crawl_content",
    download: "crawl_download",
    stop: "crawl_stop",
    wait: "crawl_wait",
  },
  params: Object.fromEntries(
    [
      "url",
      "depth",
      "max_items",
      "max_pages",
      "include_patterns",
      "exclude_patterns",
      "output_format",
      "discovery",
      "webhook",
      "idempotency_key",
      "cursor",
      "limit",
      "timeout",
      "content_id",
    ].map((k) => [k, k]),
  ),
});
record("17", "Naming", SKIP, "the API's names in this surface's casing", "computed by the report");

await check(
  "18",
  "Copy",
  'Crawl is "new", never "beta"; one "still evolving" line; the 429 limit is active jobs shared with Batch',
  async () => {
    const row = pkgReadme.split("\n").filter((l) => l.includes("crawl_create"));
    const descriptions = tools
      .filter((t) => t.name.startsWith("crawl"))
      .map((t) => `${t.name}: ${t.description}`)
      .join("\n");
    const problems = [];
    const beta = [...row, ...descriptions.split("\n")].filter((l) => /\bbeta\b/i.test(l));
    if (beta.length) problems.push(`"beta": ${beta[0].slice(0, 160)}`);
    const evolving = pkgReadme.split("\n").filter((l) => /still evolving/i.test(l)).length;
    if (evolving !== 1) problems.push(`${evolving} "still evolving" lines in the README (want 1)`);
    if (!row.some((l) => /\bNew\b/.test(l))) problems.push('the Crawl row does not say "new"');
    if (!/active jobs[^.]*Batch/i.test(descriptions))
      problems.push("no tool description reads the 429 limit as active jobs shared with Batch");
    return {
      status: passIf(problems.length === 0),
      actual:
        problems.join("; ") ||
        'README row says "New", 1 "still evolving" line; crawl_create names the limit shared with Batch',
      evidence: `${row.join("\n")}\n---\n${descriptions}`,
    };
  },
);
await srv.close();
console.log("mcp: done");
process.exit(0);
