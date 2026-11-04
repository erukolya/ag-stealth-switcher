"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getActiveSessionPaths = void 0;
exports.generateFreshTelemetry = generateFreshTelemetry;
exports.readOrGenerateTelemetry = readOrGenerateTelemetry;
exports.writeTelemetry = writeTelemetry;
exports.readCliToken = readCliToken;
exports.writeCliToken = writeCliToken;
exports.readGeminiFileCredentials = readGeminiFileCredentials;
exports.writeGeminiFileCredentials = writeGeminiFileCredentials;
exports.clearGeminiFileCredentials = clearGeminiFileCredentials;
exports.loadConfig = loadConfig;
exports.saveConfig = saveConfig;
exports.listProfiles = listProfiles;
exports.getProfile = getProfile;
exports.saveProfile = saveProfile;
exports.deleteProfile = deleteProfile;
exports.calculateEstimatedQuota = calculateEstimatedQuota;
exports.buildQuotaSnapshot = buildQuotaSnapshot;
exports.getActiveSessionContext = getActiveSessionContext;
exports.captureCurrentProfile = captureCurrentProfile;
exports.prepareIsolatedDir = prepareIsolatedDir;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const paths_1 = require("./paths");
const sandboxEnv_1 = require("./sandboxEnv");
const sqliteInjector_1 = require("./sqliteInjector");
const lsRpcClient_1 = require("./lsRpcClient");
/**
 * Generates a fresh, cryptographically secure set of telemetry identifiers.
 */
function generateFreshTelemetry() {
    return {
        machineId: crypto.randomBytes(32).toString('hex'),
        sqmId: `{${crypto.randomUUID().toUpperCase()}}`,
        devDeviceId: crypto.randomUUID(),
    };
}
/**
 * Reads telemetry IDs from storage.json, or generates new ones if missing.
 */
function readOrGenerateTelemetry(storageJsonPath, sandboxRoot) {
    (0, sandboxEnv_1.assertInsideSandbox)(storageJsonPath, sandboxRoot);
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
        }
        catch {
            // Parse error, will regenerate
        }
    }
    return generateFreshTelemetry();
}
/**
 * Writes telemetry identifiers into storage.json.
 */
