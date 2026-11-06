import assert from "node:assert/strict";
import { test } from "node:test";

// With ZENROWS_FETCH_RETRIES unset, scrape and extract must behave as before it existed.
delete process.env.ZENROWS_FETCH_RETRIES;
const { harness } = await import("./helpers/fetch-harness.ts");
type ToolResult = import("./helpers/fetch-harness.ts").ToolResult;

for (const tool of ["scrape", "extract"]) {
  test(`${tool}: by default a 503 is sent once and returned to the agent`, async (t) => {
    const { client, hits, retryLines } = await harness(
      t,
      () => new Response('{"code":"RESP009"}', { status: 503, headers: { "retry-after": "0" } })
    );
    const out = (await client.callTool({ name: tool, arguments: { url: "https://example.com" } })) as ToolResult;
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /503/);
    assert.equal(hits.length, 1);
    assert.deepEqual(retryLines(), []);
  });
}
