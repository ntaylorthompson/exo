#!/bin/bash
# Ensure native modules (better-sqlite3) are compiled for Electron's ABI
# and the correct CPU architecture.
# Runs quickly (~200ms) if already correct; rebuilds only when needed.

NATIVE_MODULE="node_modules/better-sqlite3/build/Release/better_sqlite3.node"

needs_rebuild=false

if [ ! -f "$NATIVE_MODULE" ]; then
  echo "Native module not found, rebuilding..."
  needs_rebuild=true
fi

# Check architecture matches the host machine.
# On Apple Silicon, npm may install x86_64 prebuilds that crash at runtime.
if [ "$needs_rebuild" = false ]; then
  HOST_ARCH=$(uname -m)
  BINARY_ARCH=$(file "$NATIVE_MODULE" 2>/dev/null | grep -o 'arm64\|x86_64' | head -1)

  if [ "$HOST_ARCH" = "arm64" ] && [ "$BINARY_ARCH" = "x86_64" ]; then
    echo "Native module is x86_64 but host is arm64, rebuilding..."
    needs_rebuild=true
  elif [ "$HOST_ARCH" = "x86_64" ] && [ "$BINARY_ARCH" = "arm64" ]; then
    echo "Native module is arm64 but host is x86_64, rebuilding..."
    needs_rebuild=true
  fi
fi

# Check if the binary was compiled for system Node (wrong) vs Electron (right).
# If system Node CAN load it, it means it's compiled for the wrong ABI.
if [ "$needs_rebuild" = false ]; then
  if node -e "new (require('better-sqlite3'))(':memory:')" 2>/dev/null; then
    echo "Native module compiled for system Node, rebuilding for Electron..."
    needs_rebuild=true
  fi
fi

if [ "$needs_rebuild" = true ]; then
  # NODE_TLS_REJECT_UNAUTHORIZED=0 works around corporate proxy / certificate
  # issues that prevent downloading Electron headers during rebuild.
  NODE_TLS_REJECT_UNAUTHORIZED=0 exec npx electron-rebuild -f -w better-sqlite3
else
  echo "Native modules OK"
fi
