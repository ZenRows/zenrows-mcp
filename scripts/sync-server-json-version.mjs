#!/usr/bin/env node
/**
 * Keep server.json version fields aligned with package.json (or an explicit VERSION).
 *
 * Usage:
 *   node scripts/sync-server-json-version.mjs           # from package.json
 *   VERSION=2.2.0 node scripts/sync-server-json-version.mjs
 *   node scripts/sync-server-json-version.mjs --check   # exit 1 on drift
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(root, "package.json");
const serverPath = join(root, "server.json");

const checkOnly = process.argv.includes("--check");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const version = process.env.VERSION?.replace(/^v/, "") || pkg.version;

if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`Invalid version: ${version}`);
  process.exit(1);
}

const server = JSON.parse(readFileSync(serverPath, "utf8"));
const npmPkg = server.packages?.find((p) => p.registryType === "npm");

const drifts = [];
if (server.version !== version) drifts.push(`server.version=${server.version}`);
if (!npmPkg) drifts.push("missing npm package entry");
else if (npmPkg.version !== version) drifts.push(`packages[npm].version=${npmPkg.version}`);

if (checkOnly) {
  if (drifts.length) {
    console.error(
      `server.json out of sync with ${version} (package.json${process.env.VERSION ? " / VERSION" : ""}): ${drifts.join(
        ", "
      )}`
    );
    process.exit(1);
  }
  console.log(`server.json OK @ ${version}`);
  process.exit(0);
}

server.version = version;
if (npmPkg) npmPkg.version = version;

// Keep package description as the catalog blurb when present.
if (typeof pkg.description === "string" && pkg.description.trim()) {
  server.description = pkg.description;
}

writeFileSync(serverPath, `${JSON.stringify(server, null, 2)}\n`);
console.log(`Synced server.json → ${version}`);