function writeTelemetry(storageJsonPath, telemetry, sandboxRoot) {
    (0, sandboxEnv_1.assertInsideSandbox)(storageJsonPath, sandboxRoot);
    fs.mkdirSync(path.dirname(storageJsonPath), { recursive: true });
    let json = {};
    if (fs.existsSync(storageJsonPath)) {
        try {
            json = JSON.parse(fs.readFileSync(storageJsonPath, 'utf-8'));
        }
        catch {
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
function readCliToken(cliTokenPath, sandboxRoot) {
    (0, sandboxEnv_1.assertInsideSandbox)(cliTokenPath, sandboxRoot);
    if (!fs.existsSync(cliTokenPath)) {
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(cliTokenPath, 'utf-8'));
    }
    catch {
        return null;
    }
}
/**
 * Writes oauth_token.json conforming to Antigravity schema:
 * Preserves authentic token lifetime without synthesizing artificial expiry.
 */
function writeCliToken(cliTokenPath, tokenData, email, sandboxRoot) {
    (0, sandboxEnv_1.assertInsideSandbox)(cliTokenPath, sandboxRoot);
    fs.mkdirSync(path.dirname(cliTokenPath), { recursive: true });
    const updatedToken = {
        ...(tokenData || {}),
        id_token_email: email,
    };
    fs.writeFileSync(cliTokenPath, JSON.stringify(updatedToken, null, 2), 'utf-8');
}
/**
 * Reads file credentials from <SandboxHome>/.gemini/oauth_creds.json
 */
function readGeminiFileCredentials(sandboxHome, sandboxRoot) {
    (0, sandboxEnv_1.assertInsideSandbox)(sandboxHome, sandboxRoot, 'read');
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
    }
    catch {
        return null;
    }
}
/**
 * Writes complete file-based credentials to:
 * 1. <SandboxHome>/.gemini/oauth_creds.json
 * 2. <SandboxHome>/.gemini/google_accounts.json
 * 3. <SandboxHome>/.gemini/jetski-standalone-oauth-token
 */
function writeGeminiFileCredentials(sandboxHome, email, tokenData, sandboxRoot) {
    (0, sandboxEnv_1.assertInsideSandbox)(sandboxHome, sandboxRoot, 'write');
    const geminiDir = path.join(sandboxHome, '.gemini');
    fs.mkdirSync(geminiDir, { recursive: true });
    const rawToken = tokenData || {};
    const accessToken = rawToken.access_token || (typeof rawToken === 'string' ? rawToken : '');
    const refreshToken = rawToken.refresh_token || '';
    const idToken = rawToken.id_token || undefined;
    // Preserve authentic expiry timestamp if present; avoid artificial Date.now() + 1h synthesis.
    // When expiry_date is 0 or absent, Antigravity language_server natively triggers OAuth refresh.
    const expiryDate = rawToken.expiry_date ?? (rawToken.expires_at ? rawToken.expires_at * 1000 : 0);
    // 1. oauth_creds.json
    const creds = {
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: 'Bearer',
        expiry_date: expiryDate,
        ...(idToken ? { id_token: idToken } : {}),
        scope: 'https://www.googleapis.com/auth/userinfo.email openid https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.profile',
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
function clearGeminiFileCredentials(sandboxHome, sandboxRoot) {
    (0, sandboxEnv_1.assertInsideSandbox)(sandboxHome, sandboxRoot, 'write');
    const geminiDir = path.join(sandboxHome, '.gemini');
    const filesToDelete = ['oauth_creds.json', 'google_accounts.json', 'jetski-standalone-oauth-token'];
    for (const f of filesToDelete) {
        const p = path.join(geminiDir, f);
        if (fs.existsSync(p)) {
            try {
                fs.unlinkSync(p);
            }
            catch {
                // Best-effort unlink
            }
        }
    }
}
/**
 * Loads the switcher configuration (mode, activeProfile, globalProxyUrl).
 */
function loadConfig(sandboxRoot) {
    const paths = (0, paths_1.getSandboxPaths)(sandboxRoot);
    if (!fs.existsSync(paths.configFile)) {
        return { mode: 'in-place', activeProfile: null };
    }
    try {
        return JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'));
    }
    catch {
        return { mode: 'in-place', activeProfile: null };
    }
}
/**
 * Saves the switcher configuration to config.json.
 */
function saveConfig(sandboxRoot, config) {
    const paths = (0, paths_1.getSandboxPaths)(sandboxRoot);
    (0, sandboxEnv_1.assertInsideSandbox)(paths.configFile, sandboxRoot);
    fs.mkdirSync(path.dirname(paths.configFile), { recursive: true });
    fs.writeFileSync(paths.configFile, JSON.stringify(config, null, 2), 'utf-8');
}
/**
 * Lists all stored profiles from <SandboxHome>/.ag-stealth-switcher/profiles/
 */
function listProfiles(sandboxRoot) {
    const paths = (0, paths_1.getSandboxPaths)(sandboxRoot);
    if (!fs.existsSync(paths.profilesDir)) {
        return [];
    }
    const profiles = [];
    const entries = fs.readdirSync(paths.profilesDir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory()) {
            const profilePath = path.join(paths.profilesDir, entry.name, 'profile.json');
            if (fs.existsSync(profilePath)) {
                try {
                    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
                    profiles.push(profile);
                }
                catch {
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
function getProfile(sandboxRoot, email) {
    const profileDir = (0, paths_1.getProfileSnapshotDir)(sandboxRoot, email);
    const profileFile = path.join(profileDir, 'profile.json');
    if (!fs.existsSync(profileFile)) {
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(profileFile, 'utf-8'));
    }
    catch {
        return null;
    }
}
/**
 * Saves a profile object to disk.
 */
function saveProfile(sandboxRoot, profile) {
    const profileDir = (0, paths_1.getProfileSnapshotDir)(sandboxRoot, profile.email);
    (0, sandboxEnv_1.assertInsideSandbox)(profileDir, sandboxRoot);
    fs.mkdirSync(profileDir, { recursive: true });
    const profileFile = path.join(profileDir, 'profile.json');
    fs.writeFileSync(profileFile, JSON.stringify(profile, null, 2), 'utf-8');
}
/**
 * Deletes a stored profile and any associated isolated directory.
 * Guards against deleting the currently active profile.
 */
async function deleteProfile(sandboxRoot, email) {
    const config = loadConfig(sandboxRoot);
    if (config.activeProfile === email) {
        throw new Error(`Cannot delete active profile "${email}". Switch to another profile or Blank Profile first.`);
    }
    const profileDir = (0, paths_1.getProfileSnapshotDir)(sandboxRoot, email);
    (0, sandboxEnv_1.assertInsideSandbox)(profileDir, sandboxRoot);
    if (fs.existsSync(profileDir)) {
        fs.rmSync(profileDir, { recursive: true, force: true });
    }
    const isolatedDir = (0, paths_1.getIsolatedProfileEnvDir)(sandboxRoot, email);
    (0, sandboxEnv_1.assertInsideSandbox)(isolatedDir, sandboxRoot);
    if (fs.existsSync(isolatedDir)) {
        fs.rmSync(isolatedDir, { recursive: true, force: true });
    }
}
/**
 * Offline Mathematical Quota Estimator:
 * Calculates estimated remaining percentage based on elapsed time without sending network packets.
 * If >= 5 hours elapsed since recorded snapshot, 5-hour limit is estimated as 100% recovered!
 */
function calculateEstimatedQuota(profile) {
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
    }
    else if (fiveHourPercent < 100) {
        // Proportional recovery estimate: 20% per hour
        const recovered = Math.round(elapsedHours * 20);
        fiveHourPercent = Math.min(100, profile.quotas.fiveHourPercent + recovered);
        if (fiveHourPercent >= 100) {
            isRestored = true;
        }
    }
    const weeklyPercent = profile.quotas.weeklyPercent;
    let timeRemainingStr;
    if (fiveHourPercent < 100) {
        const hoursLeft = Math.max(0, Math.ceil(5 - elapsedHours));
        timeRemainingStr = `resets in ~${hoursLeft}h`;
    }
    return { fiveHourPercent, weeklyPercent, isRestored, timeRemainingStr };
}
/**
 * Builds a quota snapshot object from UserStatusResult or defaults.
 */
function buildQuotaSnapshot(status) {
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
        }
        else if (lbl.includes('weekly')) {
            weeklyPercent = m.remainingPercentage;
        }
        else if (lbl.includes('claude') || lbl.includes('gpt')) {
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
 * Resolves the real unified context of the currently executing IDE session.
 * The paths are strictly determined by the physical runtime environment of the active process
 * (process.argv and process.env), and are never altered by toggling config.mode while running.
 */
function getActiveSessionContext(sandboxRoot, emailHint) {
    const defaultPaths = (0, paths_1.getSandboxPaths)(sandboxRoot);
    const config = loadConfig(sandboxRoot);
    let activeUserData = defaultPaths.userDataDir;
    let activeHome = defaultPaths.sandboxHome;
    // 1. Scan command-line arguments for explicit --user-data-dir of CURRENT process
    if (Array.isArray(process.argv)) {
        for (let i = 0; i < process.argv.length; i++) {
            const arg = process.argv[i];
            if (arg === '--user-data-dir' && i + 1 < process.argv.length) {
                activeUserData = path.resolve(process.argv[i + 1]);
            }
            else if (arg.startsWith('--user-data-dir=')) {
                activeUserData = path.resolve(arg.slice('--user-data-dir='.length));
            }
        }
    }
    // 2. Check process.env.USERPROFILE / HOME of CURRENT process
    const envHome = process.env.USERPROFILE || process.env.HOME;
    if (envHome &&
        path.resolve(envHome).toLowerCase().startsWith(path.resolve(sandboxRoot).toLowerCase()) &&
        path.resolve(envHome).toLowerCase() !== path.resolve(defaultPaths.sandboxHome).toLowerCase()) {
        activeHome = path.resolve(envHome);
    }
    // 3. Determine if the CURRENT running process is running in an isolated directory
    const isIsolatedDir = activeUserData.includes('isolated_envs') ||
        activeHome.includes('isolated_envs');
    let instanceId = undefined;
    let detectedAccount = undefined;
    if (isIsolatedDir) {
        const isolatedMarker = `${path.sep}isolated_envs${path.sep}`;
        const searchTarget = activeUserData.includes('isolated_envs') ? activeUserData : activeHome;
        const idx = searchTarget.indexOf(isolatedMarker);
        if (idx !== -1) {
            const remainder = searchTarget.slice(idx + isolatedMarker.length);
            const parts = remainder.split(path.sep);
            if (parts.length > 0 && parts[0]) {
                instanceId = parts[0];
                // If instanceId is NOT a temporary blank folder, it may be an email hint
                if (!instanceId.startsWith('blank_') && instanceId !== 'blank') {
                    detectedAccount = emailHint || instanceId;
                }
            }
        }
    }
    else {
        // In in-place mode, emailHint or config.activeProfile can be an account hint if not blank
        if (emailHint && !emailHint.startsWith('blank_')) {
            detectedAccount = emailHint;
        }
        else if (config.activeProfile && !config.activeProfile.startsWith('blank_')) {
            detectedAccount = config.activeProfile;
        }
    }
    return {
        mode: isIsolatedDir ? 'isolated-dir' : 'in-place',
        configuredMode: config.mode,
        instanceId,
        account: detectedAccount,
        userDataDir: activeUserData,
        userHome: activeHome,
        stateVscdb: path.join(activeUserData, 'User', 'globalStorage', 'state.vscdb'),
        storageJson: path.join(activeUserData, 'User', 'globalStorage', 'storage.json'),
        cliTokenFile: path.join(activeHome, '.antigravity-cli', 'oauth_token.json'),
        geminiHome: activeHome,
    };
}
exports.getActiveSessionPaths = getActiveSessionContext;
/**
 * Captures the currently active session in the sandbox and stores it as a profile snapshot.
 * Auto-detects email without prompting if token or status exists.
 * Accurately reads credentials from active session in both in-place and isolated-dir modes.
 */
async function captureCurrentProfile(sandboxRoot, emailOverride) {
    const session = getActiveSessionContext(sandboxRoot, emailOverride);
    // 1. Read token strictly from active session paths: CLI token or Gemini file credentials
    let cliToken = readCliToken(session.cliTokenFile, sandboxRoot);
    if (!cliToken) {
        cliToken = readGeminiFileCredentials(session.geminiHome, sandboxRoot);
    }
    // Fallback to default paths ONLY if the current process is running in in-place mode
    if (!cliToken && session.mode !== 'isolated-dir') {
        const defaultPaths = (0, paths_1.getSandboxPaths)(sandboxRoot);
        cliToken = readCliToken(defaultPaths.cliTokenFile, sandboxRoot);
        if (!cliToken) {
            cliToken = readGeminiFileCredentials(defaultPaths.sandboxHome, sandboxRoot);
        }
    }
    // 2. Resolve email strictly: token / RPC / non-blank account
    // If emailOverride was provided but is a blank_* ID, ignore it
    let email = emailOverride && !emailOverride.startsWith('blank_') ? emailOverride : undefined;
    // Real OAuth token email has priority 1
    if (!email && cliToken && cliToken.id_token_email && !cliToken.id_token_email.startsWith('blank_')) {
        email = cliToken.id_token_email;
    }
    // Local Language Server RPC email has priority 2
    if (!email) {
        const userStatus = await (0, lsRpcClient_1.getLocalUserStatus)(sandboxRoot);
        if (userStatus && userStatus.email && !userStatus.email.startsWith('blank_')) {
            email = userStatus.email;
        }
    }
    // Non-blank session account has priority 3
    if (!email && session.account && !session.account.startsWith('blank_')) {
        email = session.account;
    }
    // If still not resolved, check config.activeProfile if valid
    if (!email) {
        const config = loadConfig(sandboxRoot);
        if (config.activeProfile && !config.activeProfile.startsWith('blank_')) {
            email = config.activeProfile;
        }
    }
    if (!email) {
        throw new Error('Cannot determine user email for active session. Please log in or specify an email.');
    }
    // 3. Extract database auth rows from active session's state.vscdb
    let dbItems = await (0, sqliteInjector_1.extractAuthItemsFromDb)(session.stateVscdb, sandboxRoot);
    if (dbItems.length === 0 && session.mode !== 'isolated-dir') {
        const defaultPaths = (0, paths_1.getSandboxPaths)(sandboxRoot);
        if (session.stateVscdb !== defaultPaths.stateVscdb && fs.existsSync(defaultPaths.stateVscdb)) {
            dbItems = await (0, sqliteInjector_1.extractAuthItemsFromDb)(defaultPaths.stateVscdb, sandboxRoot);
        }
    }
    // 4. Read telemetry IDs from active session's storage.json
    const telemetry = readOrGenerateTelemetry(session.storageJson, sandboxRoot);
    // 5. Build quota snapshot on-demand
    let userStatus = null;
    try {
        userStatus = await (0, lsRpcClient_1.getLocalUserStatus)(sandboxRoot);
    }
    catch {
        // Local RPC may be offline, keep existing snapshot
    }
    const existing = getProfile(sandboxRoot, email);
    const now = new Date().toISOString();
    const quotas = userStatus ? buildQuotaSnapshot(userStatus) : existing?.quotas;
    // Preserve authentic token fields without synthetic expires_in overwrite
    if (cliToken) {
        cliToken.id_token_email = email;
    }
    const profile = {
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
    // Sync file credentials into active session home
    if (profile.cliToken) {
        writeGeminiFileCredentials(session.geminiHome, email, profile.cliToken, sandboxRoot);
        // Only mirror to default sandboxHome in clean-env mode
        if (session.mode !== 'isolated-dir') {
            const defaultPaths = (0, paths_1.getSandboxPaths)(sandboxRoot);
            if (session.geminiHome !== defaultPaths.sandboxHome) {
                writeGeminiFileCredentials(defaultPaths.sandboxHome, email, profile.cliToken, sandboxRoot);
            }
        }
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
function prepareIsolatedDir(sandboxRoot, email) {
    const isolatedBase = (0, paths_1.getIsolatedProfileEnvDir)(sandboxRoot, email);
    (0, sandboxEnv_1.assertInsideSandbox)(isolatedBase, sandboxRoot);
    const userHome = path.join(isolatedBase, 'home');
    const userData = path.join(isolatedBase, 'user-data');
    const userGlobalStorage = path.join(userData, 'User', 'globalStorage');
    const userSettingsDir = path.join(userData, 'User');
    fs.mkdirSync(userHome, { recursive: true });
    fs.mkdirSync(userGlobalStorage, { recursive: true });
    const paths = (0, paths_1.getSandboxPaths)(sandboxRoot);
    const masterSettings = paths.userSettingsDir;
    if (fs.existsSync(masterSettings)) {
        const filesToMirror = ['settings.json', 'keybindings.json'];
        for (const file of filesToMirror) {
            const srcFile = path.join(masterSettings, file);
            const dstFile = path.join(userSettingsDir, file);
            if (fs.existsSync(srcFile) && !fs.existsSync(dstFile)) {
                try {
                    fs.copyFileSync(srcFile, dstFile);
                }
                catch {
                    // Best-effort copy
                }
            }
        }
    }
    return { userHome, userData };
}
//# sourceMappingURL=profileStore.js.map