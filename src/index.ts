#!/usr/bin/env node
import { createRequire } from "module";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AuthError, ensureApiKey, getZenrowsDir, resolveApiKey } from "./auth/ensure-key.js";
import { createServer } from "./server.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

let apiKey: string;
try {
  const existing = resolveApiKey();
  if (existing.key) {
    process.stderr.write(`Using existing API key from ${existing.source} (secrets dir: ${getZenrowsDir()})\n`);
  } else {
    const signup =
      process.env.ZENROWS_AGENT_SIGNUP_URL?.trim() || "https://app.zenrows.com/api/agent/signup (default prod)";
    process.stderr.write(`No API key — will auto-signup via: ${signup}\n`);
  }

  const resolved = await ensureApiKey({
    userAgent: `zenrows/mcp ${pkg.version}`,
    onProvision: (acct) => {
      process.stderr.write(
        `Created a Zenrows Free plan account.\n` +
          `Claim it anytime (keeps your usage): ${acct.claimUrl}\n` +
          `Key stored in ${getZenrowsDir()}/secrets.json\n`
      );
    },
  });
  apiKey = resolved.apiKey;
} catch (err) {
  const msg =
    err instanceof AuthError
      ? `Error: ${err.message}\n`
      : `Error: ${err instanceof Error ? err.message : String(err)}\n`;
  process.stderr.write(msg);
  process.exit(1);
}

const server = createServer(apiKey);
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`Zenrows MCP server running on stdio (secrets dir: ${getZenrowsDir()})\n`);
