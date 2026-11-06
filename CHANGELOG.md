# Changelog

## [2.19.0](https://github.com/ZenRows/zenrows-mcp/compare/v2.18.0...v2.19.0) (2026-11-06)


### Features

* **fetch:** new ZENROWS_FETCH_RETRIES option lets scrape and extract retry calls the API did not serve; off by default ([18e5684](https://github.com/ZenRows/zenrows-mcp/commit/18e56843a86dd56c531a666c20c65cad86a75c6f))

## [2.18.0](https://github.com/ZenRows/zenrows-mcp/compare/v2.17.0...v2.18.0) (2026-10-30)


### Features

* **crawl:** get notified by webhook when a crawl starts, completes, stops or fails ([#110](https://github.com/ZenRows/zenrows-mcp/issues/110)) ([e661eb2](https://github.com/ZenRows/zenrows-mcp/commit/e661eb2f899432bdd67c0f2c48c31a870a7de96b))

## [2.17.0](https://github.com/ZenRows/zenrows-mcp/compare/v2.16.1...v2.17.0) (2026-10-27)


### Features

* **extract:** ask for several example URLs of one page type when preparing a domain ([#100](https://github.com/ZenRows/zenrows-mcp/issues/100)) ([5039ebc](https://github.com/ZenRows/zenrows-mcp/commit/5039ebce97095be804e3dce2eb4b38426caf2b92))

## [2.16.1](https://github.com/ZenRows/zenrows-mcp/compare/v2.16.0...v2.16.1) (2026-10-24)


### Bug Fixes

* **docker:** build the image on Node 22 (CVE-2026-111497) ([#104](https://github.com/ZenRows/zenrows-mcp/issues/104)) ([732d8f7](https://github.com/ZenRows/zenrows-mcp/commit/732d8f7023c229405de467c2602bf6b5f16ae772))

## [2.16.0](https://github.com/ZenRows/zenrows-mcp/compare/v2.15.1...v2.16.0) (2026-10-23)


### Features

* **auth:** let the agent answer the signup question instead of failing keyless calls on a raw 428 ([#101](https://github.com/ZenRows/zenrows-mcp/issues/101)) ([5d4143f](https://github.com/ZenRows/zenrows-mcp/commit/5d4143fc97fc0dac0e44b3a54ec448481c84ac75))

## [2.15.1](https://github.com/ZenRows/zenrows-mcp/compare/v2.15.0...v2.15.1) (2026-10-21)


### Bug Fixes

* **browser:** mark the browser tools that can overwrite or delete page state destructive ([#97](https://github.com/ZenRows/zenrows-mcp/issues/97)) ([577bf45](https://github.com/ZenRows/zenrows-mcp/commit/577bf459cbdfb10a91e8212712ec24d472a6e728))

## [2.15.0](https://github.com/ZenRows/zenrows-mcp/compare/v2.14.0...v2.15.0) (2026-10-20)


### Features

* **extract:** remove the autoparse fallback and add prepare_domain tools ([#60](https://github.com/ZenRows/zenrows-mcp/issues/60)) ([c71f9a6](https://github.com/ZenRows/zenrows-mcp/commit/c71f9a6d0e16d447f8e4df507bf7e7a485351709))


### Bug Fixes

* **browser:** split local storage into one tool per operation and mark clearing destructive ([#95](https://github.com/ZenRows/zenrows-mcp/issues/95)) ([434b005](https://github.com/ZenRows/zenrows-mcp/commit/434b0050cca87b66a14b59d4d9d6a8ce31a06cf0))

## [2.14.0](https://github.com/ZenRows/zenrows-mcp/compare/v2.13.0...v2.14.0) (2026-10-20)


### Features

* **http:** serve the OpenAI apps domain challenge ([#93](https://github.com/ZenRows/zenrows-mcp/issues/93)) ([2f390fa](https://github.com/ZenRows/zenrows-mcp/commit/2f390fa48576c5952c34c2a314c886f602281ed4))

## [2.13.0](https://github.com/ZenRows/zenrows-mcp/compare/v2.12.1...v2.13.0) (2026-10-20)


### Features

* **batch:** let an agent read, recover and clean up a Batch job, and fix the existing Batch tools ([#91](https://github.com/ZenRows/zenrows-mcp/issues/91)) ([009932d](https://github.com/ZenRows/zenrows-mcp/commit/009932d7e7aa8f4dd4b497e6c5d06dabfc003636))

## [2.12.1](https://github.com/ZenRows/zenrows-mcp/compare/v2.12.0...v2.12.1) (2026-10-19)


### Bug Fixes

* **http:** stop the server card describing the server as an anti-bot bypass ([#88](https://github.com/ZenRows/zenrows-mcp/issues/88)) ([f233862](https://github.com/ZenRows/zenrows-mcp/commit/f23386233c4e1a1156822eeeee679f7b926f6c1a))

## [2.12.0](https://github.com/ZenRows/zenrows-mcp/compare/v2.11.1...v2.12.0) (2026-10-18)


### Features

* **auth:** a refused signup no longer stops the stdio server from starting ([#85](https://github.com/ZenRows/zenrows-mcp/issues/85)) ([4fc09e2](https://github.com/ZenRows/zenrows-mcp/commit/4fc09e2660c8ed51b886779db3430ec8aca3dfc4))
* **http:** a keyless agent hitting the hosted 401 had no way to learn how to get a key ([#86](https://github.com/ZenRows/zenrows-mcp/issues/86)) ([2638756](https://github.com/ZenRows/zenrows-mcp/commit/2638756c7e1de82388773609a55b64b1a02720ec))

## [2.11.1](https://github.com/ZenRows/zenrows-mcp/compare/v2.11.0...v2.11.1) (2026-10-17)


### Bug Fixes

* **http:** an empty GET event stream made MCP clients reconnect in a loop ([#83](https://github.com/ZenRows/zenrows-mcp/issues/83)) ([623af83](https://github.com/ZenRows/zenrows-mcp/commit/623af83035cb279451c71854c2060f4324532808))

## [2.11.0](https://github.com/ZenRows/zenrows-mcp/compare/v2.10.2...v2.11.0) (2026-10-17)


### Features

* **auth:** signups could not be attributed, and the hosted server left no trace per request ([#81](https://github.com/ZenRows/zenrows-mcp/issues/81)) ([2fa1d7f](https://github.com/ZenRows/zenrows-mcp/commit/2fa1d7f84944c319f6c1576520ddad2451f4ffa0))

## [2.10.2](https://github.com/ZenRows/zenrows-mcp/compare/v2.10.1...v2.10.2) (2026-10-16)


### Bug Fixes

* **crawl:** tell agents a crawl with nothing new to follow completes, so they stop chasing patterns ([#64](https://github.com/ZenRows/zenrows-mcp/issues/64)) ([68850e7](https://github.com/ZenRows/zenrows-mcp/commit/68850e7105a2085188e4364f6808479b40d0d3ea))

## [2.10.1](https://github.com/ZenRows/zenrows-mcp/compare/v2.10.0...v2.10.1) (2026-10-16)


### Bug Fixes

* **crawl:** answer ok: false when a crawl stops because credits ran out ([#62](https://github.com/ZenRows/zenrows-mcp/issues/62)) ([9b0a3a8](https://github.com/ZenRows/zenrows-mcp/commit/9b0a3a83caf46ca8344ee7bd50e04ca61e6f9241))

## [2.10.0](https://github.com/ZenRows/zenrows-mcp/compare/v2.9.1...v2.10.0) (2026-10-16)


### Features

* **crawl:** return each page as Markdown, and choose how a crawl finds URLs ([#56](https://github.com/ZenRows/zenrows-mcp/issues/56)) ([577ff50](https://github.com/ZenRows/zenrows-mcp/commit/577ff503d58d5ea8db078f1f880ec36fc7f94ad1))

## [2.9.1](https://github.com/ZenRows/zenrows-mcp/compare/v2.9.0...v2.9.1) (2026-10-15)


### Bug Fixes

* **server:** the hosted server offered an account resource it could never fill ([#69](https://github.com/ZenRows/zenrows-mcp/issues/69)) ([cbc5d85](https://github.com/ZenRows/zenrows-mcp/commit/cbc5d85c80b49db3296779ec99f1e2c21d33e914))

## [2.9.0](https://github.com/ZenRows/zenrows-mcp/compare/v2.8.0...v2.9.0) (2026-10-15)


### Features

* **server:** clients got no guidance at connect on which tool to use first ([#67](https://github.com/ZenRows/zenrows-mcp/issues/67)) ([b4bd350](https://github.com/ZenRows/zenrows-mcp/commit/b4bd350b886a424603cdcdd286a5d54b1d0b2fa9))

## [2.8.0](https://github.com/ZenRows/zenrows-mcp/compare/v2.7.0...v2.8.0) (2026-10-15)


### Features

* **http:** registries and scanners could not list the tools without signing in ([#65](https://github.com/ZenRows/zenrows-mcp/issues/65)) ([46d5e39](https://github.com/ZenRows/zenrows-mcp/commit/46d5e394caa520939cf0cd6a91f058c7ae30ffe5))


### Bug Fixes

* **batch:** point an inactive subscription to Billing, not to the API key ([#57](https://github.com/ZenRows/zenrows-mcp/issues/57)) ([9634397](https://github.com/ZenRows/zenrows-mcp/commit/9634397b9bfd3f3e855714b1cb3ded195d2d66a3))

## [2.7.0](https://github.com/ZenRows/zenrows-mcp/compare/v2.6.1...v2.7.0) (2026-10-14)


### Features

* **tools:** declare openWorldHint on every tool for the ChatGPT plugin review ([#43](https://github.com/ZenRows/zenrows-mcp/issues/43)) ([2e9f15d](https://github.com/ZenRows/zenrows-mcp/commit/2e9f15d9543bffab62d807046a05d5f22b9c2ca9))


### Bug Fixes

* account_usage no longer links to checkout or upgrade pages ([#48](https://github.com/ZenRows/zenrows-mcp/issues/48)) ([a8e7465](https://github.com/ZenRows/zenrows-mcp/commit/a8e7465f99a618ee8335573c779147486b3b3314))
* **extract:** describe extract=auto as it works today ([#44](https://github.com/ZenRows/zenrows-mcp/issues/44)) ([20e9a47](https://github.com/ZenRows/zenrows-mcp/commit/20e9a476977ed93b229a512fb4004bf5e3fec09c))
* **tools:** describe automatic mode by what it does, not as getting past blocks ([#47](https://github.com/ZenRows/zenrows-mcp/issues/47)) ([1480b36](https://github.com/ZenRows/zenrows-mcp/commit/1480b36a6aea21713f0797bbdb7b3a306b096a3e))

## Older releases

Releases before 2.7.0 are not listed here; see their tags on GitHub: https://github.com/ZenRows/zenrows-mcp/tags
