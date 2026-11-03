#!/usr/bin/env bash
set -euo pipefail

SANDBOX_ROOT="${1:-$HOME/Antigravity-Sandbox}"
SOURCE_IDE_PATH="${2:-}"

echo "=========================================================="
echo "   Antigravity IDE Sandbox Initializer (macOS / Linux)    "
echo "=========================================================="

RESOLVED_SANDBOX="$(mkdir -p "$SANDBOX_ROOT" && cd "$SANDBOX_ROOT" && pwd)"
echo "[+] Target Sandbox: $RESOLVED_SANDBOX"

# Auto-detect source binary on macOS or Linux
if [ -z "$SOURCE_IDE_PATH" ]; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
        if [ -d "/Applications/Antigravity.app" ]; then
            SOURCE_IDE_PATH="/Applications/Antigravity.app"
        fi
    else
        if [ -d "/opt/Antigravity" ]; then
            SOURCE_IDE_PATH="/opt/Antigravity"
        elif [ -d "/usr/share/antigravity" ]; then
            SOURCE_IDE_PATH="/usr/share/antigravity"
        fi
    fi
fi

if [ -z "$SOURCE_IDE_PATH" ] || [ ! -e "$SOURCE_IDE_PATH" ]; then
    echo "[-] Error: Could not locate primary Antigravity installation. Please pass path as argument 2." >&2
    exit 1
fi

echo "[+] Source installation: $SOURCE_IDE_PATH"

APP_DIR="$RESOLVED_SANDBOX/App"
SANDBOX_HOME="$RESOLVED_SANDBOX/SandboxHome"
DATA_DIR="$RESOLVED_SANDBOX/data"
USER_DATA_DIR="$DATA_DIR/user-data"
EXTENSIONS_DIR="$DATA_DIR/extensions"
USER_SETTINGS_DIR="$USER_DATA_DIR/User"
GLOBAL_STORAGE_DIR="$USER_SETTINGS_DIR/globalStorage"
SWITCHER_DIR="$SANDBOX_HOME/.ag-stealth-switcher"

mkdir -p "$APP_DIR" "$SANDBOX_HOME/.gemini" "$SANDBOX_HOME/.antigravity-cli" \
         "$SWITCHER_DIR/profiles" "$SWITCHER_DIR/isolated_envs" \
         "$GLOBAL_STORAGE_DIR" "$EXTENSIONS_DIR"

echo "[*] Copying application files..."
cp -R "$SOURCE_IDE_PATH/." "$APP_DIR/"

# Generate fresh telemetry IDs
STORAGE_JSON="$GLOBAL_STORAGE_DIR/storage.json"
if [ ! -f "$STORAGE_JSON" ]; then
    MACHINE_ID=$(openssl rand -hex 32 2>/dev/null || cat /proc/sys/kernel/random/uuid | tr -d '-')
    SQM_ID="{$({ uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid; } | tr '[:lower:]' '[:upper:]')}"
    DEV_DEVICE_ID=$({ uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid; })

    cat <<EOF > "$STORAGE_JSON"
{
  "telemetry.machineId": "$MACHINE_ID",
  "telemetry.sqmId": "$SQM_ID",
  "telemetry.devDeviceId": "$DEV_DEVICE_ID"
}
EOF
    echo "[+] Initialized isolated telemetry in storage.json"
fi

# Enforce anti-telemetry & loopback safety in settings.json
SETTINGS_JSON="$USER_SETTINGS_DIR/settings.json"
if [ ! -f "$SETTINGS_JSON" ]; then
    cat <<EOF > "$SETTINGS_JSON"
{
  "telemetry.telemetryLevel": "off",
  "workbench.enableExperiments": false,
  "update.mode": "none",
  "http.noProxy": ["localhost", "127.0.0.1", "::1"]
}
EOF
    echo "[+] Enforced anti-telemetry and http.noProxy in settings.json"
fi

# Copy launcher script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "$SCRIPT_DIR/launch-sandbox.sh" "$RESOLVED_SANDBOX/launch-sandbox.sh"
chmod +x "$RESOLVED_SANDBOX/launch-sandbox.sh"

echo "[+] Sandbox setup completed! Launch with: $RESOLVED_SANDBOX/launch-sandbox.sh"
