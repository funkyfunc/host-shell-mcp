#!/bin/sh
# Starts the bundled MCP server with whatever Node.js is installed.
#
# Apps launched from the Dock get a minimal PATH that usually has no node on it
# (nvm, fnm and friends only set it up in an interactive shell), so look in the
# usual install locations too. Set HOST_SHELL_MCP_NODE to override.
#
# stdout is the MCP channel: nothing here may write to it.

root=$(cd "$(dirname "$0")/.." && pwd)

find_node() {
  if [ -n "$HOST_SHELL_MCP_NODE" ]; then echo "$HOST_SHELL_MCP_NODE"; return; fi
  command -v node 2>/dev/null && return
  for n in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME/.local/share/mise/shims/node" \
    "$HOME/.asdf/shims/node" \
    "$HOME/.local/share/fnm/aliases/default/bin/node"; do
    if [ -x "$n" ]; then echo "$n"; return; fi
  done
  # nvm: newest installed version.
  ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -V | tail -n 1
}

node=$(find_node)
if [ -z "$node" ] || [ ! -x "$node" ]; then
  echo "host-shell-mcp: could not find node. Install Node.js 20+ or set HOST_SHELL_MCP_NODE to its path." >&2
  exit 1
fi
exec "$node" "$root/server.mjs"
