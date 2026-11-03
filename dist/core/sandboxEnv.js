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
exports.SecurityError = void 0;
exports.getForbiddenPrimaryPaths = getForbiddenPrimaryPaths;
exports.getSandboxRoot = getSandboxRoot;
exports.isRunningInsideSandbox = isRunningInsideSandbox;
exports.assertInsideSandbox = assertInsideSandbox;
exports.getIsolatedEnv = getIsolatedEnv;
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const fs = __importStar(require("fs"));
const paths_1 = require("./paths");
class SecurityError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SecurityError';
    }
}
exports.SecurityError = SecurityError;
/**
 * Returns primary system paths of the original untouched Antigravity installation.
 * Any access or modification to these paths from the switcher is strictly forbidden.
 */
function getForbiddenPrimaryPaths() {
    const forbidden = [];
    const homeDir = os.homedir();
    // Primary user home caches
    forbidden.push(path.join(homeDir, '.gemini'));
    forbidden.push(path.join(homeDir, '.antigravity-cli'));
    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
        const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
        forbidden.push(path.join(localAppData, 'Programs', 'Antigravity'));
        forbidden.push(path.join(localAppData, 'Programs', 'Antigravity IDE'));
        forbidden.push(path.join(appData, 'Antigravity'));
        forbidden.push(path.join(appData, 'Antigravity IDE'));
    }
    else if (process.platform === 'darwin') {
        forbidden.push('/Applications/Antigravity.app');
        forbidden.push(path.join(homeDir, 'Applications', 'Antigravity.app'));
        forbidden.push(path.join(homeDir, 'Library', 'Application Support', 'Antigravity'));
        forbidden.push(path.join(homeDir, 'Library', 'Application Support', 'Antigravity IDE'));
    }
    else {
        // Linux
        forbidden.push('/opt/Antigravity');
        forbidden.push('/usr/share/antigravity');
        const configDir = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
        forbidden.push(path.join(configDir, 'Antigravity'));
        forbidden.push(path.join(configDir, 'Antigravity IDE'));
    }
    return forbidden.map(p => path.resolve(p).toLowerCase());
}
/**
 * Resolves the root directory of the sandbox instance.
 * Checks AG_SANDBOX_ROOT env, or auto-detects from process.execPath.
 */
function getSandboxRoot() {
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
function isRunningInsideSandbox(sandboxRoot) {
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
    const paths = (0, paths_1.getSandboxPaths)(root);
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
function assertInsideSandbox(targetPath, sandboxRoot, op = 'write') {
    const root = path.resolve(sandboxRoot || getSandboxRoot()).toLowerCase();
    const resolvedTarget = path.resolve(targetPath).toLowerCase();
    // If reading, allow reading external files (e.g., importing existing config or DB)
    if (op === 'read') {
        return;
    }
    // Check 1: Forbidden primary system paths check (mutation strictly blocked)
    const forbidden = getForbiddenPrimaryPaths();
    for (const forb of forbidden) {
        if (resolvedTarget.startsWith(forb)) {
            throw new SecurityError(`Security Violation: Target path is inside forbidden primary Antigravity system directory! [Target: ${targetPath}]`);
        }
    }
    // Check 2: Target must reside within sandbox root prefix
    // Allow exact root or child of root
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (resolvedTarget !== root && !resolvedTarget.startsWith(rootWithSep)) {
        throw new SecurityError(`Security Violation: Attempted to touch path outside of SandboxRoot! [Root: ${root}, Target: ${targetPath}]`);
    }
}
/**
 * Generates an isolated environment variable map for spawning child processes inside the sandbox.
 * Replaces USERPROFILE, HOME, APPDATA, LOCALAPPDATA with SandboxHome paths.
 * If proxyUrl is provided, sets outbound proxy while STRICTLY protecting loopback (127.0.0.1) via NO_PROXY (Argon Fix #2).
 */
function getIsolatedEnv(sandboxRoot, customHome, proxyUrl) {
    const paths = (0, paths_1.getSandboxPaths)(sandboxRoot);
    const homePath = customHome ? path.resolve(customHome) : paths.sandboxHome;
    assertInsideSandbox(homePath, sandboxRoot);
    const env = {
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
    }
    else {
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
//# sourceMappingURL=sandboxEnv.js.map