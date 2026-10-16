import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";

/**
 * zenrows://account reads the account file from ~/.zenrows on the machine running the
 * server. Locally that is the user's file. Hosted, it is the server's own disk, which
 * never holds the caller's account, so the hosted server does not list the resource.
 */
async function connect(hosted: boolean) {
  const server = createServer("k", undefined, { hosted });
  const client = new Client({ name: "account-resource-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test("the local server lists and reads zenrows://account", async () => {
  const client = await connect(false);
  try {
    const { resources } = await client.listResources();
    assert.ok(resources.some((r) => r.uri === "zenrows://account"));
    const { contents } = await client.readResource({ uri: "zenrows://account" });
    assert.equal(contents[0]?.mimeType, "application/json");
  } finally {
    await client.close();
  }
});

test("the hosted server does not offer zenrows://account", async () => {
  const client = await connect(true);
  try {
    const resources = client.getServerCapabilities()?.resources ? (await client.listResources()).resources : [];
    assert.ok(!resources.some((r) => r.uri === "zenrows://account"));
  } finally {
    await client.close();
  }
});
