<#
.SYNOPSIS
  Launches the isolated secondary (portable) Antigravity IDE instance.
.PARAMETER SandboxRoot
  Root path of the sandbox instance (default: script parent folder).
.PARAMETER InstallExtension
  Path to a .vsix extension package to install before launch.
.PARAMETER ProxyUrl
  Optional proxy URL (e.g. "socks5://127.0.0.1:1080" or "http://127.0.0.1:8080").
  Strictly enforces NO_PROXY="localhost,127.0.0.1,::1" to prevent loopback hangs.
#>
param (
    [string]$SandboxRoot = "",
    [string]$InstallExtension = "",
    [string]$ProxyUrl = "",
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ExtraArgs
)

$ErrorActionPreference = "Stop"

# 1. Resolve Sandbox Root
if ([string]::IsNullOrWhiteSpace($SandboxRoot)) {
    $SandboxRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
    # If script is in scripts/ subfolder, go one level up
    if ((Split-Path -Leaf $SandboxRoot).ToLower() -eq "scripts") {
        $SandboxRoot = Split-Path -Parent $SandboxRoot
    }
}

$ResolvedSandbox = [System.IO.Path]::GetFullPath($SandboxRoot)
$AppExe = Join-Path $ResolvedSandbox "App\Antigravity.exe"

if (-not (Test-Path $AppExe)) {
    Write-Error "[-] Antigravity.exe not found at: $AppExe. Please run init-sandbox.ps1 first."
    exit 1
}

$SandboxHome = Join-Path $ResolvedSandbox "SandboxHome"
$UserDataDir = Join-Path $ResolvedSandbox "data\user-data"
$ExtensionsDir = Join-Path $ResolvedSandbox "data\extensions"
$SwitcherDir = Join-Path $SandboxHome ".ag-stealth-switcher"
$ConfigFile = Join-Path $SwitcherDir "config.json"

# 2. Check Active Profile & Mode Configuration
$EffectiveHome = $SandboxHome
$EffectiveUserData = $UserDataDir
$DetectedProxy = ""

if (Test-Path $ConfigFile) {
    try {
        $cfg = Get-Content $ConfigFile -Raw | ConvertFrom-Json
        if ($cfg.mode -eq "isolated-dir" -and $cfg.activeProfile) {
            $isolatedProfileDir = Join-Path $SwitcherDir "isolated_envs\$($cfg.activeProfile)"
            $isolatedHome = Join-Path $isolatedProfileDir "home"
            $isolatedUserData = Join-Path $isolatedProfileDir "user-data"

            if (Test-Path $isolatedUserData) {
                $EffectiveHome = $isolatedHome
                $EffectiveUserData = $isolatedUserData
            }
        }

        # Check for profile-specific proxy
        if ($cfg.activeProfile) {
            $profileJsonPath = Join-Path $SwitcherDir "profiles\$($cfg.activeProfile)\profile.json"
            if (Test-Path $profileJsonPath) {
                $prof = Get-Content $profileJsonPath -Raw | ConvertFrom-Json
                if ($prof.proxyUrl) {
                    $DetectedProxy = $prof.proxyUrl
                }
            }
        }
        if (-not $DetectedProxy -and $cfg.globalProxyUrl) {
            $DetectedProxy = $cfg.globalProxyUrl
        }
    } catch {
        # Fallback to standard sandbox paths
    }
}

# 3. Configure Strict Process-Level Isolation
$env:AG_SANDBOX_ROOT = $ResolvedSandbox
$env:AG_STEALTH_USER_DATA_DIR = $EffectiveUserData
$env:USERPROFILE = $EffectiveHome
$env:HOME = $EffectiveHome
$env:APPDATA = Join-Path $EffectiveHome "AppData\Roaming"
$env:LOCALAPPDATA = Join-Path $EffectiveHome "AppData\Local"
$env:XDG_CONFIG_HOME = Join-Path $EffectiveHome ".config"
$env:XDG_DATA_HOME = Join-Path $EffectiveHome ".local\share"

# 4. Proxy Configuration with Mandatory NO_PROXY Protection (Argon Fix #2)
$EffectiveProxy = if ($ProxyUrl) { $ProxyUrl } else { $DetectedProxy }

if ($EffectiveProxy) {
    Write-Host "[+] Routing sandbox outbound traffic via proxy: $EffectiveProxy" -ForegroundColor Cyan
    Write-Host "[+] Loopback protection enforced: NO_PROXY=localhost,127.0.0.1,::1" -ForegroundColor Green
    $env:HTTP_PROXY = $EffectiveProxy
    $env:HTTPS_PROXY = $EffectiveProxy
    $env:ALL_PROXY = $EffectiveProxy
    $env:http_proxy = $EffectiveProxy
    $env:https_proxy = $EffectiveProxy
    $env:all_proxy = $EffectiveProxy
    $env:NO_PROXY = "localhost,127.0.0.1,::1"
    $env:no_proxy = "localhost,127.0.0.1,::1"
} else {
    $env:HTTP_PROXY = $null
    $env:HTTPS_PROXY = $null
    $env:ALL_PROXY = $null
    $env:http_proxy = $null
    $env:https_proxy = $null
    $env:all_proxy = $null
}

# Ensure Roaming and Local directories exist
New-Item -ItemType Directory -Path $env:APPDATA -Force | Out-Null
New-Item -ItemType Directory -Path $env:LOCALAPPDATA -Force | Out-Null

# 5. Optional: Install Extension (.vsix)
if (-not [string]::IsNullOrWhiteSpace($InstallExtension)) {
    if (Test-Path $InstallExtension) {
        Write-Host "[*] Installing extension: $InstallExtension..." -ForegroundColor Yellow
        $installProc = Start-Process -FilePath $AppExe -ArgumentList @(
            "--user-data-dir", "`"$EffectiveUserData`"",
            "--extensions-dir", "`"$ExtensionsDir`"",
            "--install-extension", "`"$InstallExtension`""
        ) -Wait -PassThru -NoNewWindow
        Write-Host "[+] Extension installed with exit code: $($installProc.ExitCode)" -ForegroundColor Green
    } else {
        Write-Warning "Extension file not found: $InstallExtension"
    }
}

# 6. Launch Antigravity IDE Instance
$LaunchArgs = @(
    "--user-data-dir", "`"$EffectiveUserData`"",
    "--extensions-dir", "`"$ExtensionsDir`"",
    "--password-store=basic"
)

if ($ExtraArgs) {
    $LaunchArgs += $ExtraArgs
}

Write-Host "[*] Launching Isolated Antigravity IDE..." -ForegroundColor Green
Write-Host "    User Data: $EffectiveUserData" -ForegroundColor DarkGray
Write-Host "    Home Dir:  $EffectiveHome" -ForegroundColor DarkGray

Start-Process -FilePath $AppExe -ArgumentList $LaunchArgs
