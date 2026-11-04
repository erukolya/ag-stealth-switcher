import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { findSandboxLanguageServer } from './processManager';
import { getSandboxPaths } from './paths';

const execAsync = promisify(exec);

export interface ModelQuotaInfo {
  label: string;
  modelOrAlias: string;
  remainingPercentage: number;
  resetTime?: string;
}

export interface UserStatusResult {
  email: string;
  planName: string;
  models: ModelQuotaInfo[];
  minQuotaPercentage: number;
  raw?: any;
}

/**
 * Extracts the CSRF token from the language_server process command line.
 */
export function extractCsrfToken(commandLine: string): string | null {
  const match = commandLine.match(/--csrf_token[=\s]+([a-zA-Z0-9_-]+)/);
  if (match && match[1]) {
    return match[1];
  }
  return null;
}

export interface LanguageServerPorts {
  httpsPort: number | null;
  httpPort: number | null;
}

/**
 * Resolves the ports from language_server.log.
 * Explicitly separates HTTPS (gRPC) port and HTTP port to eliminate SSL handshake failures.
 */
export function findServerPortsFromLogFile(logPath: string, pid?: number): LanguageServerPorts {
  const result: LanguageServerPorts = { httpsPort: null, httpPort: null };
  if (!fs.existsSync(logPath)) {
    return result;
  }
  try {
    const stats = fs.statSync(logPath);
    let content: string;
    if (stats.size <= 10 * 1024 * 1024) {
      content = fs.readFileSync(logPath, 'utf8');
    } else {
      const headBuf = Buffer.alloc(1024 * 1024);
      const tailBuf = Buffer.alloc(1024 * 1024);
      const fd = fs.openSync(logPath, 'r');
      fs.readSync(fd, headBuf, 0, 1024 * 1024, 0);
      fs.readSync(fd, tailBuf, 0, 1024 * 1024, stats.size - 1024 * 1024);
      fs.closeSync(fd);
      content = headBuf.toString('utf8') + '\n' + tailBuf.toString('utf8');
    }

    let searchContent = content;
    if (pid && pid > 0) {
      const pidRegex = new RegExp(`Starting language server process with pid ${pid}[\\s\\S]{1,3000}`, 'i');
      const pidMatch = content.match(pidRegex);
      if (pidMatch) {
        searchContent = pidMatch[0];
      }
    }

    const httpsMatches = Array.from(
      searchContent.matchAll(/Language server listening on random port at (\d+) for HTTPS/gi)
    );
    if (httpsMatches.length > 0) {
      result.httpsPort = parseInt(httpsMatches[httpsMatches.length - 1][1], 10);
    }

    const httpMatches = Array.from(
      searchContent.matchAll(/Language server listening on random port at (\d+) for HTTP/gi)
    );
    if (httpMatches.length > 0) {
      result.httpPort = parseInt(httpMatches[httpMatches.length - 1][1], 10);
    }
  } catch {
    // Read failed
  }
  return result;
}

/**
 * Backward compatibility alias: returns httpsPort or httpPort.
 */
export function findPortFromLogFile(logPath: string, pid?: number): number | null {
  const ports = findServerPortsFromLogFile(logPath, pid);
  return ports.httpsPort || ports.httpPort;
}

/**
 * Resolves the server ports (HTTPS and HTTP) belonging to this sandbox instance.
 */
export async function resolveSandboxServerPorts(
  sandboxRoot: string,
  pid?: number
): Promise<LanguageServerPorts> {
  try {
    const paths = getSandboxPaths(sandboxRoot);
    const candidateLogs = [
      path.join(paths.sandboxHome, 'AppData', 'Roaming', 'Antigravity', 'logs', 'language_server.log'),
      path.join(paths.userDataDir, 'logs', 'language_server.log'),
      path.join(paths.sandboxHome, '.antigravity-cli', 'log', 'language_server.log'),
    ];

    for (const logFile of candidateLogs) {
      const ports = findServerPortsFromLogFile(logFile, pid);
      if (ports.httpsPort || ports.httpPort) {
        return ports;
      }
    }
  } catch {
    // Path resolution failed
  }

  // Fallback to netstat / lsof
  if (pid && pid > 0) {
    const fallbackPort = await findListeningPortForPid(pid, sandboxRoot);
    if (fallbackPort) {
      return { httpsPort: fallbackPort, httpPort: fallbackPort };
    }
  }

  return { httpsPort: null, httpPort: null };
}

/**
 * Executes an RPC call targeting HTTPS port first if known, or HTTP port directly.
 * Eliminates SSL handshake resets caused by sending HTTPS requests to an HTTP port.
 */
