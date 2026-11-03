import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { assertInsideSandbox } from './sandboxEnv';
import { getSandboxPaths } from './paths';

const execAsync = promisify(exec);

export interface SandboxProcessInfo {
  pid: number;
  name: string;
  executablePath: string;
  commandLine: string;
}

/**
 * Lists all running processes that strictly belong to this Sandbox instance.
 * Filters strictly by executable path prefix (<SandboxRoot>/App) or command line arguments.
 */
export async function listSandboxProcesses(sandboxRoot: string): Promise<SandboxProcessInfo[]> {
  const resolvedRoot = path.resolve(sandboxRoot);
  assertInsideSandbox(resolvedRoot, sandboxRoot);

  const paths = getSandboxPaths(resolvedRoot);
  const appPrefix = paths.appDir.toLowerCase();
  const rootPrefix = resolvedRoot.toLowerCase();
  const results: SandboxProcessInfo[] = [];

  if (process.platform === 'win32') {
    // PowerShell CIM query with strict prefix matching
    const escapedAppPrefix = paths.appDir.replace(/'/g, "''");
    const escapedRootPrefix = resolvedRoot.replace(/'/g, "''");

    const psCommand = `
      $procs = Get-CimInstance Win32_Process | Where-Object {
        ($_.ExecutablePath -ne $null -and $_.ExecutablePath.StartsWith('${escapedAppPrefix}', [System.StringComparison]::OrdinalIgnoreCase)) -or
        ($_.CommandLine -ne $null -and ($_.CommandLine.IndexOf('${escapedRootPrefix}', [System.StringComparison]::OrdinalIgnoreCase) -ge 0))
      } | Select-Object @{Name='pid';Expression={$_.ProcessId}}, @{Name='name';Expression={$_.Name}}, @{Name='executablePath';Expression={$_.ExecutablePath}}, @{Name='commandLine';Expression={$_.CommandLine}}
      if ($procs) { $procs | ConvertTo-Json -Compress } else { '[]' }
    `.replace(/\r?\n\s*/g, ' ');

    try {
      const { stdout } = await execAsync(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${psCommand}"`, {
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      });

      const trimmed = stdout.trim();
      if (!trimmed || trimmed === '[]') {
        return [];
      }

      const parsed = JSON.parse(trimmed);
      const items = Array.isArray(parsed) ? parsed : [parsed];

      for (const item of items) {
        if (!item || !item.pid) {
          continue;
        }
        const exePath = String(item.executablePath || '');
        const cmdLine = String(item.commandLine || '');

        // Double check in JS to ensure zero leakage
        const exeLower = exePath.toLowerCase();
        const cmdLower = cmdLine.toLowerCase();

        if (exeLower.startsWith(appPrefix) || cmdLower.includes(rootPrefix)) {
          results.push({
            pid: Number(item.pid),
            name: String(item.name || ''),
            executablePath: exePath,
            commandLine: cmdLine,
          });
        }
      }
    } catch (err) {
      // If CIM fails, fallback to tasklist-based parsing
      return await fallbackListWindowsProcesses(paths.appDir, resolvedRoot);
    }
  } else {
    // macOS / Linux POSIX process scanning
    try {
      const { stdout } = await execAsync('ps -eo pid=,comm=,args=', { maxBuffer: 10 * 1024 * 1024 });
      const lines = stdout.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        const match = trimmed.match(/^(\d+)\s+(\S+)\s+(.*)$/);
        if (!match) {
          continue;
        }

        const pid = parseInt(match[1], 10);
        const name = match[2];
        const cmdLine = match[3];

        let exePath = '';
        if (process.platform === 'linux') {
          try {
            exePath = fs.readlinkSync(`/proc/${pid}/exe`);
          } catch {
            exePath = '';
          }
        }

        const exeLower = exePath.toLowerCase();
        const cmdLower = cmdLine.toLowerCase();

        if (
          (exeLower && exeLower.startsWith(appPrefix)) ||
          cmdLower.includes(appPrefix) ||
          cmdLower.includes(rootPrefix)
        ) {
          results.push({
            pid,
            name,
            executablePath: exePath || name,
            commandLine: cmdLine,
          });
        }
      }
    } catch {
      // Process list command failed
    }
  }

  return results;
}

/**
 * Fallback for Windows if PowerShell CIM is restricted.
 * Uses native PowerShell Get-Process (100% compatible with Windows 11 24H2+ where wmic is removed).
 */
