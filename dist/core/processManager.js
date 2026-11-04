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
exports.isProcessBelongingToSandbox = isProcessBelongingToSandbox;
exports.listSandboxProcesses = listSandboxProcesses;
exports.findSandboxLanguageServer = findSandboxLanguageServer;
exports.killProcessByPid = killProcessByPid;
exports.sweepSandboxOrphanServers = sweepSandboxOrphanServers;
exports.terminateSandboxIdeProcesses = terminateSandboxIdeProcesses;
exports.sleep = sleep;
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const sandboxEnv_1 = require("./sandboxEnv");
const paths_1 = require("./paths");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
/**
 * Runs a PowerShell script reliably using -EncodedCommand (UTF-16LE Base64).
 * Eliminates all command-line quoting, whitespace, and variable expansion bugs on Windows.
 */
function runPowerShellScript(script) {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return new Promise((resolve, reject) => {
        (0, child_process_1.exec)(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`, { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
            if (err) {
                reject(err);
            }
            else {
                resolve(stdout || '');
            }
        });
    });
}
/**
 * Validates whether a process strictly belongs to the sandbox instance.
 * Strict rule: Binary must reside in <SandboxRoot>/App/, OR be a recognized Antigravity
 * binary explicitly bound to this sandbox's userDataDir.
 * NEVER matches general text editors, shells, or external IDEs.
 */
function isProcessBelongingToSandbox(exePath, procName, cmdLine, appPrefix, userDataPrefix) {
    const exeLower = exePath.toLowerCase();
    const nameLower = procName.toLowerCase();
    const cmdLower = cmdLine.toLowerCase();
    // 1. Strict primary rule: Executable is located inside <SandboxRoot>/App/
    if (exeLower.startsWith(appPrefix)) {
        return true;
    }
    // 2. Strict secondary rule: Specific Antigravity binary explicitly tied to this sandbox userDataDir
    const isAntigravityBinary = nameLower.includes('antigravity') ||
        nameLower.includes('language_server') ||
        nameLower === 'agy.exe' ||
        nameLower === 'agy';
    if (isAntigravityBinary && userDataPrefix && cmdLower.includes(userDataPrefix)) {
        return true;
    }
    return false;
}
/**
 * Lists all running processes that strictly belong to this Sandbox instance.
 * Filters strictly by executable path prefix (<SandboxRoot>/App) or Antigravity binary + userDataDir.
 */
async function listSandboxProcesses(sandboxRoot) {
    const resolvedRoot = path.resolve(sandboxRoot);
    (0, sandboxEnv_1.assertInsideSandbox)(resolvedRoot, sandboxRoot);
    const paths = (0, paths_1.getSandboxPaths)(resolvedRoot);
    const appPrefix = paths.appDir.toLowerCase();
    const userDataPrefix = paths.userDataDir.toLowerCase();
    const results = [];
    if (process.platform === 'win32') {
        // PowerShell CIM query with strict prefix matching
        const escapedAppPrefix = paths.appDir.replace(/'/g, "''");
        const psCommand = `
      $procs = Get-CimInstance Win32_Process | Where-Object {
        ($_.ExecutablePath -ne $null -and $_.ExecutablePath.StartsWith('${escapedAppPrefix}', [System.StringComparison]::OrdinalIgnoreCase))
      } | Select-Object ProcessId, Name, ExecutablePath, CommandLine
      if ($procs) { $procs | ConvertTo-Json -Compress } else { '[]' }
    `;
        try {
            const stdout = await runPowerShellScript(psCommand);
            const trimmed = stdout.trim();
            if (!trimmed || trimmed === '[]') {
                return [];
            }
            const parsed = JSON.parse(trimmed);
            const items = Array.isArray(parsed) ? parsed : [parsed];
            for (const item of items) {
                const pid = Number(item.ProcessId || item.pid);
                if (!pid) {
                    continue;
                }
                const exePath = String(item.ExecutablePath || item.executablePath || '');
                const name = String(item.Name || item.name || '');
                const cmdLine = String(item.CommandLine || item.commandLine || '');
                if (isProcessBelongingToSandbox(exePath, name, cmdLine, appPrefix, userDataPrefix)) {
                    results.push({
                        pid,
                        name,
                        executablePath: exePath,
                        commandLine: cmdLine,
                    });
                }
            }
        }
        catch (err) {
            // If CIM fails, fallback to tasklist-based parsing
            return await fallbackListWindowsProcesses(paths.appDir, paths.userDataDir);
        }
    }
    else {
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
                    }
                    catch {
                        exePath = '';
                    }
                }
                if (isProcessBelongingToSandbox(exePath || name, name, cmdLine, appPrefix, userDataPrefix)) {
                    results.push({
                        pid,
                        name,
                        executablePath: exePath || name,
                        commandLine: cmdLine,
                    });
                }
            }
        }
        catch {
            // Process list command failed
        }
    }
    return results;
}
/**
 * Fallback for Windows if PowerShell CIM is restricted.
 * Uses native PowerShell Get-Process (100% compatible with Windows 11 24H2+ where wmic is removed).
 */
async function fallbackListWindowsProcesses(appDir, userDataDir) {
    const results = [];
    const appPrefix = appDir.toLowerCase();
    const userDataPrefix = userDataDir ? userDataDir.toLowerCase() : '';
    try {
        const psCmd = `Get-Process | Where-Object { $_.Path -ne $null } | Select-Object ProcessId, ProcessName, Path | ConvertTo-Json -Compress`;
        const stdout = await runPowerShellScript(psCmd);
        const trimmed = stdout.trim();
        if (!trimmed || trimmed === '[]') {
            return [];
        }
        const parsed = JSON.parse(trimmed);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
            const pid = Number(item.ProcessId || item.Id || item.pid);
            if (!pid) {
                continue;
            }
            const exePath = String(item.Path || item.executablePath || '');
            const name = String(item.ProcessName || item.name || '');
            if (isProcessBelongingToSandbox(exePath, name, '', appPrefix, userDataPrefix)) {
                results.push({
                    pid,
                    name,
                    executablePath: exePath,
                    commandLine: '',
                });
            }
        }
    }
    catch {
        // Both CIM and fallback failed
    }
    return results;
}
/**
 * Finds the local language_server process belonging strictly to this sandbox instance.
 * Supports language_server.exe, language_server_windows_x64.exe, agy.exe, and hub processes.
 */
async function findSandboxLanguageServer(sandboxRoot) {
    // Test hook: allows integration tests to target an active language server without spawning a full sandbox
    if (process.env.AG_TEST_FORCE_PID) {
        const forcePid = parseInt(process.env.AG_TEST_FORCE_PID, 10);
        if (forcePid > 0) {
            if (process.platform === 'win32') {
                try {
                    const psCommand = `Get-CimInstance Win32_Process -Filter "ProcessId = ${forcePid}" | Select-Object ProcessId, Name, ExecutablePath, CommandLine | ConvertTo-Json -Compress`;
                    const stdout = await runPowerShellScript(psCommand);
                    const parsed = JSON.parse(stdout.trim());
                    if (parsed && (parsed.ProcessId || parsed.pid)) {
                        return {
                            pid: parsed.ProcessId || parsed.pid,
                            name: parsed.Name || parsed.name || '',
                            executablePath: parsed.ExecutablePath || parsed.executablePath || '',
                            commandLine: parsed.CommandLine || parsed.commandLine || '',
                        };
                    }
                }
                catch { }
            }
        }
    }
    const procs = await listSandboxProcesses(sandboxRoot);
    for (const proc of procs) {
        const nameLower = proc.name.toLowerCase();
        const exeLower = proc.executablePath.toLowerCase();
        const cmdLower = proc.commandLine.toLowerCase();
        if (nameLower.includes('language_server') ||
            exeLower.includes('language_server') ||
            cmdLower.includes('language_server') ||
            nameLower === 'agy.exe' ||
            nameLower === 'agy' ||
            cmdLower.includes('--subclient_type hub')) {
            return proc;
        }
    }
    return null;
}
/**
 * Force terminates a single process strictly by PID.
 */
async function killProcessByPid(pid) {
    if (pid <= 0 || pid === process.pid) {
        return;
    }
    if (process.platform === 'win32') {
        try {
            await execAsync(`taskkill /F /PID ${pid}`, { windowsHide: true });
        }
        catch {
            // Process might have already exited
        }
    }
    else {
        try {
            process.kill(pid, 'SIGKILL');
        }
        catch {
            // Process already terminated
        }
    }
}
/**
 * Terminates any orphan language_server_* or agy / agy.exe processes
 * that belong strictly to this sandbox root. NEVER touches primary instance!
 */
async function sweepSandboxOrphanServers(sandboxRoot) {
    const procs = await listSandboxProcesses(sandboxRoot);
    for (const proc of procs) {
        const nameLower = proc.name.toLowerCase();
        const exeLower = proc.executablePath.toLowerCase();
        const isLs = nameLower.includes('language_server') ||
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
async function terminateSandboxIdeProcesses(sandboxRoot, timeoutMs = 5000) {
    const paths = (0, paths_1.getSandboxPaths)(sandboxRoot);
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
            }
            catch (err) {
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
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
//# sourceMappingURL=processManager.js.map