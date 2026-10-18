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

The exact location of this config varies by client. See the [per-client setup guides](https://docs.zenrows.com/mcp/overview#per-client-setup-guides) for the file path for your client.

---

## Tools

The Zenrows MCP exposes these tool families:

| Tool | Purpose |
|------|---------|
| **`scrape`** | Full-page content → Markdown, plain text, HTML, PDF, or screenshot (plus helper outputs). |
| **`extract`** | Structured JSON (`extract=auto`, autoparse, or `css_extractor`) + optional stealth flags. `extract=auto` is currently free (billing may apply later) and works on any domain Zenrows has prepared, with any API key; on a domain not prepared yet (`REQS007`) it falls back to autoparse. |
| **`batch_create` / `batch_status` / `batch_results` / `batch_cancel` / `batch_wait`** | Cloud Batch API fan-out (`async.api.zenrows.com`). Same credits as Fetch; a 403 maps to `BATCH_ACCESS_DENIED`. Not `browser_batch`. |
| **`crawl_create` / `crawl_get` / `crawl_results` / `crawl_content` / `crawl_download` / `crawl_list` / `crawl_stop` / `crawl_wait`** | Crawl API (`api.zenrows.com/v1/crawls`). New. Crawl is still evolving: new features are coming, limits may be tuned, and the changelog announces each change. Give one start URL, get back the URLs behind it on the same registrable domain (subdomains count), optionally with each page's HTML (`output_format: "html"`). `crawl_create` returns at once; call `crawl_wait` (counts and the first 20 URLs), then `crawl_download` to save every result to a local JSON-lines file (default `~/.zenrows/crawls/<crawl_id>.jsonl`; a `path` must stay inside `~/.zenrows/crawls`; an existing file is kept unless `overwrite: true`; the hosted server writes no file and returns the download URL and a `curl` command instead), or `crawl_results` to page through them. Leave `depth` out of `crawl_create` for no depth limit: the crawl follows links until `max_pages` or `max_items` (default 100 each) stops it, and each page fetched is billed as one scrape. Set `idempotency_key` on `crawl_create` to make a retry safe. `crawl_content` takes `crawl_id` and `content_id` (a content id or a result's `content_url`). Reads retry on 429, 502, 503, 504 and network errors (up to 3 times, honoring `Retry-After` up to 30 seconds); `crawl_create` retries only with an `idempotency_key`, and never on 429; `crawl_stop` retries on 429, 502, 503 and 504 (repeating a stop is safe; a 503 `crawl_busy` means the stop was not saved yet), up to 3 times and 50 seconds at most in all, and returns `CRAWL_BUSY` if a `crawl_busy` persists. May return `CRAWL_NOT_ENABLED` (Crawl is not enabled for this account). |
| **`browser_*`** | 30+ tools for full browser automation (navigation, clicks, forms, JS, cookies, tabs, sessions). |

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
