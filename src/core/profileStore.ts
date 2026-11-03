import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { getSandboxPaths, getProfileSnapshotDir, getIsolatedProfileEnvDir } from './paths';
import { assertInsideSandbox } from './sandboxEnv';
import { extractAuthItemsFromDb, DbItem } from './sqliteInjector';
import { getLocalUserStatus, UserStatusResult } from './lsRpcClient';

export interface DeviceTelemetry {
  machineId: string;
  sqmId: string;
  devDeviceId: string;
}

export interface ModelQuotaSnapshot {
  label: string;
  modelOrAlias: string;
  remainingPercentage: number;
  resetTime?: string;
}

export interface ProfileQuotaSnapshot {
  recordedAt: string;
  fiveHourPercent: number;
  weeklyPercent: number;
  claudeGptPercent?: number;
  models: ModelQuotaSnapshot[];
}

export interface StoredProfile {
  email: string;
  label?: string;
  capturedAt: string;
  lastUsedAt: string;
  telemetry: DeviceTelemetry;
  dbItems: DbItem[];
  cliToken?: any;
  quotas?: ProfileQuotaSnapshot;
  proxyUrl?: string; // Argon fix #2: individual proxy per profile
}

export interface SwitcherConfig {
  mode: 'in-place' | 'isolated-dir';
  activeProfile: string | null;
  globalProxyUrl?: string;
  lastUpdated?: string;
}

/**
 * Generates a fresh, cryptographically secure set of telemetry identifiers.
 */
export function generateFreshTelemetry(): DeviceTelemetry {
  return {
    machineId: crypto.randomBytes(32).toString('hex'),
    sqmId: `{${crypto.randomUUID().toUpperCase()}}`,
    devDeviceId: crypto.randomUUID(),
  };
}

/**
 * Reads telemetry IDs from storage.json, or generates new ones if missing.
 */
export function readOrGenerateTelemetry(storageJsonPath: string, sandboxRoot: string): DeviceTelemetry {
  assertInsideSandbox(storageJsonPath, sandboxRoot);

  if (fs.existsSync(storageJsonPath)) {
    try {
      const content = fs.readFileSync(storageJsonPath, 'utf-8');
      const json = JSON.parse(content);
      const machineId = json['telemetry.machineId'];
      const sqmId = json['telemetry.sqmId'];
      const devDeviceId = json['telemetry.devDeviceId'];

      if (machineId && sqmId && devDeviceId) {
        return { machineId, sqmId, devDeviceId };
      }
    } catch {
      // Parse error, will regenerate
    }
  }

  return generateFreshTelemetry();
}

/**
 * Writes telemetry identifiers into storage.json.
 */
export function writeTelemetry(storageJsonPath: string, telemetry: DeviceTelemetry, sandboxRoot: string): void {
  assertInsideSandbox(storageJsonPath, sandboxRoot);
  fs.mkdirSync(path.dirname(storageJsonPath), { recursive: true });

  let json: Record<string, any> = {};
  if (fs.existsSync(storageJsonPath)) {
    try {
      json = JSON.parse(fs.readFileSync(storageJsonPath, 'utf-8'));
    } catch {
      json = {};
    }
  }

  json['telemetry.machineId'] = telemetry.machineId;
  json['telemetry.sqmId'] = telemetry.sqmId;
  json['telemetry.devDeviceId'] = telemetry.devDeviceId;

  fs.writeFileSync(storageJsonPath, JSON.stringify(json, null, 2), 'utf-8');
}

/**
 * Reads the CLI oauth_token.json file inside SandboxHome.
 */
