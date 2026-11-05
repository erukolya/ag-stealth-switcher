#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX_ROOT="$SCRIPT_DIR"
if [ "$(basename "$SANDBOX_ROOT")" = "scripts" ]; then
    SANDBOX_ROOT="$(dirname "$SANDBOX_ROOT")"
fi

PROXY_URL=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --proxy|--proxy-url)
            PROXY_URL="$2"
            shift 2
            ;;
        *)
            break
            ;;
    esac
done

RESOLVED_SANDBOX="$(cd "$SANDBOX_ROOT" && pwd)"
SANDBOX_HOME="$RESOLVED_SANDBOX/SandboxHome"
USER_DATA_DIR="$RESOLVED_SANDBOX/data/user-data"
EXTENSIONS_DIR="$RESOLVED_SANDBOX/data/extensions"
CONFIG_FILE="$SANDBOX_HOME/.ag-stealth-switcher/config.json"

EFFECTIVE_HOME="$SANDBOX_HOME"
EFFECTIVE_USER_DATA="$USER_DATA_DIR"

if [ -f "$CONFIG_FILE" ]; then
    MODE=$(grep -o '"mode"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG_FILE" | cut -d'"' -f4 || echo "in-place")
    PROFILE=$(grep -o '"activeProfile"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG_FILE" | cut -d'"' -f4 || echo "")

    if [ "$MODE" = "isolated-dir" ] && [ -n "$PROFILE" ] && [ "$PROFILE" != "null" ]; then
        ISO_DIR="$SANDBOX_HOME/.ag-stealth-switcher/isolated_envs/$PROFILE"
        if [ -d "$ISO_DIR/user-data" ]; then
            EFFECTIVE_HOME="$ISO_DIR/home"
            EFFECTIVE_USER_DATA="$ISO_DIR/user-data"
        fi
    fi
fi

# Export strictly isolated environment
export AG_SANDBOX_ROOT="$RESOLVED_SANDBOX"
export AG_STEALTH_USER_DATA_DIR="$EFFECTIVE_USER_DATA"
export USERPROFILE="$EFFECTIVE_HOME"
export HOME="$EFFECTIVE_HOME"
export XDG_CONFIG_HOME="$EFFECTIVE_HOME/.config"
export XDG_DATA_HOME="$EFFECTIVE_HOME/.local/share"

# Proxy handling with mandatory NO_PROXY loopback protection (Argon Fix #2)
if [ -n "$PROXY_URL" ]; then
    echo "[+] Routing sandbox outbound traffic via proxy: $PROXY_URL"
    echo "[+] Loopback protection enforced: NO_PROXY=localhost,127.0.0.1,::1"
    export HTTP_PROXY="$PROXY_URL"
    export HTTPS_PROXY="$PROXY_URL"
    export ALL_PROXY="$PROXY_URL"
    export http_proxy="$PROXY_URL"
    export https_proxy="$PROXY_URL"
    export all_proxy="$PROXY_URL"
    export NO_PROXY="localhost,127.0.0.1,::1"
    export no_proxy="localhost,127.0.0.1,::1"
else
    unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
fi

# Locate executable
if [[ "$OSTYPE" == "darwin"* ]]; then
    EXE_PATH="$RESOLVED_SANDBOX/App/Contents/MacOS/Electron"
    if [ ! -f "$EXE_PATH" ]; then
        EXE_PATH="$RESOLVED_SANDBOX/App/Antigravity.app/Contents/MacOS/Electron"
    fi
else
    EXE_PATH="$RESOLVED_SANDBOX/App/antigravity"
fi

exec "$EXE_PATH" --user-data-dir "$EFFECTIVE_USER_DATA" --extensions-dir "$EXTENSIONS_DIR" --password-store=basic "$@"
