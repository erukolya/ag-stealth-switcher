import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { getSandboxPaths } from '../core/paths';
import { assertInsideSandbox, getIsolatedEnv } from '../core/sandboxEnv';
import { terminateSandboxIdeProcesses, sweepSandboxOrphanServers, sleep } from '../core/processManager';
import {
  getProfile,
  loadConfig,
  saveConfig,
  generateFreshTelemetry,
  writeTelemetry,
  writeCliToken,
  writeGeminiFileCredentials,
  clearGeminiFileCredentials,
  prepareIsolatedDir,
} from '../core/profileStore';
import { injectAuthItemsIntoDb, clearAuthItemsInDb } from '../core/sqliteInjector';

interface CliArgs {
  mode: 'in-place' | 'isolated-dir';
  sandboxRoot: string;
  target: string;
  idePid?: number;
}

function parseArgs(args: string[]): CliArgs {
  let mode: 'in-place' | 'isolated-dir' = 'in-place';
  let sandboxRoot = '';
  let target = '';
  let idePid: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--mode' && i + 1 < args.length) {
      const val = args[++i];
      if (val === 'isolated-dir' || val === 'in-place') {
        mode = val;
      }
    } else if (arg === '--sandbox' && i + 1 < args.length) {
      sandboxRoot = args[++i];
    } else if (arg === '--target' && i + 1 < args.length) {
      target = args[++i];
    } else if (arg === '--ide-pid' && i + 1 < args.length) {
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

function logWorker(sandboxRoot: string, message: string): void {
  try {
    const paths = getSandboxPaths(sandboxRoot);
    const logFile = path.join(paths.switcherDir, 'switcher.log');
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logFile, `[${timestamp}] [Worker] ${message}\n`, 'utf-8');
  } catch {
    // Ignore logging failures
  }
}

function cleanupOrphanWalFiles(dbPath: string): void {
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  try {
    if (fs.existsSync(walPath)) {
      fs.unlinkSync(walPath);
    }
    if (fs.existsSync(shmPath)) {
      fs.unlinkSync(shmPath);
    }
  } catch {
    // Best-effort cleanup
  }
}

