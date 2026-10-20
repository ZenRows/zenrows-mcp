<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/zenrows_light.svg">
    <img src="assets/zenrows_dark.svg" alt="Zenrows MCP" width="380">
  </picture>
</p>

# Zenrows MCP Server

The Zenrows MCP (Model Context Protocol) server is the standard way AI systems use Zenrows' web data infrastructure. A single connection gives your AI assistant, agent, or application reliable, real-time access to the live web, including the protected web.

[![npm version](https://img.shields.io/npm/v/@zenrows/mcp)](https://www.npmjs.com/package/@zenrows/mcp)
[![MIT License](https://img.shields.io/badge/license-MIT-blue)](https://github.com/ZenRows/zenrows-mcp/blob/main/LICENSE)

📚 **Full documentation:** [docs.zenrows.com/mcp/overview](https://docs.zenrows.com/mcp/overview)

---

## Why Zenrows MCP

- **Reach sites that normally block bots.** Get reliable access to protected sites at scale, without building anti-bot handling yourself.
- **Managed web data infrastructure.** Proxy rotation, headless browser orchestration, anti-bot handling, and session management run on Zenrows' infrastructure.
- **Plug into any AI you already use.** Works with any MCP client, including AI assistants, agent frameworks, AI SDKs, IDE plugins, and custom applications.
- **Plain English, no scraping code.** Describe the task naturally and the AI picks the right tool. No selectors, no proxy management, no anti-bot tuning.

---

## Quick start

Zenrows MCP supports two transport options. Both expose the same set of tools and capabilities. Pick the one that fits your client.

**What works without a key:**

- **Local (`npx @zenrows/mcp`):** no signup, no key. The first tool call creates a Free account (5,000 credits/month) that you can claim later, keeping the key and its usage. Opt out with `ZENROWS_AUTO_SIGNUP=false`. In CI, set `ZENROWS_API_KEY` as a secret or persist `ZENROWS_HOME` between runs.
- **Remote (`https://mcp.zenrows.com/mcp`):** `initialize` and `tools/list` answer without a key; tool calls need one (OAuth in clients that support it, or a Bearer key). The remote server never creates accounts by itself. A headless agent can create a Free account with `POST https://app.zenrows.com/api/agent/signup` and use the returned `apiKey` as the Bearer token.

### Remote MCP server

Use the hosted Zenrows MCP server when your AI application calls an LLM API directly. The server runs on Zenrows' infrastructure, so there is nothing to install, configure, or update.

**Server URL:**

```
https://mcp.zenrows.com/mcp
```

**Transport:** Streamable HTTP

**Authentication:** OAuth or API key as Bearer token. Pass your Zenrows API key in the `Authorization` header on every request (or complete OAuth in clients that support it).

```
Authorization: Bearer YOUR_ZENROWS_API_KEY
```

Most MCP clients accept this through an `authorization` shorthand field on the tool config and forward it as the Bearer token automatically. Some clients use a free-form `headers` field instead. Either approach works.

> Remote MCP does **not** auto-create accounts. `initialize` and `tools/list` work without a key; a keyless tool call gets a 401 whose body names the signup endpoint (`agent_signup`). Use OAuth “Create Free account” in the client, pass an existing API key, or, from a headless agent, `POST https://app.zenrows.com/api/agent/signup` (anonymous, returns `apiKey`; per-network limits apply) and retry with `Authorization: Bearer <apiKey>`.

#### Example: OpenAI Responses API

```python
import os
from openai import OpenAI

ZENROWS_API_KEY = os.environ["ZENROWS_API_KEY"]
client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])

response = client.responses.create(
    model="gpt-5",
    tools=[
        {
            "type": "mcp",
            "server_label": "zenrows",
            "server_description": "Web scraping MCP server for accessing live web content.",
            "server_url": "https://mcp.zenrows.com/mcp",
            "authorization": ZENROWS_API_KEY,
            "require_approval": "never",
        }
    ],
    input="Visit https://news.ycombinator.com/ and summarize the three most recent posts.",
)

print(response.output_text)
```

For the full walkthrough with framework-specific examples, see the [Remote MCP server docs](https://docs.zenrows.com/mcp/overview#remote-mcp-server).

### Local MCP server

Use the local stdio configuration when your MCP client runs the server as a local subprocess instead of calling a remote URL. This is the standard setup for desktop AI tools and IDE plugins, including Claude Desktop, Claude Code, Cursor, Windsurf, VS Code, Zed, and JetBrains IDEs.

**Package:** [`@zenrows/mcp`](https://www.npmjs.com/package/@zenrows/mcp) on npm

**Authentication:**

1. `ZENROWS_API_KEY` environment variable, or
2. Key previously stored in `~/.zenrows/secrets.json`, or
3. **Auto-signup** (default): if neither is set, the server still starts, and the first tool call provisions a Free plan account via `POST /api/agent/signup`, persists the key + claim metadata under `~/.zenrows/` (`secrets.json` + `account.json`, mode `0600`), and prints a claim URL on stderr. If signup is refused (for example the per-network cap in CI), that tool call returns an error saying when to retry; in CI, set `ZENROWS_API_KEY` as a secret or persist `ZENROWS_HOME` between runs. Opt out with `ZENROWS_AUTO_SIGNUP=false`: tool calls then return an error until a key is set. The signup request also sends a random per-machine id (shared with the Zenrows CLI) and a guess at the host agent (`claude-code`, `cursor`, …) so signups can be attributed; set `ZENROWS_TELEMETRY=off` to omit both.

**Requirements:** [Node.js](https://nodejs.org/) installed (for `npx` to work).

**Configuration (with your own key):**

```json
{
  "mcpServers": {
    "zenrows": {
      "command": "npx",
      "args": ["-y", "@zenrows/mcp"],
      "env": {
        "ZENROWS_API_KEY": "YOUR_ZENROWS_API_KEY"
      }
    }
  }
}
```

**Zero-config (auto-signup):**

```json
{
  "mcpServers": {
    "zenrows": {
      "command": "npx",
      "args": ["-y", "@zenrows/mcp"]
    }
  }
}
```

**Optional:** `ZENROWS_CRAWL_API_BASE` sets the Crawl API base URL for the `crawl_*` tools (default `https://api.zenrows.com/v1`). Set it only to point those tools at another deployment.

**Optional:** `ZENROWS_BATCH_API_BASE` sets the Batch API base URL for the `batch_*` tools (default `https://async.api.zenrows.com/v1`). Set it only to point those tools at another deployment.

The exact location of this config varies by client. See the [per-client setup guides](https://docs.zenrows.com/mcp/overview#per-client-setup-guides) for the file path for your client.

---

## Tools

The Zenrows MCP exposes these tool families:

| Tool | Purpose |
|------|---------|
| **`scrape`** | Full-page content → Markdown, plain text, HTML, PDF, or screenshot (plus helper outputs). |
| **`extract`** | Structured JSON (`extract=auto` or `css_extractor`; `autoparse` is deprecated) + optional stealth flags. `extract=auto` is currently free (billing may apply later) and works on any prepared domain, with any API key. Returns `parsed` fields only; set `include_html: true` to also get the page HTML. Error `REQS007` says why in `reason`: `domain_not_prepared` → call `prepare_domain` (the error carries its arguments); `page_not_recognised` → the domain is prepared, but this page is not one Extract extracts (a page with nothing to extract, such as a home page): try a product, article or listing page instead, retry it once in a few minutes if it should work, otherwise use `css_extractor`, and do not prepare again; `domain_not_enabled` → preparing does not help, use `css_extractor`. The error never offers autoparse, and the tool never falls back to it: `fallback_autoparse` is deprecated and has no effect (when it is `true`, the result carries a `note` saying it was ignored). |
| **`prepare_domain` / `prepared_domain_status`** | Prepare a domain for `extract` (mode=auto) after a `REQS007` with reason `domain_not_prepared`. `prepare_domain` takes the domain and 1 to 5 example URLs (one per page kind you want), returns at once with `status: "preparing"` (it never waits), and costs no credits. Preparation takes a few minutes: poll `prepared_domain_status` about every 30 seconds (status, current step, failure code, the account's monthly allowance `used` / `limit` / `remaining`, and `next`, the step to take now) until `status` is `ready`, then call `extract` again. Each new domain uses one allowance slot; a domain that is already prepared answers `ready` at once with `already_prepared: true` and uses none. The domain is the host: `shop.example.com` and `example.com` are prepared separately, and a leading `www.` is dropped. |
| **`batch_create` / `batch_status` / `batch_wait` / `batch_results` / `batch_content` / `batch_list` / `batch_cancel` / `batch_pause` / `batch_resume` / `batch_rerun` / `batch_delete`** | Cloud Batch API fan-out (`async.api.zenrows.com`). Same credits as Fetch. Not `browser_batch`. See [Batch tools](#batch-tools) below. |
| **`crawl_create` / `crawl_get` / `crawl_results` / `crawl_content` / `crawl_download` / `crawl_list` / `crawl_stop` / `crawl_wait`** | Crawl API (`api.zenrows.com/v1/crawls`). New. Crawl is still evolving: new features are coming, limits may be tuned, and the changelog announces each change. Give one start URL, get back the URLs behind it on the same registrable domain (subdomains count), optionally with each page's HTML (`output_format: "html"`). `crawl_create` returns at once; call `crawl_wait` (counts and the first 20 URLs), then `crawl_download` to save every result to a local JSON-lines file (default `~/.zenrows/crawls/<crawl_id>.jsonl`; a `path` must stay inside `~/.zenrows/crawls`; an existing file is kept unless `overwrite: true`; the hosted server writes no file and returns the download URL and a `curl` command instead), or `crawl_results` to page through them. Leave `depth` out of `crawl_create` for no depth limit: the crawl follows links until `max_pages` or `max_items` (default 100 each) stops it, and each page fetched is billed as one scrape. Set `idempotency_key` on `crawl_create` to make a retry safe. `crawl_content` takes `crawl_id` and `content_id` (a content id or a result's `content_url`). Reads retry on 429, 502, 503, 504 and network errors (up to 3 times, honoring `Retry-After` up to 30 seconds); `crawl_create` retries only with an `idempotency_key`, and never on 429; `crawl_stop` retries on 429, 502, 503 and 504 (repeating a stop is safe; a 503 `crawl_busy` means the stop was not saved yet), up to 3 times and 50 seconds at most in all, and returns `CRAWL_BUSY` if a `crawl_busy` persists. May return `CRAWL_NOT_ENABLED` (Crawl is not enabled for this account). |
| **`browser_*`** | 30+ tools for full browser automation (navigation, clicks, forms, JS, cookies, tabs, sessions). |

### Batch tools

A Batch job scrapes many URLs asynchronously. The usual flow: `batch_create`, then `batch_wait` until the run ends, `batch_results` to page through the rows, and `batch_content` to read one task's page.

- **`batch_create`** submits one closed job with all its tasks, up to 100,000 per call. Each task takes a `url` (http or https, up to 2,048 characters), plus optional `external_id` (up to 128 characters of letters, digits, `.`, `_` and `-`; need not be unique), `metadata` (up to 20 string-to-string entries, 4 KiB in all), `method` and `body` for POST tasks (body up to 16 KiB; POST is for read-only queries, since the target can receive a POST more than once), and scrape params, in `zenrows_params` or flat on the task. An unknown task field fails the call by name, before anything is sent. `response_type` takes `markdown`, `plaintext` or `pdf`; leave it out for HTML. Tasks use `mode=auto` unless you force `js_render` or `premium_proxy`. Every call sends an `Idempotency-Key`, generated unless you set `idempotency_key`: a repeat with the same key and body within 24 hours returns the original job instead of a second one, and a different body is `BATCH_IDEMPOTENCY_CONFLICT`. An error reply carries the key to retry with. Set `wait: true` to return when the run ends or pauses, or when `wait_timeout` (seconds, default 50) passes.
- **`batch_status`** and **`batch_wait`** report the latest run's `status` (`pending`, `running`, `completed`, `stopped`, `failed`) and `stats`. `batch_wait` polls until the run ends, returns at once with `paused: true` on a paused run, and tolerates transient errors. Its `timeout` is in seconds (default 50, under the 60 seconds after which many clients cancel a call); when it runs out, the reply is the current state with `ok: true`, `timed_out: true` and a note, not an error. A call with a `progressToken` gets a progress notification after each poll. A run still writing its tasks (submits of 10,000 or more, and every rerun) has `ingesting: true`.
- **`batch_results`** returns up to `limit` rows (default 100, max 1,000) and a `next_cursor`; pass it back as `cursor` until it is `null`. Filter with `status`: `all`, `successful`, `failed` or `processing`. Pass `run_id` for an earlier run. A row's `result_url` is presigned for 2 hours: list again, or use `batch_content`, for a fresh one. Results are kept 14 days by default; after that a successful row reads as `expired`, with no `result_url`.
- **`batch_content`** returns one task's result. Text (HTML, Markdown, plain text, JSON) comes back inline, cut to `max_chars` (default 20,000); a PDF comes back as its presigned `result_url`; on a large run, finding it can take more than one call, and the reply then carries `lookup_cursor` to pass back. A task not finished yet is `BATCH_TASK_NOT_READY`, a failed one `BATCH_TASK_FAILED` (with `task_error`), an expired one `BATCH_RESULT_EXPIRED`.
- **`batch_list`** lists the account's jobs, newest first (default 20 per page, max 100).
- **`batch_cancel`** stops the current run for good: no waiting task starts, in-flight tasks finish and bill, results stay. **`batch_pause`** halts it until **`batch_resume`**; a paused run still counts as an active job. All three are idempotent, and on a run that already ended they answer with its final state and `already_ended: true`.
- **`batch_rerun`** starts a new run once the latest one ended. By default it reruns the `failed` and `pending` tasks and carries the others over: the recovery after a run that ran out of credits or was cancelled. Pass `status` for other task statuses, or `full: true` to scrape every task again. A partial rerun works up to 10 days after the run started. It sends an `Idempotency-Key`.
- **`batch_delete`** deletes a job with its runs and results, and frees its active-job slot.

Costs: the same credits as the regular API, per successful task: 1 basic, 5 with `js_render`, 10 with `premium_proxy`, 25 with both; `mode=auto` bills each task at the configuration that worked. Failed tasks are not billed, except target 404 and 410 answers. An account runs 3 active jobs at once by default, shared with Crawl.

A run that ends `failed` answers `ok: false`, with `error.code` the same as the matching HTTP error (`BATCH_INSUFFICIENT_CREDITS`, `BATCH_KEY_CAP_REACHED`, or `AUTH_INVALID` for an inactive subscription; `BATCH_RUN_FAILED` otherwise), `error.server_code` (the `failure_reason`), `error.job_id` and advice. Fix the cause, then `batch_rerun`.

Errors carry `code`, `message`, `detail`, `server_code` (the Batch API's own code) and, for a call about one job, `job_id`:

| Code | When |
|------|------|
| `BATCH_INVALID_REQUEST` | 400: the request was rejected; `invalid_tasks` lists the first bad tasks. Nothing was created. |
| `AUTH_INVALID` | 401: the API key was rejected, or, with `server_code` `subscription_inactive`, the key is valid but the subscription needs fixing in Billing. |
| `BATCH_INSUFFICIENT_CREDITS` | 402: the account has no credits left. |
| `BATCH_KEY_CAP_REACHED` | 402: this API key reached one of its credit caps; the account's other keys still work. |
| `BATCH_ACCESS_DENIED` | 403: Batch is not enabled for this account or key. Do not retry. |
| `BATCH_NOT_FOUND` | 404: no such job, run or task for this account (a deleted job included). |
| `BATCH_RUN_ENDED`, `BATCH_RUN_NOT_FINISHED`, `BATCH_NO_MATCHING_TASKS`, `BATCH_RERUN_WINDOW_EXPIRED`, `BATCH_NO_PRIOR_RUN`, `BATCH_IDEMPOTENCY_CONFLICT`, `BATCH_TASK_NOT_READY`, `BATCH_CONFLICT` | 409, by `server_code`. |
| `BATCH_RESULT_EXPIRED` | 410: past the job's retention. |
| `BATCH_TASK_FAILED` | 422: the task failed; `task_error` holds its error. |
| `BATCH_QUOTA_EXCEEDED` | 429: a job limit more credits do not raise (3 active jobs, shared with Crawl; 5 scheduled jobs). |
| `BATCH_RATE_LIMITED` | Any other 429. |
| `BATCH_FAILED` | Any other HTTP error. |
| `BACKEND_UNAVAILABLE` | No response: a network error or timeout, after retries. |

Reads retry on 429, 500, 502, 503, 504 and network errors, up to 3 times, honoring `Retry-After` up to 30 seconds. `batch_create` and `batch_rerun` retry on 500, 502, 503, 504, network errors and a 429 with `Retry-After`, always with the same `Idempotency-Key`; never on the job-limit 429. On `BATCH_IDEMPOTENCY_CONFLICT` for the same request, keep the key, check `batch_list` and retry later: a new key can create a second, billed job.

Schedules, webhooks, results exports, CSV inputs, open jobs (adding tasks over time), runs and task history are available through the [Batch API](https://docs.zenrows.com/batch/introduction) and the Zenrows SDKs only.

The AI selects the right tool from your prompt. You don't call tools directly in code.

See the [full tool reference](https://docs.zenrows.com/mcp/overview#tools) for every tool, parameter, and return value.

---

## Development

```bash
git clone https://github.com/ZenRows/zenrows-mcp
cd zenrows-mcp
npm install
cp .env.example .env   # Optional: add your API key (stdio can auto-signup)
npm run dev            # Run with .env loaded (requires Node.js 20.6+)
npm run build          # Compile to dist/
npm run inspect        # Open the MCP inspector UI
```

### Running the Crawl end-to-end test

`npm test` stays offline. `npm run test:e2e` drives the `crawl_*` tools through a real MCP client against a live Crawl API: it creates a small crawl (depth 1, at most 3 URLs and 5 pages) of the start URL you give it, waits for it, reads its results and one page, lists crawls, stops the ended crawl, and checks the not-found error. It is skipped unless the first three variables are set:

- `ZENROWS_API_KEY`: a key with Crawl access.
- `ZENROWS_CRAWL_API_BASE`: the Crawl API base, e.g. `https://api.zenrows.com/v1`. Point it at a local or staging deployment to test against that instead.
- `ZENROWS_E2E_CRAWL_URL`: the start URL to crawl, a listing page whose links lead to item pages.
- `ZENROWS_E2E_CRAWL_INCLUDE` (optional): an include pattern; when set, the test checks that every result URL contains it.

```bash
export ZENROWS_API_KEY=...            # a key with Crawl access
export ZENROWS_CRAWL_API_BASE=https://api.zenrows.com/v1
export ZENROWS_E2E_CRAWL_URL=https://example.com/products/
export ZENROWS_E2E_CRAWL_INCLUDE=/product/
npm run test:e2e
```

The crawl is billed to the key's account (at most 5 page fetches), and it counts against the account's limit of active jobs (3 by default), shared with its Batch jobs. When the account has reached that limit, the test waits and retries for up to 5 minutes.

### Releases

Merge PRs with Conventional Commit titles, for example `fix(extract): ...` or
`feat(crawl): ...`. `fix`, `feat` and `perf` need a scope.

After each merge to `main`, release-please opens or updates the PR
`chore: release X.Y.Z`. It sets the version in `package.json`,
`package-lock.json` and `server.json`. Do not change these by hand.

To release, merge that PR. The Release workflow runs the checks, creates the
tag `vX.Y.Z` and the GitHub release, and starts the Publish workflow. That
workflow publishes to npm and the MCP Registry, pushes the GHCR image and
deploys the hosted server.

To publish an existing tag again, run the Release workflow by hand from
`main` with that tag.

#### If the checks fail after the release PR is merged

The release PR runs CI like any other PR. After you merge it, the release
run checks the code again before it tags and publishes. If that check
fails, `main` already has the new version, but there is no tag, and the
merged release PR keeps the `autorelease: pending` label, which blocks the
next release PR. To recover:

1. Fix the problem in a normal PR and merge it.
2. Create the release on that fix commit, with the version from
   `.release-please-manifest.json`:
   `gh release create vX.Y.Z --target <fix commit> --title vX.Y.Z --generate-notes --notes-start-tag <previous tag>`
3. On the merged release PR, replace the label `autorelease: pending` with
   `autorelease: tagged`.
4. Run the Release workflow by hand from `main` with the tag `vX.Y.Z`.

Pull requests and issues are welcome.

---

## Resources

- [Full Zenrows MCP documentation](https://docs.zenrows.com/mcp/overview)
- [Zenrows Fetch](https://docs.zenrows.com/fetch/api-reference)
- [Zenrows Browser Sessions](https://docs.zenrows.com/browser-sessions/introduction)
- [npm package](https://www.npmjs.com/package/@zenrows/mcp)
- [Get your API key](https://app.zenrows.com/register)

---

## License

[MIT](LICENSE)