export function readCliToken(cliTokenPath: string, sandboxRoot: string): any | null {
  assertInsideSandbox(cliTokenPath, sandboxRoot);
  if (!fs.existsSync(cliTokenPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(cliTokenPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Writes oauth_token.json conforming to Antigravity >= 2.6.0 schema:
 * - "expires_in": 3599
 * - "id_token_email": "<user@gmail.com>"
 */
export function writeCliToken(cliTokenPath: string, tokenData: any, email: string, sandboxRoot: string): void {
  assertInsideSandbox(cliTokenPath, sandboxRoot);
  fs.mkdirSync(path.dirname(cliTokenPath), { recursive: true });

  const updatedToken = {
    ...(tokenData || {}),
    expires_in: 3599,
    id_token_email: email,
  };

  fs.writeFileSync(cliTokenPath, JSON.stringify(updatedToken, null, 2), 'utf-8');
}

/**
 * Reads file credentials from <SandboxHome>/.gemini/oauth_creds.json
 */
export function readGeminiFileCredentials(sandboxHome: string, sandboxRoot: string): any | null {
  assertInsideSandbox(sandboxHome, sandboxRoot, 'read');
  const credsPath = path.join(sandboxHome, '.gemini', 'oauth_creds.json');
  if (!fs.existsSync(credsPath)) {
    return null;
  }
  try {
    const json = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      id_token: json.id_token,
      expiry_date: json.expiry_date,
      token_type: json.token_type || 'Bearer',
      scope: json.scope,
    };
  } catch {
    return null;
  }
}

/**
 * Writes complete file-based credentials to:
 * 1. <SandboxHome>/.gemini/oauth_creds.json
 * 2. <SandboxHome>/.gemini/google_accounts.json
 * 3. <SandboxHome>/.gemini/jetski-standalone-oauth-token
 */
export function writeGeminiFileCredentials(
  sandboxHome: string,
  email: string,
  tokenData: any,
  sandboxRoot: string
): void {
  assertInsideSandbox(sandboxHome, sandboxRoot, 'write');
  const geminiDir = path.join(sandboxHome, '.gemini');
  fs.mkdirSync(geminiDir, { recursive: true });

  const rawToken = tokenData || {};
  const accessToken = rawToken.access_token || (typeof rawToken === 'string' ? rawToken : '');
  const refreshToken = rawToken.refresh_token || '';
  const idToken = rawToken.id_token || undefined;
  const expiryDate = rawToken.expiry_date || Date.now() + 3600 * 1000;

  // 1. oauth_creds.json
  const creds = {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expiry_date: expiryDate,
    ...(idToken ? { id_token: idToken } : {}),
    scope:
      'https://www.googleapis.com/auth/userinfo.email openid https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.profile',
  };
  fs.writeFileSync(path.join(geminiDir, 'oauth_creds.json'), JSON.stringify(creds, null, 2), 'utf-8');

  // 2. google_accounts.json
  const accountsInfo = {
    active: email,
    old: [],
  };
  fs.writeFileSync(path.join(geminiDir, 'google_accounts.json'), JSON.stringify(accountsInfo, null, 2), 'utf-8');

  // 3. jetski-standalone-oauth-token
  if (accessToken) {
    fs.writeFileSync(path.join(geminiDir, 'jetski-standalone-oauth-token'), accessToken, 'utf-8');
  }
}

/**
 * Clears file credentials from <SandboxHome>/.gemini/ for a fresh blank login session.
 */
export function clearGeminiFileCredentials(sandboxHome: string, sandboxRoot: string): void {
  assertInsideSandbox(sandboxHome, sandboxRoot, 'write');
  const geminiDir = path.join(sandboxHome, '.gemini');
  const filesToDelete = ['oauth_creds.json', 'google_accounts.json', 'jetski-standalone-oauth-token'];
  for (const f of filesToDelete) {
    const p = path.join(geminiDir, f);
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        // Best-effort unlink
      }
    }
  }
}

/**
 * Reads a generic credential from Windows Credential Manager via PowerShell / advapi32.
 * STRICTLY READ-ONLY: Used solely to capture newly authenticated tokens without mutating system state.
 */
export function readWindowsCredential(target: string): string | null {
  if (process.platform !== 'win32') {
    return null;
  }
  try {
    const psScript = `
      Add-Type -TypeDefinition @"
      using System;
      using System.Runtime.InteropServices;
      public class WinCred {
          [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
          public struct CREDENTIAL {
              public int Flags;
              public int Type;
              public string TargetName;
              public string Comment;
              public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
              public int CredentialBlobSize;
              public IntPtr CredentialBlob;
              public int Persist;
              public int AttributeCount;
              public IntPtr Attributes;
              public string TargetAlias;
              public string UserName;
          }
          [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
          public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);
          [DllImport("advapi32.dll", EntryPoint = "CredFree", SetLastError = true)]
          public static extern void CredFree(IntPtr cred);
          public static string Read(string target) {
              IntPtr credPtr;
              if (CredRead(target, 1, 0, out credPtr)) {
                  CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(credPtr, typeof(CREDENTIAL));
                  byte[] bytes = new byte[cred.CredentialBlobSize];
                  Marshal.Copy(cred.CredentialBlob, bytes, 0, cred.CredentialBlobSize);
                  CredFree(credPtr);
                  return System.Text.Encoding.UTF8.GetString(bytes);
              }
              return null;
          }
      }
"@
      [WinCred]::Read('${target}')
    `.replace(/\\r?\\n\\s*/g, ' ');

    const output = execSync(
      `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${psScript}"`,
      {
        windowsHide: true,
        encoding: 'utf-8',
        timeout: 4000,
      }
    );
    const trimmed = output.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

/**
 * Loads the switcher configuration (mode, activeProfile, globalProxyUrl).
 */
export function loadConfig(sandboxRoot: string): SwitcherConfig {
  const paths = getSandboxPaths(sandboxRoot);
  if (!fs.existsSync(paths.configFile)) {
    return { mode: 'in-place', activeProfile: null };
  }
  try {
    return JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'));
  } catch {
    return { mode: 'in-place', activeProfile: null };
  }
}

/**
 * Saves the switcher configuration to config.json.
 */
export function saveConfig(sandboxRoot: string, config: SwitcherConfig): void {
  const paths = getSandboxPaths(sandboxRoot);
  assertInsideSandbox(paths.configFile, sandboxRoot);
  fs.mkdirSync(path.dirname(paths.configFile), { recursive: true });
  fs.writeFileSync(paths.configFile, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Lists all stored profiles from <SandboxHome>/.ag-stealth-switcher/profiles/
 */
export function listProfiles(sandboxRoot: string): StoredProfile[] {
  const paths = getSandboxPaths(sandboxRoot);
  if (!fs.existsSync(paths.profilesDir)) {
    return [];
  }

  const profiles: StoredProfile[] = [];
  const entries = fs.readdirSync(paths.profilesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const profilePath = path.join(paths.profilesDir, entry.name, 'profile.json');
      if (fs.existsSync(profilePath)) {
        try {
          const profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
          profiles.push(profile);
        } catch {
          // Skip corrupted profile file
        }
      }
    }
  }

  return profiles.sort((a, b) => (b.lastUsedAt || '').localeCompare(a.lastUsedAt || ''));
}

/**
 * Retrieves a single stored profile by email.
 */
export function getProfile(sandboxRoot: string, email: string): StoredProfile | null {
  const profileDir = getProfileSnapshotDir(sandboxRoot, email);
  const profileFile = path.join(profileDir, 'profile.json');
  if (!fs.existsSync(profileFile)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(profileFile, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Saves a profile object to disk.
 */
export function saveProfile(sandboxRoot: string, profile: StoredProfile): void {
  const profileDir = getProfileSnapshotDir(sandboxRoot, profile.email);
  assertInsideSandbox(profileDir, sandboxRoot);
  fs.mkdirSync(profileDir, { recursive: true });

  const profileFile = path.join(profileDir, 'profile.json');
  fs.writeFileSync(profileFile, JSON.stringify(profile, null, 2), 'utf-8');
}

/**
 * Deletes a stored profile and any associated isolated directory.
 * Guards against deleting the currently active profile.
 */
export async function deleteProfile(sandboxRoot: string, email: string): Promise<void> {
  const config = loadConfig(sandboxRoot);
  if (config.activeProfile === email) {
    throw new Error(`Cannot delete active profile "${email}". Switch to another profile or Blank Profile first.`);
  }

  const profileDir = getProfileSnapshotDir(sandboxRoot, email);
  assertInsideSandbox(profileDir, sandboxRoot);
  if (fs.existsSync(profileDir)) {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }

  const isolatedDir = getIsolatedProfileEnvDir(sandboxRoot, email);
  assertInsideSandbox(isolatedDir, sandboxRoot);
  if (fs.existsSync(isolatedDir)) {
    fs.rmSync(isolatedDir, { recursive: true, force: true });
  }
}

/**
 * Offline Mathematical Quota Estimator:
 * Calculates estimated remaining percentage based on elapsed time without sending network packets.
 * If >= 5 hours elapsed since recorded snapshot, 5-hour limit is estimated as 100% recovered!
 */
export function calculateEstimatedQuota(profile: StoredProfile): {
  fiveHourPercent: number;
  weeklyPercent: number;
  isRestored: boolean;
  timeRemainingStr?: string;
} {
  if (!profile.quotas) {
    return { fiveHourPercent: 100, weeklyPercent: 100, isRestored: false };
  }

  const recordedTime = new Date(profile.quotas.recordedAt).getTime();
  const now = Date.now();
  const elapsedMs = Math.max(0, now - recordedTime);
  const elapsedHours = elapsedMs / (1000 * 60 * 60);

  let fiveHourPercent = profile.quotas.fiveHourPercent;
  let isRestored = false;

  // 5-hour window recovery logic
  if (elapsedHours >= 5) {
    fiveHourPercent = 100;
    isRestored = true;
  } else if (fiveHourPercent < 100) {
    // Proportional recovery estimate: 20% per hour
    const recovered = Math.round(elapsedHours * 20);
    fiveHourPercent = Math.min(100, profile.quotas.fiveHourPercent + recovered);
    if (fiveHourPercent >= 100) {
      isRestored = true;
    }
  }

  const weeklyPercent = profile.quotas.weeklyPercent;
  let timeRemainingStr: string | undefined;

  if (fiveHourPercent < 100) {
    const hoursLeft = Math.max(0, Math.ceil(5 - elapsedHours));
    timeRemainingStr = `resets in ~${hoursLeft}h`;
  }

  return { fiveHourPercent, weeklyPercent, isRestored, timeRemainingStr };
}

/**
 * Builds a quota snapshot object from UserStatusResult or defaults.
 */
export function buildQuotaSnapshot(status: UserStatusResult | null): ProfileQuotaSnapshot {
  const recordedAt = new Date().toISOString();
  if (!status) {
    return {
      recordedAt,
      fiveHourPercent: 100,
      weeklyPercent: 100,
      models: [],
    };
  }

  let fiveHourPercent = 100;
  let weeklyPercent = 100;
  let claudeGptPercent = 100;

  for (const m of status.models) {
    const lbl = m.label.toLowerCase();
    if (lbl.includes('5-hour') || lbl.includes('five hour')) {
      fiveHourPercent = m.remainingPercentage;
    } else if (lbl.includes('weekly')) {
      weeklyPercent = m.remainingPercentage;
    } else if (lbl.includes('claude') || lbl.includes('gpt')) {
      claudeGptPercent = m.remainingPercentage;
    }
  }

  // If specific labels weren't categorized, fallback to minQuota
  if (fiveHourPercent === 100 && status.minQuotaPercentage < 100) {
    fiveHourPercent = status.minQuotaPercentage;
  }

  return {
    recordedAt,
    fiveHourPercent,
    weeklyPercent,
    claudeGptPercent,
    models: status.models.map(m => ({
      label: m.label,
      modelOrAlias: m.modelOrAlias,
      remainingPercentage: m.remainingPercentage,
      resetTime: m.resetTime,
    })),
  };
}

/**
 * Captures the currently active session in the sandbox and stores it as a profile snapshot.
 * Auto-detects email without prompting if token or status exists.
 */
export async function captureCurrentProfile(
  sandboxRoot: string,
  emailOverride?: string
): Promise<StoredProfile> {
  const paths = getSandboxPaths(sandboxRoot);

  // 1. Read token: CLI token, or Gemini file credentials, or Windows Credential Manager fallback
  let cliToken = readCliToken(paths.cliTokenFile, sandboxRoot);
  if (!cliToken) {
    cliToken = readGeminiFileCredentials(paths.sandboxHome, sandboxRoot);
  }
  if (!cliToken && process.platform === 'win32') {
    const credStr = readWindowsCredential('gemini:antigravity');
    if (credStr) {
      try {
        const parsed = JSON.parse(credStr);
        cliToken = {
          access_token: parsed.token?.access_token || parsed.access_token,
          refresh_token: parsed.token?.refresh_token || parsed.refresh_token,
          id_token: parsed.token?.id_token || parsed.id_token,
          id_token_email: parsed.id_token_email || parsed.email,
          expiry_date: parsed.token?.expiry ? new Date(parsed.token.expiry).getTime() : undefined,
          token_type: parsed.token?.token_type || 'Bearer',
        };
      } catch {
        // Parse error
      }
    }
  }

  // 2. Resolve email automatically
  let email = emailOverride;
  if (!email && cliToken && cliToken.id_token_email) {
    email = cliToken.id_token_email;
  }

  if (!email) {
    const userStatus = await getLocalUserStatus(sandboxRoot);
    if (userStatus && userStatus.email) {
      email = userStatus.email;
    }
  }

  if (!email) {
    const config = loadConfig(sandboxRoot);
    email = config.activeProfile || `account_${Date.now()}@sandbox`;
  }

  // 3. Extract database auth rows
  const dbItems = await extractAuthItemsFromDb(paths.stateVscdb, sandboxRoot);

  // 4. Read telemetry IDs
  const telemetry = readOrGenerateTelemetry(paths.storageJson, sandboxRoot);

  // 5. Build quota snapshot on-demand
  let userStatus: UserStatusResult | null = null;
  try {
    userStatus = await getLocalUserStatus(sandboxRoot);
  } catch {
    // Local RPC may be offline, keep existing snapshot
  }

  const existing = getProfile(sandboxRoot, email);
  const now = new Date().toISOString();
  const quotas = userStatus ? buildQuotaSnapshot(userStatus) : existing?.quotas;

  if (cliToken) {
    cliToken.expires_in = 3599;
    cliToken.id_token_email = email;
  }

  const profile: StoredProfile = {
    email,
    label: email,
    capturedAt: existing ? existing.capturedAt : now,
    lastUsedAt: now,
    telemetry: existing ? existing.telemetry : telemetry,
    dbItems,
    cliToken: cliToken || existing?.cliToken,
    quotas: quotas || existing?.quotas,
    proxyUrl: existing?.proxyUrl,
  };

  saveProfile(sandboxRoot, profile);

  // Sync file credentials into sandboxHome/.gemini
  if (profile.cliToken) {
    writeGeminiFileCredentials(paths.sandboxHome, email, profile.cliToken, sandboxRoot);
  }

  const config = loadConfig(sandboxRoot);
  config.activeProfile = email;
  config.lastUpdated = now;
  saveConfig(sandboxRoot, config);

  return profile;
}

/**
 * Sets up the directory structure and links for isolated-dir mode.
 */
export function prepareIsolatedDir(sandboxRoot: string, email: string): { userHome: string; userData: string } {
  const isolatedBase = getIsolatedProfileEnvDir(sandboxRoot, email);
  assertInsideSandbox(isolatedBase, sandboxRoot);

  const userHome = path.join(isolatedBase, 'home');
  const userData = path.join(isolatedBase, 'user-data');
  const userGlobalStorage = path.join(userData, 'User', 'globalStorage');
  const userSettingsDir = path.join(userData, 'User');

  fs.mkdirSync(userHome, { recursive: true });
  fs.mkdirSync(userGlobalStorage, { recursive: true });

  const paths = getSandboxPaths(sandboxRoot);
  const masterSettings = paths.userSettingsDir;

  if (fs.existsSync(masterSettings)) {
    const filesToMirror = ['settings.json', 'keybindings.json'];
    for (const file of filesToMirror) {
      const srcFile = path.join(masterSettings, file);
      const dstFile = path.join(userSettingsDir, file);
      if (fs.existsSync(srcFile) && !fs.existsSync(dstFile)) {
        try {
          fs.copyFileSync(srcFile, dstFile);
        } catch {
          // Best-effort copy
        }
      }
    }
  }

  return { userHome, userData };
}
