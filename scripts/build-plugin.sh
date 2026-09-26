#!/bin/sh
# Bundles server.js (with its dependencies) into plugin/server.mjs and zips the
# plugin into dist/host-shell-mcp-cowork-plugin.zip, ready to upload in Cowork
# under Customize > Plugins.
set -eu
cd "$(dirname "$0")/.."

version=$(node -p 'require("./package.json").version')
description=$(node -p 'require("./package.json").description')

npx esbuild server.js --bundle --platform=node --format=esm --target=node20 \
  --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' \
  --log-level=warning --outfile=plugin/server.mjs

node -e '
const fs = require("fs");
fs.writeFileSync("plugin/.claude-plugin/plugin.json", JSON.stringify({
  name: "host-shell-mcp",
  version: process.argv[1],
  description: process.argv[2],
  author: { name: "funkyfunc" },
}, null, 2) + "\n");
' "$version" "$description"

mkdir -p dist
zip_path="dist/host-shell-mcp-cowork-plugin.zip"
rm -f "$zip_path"
(cd plugin && zip -qrX "../$zip_path" .claude-plugin .mcp.json scripts server.mjs)
echo "Built host-shell-mcp $version: $zip_path"
echo "Install it in Claude under Customize > Plugins > upload (remove the old version first)."
