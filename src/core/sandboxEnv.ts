import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { getSandboxPaths } from './paths';

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

/**
 * Resolves the genuine primary user home directory, even when USERPROFILE/HOME is overridden inside a sandbox.
 */
export function getRealPrimaryHome(): string {
  try {
    const userInfo = os.userInfo();
    if (userInfo && userInfo.homedir) {
      return path.resolve(userInfo.homedir);
    }
  } catch {}

  if (process.env.ORIGINAL_USERPROFILE) {
    return path.resolve(process.env.ORIGINAL_USERPROFILE);
  }

  const curHome = os.homedir();
  const sandboxRoot = process.env.AG_SANDBOX_ROOT;
  if (sandboxRoot && curHome.toLowerCase().startsWith(path.resolve(sandboxRoot).toLowerCase())) {
    const sysDrive = process.env.SystemDrive || 'C:';
    const userName = process.env.USERNAME || process.env.USER;
    if (userName) {
      return path.resolve(path.join(sysDrive, 'Users', userName));
    }
  }
  return path.resolve(curHome);
}

/**
 * Returns primary system paths of the original untouched Antigravity installation.
 * Any access or modification to these paths from the switcher is strictly forbidden.
 */
export function getForbiddenPrimaryPaths(sandboxRoot?: string): string[] {
  const forbidden: string[] = [];
  const homeDir = getRealPrimaryHome();

  // Primary user home caches
  forbidden.push(path.join(homeDir, '.gemini'));
  forbidden.push(path.join(homeDir, '.antigravity-cli'));

  if (process.platform === 'win32') {
    const localAppData = path.join(homeDir, 'AppData', 'Local');
    const appData = path.join(homeDir, 'AppData', 'Roaming');

    forbidden.push(path.join(localAppData, 'Programs', 'Antigravity'));
    forbidden.push(path.join(localAppData, 'Programs', 'Antigravity IDE'));
    forbidden.push(path.join(appData, 'Antigravity'));
    forbidden.push(path.join(appData, 'Antigravity IDE'));
  } else if (process.platform === 'darwin') {
    forbidden.push('/Applications/Antigravity.app');
    forbidden.push(path.join(homeDir, 'Applications', 'Antigravity.app'));
    forbidden.push(path.join(homeDir, 'Library', 'Application Support', 'Antigravity'));
    forbidden.push(path.join(homeDir, 'Library', 'Application Support', 'Antigravity IDE'));
  } else {
    // Linux
    forbidden.push('/opt/Antigravity');
    forbidden.push('/usr/share/antigravity');
    const configDir = path.join(homeDir, '.config');
    forbidden.push(path.join(configDir, 'Antigravity'));
    forbidden.push(path.join(configDir, 'Antigravity IDE'));
  }

  const normalized = forbidden.map(p => path.resolve(p).toLowerCase());

  // Filter out any paths that may happen to fall inside the isolated sandbox
  if (sandboxRoot) {
    const resolvedRoot = path.resolve(sandboxRoot).toLowerCase();
    return normalized.filter(p => !p.startsWith(resolvedRoot));
  }

  return normalized;
}

/**
 * Resolves the root directory of the sandbox instance.
 * Checks AG_SANDBOX_ROOT env, or auto-detects from process.execPath.
 */
export function getSandboxRoot(): string {
  if (process.env.AG_SANDBOX_ROOT && process.env.AG_SANDBOX_ROOT.trim().length > 0) {
    return path.resolve(process.env.AG_SANDBOX_ROOT.trim());
  }

  // Auto-detect based on current binary executable location (App folder check)
  const execDir = path.dirname(process.execPath);
  const parentDir = path.dirname(execDir);

  // If running from <SandboxRoot>/App/Antigravity.exe
  if (path.basename(execDir).toLowerCase() === 'app') {
    return path.resolve(parentDir);
  }

  // If running from within scripts or tests, fallback to parent directory check
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'App')) && fs.existsSync(path.join(cwd, 'SandboxHome'))) {
    return path.resolve(cwd);
  }

  // Default fallback for safe offline initialization
  return path.resolve(cwd);
}

/**
 * Validates whether the current instance is executing safely inside an isolated sandbox.
 */
