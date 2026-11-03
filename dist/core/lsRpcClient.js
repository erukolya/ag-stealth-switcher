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
exports.extractCsrfToken = extractCsrfToken;
exports.findPortFromLogFile = findPortFromLogFile;
exports.findListeningPortForPid = findListeningPortForPid;
exports.getLocalUserStatus = getLocalUserStatus;
exports.getAllCascadeTrajectories = getAllCascadeTrajectories;
const https = __importStar(require("https"));
const http = __importStar(require("http"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const processManager_1 = require("./processManager");
const paths_1 = require("./paths");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
/**
 * Extracts the CSRF token from the language_server process command line.
 */
function extractCsrfToken(commandLine) {
    const match = commandLine.match(/--csrf_token[=\s]+([a-zA-Z0-9_-]+)/);
    if (match && match[1]) {
        return match[1];
    }
    return null;
}
/**
 * Resolves the port from language_server.log.
 * On Windows Antigravity IDE, language_server connects as Host-Bridge (all sockets show ESTABLISHED in netstat).
 * The port is reliably written to AppData/Roaming/Antigravity/logs/language_server.log at startup:
 * "Language server listening on random port at <PORT> for HTTPS (gRPC)"
 * "Language server listening on random port at <PORT> for HTTP"
 */
function findPortFromLogFile(logPath, pid) {
    if (!fs.existsSync(logPath)) {
        return null;
    }
    try {
        const stats = fs.statSync(logPath);
        let content;
        if (stats.size <= 10 * 1024 * 1024) {
            content = fs.readFileSync(logPath, 'utf8');
        }
        else {
            const headBuf = Buffer.alloc(1024 * 1024);
            const tailBuf = Buffer.alloc(1024 * 1024);
            const fd = fs.openSync(logPath, 'r');
            fs.readSync(fd, headBuf, 0, 1024 * 1024, 0);
            fs.readSync(fd, tailBuf, 0, 1024 * 1024, stats.size - 1024 * 1024);
            fs.closeSync(fd);
            content = headBuf.toString('utf8') + '\n' + tailBuf.toString('utf8');
        }
        if (pid && pid > 0) {
            const pidRegex = new RegExp(`Starting language server process with pid ${pid}[\\s\\S]{1,1500}?Language server listening on random port at (\\d+)`, 'i');
            const pidMatch = content.match(pidRegex);
            if (pidMatch && pidMatch[1]) {
                return parseInt(pidMatch[1], 10);
            }
        }
        const matches = Array.from(content.matchAll(/Language server listening on random port at (\d+) for (?:HTTPS|HTTP)/gi));
        if (matches.length > 0) {
            const lastMatch = matches[matches.length - 1];
            return parseInt(lastMatch[1], 10);
        }
    }
    catch {
        // Read failed
    }
    return null;
}
/**
 * Finds the local listening TCP port for a given PID on 127.0.0.1.
 * First inspects the sandbox language_server.log file (bulletproof on Windows Host-Bridge),
 * then falls back to netstat or lsof if log inspection does not yield a port.
 */
async function findListeningPortForPid(pid, sandboxRoot) {
    if (pid <= 0) {
        return null;
    }
    // 1. Primary: resolve from language_server.log inside sandbox
    if (sandboxRoot) {
        try {
            const paths = (0, paths_1.getSandboxPaths)(sandboxRoot);
            const candidateLogs = [
                path.join(paths.sandboxHome, 'AppData', 'Roaming', 'Antigravity', 'logs', 'language_server.log'),
                path.join(paths.userDataDir, 'logs', 'language_server.log'),
                path.join(paths.sandboxHome, '.antigravity-cli', 'log', 'language_server.log'),
            ];
            for (const logFile of candidateLogs) {
                const port = findPortFromLogFile(logFile, pid);
                if (port) {
                    return port;
                }
            }
        }
        catch {
            // Path resolution failed, proceed to socket inspection
        }
    }
    // 2. Fallback: Query system sockets
    if (process.platform === 'win32') {
        try {
            const { stdout } = await execAsync('netstat -ano -p tcp', { windowsHide: true });
            const lines = stdout.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.includes('LISTENING')) {
                    continue;
                }
                const parts = trimmed.split(/\s+/);
                if (parts.length >= 5) {
                    const localAddr = parts[1]; // e.g., 127.0.0.1:54321 or 0.0.0.0:54321
                    const linePid = parseInt(parts[parts.length - 1], 10);
                    if (linePid === pid) {
                        const portMatch = localAddr.match(/:(\d+)$/);
                        if (portMatch) {
                            return parseInt(portMatch[1], 10);
                        }
                    }
                }
            }
        }
        catch {
            // Netstat failed
        }
    }
    else {
        // macOS / Linux
        try {
            const { stdout } = await execAsync(`lsof -nP -iTCP -sTCP:LISTEN -a -p ${pid}`);
            const lines = stdout.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                const portMatch = trimmed.match(/:(\d+)\s+\(LISTEN\)/);
                if (portMatch) {
                    return parseInt(portMatch[1], 10);
                }
            }
        }
        catch {
            // lsof failed
        }
    }
    return null;
}
/**
 * Executes a local RPC request to 127.0.0.1.
 * Connects directly to the sandboxed Go language_server without any proxy.
 */
