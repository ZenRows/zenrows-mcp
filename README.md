<p align="center">
  <img src="assets/zenrows.svg" alt="ZenRows MCP" width="380">
</p>

<p align="center">
  Model Context Protocol server for the <a href="https://www.zenrows.com/products/universal-scraper">ZenRows Universal Scraper API</a>.<br>
  Give any MCP-compatible AI assistant the ability to scrape any webpage — including JavaScript-rendered content and anti-bot protected sites.
</p>

---

## Quick Start

**Claude Code**
```bash
claude mcp add zenrows -e ZENROWS_API_KEY=YOUR_API_KEY -- npx -y @zenrows/mcp
```

Or ask your AI assistant naturally once configured:
```
Scrape https://example.com and summarize the content.
```

---

## Tool

### `scrape`

Fetches a webpage and returns its content as clean markdown (default), plaintext, raw HTML, PDF, structured JSON, or a screenshot.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | **required** | Webpage URL to scrape |
| `js_render` | boolean | `false` | Enable JS rendering for SPAs and dynamic content |
| `premium_proxy` | boolean | `false` | Use residential proxies to bypass anti-bot systems |
| `proxy_country` | string | — | ISO 3166-1 alpha-2 country code (e.g. `US`, `GB`). Requires `premium_proxy` |
| `response_type` | `markdown` \| `plaintext` \| `pdf` \| `html` | `markdown` | Output format. `html` returns raw source (ZenRows default when no param is sent). Ignored when `autoparse`, `css_extractor`, `outputs`, or screenshot params are set |
| `autoparse` | boolean | — | Auto-extract structured JSON from the page |
| `css_extractor` | string | — | JSON map of CSS selectors: `{"title":"h1","price":".price"}` |
| `outputs` | string | — | Comma-separated data types to extract as JSON: `emails`, `headings`, `links`, `menus`, `images`, `videos`, `audios`. Use `*` for all |
| `screenshot` | boolean | — | Capture an above-the-fold screenshot. Returns an image |
| `screenshot_fullpage` | boolean | — | Capture a full-page screenshot. Returns an image |
| `screenshot_selector` | string | — | Capture a screenshot of a specific element via CSS selector |
| `wait_for` | string | — | CSS selector to wait for before capturing. Requires `js_render` |
| `wait` | number | — | Milliseconds to wait after load (max 30000). Requires `js_render` |
| `js_instructions` | string | — | JSON array of browser actions. Requires `js_render` |

---

## When to use which options

**Content doesn't appear or page is blank**
→ Enable `js_render: true`. The page likely uses React, Vue, or Angular.

**Getting 403 or blocked errors**
→ Add `premium_proxy: true`. For geo-restricted content, also set `proxy_country`.

**Content loads after a delay or interaction**
→ Use `wait_for` (CSS selector) or `wait` (milliseconds) with `js_render: true`.
→ For clicks or form inputs before scraping, use `js_instructions`.

**Only need specific data, not the full page**
→ Use `css_extractor` with a JSON map of selectors for precise extraction.
→ Use `autoparse` for structured pages like products or articles.
→ Use `outputs` to pull links, emails, images, or other content types.

**Need to verify what the page looks like**
→ Use `screenshot` or `screenshot_fullpage` for visual debugging.
→ Use `screenshot_selector` to capture a specific element.

---

## Installation

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "zenrows": {
      "command": "npx",
      "args": ["-y", "@zenrows/mcp"],
      "env": {
        "ZENROWS_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add zenrows -e ZENROWS_API_KEY=YOUR_API_KEY -- npx -y @zenrows/mcp
```

Or add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "zenrows": {
      "command": "npx",
      "args": ["-y", "@zenrows/mcp"],
      "env": {
        "ZENROWS_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

### Cursor

Edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "zenrows": {
      "command": "npx",
      "args": ["-y", "@zenrows/mcp"],
      "env": {
        "ZENROWS_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

### Windsurf

Edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "zenrows": {
      "command": "npx",
      "args": ["-y", "@zenrows/mcp"],
      "env": {
        "ZENROWS_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

### VS Code (GitHub Copilot)

Edit `.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "zenrows": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@zenrows/mcp"],
      "env": {
        "ZENROWS_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

### Zed

Edit `~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "zenrows": {
      "command": {
        "path": "npx",
        "args": ["-y", "@zenrows/mcp"],
        "env": {
          "ZENROWS_API_KEY": "YOUR_API_KEY"
        }
      }
    }
  }
}
```

### JetBrains IDEs

Go to **Settings → Tools → AI Assistant → Model Context Protocol** and add:

```json
{
  "mcpServers": {
    "zenrows": {
      "command": "npx",
      "args": ["-y", "@zenrows/mcp"],
      "env": {
        "ZENROWS_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

---

## Examples

Once configured, ask your AI assistant naturally:

```
Scrape the pricing page at https://zenrows.com/pricing and summarize the plans.

Fetch https://example.com/ — it's a React SPA, so enable JS rendering.

Get the top 5 results from https://www.scrapingcourse.com/ecommerce/ and extract just the product names and prices.

Take a full-page screenshot of https://news.ycombinator.com to see the current layout.

Scrape https://protected-site.com — it keeps blocking me, use premium proxies.
```

---

## Development

```bash
git clone https://github.com/ZenRows/zenrows-mcp
cd zenrows-mcp
npm install
cp .env.example .env   # add your API key
npm run dev            # run with .env loaded (requires Node 20.6+)
npm run build          # compile to dist/
npm run inspect        # open MCP inspector UI
```

---

## License

MIT