async function main(): Promise<void> {
  const cliArgs = parseArgs(process.argv.slice(2));
  const { mode, sandboxRoot, target, idePid } = cliArgs;

  assertInsideSandbox(sandboxRoot, sandboxRoot);
  logWorker(sandboxRoot, `Switch worker started: mode=${mode}, target=${target}, idePid=${idePid || 'N/A'}`);

  // 1. Terminate running sandbox processes
  logWorker(sandboxRoot, 'Terminating running sandbox IDE and language_server processes...');
  await terminateSandboxIdeProcesses(sandboxRoot, 5000);
  await sweepSandboxOrphanServers(sandboxRoot);
  await sleep(600);

  const paths = getSandboxPaths(sandboxRoot);
  const isBlank = target === '__BLANK__';

  let launchUserDataDir = paths.userDataDir;
  let launchHomeDir = paths.sandboxHome;

  if (mode === 'in-place') {
    logWorker(sandboxRoot, 'Executing in-place profile swap...');
    cleanupOrphanWalFiles(paths.stateVscdb);

    if (isBlank) {
      logWorker(sandboxRoot, 'Clearing credentials for blank login session...');
      await clearAuthItemsInDb(paths.stateVscdb, sandboxRoot);
      cleanupOrphanWalFiles(paths.stateVscdb);

      // Generate new isolated telemetry identifiers
      const newTelemetry = generateFreshTelemetry();
      writeTelemetry(paths.storageJson, newTelemetry, sandboxRoot);

      // Remove previous CLI token and Gemini file credentials
      if (fs.existsSync(paths.cliTokenFile)) {
        fs.unlinkSync(paths.cliTokenFile);
      }
      clearGeminiFileCredentials(paths.sandboxHome, sandboxRoot);

      const config = loadConfig(sandboxRoot);
      config.mode = 'in-place';
      config.activeProfile = null;
      config.lastUpdated = new Date().toISOString();
      saveConfig(sandboxRoot, config);
    } else {
      const profile = getProfile(sandboxRoot, target);
      if (!profile) {
        logWorker(sandboxRoot, `Error: Profile ${target} not found in store!`);
        throw new Error(`Profile ${target} not found`);
      }

      logWorker(sandboxRoot, `Injecting credentials and telemetry for: ${profile.email}`);
      await injectAuthItemsIntoDb(paths.stateVscdb, profile.dbItems, sandboxRoot, profile.telemetry.devDeviceId);
      cleanupOrphanWalFiles(paths.stateVscdb);
      writeTelemetry(paths.storageJson, profile.telemetry, sandboxRoot);

      if (profile.cliToken) {
        writeCliToken(paths.cliTokenFile, profile.cliToken, profile.email, sandboxRoot);
        writeGeminiFileCredentials(paths.sandboxHome, profile.email, profile.cliToken, sandboxRoot);
      }

      const config = loadConfig(sandboxRoot);
      config.mode = 'in-place';
      config.activeProfile = profile.email;
      config.lastUpdated = new Date().toISOString();
      saveConfig(sandboxRoot, config);
    }
  } else {
    // Mode: isolated-dir
    logWorker(sandboxRoot, 'Executing isolated-dir profile swap...');

    const profileEmail = isBlank ? `blank_${Date.now()}` : target;
    const { userHome, userData } = prepareIsolatedDir(sandboxRoot, profileEmail);

    launchUserDataDir = userData;
    launchHomeDir = userHome;

    const isolatedStorageJson = path.join(userData, 'User', 'globalStorage', 'storage.json');
    const isolatedVscdb = path.join(userData, 'User', 'globalStorage', 'state.vscdb');
    cleanupOrphanWalFiles(isolatedVscdb);

    if (isBlank) {
      logWorker(sandboxRoot, 'Setting up blank isolated directory...');
      await clearAuthItemsInDb(isolatedVscdb, sandboxRoot);
      cleanupOrphanWalFiles(isolatedVscdb);
      const newTelemetry = generateFreshTelemetry();
      writeTelemetry(isolatedStorageJson, newTelemetry, sandboxRoot);
      clearGeminiFileCredentials(userHome, sandboxRoot);

      const config = loadConfig(sandboxRoot);
      config.mode = 'isolated-dir';
      config.activeProfile = null;
      config.lastUpdated = new Date().toISOString();
      saveConfig(sandboxRoot, config);
    } else {
      const profile = getProfile(sandboxRoot, target);
      if (profile) {
        logWorker(sandboxRoot, `Populating isolated directory for: ${profile.email}`);
        await injectAuthItemsIntoDb(isolatedVscdb, profile.dbItems, sandboxRoot, profile.telemetry.devDeviceId);
        cleanupOrphanWalFiles(isolatedVscdb);
        writeTelemetry(isolatedStorageJson, profile.telemetry, sandboxRoot);

        const isolatedCliToken = path.join(userHome, '.antigravity-cli', 'oauth_token.json');
        if (profile.cliToken) {
          writeCliToken(isolatedCliToken, profile.cliToken, profile.email, sandboxRoot);
          writeGeminiFileCredentials(userHome, profile.email, profile.cliToken, sandboxRoot);
        }
      }

      const config = loadConfig(sandboxRoot);
      config.mode = 'isolated-dir';
      config.activeProfile = target;
      config.lastUpdated = new Date().toISOString();
      saveConfig(sandboxRoot, config);
    }
  }

  // 2. Relaunch Antigravity inside sandbox with isolated environment
  const exePath = paths.executablePath;
  logWorker(sandboxRoot, `Relaunching Antigravity IDE: ${exePath}`);
  logWorker(sandboxRoot, `Parameters: --user-data-dir "${launchUserDataDir}" --extensions-dir "${paths.extensionsDir}" --password-store=basic`);

  const targetProfile = isBlank ? null : getProfile(sandboxRoot, target);
  const activeCfg = loadConfig(sandboxRoot);
  const effectiveProxyUrl = targetProfile?.proxyUrl || activeCfg.globalProxyUrl;

  if (effectiveProxyUrl) {
    logWorker(sandboxRoot, `Setting isolated outbound proxy: ${effectiveProxyUrl} with NO_PROXY`);
  }

  const spawnEnv = getIsolatedEnv(sandboxRoot, launchHomeDir, effectiveProxyUrl);
  const spawnArgs = [
    '--user-data-dir', launchUserDataDir,
    '--extensions-dir', paths.extensionsDir,
    '--password-store=basic',
  ];

  const child = spawn(exePath, spawnArgs, {
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