async function sendLocalPostRequest(port, path, csrfToken, bodyData, useHttps = true) {
    const payload = JSON.stringify(bodyData);
    const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Connect-Protocol-Version': '1',
        'X-Codeium-Csrf-Token': csrfToken,
        'Host': `127.0.0.1:${port}`,
    };
    const options = {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers,
        rejectUnauthorized: false, // Local self-signed certificate
        timeout: 3000,
    };
    return new Promise((resolve, reject) => {
        const client = useHttps ? https : http;
        const req = client.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        const parsed = JSON.parse(data);
                        resolve(parsed);
                    }
                    catch (e) {
                        reject(new Error(`Failed to parse RPC response: ${e}`));
                    }
                }
                else {
                    reject(new Error(`RPC responded with HTTP ${res.statusCode}: ${data}`));
                }
            });
        });
        req.on('error', (err) => {
            reject(err);
        });
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Local RPC request timed out'));
        });
        req.write(payload);
        req.end();
    });
}
/**
 * Fetches user status and model quotas strictly from the local sandboxed language_server.
 * Returns null if the language server is offline or not found.
 */
async function getLocalUserStatus(sandboxRoot) {
    const lsProc = await (0, processManager_1.findSandboxLanguageServer)(sandboxRoot);
    if (!lsProc) {
        return null;
    }
    const csrfToken = extractCsrfToken(lsProc.commandLine);
    if (!csrfToken) {
        return null;
    }
    const port = await findListeningPortForPid(lsProc.pid, sandboxRoot);
    if (!port) {
        return null;
    }
    const requestBody = {
        metadata: {
            ideName: 'antigravity',
            extensionName: 'antigravity',
            locale: 'en',
        },
    };
    let responseData;
    const endpoint = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
    // Try HTTPS first, then fallback to HTTP
    try {
        responseData = await sendLocalPostRequest(port, endpoint, csrfToken, requestBody, true);
    }
    catch {
        try {
            responseData = await sendLocalPostRequest(port, endpoint, csrfToken, requestBody, false);
        }
        catch {
            return null;
        }
    }
    if (!responseData) {
        return null;
    }
    const userStatus = responseData.userStatus || responseData;
    const email = userStatus.email || '';
    const planName = userStatus.planStatus?.planInfo?.planName || 'Standard';
    const models = [];
    let minQuota = 100;
    const rawConfigs = userStatus.cascadeModelConfigData?.clientModelConfigs ||
        userStatus.clientModelConfigs ||
        userStatus.modelConfigs ||
        [];
    if (Array.isArray(rawConfigs)) {
        for (const cfg of rawConfigs) {
            const label = cfg.label || cfg.modelName || 'Unknown Model';
            const modelOrAlias = cfg.modelOrAlias || cfg.modelKey || label;
            let remainingPercentage = 100;
            const qInfo = cfg.quotaInfo || {};
            if (typeof cfg.remainingPercentage === 'number') {
                remainingPercentage = Math.round(cfg.remainingPercentage);
            }
            else if (typeof cfg.remainingFraction === 'number') {
                remainingPercentage = Math.round(cfg.remainingFraction * 100);
            }
            else if (typeof qInfo.remainingPercentage === 'number') {
                remainingPercentage = Math.round(qInfo.remainingPercentage);
            }
            else if (typeof qInfo.remainingFraction === 'number') {
                remainingPercentage = Math.round(qInfo.remainingFraction * 100);
            }
            if (remainingPercentage < minQuota) {
                minQuota = remainingPercentage;
            }
            models.push({
                label,
                modelOrAlias,
                remainingPercentage,
                resetTime: cfg.resetTime || qInfo.resetTime || undefined,
            });
        }
    }
    return {
        email,
        planName,
        models,
        minQuotaPercentage: models.length > 0 ? minQuota : 100,
        raw: responseData,
    };
}
/**
 * Fetches all cascade trajectories strictly via local RPC on 127.0.0.1.
 * Returns null if language_server is offline or uncontactable.
 */
async function getAllCascadeTrajectories(sandboxRoot) {
    const lsProc = await (0, processManager_1.findSandboxLanguageServer)(sandboxRoot);
    if (!lsProc) {
        return null;
    }
    const csrfToken = extractCsrfToken(lsProc.commandLine);
    if (!csrfToken) {
        return null;
    }
    const port = await findListeningPortForPid(lsProc.pid, sandboxRoot);
    if (!port) {
        return null;
    }
    const requestBody = {
        metadata: {
            ideName: 'antigravity',
            extensionName: 'antigravity',
            locale: 'en',
        },
    };
    const endpoint = '/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories';
    try {
        return await sendLocalPostRequest(port, endpoint, csrfToken, requestBody, true);
    }
    catch {
        try {
            return await sendLocalPostRequest(port, endpoint, csrfToken, requestBody, false);
        }
        catch {
            return null;
        }
    }
}
//# sourceMappingURL=lsRpcClient.js.map