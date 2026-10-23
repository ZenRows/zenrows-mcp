#!/usr/bin/env node
import { createRequire } from "module";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  AGENT_SIGNUP_API_URL,
  autoSignupEnabled,
  getZenrowsDir,
  provisionMessage,
  resolveApiKey,
  SIGNUP_URL_ENV,
} from "./auth/ensure-key.js";
import { LazyApiKey } from "./auth/lazy-key.js";
import { createServer } from "./server.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

// The server always starts and answers the handshake, key or not. The key is resolved, or
// a Free account created, on the first tool call; a refused signup is that call's error.
const existing = resolveApiKey();
if (existing.key) {
  process.stderr.write(`Using existing API key from ${existing.source} (secrets dir: ${getZenrowsDir()})\n`);
} else if (!autoSignupEnabled()) {
  process.stderr.write(
    "No API key, and ZENROWS_AUTO_SIGNUP=false: tool calls return an error until ZENROWS_API_KEY is set.\n"
  );
} else {
  const signup = process.env[SIGNUP_URL_ENV]?.trim() || AGENT_SIGNUP_API_URL;
  process.stderr.write(`No API key yet: the first tool call creates a Free account via ${signup}\n`);
}

const key = new LazyApiKey({
  userAgent: `zenrows/mcp ${pkg.version}`,
  onProvision: (acct) => {
    process.stderr.write(provisionMessage(acct, getZenrowsDir()));
  },
});

const server = createServer(key, undefined, {
  ensureKey: (clientName) => key.ensure(clientName),
  answerSignup: (answer, clientName) => key.answer(answer, clientName),
});
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`Zenrows MCP server running on stdio (secrets dir: ${getZenrowsDir()})\n`);
