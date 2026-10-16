# AGENTS.md

Instructions for coding agents working on this repository: the Zenrows MCP
server (`@zenrows/mcp`), run locally over stdio and hosted at
`https://mcp.zenrows.com/mcp`. To *use* Zenrows from an agent instead, connect
that URL, or install the skills with `npx skills add ZenRows/cli`.

## Commands

```bash
npm ci
npm run typecheck           # tsc --noEmit
npm run lint                # eslint src
npm test                    # node:test, offline
npm run check:server-json   # server.json version matches package.json
npm run dev                 # stdio server with .env
npm run dev:http            # hosted server on http://localhost:3000/mcp
```

CI runs `check:server-json`, `typecheck`, `lint` and `test` on Node 20 and
22. Run them before pushing. `npm run test:e2e` hits the live Crawl API and
bills the key's account; see the README before running it.

## Code

- `src/index.ts` is the stdio entry point, `src/http.ts` the hosted one, and
  `src/server.ts` builds the server both use. Tools live in `src/tools/`.
- Hosted is not local. `createServer(..., { hosted: true })` runs on a shared
  server: a tool or resource that reads or writes the local disk must not be
  offered there, or must answer differently.
- Without a key, `/mcp` answers only the read-only discovery methods
  (`initialize`, `tools/list`, `prompts/list`, `resources/list`, ...). Every
  other request keeps the 401 `WWW-Authenticate` challenge, which is what
  starts an OAuth client's sign-in. `tests/public-discovery.test.ts` guards it.
- Tool and parameter descriptions say what a tool does and costs. Never words
  such as "stealth", "anti-bot" or "protected"; directory reviewers flag them,
  and `tests/descriptions.test.ts` fails on them. Every tool description is at
  least 30 characters.
- Every tool declares `readOnlyHint`, `destructiveHint` and `openWorldHint`;
  `tests/annotations.test.ts` checks it.

## Commits and pull requests (CI enforces these)

- Conventional Commits in commit messages and the PR title:
  `type(scope): subject`. `fix`, `feat` and `perf` need a lowercase scope.
- The subject says why the change is needed, not what the diff does.
- No trailer lines (`Co-authored-by`, `Signed-off-by`, ...), no issue-tracker
  keys, and no "generated with/by" AI attribution, in commits, PR title or
  PR body.

## Releases

- Never edit the version in `package.json`, `package-lock.json` or
  `server.json`. release-please sets them.
- Merging the `chore: release X.Y.Z` PR tags, releases, publishes to npm and
  the MCP Registry, and deploys the hosted server. Recovery when a release
  fails: README, "Releases".
