import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";

// The ChatGPT plugin directory requires readOnlyHint, destructiveHint and openWorldHint
// as explicit booleans on every tool, and imports them from the live server's tools/list:
// https://developers.openai.com/plugins/plugin-guidelines
const REQUIRED_HINTS = ["readOnlyHint", "destructiveHint", "openWorldHint"] as const;

async function listTools(hosted: boolean) {
  const server = createServer("k", undefined, { hosted });
  const client = new Client({ name: "annotations-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

for (const hosted of [false, true]) {
  test(`every tool declares all three hints as booleans (hosted=${hosted})`, async () => {
    const tools = await listTools(hosted);
    assert.ok(tools.length > 0, "server advertises no tools");

    const missing = tools.flatMap((tool) =>
      REQUIRED_HINTS.filter((hint) => typeof tool.annotations?.[hint] !== "boolean").map(
        (hint) => `${tool.name}.${hint}`
      )
    );
    assert.deepEqual(missing, []);
  });

  test(`a read-only tool is never marked destructive (hosted=${hosted})`, async () => {
    const tools = await listTools(hosted);
    const contradictory = tools
      .filter((tool) => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === true)
      .map((tool) => tool.name);
    assert.deepEqual(contradictory, []);
  });
}
