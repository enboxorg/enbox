#!/bin/bash
set -e

# Topological build script for the Enbox monorepo.
#
# Builds packages in dependency order. Packages at the same level of the
# dependency graph are built in parallel via `bun run --filter`.
#
# Dependency graph (each level depends only on previous levels):
#
#   L0: common, protocol-codegen, dwn-server-admin-ui  (no workspace deps)
#   L1: crypto                                          (common)
#   L2: dids                                            (common, crypto)
#   L3: browser, dwn-sdk-js                             (dids | crypto, dids)
#   L4: dwn-sql-store, dwn-clients                      (dwn-sdk-js | common, crypto, dwn-sdk-js)
#   L5: agent, dwn-server                               (common, crypto, dids, dwn-clients, dwn-sdk-js | + dwn-sql-store, dwn-server-admin-ui)
#   L6: auth                                            (agent, common, dids, dwn-clients)
#   L7: api                                             (agent, auth, common, dwn-clients)
#   L8: protocols, electrobun-dwn                       (api, dwn-sdk-js | agent, dwn-server)

echo "=== Building packages in dependency order ==="

echo "[L0] common, protocol-codegen, dwn-server-admin-ui"
bun run --filter '@enbox/common' --filter '@enbox/protocol-codegen' --filter '@enbox/dwn-server-admin-ui' build

echo "[L1] crypto"
bun run --filter '@enbox/crypto' build

echo "[L2] dids"
bun run --filter '@enbox/dids' build

echo "[L3] browser, dwn-sdk-js"
bun run --filter '@enbox/browser' --filter '@enbox/dwn-sdk-js' build

echo "[L4] dwn-sql-store, dwn-clients"
bun run --filter '@enbox/dwn-sql-store' --filter '@enbox/dwn-clients' build

echo "[L5] agent, dwn-server"
bun run --filter '@enbox/agent' --filter '@enbox/dwn-server' build

echo "[L6] auth"
bun run --filter '@enbox/auth' build

echo "[L7] api"
bun run --filter '@enbox/api' build

echo "[L8] protocols, electrobun-dwn"
bun run --filter '@enbox/protocols' --filter '@enbox/electrobun-dwn' build

echo "=== All packages built successfully ==="
