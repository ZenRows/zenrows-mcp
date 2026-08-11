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

The exact location of this config varies by client. See the [per-client setup guides](https://docs.zenrows.com/mcp/overview#per-client-setup-guides) for the file path for your client.

---

## Tools

The Zenrows MCP exposes these tool families:

| Tool | Purpose |
|------|---------|
| **`scrape`** | Full-page content → Markdown, plain text, HTML, PDF, or screenshot (plus helper outputs). |
| **`extract`** | Structured JSON (`extract=auto`, autoparse, or `css_extractor`) + optional stealth flags. `extract=auto` is open beta (currently free; billing may apply later). |
| **`batch_create` / `batch_status` / `batch_results` / `batch_cancel` / `batch_wait`** | Cloud Batch API fan-out (`async.api.zenrows.com`). Beta; may return `BATCH_ACCESS_DENIED`. Not `browser_batch`. |
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
