#!/usr/bin/env bash
set -euo pipefail

missing=()
for cmd in wine mono makensis; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    missing+=("$cmd")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "Faltan dependencias para compilar Windows desde Linux: ${missing[*]}" >&2
  echo "Instala con:" >&2
  echo "  sudo apt update && sudo apt install -y wine64 mono-devel nsis" >&2
  exit 1
fi

export USE_SYSTEM_WINE=true
export WINEDLLOVERRIDES="mscoree,mshtml="

echo "Compilando instalador Windows (.exe) con electron-builder..."
npx electron-builder --win nsis --x64
