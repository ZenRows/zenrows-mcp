#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const apiKey = process.env.ZENROWS_API_KEY;
if (!apiKey) {
  process.stderr.write("Error: ZENROWS_API_KEY environment variable is required\n");
  process.exit(1);
}

const server = createServer(apiKey);
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("ZenRows MCP server running on stdio\n");
