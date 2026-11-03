<#
.SYNOPSIS
  Initializes an isolated secondary (portable) Antigravity IDE instance.
.PARAMETER SandboxRoot
  Target directory for the sandbox instance (default: C:\Apps\Antigravity-Sandbox).
.PARAMETER SourceIdePath
  Path to the original Antigravity installation (auto-detected if omitted).
#>
param (
    [string]$SandboxRoot = "C:\Apps\Antigravity-Sandbox",
    [string]$SourceIdePath = ""
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   Antigravity IDE 2.0+ Sandbox Deployment Initializer   " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Resolve and Validate Sandbox Path
$ResolvedSandbox = [System.IO.Path]::GetFullPath($SandboxRoot)
$PrimaryLocal = [System.IO.Path]::GetFullPath("$env:LOCALAPPDATA\Programs\Antigravity")

if ($ResolvedSandbox.Equals($PrimaryLocal, [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-Error "CRITICAL: Target SandboxRoot cannot be the primary Antigravity installation path!"
    exit 1
}

Write-Host "[+] Target Sandbox Directory: $ResolvedSandbox" -ForegroundColor Green

# 2. Locate Primary Installation Binaries
if ([string]::IsNullOrWhiteSpace($SourceIdePath)) {
    $PotentialPaths = @(
        "$env:LOCALAPPDATA\Programs\Antigravity",
        "$env:LOCALAPPDATA\Programs\Antigravity IDE",
        "C:\Program Files\Antigravity",
        "C:\Program Files\Antigravity IDE"
    )

    foreach ($p in $PotentialPaths) {
        if (Test-Path "$p\Antigravity.exe") {
            $SourceIdePath = $p
            break
        }
    }
}

if (-not (Test-Path "$SourceIdePath\Antigravity.exe")) {
    Write-Error "[-] Could not find original Antigravity.exe! Please specify -SourceIdePath manually."
    exit 1
}

Write-Host "[+] Primary Antigravity source found: $SourceIdePath" -ForegroundColor Green

# 3. Create Sandbox Directory Structure
$AppDir = Join-Path $ResolvedSandbox "App"
$SandboxHome = Join-Path $ResolvedSandbox "SandboxHome"
$DataDir = Join-Path $ResolvedSandbox "data"
$UserDataDir = Join-Path $DataDir "user-data"
$ExtensionsDir = Join-Path $DataDir "extensions"
$UserSettingsDir = Join-Path $UserDataDir "User"
$GlobalStorageDir = Join-Path $UserSettingsDir "globalStorage"
$SwitcherDir = Join-Path $SandboxHome ".ag-stealth-switcher"
$ProfilesDir = Join-Path $SwitcherDir "profiles"
$IsolatedEnvsDir = Join-Path $SwitcherDir "isolated_envs"

$FoldersToCreate = @(
    $AppDir,
    $SandboxHome,
    (Join-Path $SandboxHome ".gemini"),
    (Join-Path $SandboxHome ".antigravity-cli"),
    (Join-Path $SandboxHome "AppData\Roaming"),
    (Join-Path $SandboxHome "AppData\Local"),
    $SwitcherDir,
    $ProfilesDir,
    $IsolatedEnvsDir,
    $DataDir,
    $UserDataDir,
    $ExtensionsDir,
    $UserSettingsDir,
    $GlobalStorageDir
)

foreach ($f in $FoldersToCreate) {
    if (-not (Test-Path $f)) {
        New-Item -ItemType Directory -Path $f -Force | Out-Null
    }
}
Write-Host "[+] Sandbox directory tree created successfully." -ForegroundColor Green

# 4. Clone IDE Binaries to Sandbox App Directory
Write-Host "[*] Copying Antigravity binaries to App directory (this may take a minute)..." -ForegroundColor Yellow
robocopy "$SourceIdePath" "$AppDir" /MIR /R:2 /W:1 /XF *.log /XD Crashpad "Code Cache" | Out-Null
Write-Host "[+] Antigravity binaries copied to: $AppDir" -ForegroundColor Green

# 5. Migrate Only Safe Settings (settings.json, keybindings.json, snippets)
$PrimarySettingsDir = "$env:APPDATA\Antigravity\User"
if (Test-Path $PrimarySettingsDir) {
    Write-Host "[*] Copying safe user preferences (settings, keybindings, snippets)..." -ForegroundColor Yellow
    $SafeFiles = @("settings.json", "keybindings.json")
    foreach ($sf in $SafeFiles) {
        $src = Join-Path $PrimarySettingsDir $sf
        $dst = Join-Path $UserSettingsDir $sf
        if ((Test-Path $src) -and (-not (Test-Path $dst))) {
            Copy-Item -Path $src -Destination $dst -Force
        }
    }

    $srcSnippets = Join-Path $PrimarySettingsDir "snippets"
    $dstSnippets = Join-Path $UserSettingsDir "snippets"
    if ((Test-Path $srcSnippets) -and (-not (Test-Path $dstSnippets))) {
        Copy-Item -Path $srcSnippets -Destination $dstSnippets -Recurse -Force
    }
}

# 5.1 Enforce Strict Anti-Telemetry & Loopback Safety in Sandbox settings.json (Argon Review)
$SettingsFile = Join-Path $UserSettingsDir "settings.json"
$settingsObj = @{}
if (Test-Path $SettingsFile) {
    try {
        $raw = Get-Content $SettingsFile -Raw | ConvertFrom-Json
        foreach ($prop in $raw.PSObject.Properties) {
            $settingsObj[$prop.Name] = $prop.Value
        }
    } catch {
        $settingsObj = @{}
    }
}
$settingsObj["telemetry.telemetryLevel"] = "off"
$settingsObj["workbench.enableExperiments"] = $false
$settingsObj["update.mode"] = "none"
$settingsObj["http.noProxy"] = @("localhost", "127.0.0.1", "::1")

$settingsObj | ConvertTo-Json -Depth 5 | Set-Content -Path $SettingsFile -Encoding UTF8
Write-Host "[+] Strict anti-telemetry and http.noProxy enforced in sandbox settings.json" -ForegroundColor Green


# 6. Generate Clean, Isolated Telemetry Identifiers for Sandbox
$StorageJsonFile = Join-Path $GlobalStorageDir "storage.json"
if (-not (Test-Path $StorageJsonFile)) {
    Write-Host "[*] Generating fresh isolated telemetry IDs (machineId, sqmId, devDeviceId)..." -ForegroundColor Yellow
    $bytes = New-Object byte[] 32
    (New-Object System.Security.Cryptography.RNGCryptoServiceProvider).GetBytes($bytes)
    $machineId = ($bytes | ForEach-Object { "{0:x2}" -f $_ }) -join ""
    $sqmId = "{" + [System.Guid]::NewGuid().ToString().ToUpper() + "}"
    $devDeviceId = [System.Guid]::NewGuid().ToString()

    $telemetryObj = @{
        "telemetry.machineId" = $machineId
        "telemetry.sqmId" = $sqmId
        "telemetry.devDeviceId" = $devDeviceId
    }
    $telemetryObj | ConvertTo-Json | Set-Content -Path $StorageJsonFile -Encoding UTF8
    Write-Host "[+] Fresh telemetry identifiers initialized in storage.json." -ForegroundColor Green
}

# 7. Initialize Switcher Configuration
$ConfigFile = Join-Path $SwitcherDir "config.json"
if (-not (Test-Path $ConfigFile)) {
    $initCfg = @{
        "mode" = "in-place"
        "activeProfile" = $null
        "created" = (Get-Date).ToString("o")
    }
    $initCfg | ConvertTo-Json | Set-Content -Path $ConfigFile -Encoding UTF8
}

# 8. Copy Launcher Script to Sandbox Root
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$LauncherSrc = Join-Path $ScriptDir "launch-sandbox.ps1"
$LauncherDst = Join-Path $ResolvedSandbox "launch-sandbox.ps1"
if (Test-Path $LauncherSrc) {
    Copy-Item -Path $LauncherSrc -Destination $LauncherDst -Force
}

# 9. Create Desktop Shortcut
try {
    $WshShell = New-Object -ComObject WScript.Shell
    $DesktopPath = [System.Environment]::GetFolderPath('Desktop')
    $ShortcutPath = Join-Path $DesktopPath "Antigravity Sandbox.lnk"
    $Shortcut = $WshShell.CreateShortcut($ShortcutPath)
    $Shortcut.TargetPath = "powershell.exe"
    $Shortcut.Arguments = "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$LauncherDst`""
    $Shortcut.WorkingDirectory = $ResolvedSandbox
    $Shortcut.IconLocation = "$AppDir\Antigravity.exe,0"
    $Shortcut.Description = "Launch Isolated Secondary Antigravity IDE Instance"
    $Shortcut.Save()
    Write-Host "[+] Desktop shortcut created: $ShortcutPath" -ForegroundColor Green
} catch {
    Write-Warning "Could not create Desktop shortcut automatically: $_"
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   Deployment Complete! Launch with:                      " -ForegroundColor Cyan
Write-Host "   $LauncherDst                                           " -ForegroundColor Yellow
Write-Host "==========================================================" -ForegroundColor Cyan