export function isRunningInsideSandbox(sandboxRoot?: string): boolean {
  const root = path.resolve(sandboxRoot || getSandboxRoot()).toLowerCase();
  const execPath = path.resolve(process.execPath).toLowerCase();

  // Rule 1: Must not match any forbidden primary paths
  const forbidden = getForbiddenPrimaryPaths();
  for (const forb of forbidden) {
    if (execPath.startsWith(forb) || root === forb) {
      return false;
    }
  }

  // Rule 2: If AG_SANDBOX_ROOT is explicitly set and executable is inside App/ or root
  if (process.env.AG_SANDBOX_ROOT) {
    return execPath.startsWith(root);
  }

  // Rule 3: Check folder markers of sandbox (<root>/App, <root>/SandboxHome)
  const paths = getSandboxPaths(root);
  if (fs.existsSync(paths.appDir) || fs.existsSync(paths.sandboxHome)) {
    return true;
  }

  return false;
}

/**
 * Security Assertion: Ensures targetPath resides strictly within sandboxRoot for write/mutation operations
 * and does not point to or touch any primary system installations.
 * Read operations (e.g. importing data from external sources) are permitted outside sandbox.
 */
export function assertInsideSandbox(
  targetPath: string,
  sandboxRoot?: string,
  op: 'read' | 'write' = 'write'
): void {
  const root = path.resolve(sandboxRoot || getSandboxRoot()).toLowerCase();
  const resolvedTarget = path.resolve(targetPath).toLowerCase();

  // If reading, allow reading external files (e.g., importing existing config or DB)
  if (op === 'read') {
    return;
  }

  // Check 1: Target must reside within sandbox root prefix
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  const isInsideSandbox = resolvedTarget === root || resolvedTarget.startsWith(rootWithSep);

  if (!isInsideSandbox) {
    throw new SecurityError(
      `Security Violation: Attempted to touch path outside of SandboxRoot! [Root: ${root}, Target: ${targetPath}]`
    );
  }

  // Check 2: Forbidden primary system paths check (mutation of real system installation is strictly blocked)
  const forbidden = getForbiddenPrimaryPaths(root);
  for (const forb of forbidden) {
    if (resolvedTarget.startsWith(forb)) {
      throw new SecurityError(
        `Security Violation: Target path is inside forbidden primary Antigravity system directory! [Target: ${targetPath}]`
      );
    }
  }
}

/**
 * Generates an isolated environment variable map for spawning child processes inside the sandbox.
 * Replaces USERPROFILE, HOME, APPDATA, LOCALAPPDATA with SandboxHome paths.
 * If proxyUrl is provided, sets outbound proxy while STRICTLY protecting loopback (127.0.0.1) via NO_PROXY (Argon Fix #2).
 */
export function getIsolatedEnv(
  sandboxRoot: string,
  customHome?: string,
  proxyUrl?: string
): NodeJS.ProcessEnv {
  const paths = getSandboxPaths(sandboxRoot);
  const homePath = customHome ? path.resolve(customHome) : paths.sandboxHome;

  assertInsideSandbox(homePath, sandboxRoot);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AG_SANDBOX_ROOT: paths.sandboxRoot,
    USERPROFILE: homePath,
    HOME: homePath,
    APPDATA: path.join(homePath, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(homePath, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(homePath, '.config'),
    XDG_DATA_HOME: path.join(homePath, '.local', 'share'),
  };

  if (proxyUrl && proxyUrl.trim().length > 0) {
    const cleanProxy = proxyUrl.trim();
    env['HTTP_PROXY'] = cleanProxy;
    env['HTTPS_PROXY'] = cleanProxy;
    env['ALL_PROXY'] = cleanProxy;
    env['http_proxy'] = cleanProxy;
    env['https_proxy'] = cleanProxy;
    env['all_proxy'] = cleanProxy;

    // Argon Fix #2: Prevent IDE loopback freeze by strictly bypassing 127.0.0.1 and localhost
    env['NO_PROXY'] = 'localhost,127.0.0.1,::1';
    env['no_proxy'] = 'localhost,127.0.0.1,::1';
  } else {
    // Strip any external system proxy if none is configured
    delete env['HTTP_PROXY'];
    delete env['HTTPS_PROXY'];
    delete env['ALL_PROXY'];
    delete env['http_proxy'];
    delete env['https_proxy'];
    delete env['all_proxy'];
    delete env['NO_PROXY'];
    delete env['no_proxy'];
  }

  return env;
}
