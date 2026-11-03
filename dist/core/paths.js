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
exports.getPlatformExecutableName = getPlatformExecutableName;
exports.getSandboxPaths = getSandboxPaths;
exports.getProfileSnapshotDir = getProfileSnapshotDir;
exports.getIsolatedProfileEnvDir = getIsolatedProfileEnvDir;
exports.sanitizeProfileName = sanitizeProfileName;
const path = __importStar(require("path"));
function getPlatformExecutableName() {
    if (process.platform === 'win32') {
        return 'Antigravity.exe';
    }
    else if (process.platform === 'darwin') {
        return 'Antigravity.app/Contents/MacOS/Electron';
    }
    return 'antigravity';
}
function getSandboxPaths(sandboxRoot) {
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
function getProfileSnapshotDir(sandboxRoot, email) {
    const safeName = sanitizeProfileName(email);
    return path.join(getSandboxPaths(sandboxRoot).profilesDir, safeName);
}
function getIsolatedProfileEnvDir(sandboxRoot, email) {
    const safeName = sanitizeProfileName(email);
    return path.join(getSandboxPaths(sandboxRoot).isolatedEnvsDir, safeName);
}
function sanitizeProfileName(name) {
    return name.replace(/[/\\?%*:|"<>]/g, '_').trim();
}
//# sourceMappingURL=paths.js.map