import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { API_BASE_ENV, apiBase } from "../src/api-base.ts";
import { CRAWL_API_BASE_ENV, crawlBase } from "../src/crawl-api.ts";
import { EXTRACT_API_BASE_ENV, extractApiBase } from "../src/tools/prepare.ts";
import { runAccountUsage } from "../src/tools/account.ts";

/**
 * A deployment in another environment sets one variable and every API call follows it.
 * A hosted server that read only some of them sent that environment's key to production,
 * which rejects it.
 */

const saved = {
  [API_BASE_ENV]: process.env[API_BASE_ENV],
  [CRAWL_API_BASE_ENV]: process.env[CRAWL_API_BASE_ENV],
  [EXTRACT_API_BASE_ENV]: process.env[EXTRACT_API_BASE_ENV],
};

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("apiBase defaults to production when the variable is unset or blank", () => {
  delete process.env[API_BASE_ENV];
  assert.equal(apiBase(), "https://api.zenrows.com/v1");
  process.env[API_BASE_ENV] = "  ";
  assert.equal(apiBase(), "https://api.zenrows.com/v1");
});

test("apiBase takes the variable, without its trailing slashes", () => {
  process.env[API_BASE_ENV] = " https://api.example.test/v1// ";
  assert.equal(apiBase(), "https://api.example.test/v1");
});

test("Crawl and Extract preparation follow ZENROWS_API_BASE unless their own variable is set", () => {
  delete process.env[CRAWL_API_BASE_ENV];
  delete process.env[EXTRACT_API_BASE_ENV];
  process.env[API_BASE_ENV] = "https://api.example.test/v1";
  assert.equal(crawlBase(), "https://api.example.test/v1");
  assert.equal(extractApiBase(), "https://api.example.test/v1");

  process.env[CRAWL_API_BASE_ENV] = "https://crawl.example.test/v1/";
  process.env[EXTRACT_API_BASE_ENV] = "https://extract.example.test/v1/";
  assert.equal(crawlBase(), "https://crawl.example.test/v1");
  assert.equal(extractApiBase(), "https://extract.example.test/v1");
});

test("account_usage asks the environment ZENROWS_API_BASE names", async () => {
  process.env[API_BASE_ENV] = "https://api.example.test/v1";
  let seenUrl: string | undefined;
  await runAccountUsage("k", {
    fetchImpl: (async (url: string) => {
      seenUrl = String(url);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.equal(seenUrl, "https://api.example.test/v1/subscriptions/self/details");
});
