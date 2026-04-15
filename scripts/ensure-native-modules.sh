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
# uname -m lies under Rosetta (reports x86_64); use sysctl for real hardware.
if [ "$needs_rebuild" = false ]; then
  if sysctl -n hw.optional.arm64 2>/dev/null | grep -q '1'; then
    REAL_ARCH="arm64"
  else
    REAL_ARCH=$(uname -m)
  fi
  BINARY_ARCH=$(file "$NATIVE_MODULE" 2>/dev/null | grep -o 'arm64\|x86_64' | head -1)

  if [ "$REAL_ARCH" = "arm64" ] && [ "$BINARY_ARCH" = "x86_64" ]; then
    echo "Native module is x86_64 but hardware is arm64, rebuilding..."
    needs_rebuild=true
  elif [ "$REAL_ARCH" = "x86_64" ] && [ "$BINARY_ARCH" = "arm64" ]; then
    echo "Native module is arm64 but hardware is x86_64, rebuilding..."
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
  # Detect real hardware arch — uname -m lies under Rosetta (reports x86_64 on arm64 hw).
  if sysctl -n hw.optional.arm64 2>/dev/null | grep -q '1'; then
    HOST_ARCH="arm64"
  else
    HOST_ARCH=$(uname -m | sed 's/x86_64/x64/')
  fi
  echo "Targeting arch: $HOST_ARCH"
  # NODE_TLS_REJECT_UNAUTHORIZED=0 works around corporate proxy / certificate
  # issues that prevent downloading Electron headers during rebuild.
  NODE_TLS_REJECT_UNAUTHORIZED=0 exec npx electron-rebuild -f -w better-sqlite3 --arch "$HOST_ARCH"
else
  echo "Native modules OK"
fi
