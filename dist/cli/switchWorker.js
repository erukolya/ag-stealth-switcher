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
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const child_process_1 = require("child_process");
const paths_1 = require("../core/paths");
const sandboxEnv_1 = require("../core/sandboxEnv");
const processManager_1 = require("../core/processManager");
const profileStore_1 = require("../core/profileStore");
const sqliteInjector_1 = require("../core/sqliteInjector");
function parseArgs(args) {
    let mode = 'in-place';
    let sandboxRoot = '';
    let target = '';
    let idePid;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--mode' && i + 1 < args.length) {
            const val = args[++i];
            if (val === 'isolated-dir' || val === 'in-place') {
                mode = val;
            }
        }
        else if (arg === '--sandbox' && i + 1 < args.length) {
            sandboxRoot = args[++i];
        }
        else if (arg === '--target' && i + 1 < args.length) {
            target = args[++i];
        }
        else if (arg === '--ide-pid' && i + 1 < args.length) {
            idePid = parseInt(args[++i], 10);
        }
    }
    if (!sandboxRoot) {
        throw new Error('Missing required argument: --sandbox <SandboxRoot>');
    }
    if (!target) {
        throw new Error('Missing required argument: --target <email|__BLANK__>');
    }
    return { mode, sandboxRoot: path.resolve(sandboxRoot), target, idePid };
}
function logWorker(sandboxRoot, message) {
    try {
        const paths = (0, paths_1.getSandboxPaths)(sandboxRoot);
        const logFile = path.join(paths.switcherDir, 'switcher.log');
        const timestamp = new Date().toISOString();
        fs.appendFileSync(logFile, `[${timestamp}] [Worker] ${message}\n`, 'utf-8');
    }
    catch {
        // Ignore logging failures
    }
}
/**
 * Safely checkpoints SQLite WAL file into the main database before touching state.vscdb.
 * Adheres strictly to sqlite.org guidelines: NEVER delete a non-empty -wal without checkpointing,
 * as doing so destroys uncommitted and committed transactions.
 * Returns true if WAL is clean/checkpointed, false if WAL contains unmerged data and could not be checkpointed.
 */
