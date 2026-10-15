import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";

// Directory reviewers read tool descriptions against rules on bypassing third-party access
// controls (https://developers.openai.com/plugins/plugin-guidelines). Descriptions say what a
// tool does and costs, not that it gets past a site's defences.
const FLAGGED = /stealth|anti-?bot|get past|site blocks|protected/i;

async function listTools(hosted: boolean) {
  const server = createServer("k", undefined, { hosted });
  const client = new Client({ name: "descriptions-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

for (const hosted of [false, true]) {
  test(`no tool or parameter description uses circumvention wording (hosted=${hosted})`, async () => {
    const tools = await listTools(hosted);
    assert.ok(tools.length > 0, "server advertises no tools");

    const hits: string[] = [];
    for (const tool of tools) {
      if (FLAGGED.test(tool.description ?? "")) hits.push(tool.name);
      const properties = (tool.inputSchema?.properties ?? {}) as Record<string, { description?: string }>;
      for (const [param, schema] of Object.entries(properties)) {
        if (FLAGGED.test(schema.description ?? "")) hits.push(`${tool.name}.${param}`);
      }
    }
    assert.deepEqual(hits, []);
  });
}

test("the server sends instructions at initialize, in the same wording rules", async () => {
  const server = createServer("k", undefined, { hosted: true });
  const client = new Client({ name: "descriptions-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /scrape/);
    assert.doesNotMatch(instructions, FLAGGED);
  } finally {
    await client.close();
  }
});

// Registries score a description under 30 characters as missing.
for (const hosted of [false, true]) {
  test(`every tool description is at least 30 characters (hosted=${hosted})`, async () => {
    const short = (await listTools(hosted)).filter((t) => (t.description ?? "").length < 30).map((t) => t.name);
    assert.deepEqual(short, []);
  });
}
