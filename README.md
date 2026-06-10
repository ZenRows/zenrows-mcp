<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/zenrows_light.svg">
    <img src="assets/zenrows_dark.svg" alt="ZenRows MCP" width="380">
  </picture>
</p>

# ZenRows MCP Server

The ZenRows MCP (Model Context Protocol) server is the standard way AI systems use ZenRows. A single connection gives your AI assistant, agent, or application real-time access to any website.

[![npm version](https://img.shields.io/npm/v/@zenrows/mcp)](https://www.npmjs.com/package/@zenrows/mcp)
[![MIT License](https://img.shields.io/badge/license-MIT-blue)](https://github.com/ZenRows/zenrows-mcp/blob/main/LICENSE)

📚 **Full documentation:** [docs.zenrows.com/integrations/mcp/mcp-overview](https://docs.zenrows.com/integrations/mcp/mcp-overview)

---

## Why ZenRows MCP

- **Reach sites that normally block bots.** Get access to any website at scale without getting blocked by anti-bot systems.
- **Managed scraping infrastructure.** Proxy rotation, headless browser orchestration, anti-bot evasion, and session management run on ZenRows infrastructure.
- **Plug into any AI you already use.** Works with any MCP client, including AI assistants, agent frameworks, AI SDKs, IDE plugins, and custom applications.
- **Plain English, no scraping code.** Describe the task naturally and the AI picks the right tool. No selectors, no proxy management, no anti-bot tuning.

---

## Quick start

ZenRows MCP supports two transport options. Both expose the same set of tools and capabilities. Pick the one that fits your client.

### Remote MCP server

Use the hosted ZenRows MCP server when your AI application calls an LLM API directly. The server runs on ZenRows infrastructure, so there is nothing to install, configure, or update.

**Server URL:**

```
https://mcp.zenrows.com/mcp
```

**Transport:** Streamable HTTP

**Authentication:** OAuth-based. Pass your ZenRows API key as a Bearer token in the `Authorization` header on every request.

```
Authorization: Bearer YOUR_ZENROWS_API_KEY
```

Most MCP clients accept this through an `authorization` shorthand field on the tool config and forward it as the Bearer token automatically. Some clients use a free-form `headers` field instead. Either approach works.

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

For the full walkthrough with framework-specific examples, see the [Remote MCP server docs](https://docs.zenrows.com/integrations/mcp/mcp-overview#remote-mcp-server).

### Local MCP server

Use the local stdio configuration when your MCP client runs the server as a local subprocess instead of calling a remote URL. This is the standard setup for desktop AI tools and IDE plugins, including Claude Desktop, Claude Code, Cursor, Windsurf, VS Code, Zed, and JetBrains IDEs.

**Package:** [`@zenrows/mcp`](https://www.npmjs.com/package/@zenrows/mcp) on npm

**Authentication:** API key via the `ZENROWS_API_KEY` environment variable.

**Requirements:** [Node.js](https://nodejs.org/) installed (for `npx` to work).

**Configuration:**

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

The exact location of this config varies by client. See the [per-client setup guides](https://docs.zenrows.com/integrations/mcp/mcp-overview#per-client-setup-guides) for the file path for your client.

---

## Tools

The ZenRows MCP exposes two families of tools:

- **`scrape`**: single-request fetch returning Markdown, plain text, HTML, JSON, PDF, or screenshot. Backed by the [Universal Scraper API](https://docs.zenrows.com/universal-scraper-api/api-reference).
- **`browser_*`**: 30+ tools for full browser automation including navigation, clicks, form fills, JavaScript execution, cookies, tabs, and persistent sessions. Backed by the [Scraping Browser](https://docs.zenrows.com/scraping-browser/introduction).

The AI selects the right tool from your prompt. You don't call tools directly in code.

See the [full tool reference](https://docs.zenrows.com/integrations/mcp/mcp-overview#tools) for every tool, parameter, and return value.

### Credentials & scopes

Authenticate with either a ZenRows API key or a **scoped agent credential** (obtained via OAuth — e.g. `npx zenrows login`, or the MCP OAuth flow this server advertises at `/.well-known/oauth-*`). Present it as `Authorization: Bearer <credential>` or `?apikey=<credential>`.

- **API keys** have full account access (unchanged behavior).
- **Agent credentials** are scoped: the server introspects them and enforces per-tool scopes. `scrape` needs `scrape:write` (plus `extract:json` for structured extraction); `browser_*` needs `browser:session_write` (a production scope that requires approval). A call missing a scope returns an `insufficient_scope` error pointing to **Settings → Agents**. Configurable via `ZENROWS_INTROSPECTION_URL`.

---

## Development

```bash
git clone https://github.com/ZenRows/zenrows-mcp
cd zenrows-mcp
npm install
cp .env.example .env   # Add your API key
npm run dev            # Run with .env loaded (requires Node.js 20.6+)
npm run build          # Compile to dist/
npm run inspect        # Open the MCP inspector UI
```

Pull requests and issues are welcome.

---

## Resources

- [Full ZenRows MCP documentation](https://docs.zenrows.com/integrations/mcp/mcp-overview)
- [ZenRows Universal Scraper API](https://docs.zenrows.com/universal-scraper-api/api-reference)
- [ZenRows Scraping Browser](https://docs.zenrows.com/scraping-browser/introduction)
- [npm package](https://www.npmjs.com/package/@zenrows/mcp)
- [Get your API key](https://app.zenrows.com/register)

---

## License

[MIT](LICENSE)
