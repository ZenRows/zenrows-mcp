import assert from "node:assert/strict";
import { test } from "node:test";

// Set before the server module reads it at load.
process.env.ZENROWS_FETCH_RETRIES = "2";
const { harness } = await import("./helpers/fetch-harness.ts");
type ToolResult = import("./helpers/fetch-harness.ts").ToolResult;

const busy = (retryAfter: string) =>
  new Response('{"code":"RESP009"}', { status: 503, headers: { "retry-after": retryAfter } });
const ok = () => new Response('{"title":"x"}', { headers: { "content-type": "application/json" } });

for (const tool of ["scrape", "extract"]) {
  test(`${tool} retries a 503 and returns the retry's answer`, async (t) => {
    let n = 0;
    const { client, hits, retryLines } = await harness(t, () => (n++ === 0 ? busy("0") : ok()));
    const out = (await client.callTool({ name: tool, arguments: { url: "https://example.com" } })) as ToolResult;
    assert.equal(out.isError, undefined);
    assert.equal(hits.length, 2);
    assert.deepEqual(retryLines(), [`zenrows-mcp: ${tool} got 503 on attempt 1 of 3; retrying in 250 ms\n`]);
  });

  test(`${tool}: no retry is sent after the client times out the call`, async (t) => {
    const { client, hits } = await harness(t, () => busy("1"));
    await assert.rejects(
      client.callTool({ name: tool, arguments: { url: "https://example.com" } }, undefined, { timeout: 300 }),
      /timed out/i
    );
    // Without the cancel, the retry would go out at about 1 s.
    await new Promise((r) => setTimeout(r, 1_500));
    assert.equal(hits.length, 1);
  });
}

// There a 429 means the allowance is used up and a 503 that preparation is unavailable.
for (const status of [429, 503]) {
  for (const [tool, args, requests] of [
    ["prepare_domain", { domain: "example.com", example_urls: ["https://example.com/p/1"] }, 1],
    ["prepared_domain_status", { domain: "example.com" }, 2], // the domain and the allowance
  ] as const) {
    test(`${tool} never retries a ${status}`, async (t) => {
      const { client, hits, retryLines } = await harness(
        t,
        () => new Response("{}", { status, headers: { "retry-after": "0" } })
      );
      const out = (await client.callTool({ name: tool, arguments: args })) as ToolResult;
      assert.equal(out.isError, true);
      assert.equal(hits.length, requests);
      assert.deepEqual(retryLines(), []);
    });
  }
}

// Only the API's own statuses may be retried. If scrape or extract ever offers a parameter
// that returns the target site's status, the retry must learn to skip those statuses.
test("scrape and extract offer no parameter that returns the target site's status", async (t) => {
  const { client } = await harness(t, ok);
  const { tools } = await client.listTools();
  for (const name of ["scrape", "extract"]) {
    const offered = Object.keys(tools.find((x) => x.name === name)?.inputSchema.properties ?? {});
    assert.ok(offered.length > 0, name);
    assert.ok(!offered.includes("original_status") && !offered.includes("allowed_status_codes"), name);
  }
});
