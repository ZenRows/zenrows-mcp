import type { TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.ts";

/**
 * The tools through a real MCP client, with global fetch answered by `respond`. Importing
 * this loads src/retry.ts, which reads ZENROWS_FETCH_RETRIES once: set it before the
 * dynamic import.
 */
export async function harness(t: TestContext, respond: (url: string) => Response) {
  const hits: number[] = [];
  const t0 = Date.now();
  t.mock.method(globalThis, "fetch", async (url: string | URL) => {
    hits.push(Date.now() - t0);
    return respond(String(url));
  });
  const stderr = t.mock.method(process.stderr, "write", () => true);
  const server = createServer("k");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  t.after(() => client.close());
  const retryLines = () =>
    stderr.mock.calls.map((c) => String(c.arguments[0])).filter((line) => line.startsWith("zenrows-mcp:"));
  return { client, hits, retryLines };
}

export type ToolResult = { content: Array<{ text: string }>; isError?: boolean };
