import assert from "node:assert/strict";
import { test } from "node:test";
import { buildScrapeParams } from "../src/server.ts";

test("URL only → Adaptive Stealth Mode, no manual flags", () => {
  const p = buildScrapeParams("k", { url: "https://example.com" });
  assert.equal(p.get("mode"), "auto");
  assert.equal(p.get("js_render"), null);
  assert.equal(p.get("premium_proxy"), null);
  assert.equal(p.get("response_type"), "markdown");
});

test("explicit false keeps Adaptive Stealth Mode", () => {
  const p = buildScrapeParams("k", { url: "https://example.com", js_render: false, premium_proxy: false });
  assert.equal(p.get("mode"), "auto");
});

test("js_render overrides auto", () => {
  const p = buildScrapeParams("k", { url: "https://example.com", js_render: true });
  assert.equal(p.get("mode"), null);
  assert.equal(p.get("js_render"), "true");
});

test("premium_proxy overrides auto", () => {
  const p = buildScrapeParams("k", { url: "https://example.com", premium_proxy: true, proxy_country: "us" });
  assert.equal(p.get("mode"), null);
  assert.equal(p.get("premium_proxy"), "true");
  assert.equal(p.get("proxy_country"), "US");
});

test("proxy_country and screenshot stay in auto without forcing js_render", () => {
  const p = buildScrapeParams("k", { url: "https://example.com", proxy_country: "de", screenshot: true });
  assert.equal(p.get("mode"), "auto");
  assert.equal(p.get("js_render"), null);
  assert.equal(p.get("screenshot"), "true");
  assert.equal(p.get("proxy_country"), "DE");
});

test("manual premium_proxy + screenshot still enables js_render", () => {
  const p = buildScrapeParams("k", { url: "https://example.com", premium_proxy: true, screenshot: true });
  assert.equal(p.get("js_render"), "true");
});
