#!/usr/bin/env bash
# Entry point in the clean node container: record the tool versions, then run the checks.
set -uo pipefail
printf '{"node":"%s","npm":"%s","os":"%s"}\n' "$(node -v)" "$(npm -v)" "$(. /etc/os-release; echo "$PRETTY_NAME")" > /results/env.json
export npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
node /harness/test.mjs