export async function executeRpcCall(
  ports: LanguageServerPorts,
  endpoint: string,
  csrfToken: string,
  requestBody: any
): Promise<any | null> {
  // Try HTTPS port first
  if (ports.httpsPort) {
    try {
      return await sendLocalPostRequest(ports.httpsPort, endpoint, csrfToken, requestBody, true);
    } catch {
      // Fall through to HTTP if HTTPS fails
    }
  }

  // Connect via HTTP to httpPort (or fallback httpsPort if only one is known)
  const httpTargetPort = ports.httpPort || ports.httpsPort;
  if (httpTargetPort) {
    try {
      return await sendLocalPostRequest(httpTargetPort, endpoint, csrfToken, requestBody, false);
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Finds the local listening TCP port for a given PID on 127.0.0.1.
 * First inspects the sandbox language_server.log file (bulletproof on Windows Host-Bridge),
 * then falls back to netstat or lsof if log inspection does not yield a port.
 */
export async function findListeningPortForPid(pid: number, sandboxRoot?: string): Promise<number | null> {
  if (pid <= 0) {
    return null;
  }

  // 1. Primary: resolve from language_server.log inside sandbox
  if (sandboxRoot) {
    try {
      const paths = getSandboxPaths(sandboxRoot);
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
    } catch {
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
    } catch {
      // Netstat failed
    }
  } else {
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
    } catch {
      // lsof failed
    }
  }

  return null;
}

/**
 * Executes a local RPC request to 127.0.0.1.
 * Connects directly to the sandboxed Go language_server without any proxy.
 */
async function sendLocalPostRequest(
  port: number,
  path: string,
  csrfToken: string,
  bodyData: any,
  useHttps: boolean = true
): Promise<any> {
  const payload = JSON.stringify(bodyData);
  const headers: Record<string, string | number> = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Connect-Protocol-Version': '1',
    'X-Codeium-Csrf-Token': csrfToken,
    'Host': `127.0.0.1:${port}`,
  };

  const options: https.RequestOptions = {
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
          } catch (e) {
            reject(new Error(`Failed to parse RPC response: ${e}`));
          }
        } else {
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
export async function getLocalUserStatus(sandboxRoot: string): Promise<UserStatusResult | null> {
  const lsProc = await findSandboxLanguageServer(sandboxRoot);
  if (!lsProc) {
    return null;
  }

  const csrfToken = extractCsrfToken(lsProc.commandLine);
  if (!csrfToken) {
    return null;
  }

  const ports = await resolveSandboxServerPorts(sandboxRoot, lsProc.pid);
  if (!ports.httpsPort && !ports.httpPort) {
    return null;
  }

  const requestBody = {
    metadata: {
      ideName: 'antigravity',
      extensionName: 'antigravity',
      locale: 'en',
    },
  };

  const endpoint = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
  const responseData = await executeRpcCall(ports, endpoint, csrfToken, requestBody);

  if (!responseData) {
    return null;
  }

  const userStatus = responseData.userStatus || responseData;
  const email = userStatus.email || '';
  const planName = userStatus.planStatus?.planInfo?.planName || 'Standard';

  const models: ModelQuotaInfo[] = [];
  let minQuota = 100;

  const rawConfigs =
    userStatus.cascadeModelConfigData?.clientModelConfigs ||
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
      } else if (typeof cfg.remainingFraction === 'number') {
        remainingPercentage = Math.round(cfg.remainingFraction * 100);
      } else if (typeof qInfo.remainingPercentage === 'number') {
        remainingPercentage = Math.round(qInfo.remainingPercentage);
      } else if (typeof qInfo.remainingFraction === 'number') {
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
 * Fetches all cascade trajectories metadata map strictly via local RPC on 127.0.0.1.
 * Returns null if language_server is offline or uncontactable.
 */
export async function getAllCascadeTrajectories(sandboxRoot: string): Promise<any | null> {
  const lsProc = await findSandboxLanguageServer(sandboxRoot);
  if (!lsProc) {
    return null;
  }

  const csrfToken = extractCsrfToken(lsProc.commandLine);
  if (!csrfToken) {
    return null;
  }

  const ports = await resolveSandboxServerPorts(sandboxRoot, lsProc.pid);
  if (!ports.httpsPort && !ports.httpPort) {
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
  return await executeRpcCall(ports, endpoint, csrfToken, requestBody);
}

/**
 * Fetches a single cascade trajectory with full steps, generatorMetadata, and actual token usages.
 * Returns null if language_server is offline or trajectory is not found.
 */
export async function getCascadeTrajectory(
  sandboxRoot: string,
  cascadeId: string
): Promise<any | null> {
  const lsProc = await findSandboxLanguageServer(sandboxRoot);
  if (!lsProc) {
    return null;
  }

  const csrfToken = extractCsrfToken(lsProc.commandLine);
  if (!csrfToken) {
    return null;
  }

  const ports = await resolveSandboxServerPorts(sandboxRoot, lsProc.pid);
  if (!ports.httpsPort && !ports.httpPort) {
    return null;
  }

  const requestBody = {
    metadata: {
      ideName: 'antigravity',
      extensionName: 'antigravity',
      locale: 'en',
    },
    cascadeId,
  };

  const endpoint = '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory';
  return await executeRpcCall(ports, endpoint, csrfToken, requestBody);
}

