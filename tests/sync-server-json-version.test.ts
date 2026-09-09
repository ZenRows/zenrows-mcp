import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/sync-server-json-version.mjs", import.meta.url));

function fixture(version) {
  const dir = mkdtempSync(join(tmpdir(), "server-json-sync-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "@zenrows/mcp",
      version,
      description: `desc-${version}`,
    })
  );
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "sync-server-json-version.mjs"), readFileSync(script));
  writeFileSync(
    join(dir, "server.json"),
    JSON.stringify({
      name: "io.github.ZenRows/zenrows-mcp",
      description: "old",
      version: "0.0.0",
      packages: [
        {
          registryType: "npm",
          identifier: "@zenrows/mcp",
          version: "0.0.0",
          transport: { type: "stdio" },
        },
      ],
    })
  );
  return dir;
}

describe("sync-server-json-version", () => {
  it("syncs version + description from package.json", () => {
    const dir = fixture("9.9.9");
    try {
      const r = spawnSync(process.execPath, ["scripts/sync-server-json-version.mjs"], {
        cwd: dir,
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      const server = JSON.parse(readFileSync(join(dir, "server.json"), "utf8"));
      assert.equal(server.version, "9.9.9");
      assert.equal(server.packages[0].version, "9.9.9");
      assert.equal(server.description, "desc-9.9.9");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--check fails on drift", () => {
    const dir = fixture("1.2.3");
    try {
      const r = spawnSync(process.execPath, ["scripts/sync-server-json-version.mjs", "--check"], {
        cwd: dir,
        encoding: "utf8",
      });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /out of sync/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