async function fallbackListWindowsProcesses(appDir: string, rootDir: string): Promise<SandboxProcessInfo[]> {
  const results: SandboxProcessInfo[] = [];
  const appPrefix = appDir.toLowerCase();
  const rootPrefix = rootDir.toLowerCase();

  try {
    const psCmd = `Get-Process | Where-Object { $_.Path -ne $null } | Select-Object @{Name='pid';Expression={$_.Id}}, @{Name='name';Expression={$_.ProcessName}}, @{Name='executablePath';Expression={$_.Path}}, @{Name='commandLine';Expression={''}} | ConvertTo-Json -Compress`;
    const { stdout } = await execAsync(
      `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${psCmd}"`,
      {
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      }
    );

    const trimmed = stdout.trim();
    if (!trimmed || trimmed === '[]') {
      return [];
    }

    const parsed = JSON.parse(trimmed);
    const items = Array.isArray(parsed) ? parsed : [parsed];

    for (const item of items) {
      if (!item || !item.pid) {
        continue;
      }
      const exePath = String(item.executablePath || '');
      const exeLower = exePath.toLowerCase();

      if (exeLower.startsWith(appPrefix) || exeLower.includes(rootPrefix)) {
        results.push({
          pid: Number(item.pid),
          name: String(item.name || ''),
          executablePath: exePath,
          commandLine: String(item.commandLine || ''),
        });
      }
    }
  } catch {
    // Both CIM and fallback failed
  }

  return results;
}

/**
 * Finds the local language_server process belonging strictly to this sandbox instance.
 * Supports language_server.exe, language_server_windows_x64.exe, agy.exe, and hub processes.
 */
export async function findSandboxLanguageServer(sandboxRoot: string): Promise<SandboxProcessInfo | null> {
  const procs = await listSandboxProcesses(sandboxRoot);
  for (const proc of procs) {
    const nameLower = proc.name.toLowerCase();
    const exeLower = proc.executablePath.toLowerCase();
    const cmdLower = proc.commandLine.toLowerCase();

    if (
      nameLower.includes('language_server') ||
      exeLower.includes('language_server') ||
      cmdLower.includes('language_server') ||
      nameLower === 'agy.exe' ||
      nameLower === 'agy' ||
      cmdLower.includes('--subclient_type hub')
    ) {
      return proc;
    }
  }
  return null;
}

/**
 * Force terminates a single process strictly by PID.
 */
export async function killProcessByPid(pid: number): Promise<void> {
  if (pid <= 0 || pid === process.pid) {
    return;
  }

  if (process.platform === 'win32') {
    try {
      await execAsync(`taskkill /F /PID ${pid}`, { windowsHide: true });
    } catch {
      // Process might have already exited
    }
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Process already terminated
    }
  }
}

/**
 * Terminates any orphan language_server_* or agy / agy.exe processes
 * that belong strictly to this sandbox root. NEVER touches primary instance!
 */
export async function sweepSandboxOrphanServers(sandboxRoot: string): Promise<void> {
  const procs = await listSandboxProcesses(sandboxRoot);

  for (const proc of procs) {
    const nameLower = proc.name.toLowerCase();
    const exeLower = proc.executablePath.toLowerCase();

    const isLs =
      nameLower.includes('language_server') ||
      exeLower.includes('language_server') ||
      nameLower === 'agy.exe' ||
      nameLower === 'agy';

    if (isLs) {
      await killProcessByPid(proc.pid);
    }
  }
}

/**
 * Terminates all sandbox IDE and Electron processes and waits until state.vscdb is unlocked.
 */
export async function terminateSandboxIdeProcesses(sandboxRoot: string, timeoutMs: number = 5000): Promise<void> {
  const paths = getSandboxPaths(sandboxRoot);
  const procs = await listSandboxProcesses(sandboxRoot);

  // 1. Terminate all sandbox processes
  for (const proc of procs) {
    await killProcessByPid(proc.pid);
  }

  // 2. Poll until state.vscdb is unlocked
  const startTime = Date.now();
  if (fs.existsSync(paths.stateVscdb)) {
    while (Date.now() - startTime < timeoutMs) {
      try {
        const fd = fs.openSync(paths.stateVscdb, 'r+');
        fs.closeSync(fd);
        // File successfully opened exclusively, lock is free
        break;
      } catch (err: any) {
        if (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') {
          await sleep(200);
          continue;
        }
        // Non-lock error
        break;
      }
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
