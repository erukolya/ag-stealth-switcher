import * as path from 'path';

export interface SandboxPaths {
  sandboxRoot: string;
  appDir: string;
  executablePath: string;
  sandboxHome: string;
  geminiDir: string;
  cliTokenDir: string;
  cliTokenFile: string;
  switcherDir: string;
  profilesDir: string;
  isolatedEnvsDir: string;
  configFile: string;
  dataDir: string;
  userDataDir: string;
  extensionsDir: string;
  userSettingsDir: string;
  globalStorageDir: string;
  stateVscdb: string;
  storageJson: string;
}

export function getPlatformExecutableName(): string {
  if (process.platform === 'win32') {
    return 'Antigravity.exe';
  } else if (process.platform === 'darwin') {
    return 'Antigravity.app/Contents/MacOS/Electron';
  }
  return 'antigravity';
}

export function getSandboxPaths(sandboxRoot: string): SandboxPaths {
  const resolvedRoot = path.resolve(sandboxRoot);
  const appDir = path.join(resolvedRoot, 'App');
  const exeName = getPlatformExecutableName();
  const executablePath = path.join(appDir, exeName);

  const sandboxHome = path.join(resolvedRoot, 'SandboxHome');
  const geminiDir = path.join(sandboxHome, '.gemini');
  const cliTokenDir = path.join(sandboxHome, '.antigravity-cli');
  const cliTokenFile = path.join(cliTokenDir, 'oauth_token.json');

  const switcherDir = path.join(sandboxHome, '.ag-stealth-switcher');
  const profilesDir = path.join(switcherDir, 'profiles');
  const isolatedEnvsDir = path.join(switcherDir, 'isolated_envs');
  const configFile = path.join(switcherDir, 'config.json');

  const dataDir = path.join(resolvedRoot, 'data');
  const userDataDir = path.join(dataDir, 'user-data');
  const extensionsDir = path.join(dataDir, 'extensions');

  const userSettingsDir = path.join(userDataDir, 'User');
  const globalStorageDir = path.join(userSettingsDir, 'globalStorage');
  const stateVscdb = path.join(globalStorageDir, 'state.vscdb');
  const storageJson = path.join(globalStorageDir, 'storage.json');

  return {
    sandboxRoot: resolvedRoot,
    appDir,
    executablePath,
    sandboxHome,
    geminiDir,
    cliTokenDir,
    cliTokenFile,
    switcherDir,
    profilesDir,
    isolatedEnvsDir,
    configFile,
    dataDir,
    userDataDir,
    extensionsDir,
    userSettingsDir,
    globalStorageDir,
    stateVscdb,
    storageJson,
  };
}

export function getProfileSnapshotDir(sandboxRoot: string, email: string): string {
  const safeName = sanitizeProfileName(email);
  return path.join(getSandboxPaths(sandboxRoot).profilesDir, safeName);
}

export function getIsolatedProfileEnvDir(sandboxRoot: string, email: string): string {
  const safeName = sanitizeProfileName(email);
  return path.join(getSandboxPaths(sandboxRoot).isolatedEnvsDir, safeName);
}

export function sanitizeProfileName(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, '_').trim();
}
