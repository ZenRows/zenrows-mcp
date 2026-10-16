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

> Remote MCP does **not** auto-create accounts. Use OAuth “Create Free account” in the client, or pass an existing API key.

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
3. **Auto-signup** (default): if neither is set, stdio provisions a Free plan account via `POST /api/agent/signup`, persists the key + claim metadata under `~/.zenrows/` (`secrets.json` + `account.json`, mode `0600`), and prints a claim URL on stderr. Opt out with `ZENROWS_AUTO_SIGNUP=false`.

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

The exact location of this config varies by client. See the [per-client setup guides](https://docs.zenrows.com/mcp/overview#per-client-setup-guides) for the file path for your client.

---

## Tools

The Zenrows MCP exposes these tool families:

| Tool | Purpose |
|------|---------|
| **`scrape`** | Full-page content → Markdown, plain text, HTML, PDF, or screenshot (plus helper outputs). |
| **`extract`** | Structured JSON (`extract=auto`, autoparse, or `css_extractor`) + optional stealth flags. `extract=auto` is currently free (billing may apply later) and works on any domain Zenrows has prepared, with any API key; on a domain not prepared yet (`REQS007`) it falls back to autoparse. |
| **`batch_create` / `batch_status` / `batch_results` / `batch_cancel` / `batch_wait`** | Cloud Batch API fan-out (`async.api.zenrows.com`). Same credits as Fetch. Not `browser_batch`. See [Batch tools](#batch-tools) below. |
| **`crawl_create` / `crawl_get` / `crawl_results` / `crawl_content` / `crawl_download` / `crawl_list` / `crawl_stop` / `crawl_wait`** | Crawl API (`api.zenrows.com/v1/crawls`). New. Crawl is still evolving: new features are coming, limits may be tuned, and the changelog announces each change. Give one start URL, get back the URLs behind it on the same registrable domain (subdomains count), optionally with each page's HTML (`output_format: "html"`). `crawl_create` returns at once; call `crawl_wait` (counts and the first 20 URLs), then `crawl_download` to save every result to a local JSON-lines file (default `~/.zenrows/crawls/<crawl_id>.jsonl`; a `path` must stay inside `~/.zenrows/crawls`; an existing file is kept unless `overwrite: true`; the hosted server writes no file and returns the download URL and a `curl` command instead), or `crawl_results` to page through them. Leave `depth` out of `crawl_create` for no depth limit: the crawl follows links until `max_pages` or `max_items` (default 100 each) stops it, and each page fetched is billed as one scrape. Set `idempotency_key` on `crawl_create` to make a retry safe. `crawl_content` takes `crawl_id` and `content_id` (a content id or a result's `content_url`). Reads retry on 429, 502, 503, 504 and network errors (up to 3 times, honoring `Retry-After` up to 30 seconds); `crawl_create` retries only with an `idempotency_key`, and never on 429; `crawl_stop` retries on 429, 502, 503 and 504 (repeating a stop is safe; a 503 `crawl_busy` means the stop was not saved yet), up to 3 times and 50 seconds at most in all, and returns `CRAWL_BUSY` if a `crawl_busy` persists. May return `CRAWL_NOT_ENABLED` (Crawl is not enabled for this account). |
| **`browser_*`** | 30+ tools for full browser automation (navigation, clicks, forms, JS, cookies, tabs, sessions). |

### Batch tools

- **`batch_create`** submits one closed job with all its tasks (up to 100,000 URLs). Each task takes a `url`, plus optional `external_id`, `metadata` (a string-to-string map) and scrape params, either in `zenrows_params` or flat on the task. An unknown task field is not sent, as before, and is now named in the reply's `warnings`. Every call sends an `Idempotency-Key`, generated unless you set `idempotency_key`. A repeat with the same key and the same body, once the first call has finished, returns the original response instead of creating a second job; a different body, or a repeat while the first call is still being processed, fails with `server_code` `idempotency_key_conflict` (409). Keys are kept 24 hours. Set `wait: true` to return when the run ends or pauses (`paused: true`), or when `wait_timeout_ms` passes.
- **`batch_status`** and **`batch_wait`** report the latest run's `status` and `stats`. `batch_wait` returns when the run is completed, failed, stopped or deleted, and returns early with `paused: true` when the run is paused (a paused run picks up no new tasks, though tasks already in flight can still finish). Deleting the job ends the wait with `BATCH_NOT_FOUND`; deleting the job's only run returns the job at once with `status: null`. Polls honor the API's `Retry-After`, and when it points past the timeout, no further poll is made.
- **`batch_results`** returns every row when called with neither `limit` nor `cursor`. To page, pass `limit` and/or `cursor`: it returns whole pages of about 1,000 rows until at least `limit` rows (default 1000 when paging), with `next_cursor` to continue; a call can overshoot `limit` by up to one page. Filter by `status`: `all`, `successful`, `failed` or `processing`. A `result_url` expires after 2 hours. A successful task's body is kept 14 days by default, counted from when the result was stored (the row's `updated_at`; a partial rerun re-stamps the rows it copies), after which the row's status is `expired` and it has no `result_url`; failed rows keep their error.
- **`batch_cancel`** stops the current run and returns its status and stats. Tasks that had not started stay pending. Cancelling a run that is already stopped returns it unchanged; a run that completed or failed cannot be stopped (`server_code` `run_not_stoppable`).

A run that ends as `failed` comes back with `ok: false` (it used to say `ok: true`), alongside the same `job_id`, `status`, `stats` and `job` as before, plus its `failure_reason` (`insufficient_credits`, `subscription_inactive` or `api_key_cap_reached`), `failure_detail`, and what to do next.

Errors carry a `code`. `reason` says which case a shared code stands for, and `server_code` holds the Batch API's own code when it sent one. HTTP errors map as follows; a request that never got a response (a network error or timeout, after retries) is `BACKEND_UNAVAILABLE`:

| Code | When |
|------|------|
| `BATCH_QUOTA_EXCEEDED` | 402 with `reason` `insufficient_credits`: the account has no credit for the request. 429 with `reason` `too_many_jobs`: the account reached a job limit (3 active jobs or 5 scheduled jobs by default), which more credits do not raise. |
| `BATCH_KEY_CAP_REACHED` | 402 (`reason` `api_key_cap_reached`): this API key reached one of its credit caps; the account's other keys still work. |
| `BATCH_ACCESS_DENIED` | 403: Batch is not enabled for this account or API key. |
| `BATCH_NOT_FOUND` | 404: no such job, run or task for this account. |
| `AUTH_INVALID` | 401: the API key was rejected, or, with `server_code` `subscription_inactive`, the key is valid but the subscription is not active: fix it in Billing. |
| `BATCH_FAILED` | Any other HTTP error; see `server_code` and `detail`. |
| `BACKEND_UNAVAILABLE` | No response: a network error or timeout, after retries. |

Reads retry on 429, 502, 503, 504 and network errors (up to 3 times, honoring `Retry-After` up to 30 seconds). `batch_create` retries on 502, 503, 504 and network errors with its `Idempotency-Key`, never on 429.

The Batch API does more than these tools expose. Use the [Batch API](https://docs.zenrows.com/batch/introduction) directly to:

- list your jobs, or delete a job or a run;
- create an open job and add tasks to it over time, then close it;
- pause, resume or rerun a run, including a rerun of only its failed or pending tasks;
- schedule recurring jobs;
- configure signed webhooks and manage HMAC keys;
- read a task's content or attempt history, or an earlier run's results;
- export a run's results as one download, or submit a job from a CSV file;
- set a job-level `name`, `external_id` or `metadata`.

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
