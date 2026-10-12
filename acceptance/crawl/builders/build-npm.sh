#!/usr/bin/env bash
# Runs in the Node image. Builds the npm tarball a release would publish: the repo's own
# install and build, then npm pack. Only artifact/*.tgz leaves this container.
set -euo pipefail
cp -a /out/source /build && cd /build
if [ -f pnpm-lock.yaml ]; then
  npm install -g --no-audit --no-fund "pnpm@$PNPM_VERSION" >/dev/null
  pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store
  pnpm run build
else
  npm ci --no-audit --no-fund
  npm run build
fi
rm -rf /out/artifact && mkdir -p /out/artifact
npm pack --pack-destination /out/artifact 2>&1 | tail -n 60
ls -l /out/artifact