function safeCheckpointAndConsolidateWal(dbPath, sandboxRoot) {
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;
    if (!fs.existsSync(walPath)) {
        return true;
    }
    try {
        const stat = fs.statSync(walPath);
        if (stat.size === 0) {
            // WAL is already 0 bytes, safe to remove cleanly
            try {
                fs.unlinkSync(walPath);
            }
            catch { }
            try {
                fs.unlinkSync(shmPath);
            }
            catch { }
            return true;
        }
        logWorker(sandboxRoot, `Pending WAL detected (${stat.size} bytes). Executing PRAGMA wal_checkpoint(TRUNCATE)...`);
        // Strategy 1: Native Node.js DatabaseSync (built-in in Node 22+)
        try {
            const { DatabaseSync } = require('node:sqlite');
            if (typeof DatabaseSync === 'function') {
                const syncDb = new DatabaseSync(dbPath);
                syncDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
                syncDb.close();
            }
        }
        catch { }
        // Strategy 2: Python sqlite3 fallback
        if (fs.existsSync(walPath) && fs.statSync(walPath).size > 0) {
            try {
                const pyScript = `import sqlite3; c=sqlite3.connect(r'${dbPath}'); c.execute('PRAGMA wal_checkpoint(TRUNCATE);'); c.close()`;
                (0, child_process_1.execSync)(`python -c "${pyScript}"`, { windowsHide: true, timeout: 3000 });
            }
            catch { }
        }
        // Verify checkpoint result
        if (fs.existsSync(walPath)) {
            const postStat = fs.statSync(walPath);
            if (postStat.size === 0) {
                logWorker(sandboxRoot, 'WAL checkpoint completed successfully. 0 bytes remaining.');
                try {
                    fs.unlinkSync(walPath);
                }
                catch { }
                try {
                    fs.unlinkSync(shmPath);
                }
                catch { }
                return true;
            }
            else {
                logWorker(sandboxRoot, `CRITICAL: WAL retained ${postStat.size} uncheckpointed bytes. Refusing to delete or overwrite database.`);
                return false;
            }
        }
        return true;
    }
    catch (err) {
        logWorker(sandboxRoot, `Warning during WAL checkpoint: ${err.message || err}`);
        return false;
    }
}
async function main() {
    const cliArgs = parseArgs(process.argv.slice(2));
    const { mode, sandboxRoot, target, idePid } = cliArgs;
    (0, sandboxEnv_1.assertInsideSandbox)(sandboxRoot, sandboxRoot);
    logWorker(sandboxRoot, `Switch worker started: mode=${mode}, target=${target}, idePid=${idePid || 'N/A'}`);
    // 1. Wait gracefully for the parent IDE to flush databases and checkpoint WAL files
    if (idePid && idePid > 0) {
        logWorker(sandboxRoot, `Waiting for IDE PID ${idePid} to gracefully flush and exit...`);
        const graceStart = Date.now();
        let exited = false;
        while (Date.now() - graceStart < 6000) {
            try {
                process.kill(idePid, 0);
                await (0, processManager_1.sleep)(250);
            }
            catch {
                logWorker(sandboxRoot, `IDE PID ${idePid} exited gracefully.`);
                exited = true;
                break;
            }
        }
        // If IDE process is still running after timeout, user cancelled the exit (e.g. unsaved changes dialog)
        if (!exited) {
            logWorker(sandboxRoot, `Switch aborted: IDE PID ${idePid} did not exit within timeout (user cancelled quit dialog). Aborting switch.`);
            process.exit(0);
        }
    }
    // 2. Ensure all lingering sandbox processes are terminated and DB lock released
    logWorker(sandboxRoot, 'Ensuring sandbox processes are stopped and state locks freed...');
    await (0, processManager_1.terminateSandboxIdeProcesses)(sandboxRoot, 4000);
    await (0, processManager_1.sweepSandboxOrphanServers)(sandboxRoot);
    await (0, processManager_1.sleep)(400);
    const paths = (0, paths_1.getSandboxPaths)(sandboxRoot);
    const isBlank = target === '__BLANK__';
    let launchUserDataDir = paths.userDataDir;
    let launchHomeDir = paths.sandboxHome;
    if (mode === 'in-place') {
        logWorker(sandboxRoot, 'Executing in-place profile swap...');
        const checkpointOk = safeCheckpointAndConsolidateWal(paths.stateVscdb, sandboxRoot);
        if (!checkpointOk) {
            logWorker(sandboxRoot, 'ABORTING switch: Failed to safely checkpoint WAL on state.vscdb. Aborting to protect database integrity.');
            process.exit(1);
        }
        if (isBlank) {
            logWorker(sandboxRoot, 'Clearing credentials for blank login session...');
            await (0, sqliteInjector_1.clearAuthItemsInDb)(paths.stateVscdb, sandboxRoot);
            safeCheckpointAndConsolidateWal(paths.stateVscdb, sandboxRoot);
            // Generate new isolated telemetry identifiers
            const newTelemetry = (0, profileStore_1.generateFreshTelemetry)();
            (0, profileStore_1.writeTelemetry)(paths.storageJson, newTelemetry, sandboxRoot);
            // Remove previous CLI token and Gemini file credentials
            if (fs.existsSync(paths.cliTokenFile)) {
                fs.unlinkSync(paths.cliTokenFile);
            }
            (0, profileStore_1.clearGeminiFileCredentials)(paths.sandboxHome, sandboxRoot);
            const config = (0, profileStore_1.loadConfig)(sandboxRoot);
            config.mode = 'in-place';
            config.activeProfile = null;
            config.lastUpdated = new Date().toISOString();
            (0, profileStore_1.saveConfig)(sandboxRoot, config);
        }
        else {
            const profile = (0, profileStore_1.getProfile)(sandboxRoot, target);
            if (!profile) {
                logWorker(sandboxRoot, `Error: Profile ${target} not found in store!`);
                throw new Error(`Profile ${target} not found`);
            }
            logWorker(sandboxRoot, `Injecting credentials and telemetry for: ${profile.email}`);
            await (0, sqliteInjector_1.injectAuthItemsIntoDb)(paths.stateVscdb, profile.dbItems, sandboxRoot, profile.telemetry.devDeviceId);
            safeCheckpointAndConsolidateWal(paths.stateVscdb, sandboxRoot);
            (0, profileStore_1.writeTelemetry)(paths.storageJson, profile.telemetry, sandboxRoot);
            if (profile.cliToken) {
                (0, profileStore_1.writeCliToken)(paths.cliTokenFile, profile.cliToken, profile.email, sandboxRoot);
                (0, profileStore_1.writeGeminiFileCredentials)(paths.sandboxHome, profile.email, profile.cliToken, sandboxRoot);
            }
            const config = (0, profileStore_1.loadConfig)(sandboxRoot);
            config.mode = 'in-place';
            config.activeProfile = profile.email;
            config.lastUpdated = new Date().toISOString();
            (0, profileStore_1.saveConfig)(sandboxRoot, config);
        }
    }
    else {
        // Mode: isolated-dir
        logWorker(sandboxRoot, 'Executing isolated-dir profile swap...');
        const profileEmail = isBlank ? `blank_${Date.now()}` : target;
        const { userHome, userData } = (0, profileStore_1.prepareIsolatedDir)(sandboxRoot, profileEmail);
        launchUserDataDir = userData;
        launchHomeDir = userHome;
        const isolatedStorageJson = path.join(userData, 'User', 'globalStorage', 'storage.json');
        const isolatedVscdb = path.join(userData, 'User', 'globalStorage', 'state.vscdb');
        const checkpointOk = safeCheckpointAndConsolidateWal(isolatedVscdb, sandboxRoot);
        if (!checkpointOk) {
            logWorker(sandboxRoot, 'ABORTING switch: Failed to safely checkpoint WAL on isolated state.vscdb. Aborting to protect database integrity.');
            process.exit(1);
        }
        if (isBlank) {
            logWorker(sandboxRoot, 'Setting up blank isolated directory...');
            await (0, sqliteInjector_1.clearAuthItemsInDb)(isolatedVscdb, sandboxRoot);
            safeCheckpointAndConsolidateWal(isolatedVscdb, sandboxRoot);
            const newTelemetry = (0, profileStore_1.generateFreshTelemetry)();
            (0, profileStore_1.writeTelemetry)(isolatedStorageJson, newTelemetry, sandboxRoot);
            (0, profileStore_1.clearGeminiFileCredentials)(userHome, sandboxRoot);
            const config = (0, profileStore_1.loadConfig)(sandboxRoot);
            config.mode = 'isolated-dir';
            config.activeProfile = null;
            config.lastUpdated = new Date().toISOString();
            (0, profileStore_1.saveConfig)(sandboxRoot, config);
        }
        else {
            const profile = (0, profileStore_1.getProfile)(sandboxRoot, target);
            if (profile) {
                logWorker(sandboxRoot, `Populating isolated directory for: ${profile.email}`);
                await (0, sqliteInjector_1.injectAuthItemsIntoDb)(isolatedVscdb, profile.dbItems, sandboxRoot, profile.telemetry.devDeviceId);
                safeCheckpointAndConsolidateWal(isolatedVscdb, sandboxRoot);
                (0, profileStore_1.writeTelemetry)(isolatedStorageJson, profile.telemetry, sandboxRoot);
                const isolatedCliToken = path.join(userHome, '.antigravity-cli', 'oauth_token.json');
                if (profile.cliToken) {
                    (0, profileStore_1.writeCliToken)(isolatedCliToken, profile.cliToken, profile.email, sandboxRoot);
                    (0, profileStore_1.writeGeminiFileCredentials)(userHome, profile.email, profile.cliToken, sandboxRoot);
                }
            }
            const config = (0, profileStore_1.loadConfig)(sandboxRoot);
            config.mode = 'isolated-dir';
            config.activeProfile = target;
            config.lastUpdated = new Date().toISOString();
            (0, profileStore_1.saveConfig)(sandboxRoot, config);
        }
    }
    // 2. Relaunch Antigravity inside sandbox with isolated environment
    const exePath = paths.executablePath;
    logWorker(sandboxRoot, `Relaunching Antigravity IDE: ${exePath}`);
    logWorker(sandboxRoot, `Parameters: --user-data-dir "${launchUserDataDir}" --extensions-dir "${paths.extensionsDir}" --password-store=basic`);
    const targetProfile = isBlank ? null : (0, profileStore_1.getProfile)(sandboxRoot, target);
    const activeCfg = (0, profileStore_1.loadConfig)(sandboxRoot);
    const effectiveProxyUrl = targetProfile?.proxyUrl || activeCfg.globalProxyUrl;
    if (effectiveProxyUrl) {
        logWorker(sandboxRoot, `Setting isolated outbound proxy: ${effectiveProxyUrl} with NO_PROXY`);
    }
    const spawnEnv = (0, sandboxEnv_1.getIsolatedEnv)(sandboxRoot, launchHomeDir, effectiveProxyUrl);
    // Crucial Electron fix: Strip ELECTRON_RUN_AS_NODE so the launched IDE starts as a full GUI application
    delete spawnEnv.ELECTRON_RUN_AS_NODE;
    delete spawnEnv['ELECTRON_RUN_AS_NODE'];
    const spawnArgs = [
        '--user-data-dir', launchUserDataDir,
        '--extensions-dir', paths.extensionsDir,
        '--password-store=basic',
    ];
    const child = (0, child_process_1.spawn)(exePath, spawnArgs, {
        detached: true,
        stdio: 'ignore',
        env: spawnEnv,
        cwd: paths.appDir,
        windowsHide: false,
    });
    child.unref();
    logWorker(sandboxRoot, 'Antigravity IDE relaunched successfully. Worker exiting.');
    process.exit(0);
}
main().catch((err) => {
    console.error('[Worker Fatal Error]', err);
    process.exit(1);
});
//# sourceMappingURL=switchWorker.js.map