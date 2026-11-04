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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const sandboxEnv_1 = require("./core/sandboxEnv");
const lsRpcClient_1 = require("./core/lsRpcClient");
const profileStore_1 = require("./core/profileStore");
const statsPanel_1 = require("./ui/statsPanel");
let statusBarItem;
function activate(context) {
    const sandboxRoot = (0, sandboxEnv_1.getSandboxRoot)();
    const insideSandbox = (0, sandboxEnv_1.isRunningInsideSandbox)(sandboxRoot);
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'ag-stealth-switcher.showMenu';
    context.subscriptions.push(statusBarItem);
    if (!insideSandbox) {
        statusBarItem.text = '$(warning) AG Switcher: Primary Instance (Read-Only)';
        statusBarItem.tooltip =
            'Security Lock: Antigravity Stealth Switcher is inactive because this is your primary installation.\nAll switcher functions are disabled to protect your primary account.';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        statusBarItem.show();
        registerPrimarySafeCommands(context);
        return;
    }
    // Running safely inside isolated sandbox instance
    statusBarItem.show();
    registerSandboxCommands(context, sandboxRoot);
    // Passive initial quota calculation without background network polling
    updateStatusBarPassive(sandboxRoot);
}
function deactivate() {
    // No background timers or listeners to clean up (strict passive design)
}
/**
 * Commands registered when running in the primary installation.
 * All mutations are safely blocked to prevent modifying primary account state.
 */
function registerPrimarySafeCommands(context) {
    const showWarning = () => {
        vscode.window.showWarningMessage('Antigravity Stealth Switcher is disabled on the primary IDE instance to prevent account conflicts.');
    };
    context.subscriptions.push(vscode.commands.registerCommand('ag-stealth-switcher.showMenu', showWarning), vscode.commands.registerCommand('ag-stealth-switcher.openStats', showWarning), vscode.commands.registerCommand('ag-stealth-switcher.captureAccount', showWarning), vscode.commands.registerCommand('ag-stealth-switcher.switchBlank', showWarning), vscode.commands.registerCommand('ag-stealth-switcher.toggleMode', showWarning), vscode.commands.registerCommand('ag-stealth-switcher.refreshQuota', showWarning));
}
/**
 * Commands registered when running inside the isolated sandbox instance.
 */
function registerSandboxCommands(context, sandboxRoot) {
    context.subscriptions.push(vscode.commands.registerCommand('ag-stealth-switcher.showMenu', async () => {
        await showProfileQuickPick(context, sandboxRoot);
    }), vscode.commands.registerCommand('ag-stealth-switcher.openStats', () => {
        statsPanel_1.StatsPanel.render(context.extensionUri, sandboxRoot);
    }), vscode.commands.registerCommand('ag-stealth-switcher.captureAccount', async () => {
        await handleCaptureCurrentAccount(sandboxRoot);
    }), vscode.commands.registerCommand('ag-stealth-switcher.switchBlank', async () => {
        await handleSwitchToBlank(context, sandboxRoot);
    }), vscode.commands.registerCommand('ag-stealth-switcher.toggleMode', async () => {
        await handleToggleMode(sandboxRoot);
    }), vscode.commands.registerCommand('ag-stealth-switcher.refreshQuota', async () => {
        await handleManualRefreshQuota(sandboxRoot);
    }));
}
/**
 * Passive Quota Calculation (0 Background Traffic).
 * Computes remaining limits mathematically from elapsed time without polling the network.
 */
function updateStatusBarPassive(sandboxRoot) {
    const config = (0, profileStore_1.loadConfig)(sandboxRoot);
    const activeEmail = config.activeProfile;
    if (!activeEmail) {
        statusBarItem.text = `$(shield) [Sandbox] No Active Account | Mode: ${config.mode}`;
        statusBarItem.tooltip = `Antigravity Stealth Sandbox\nMode: ${config.mode}\nClick to log in or select a profile.`;
        statusBarItem.backgroundColor = undefined;
        return;
    }
    const profile = (0, profileStore_1.getProfile)(sandboxRoot, activeEmail);
    if (!profile || !profile.quotas) {
        statusBarItem.text = `$(shield) [Sandbox] ${activeEmail} | Quota: --`;
        statusBarItem.tooltip = `Antigravity Stealth Sandbox\nAccount: ${activeEmail}\nMode: ${config.mode}\n(Click "Refresh Quota Now" to fetch live status)`;
        statusBarItem.backgroundColor = undefined;
        return;
    }
    const est = (0, profileStore_1.calculateEstimatedQuota)(profile);
    const statusSuffix = est.isRestored ? ' (recovered)' : '';
    const timeHint = est.timeRemainingStr ? ` [${est.timeRemainingStr}]` : '';
    statusBarItem.text = `$(shield) [Sandbox] ${activeEmail} | 5h: ${est.fiveHourPercent}%${statusSuffix}${timeHint}`;
    statusBarItem.backgroundColor = undefined;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`### Antigravity Stealth Sandbox\n\n`);
    md.appendMarkdown(`- **Account:** \`${activeEmail}\`\n`);
    md.appendMarkdown(`- **Mode:** \`${config.mode}\`\n`);
    if (profile.proxyUrl) {
        md.appendMarkdown(`- **Proxy:** \`${profile.proxyUrl}\`\n`);
    }
    md.appendMarkdown(`\n#### Estimated Quotas (Passive):\n`);
    md.appendMarkdown(`- **5-Hour Limit:** ${est.fiveHourPercent}%${statusSuffix}\n`);
    md.appendMarkdown(`- **Weekly Limit:** ${est.weeklyPercent}%\n`);
    if (profile.quotas.claudeGptPercent !== undefined) {
        md.appendMarkdown(`- **Claude/GPT Limit:** ${profile.quotas.claudeGptPercent}%\n`);
    }
    if (est.timeRemainingStr) {
        md.appendMarkdown(`- **Recovery:** ${est.timeRemainingStr}\n`);
    }
    md.appendMarkdown(`\n*Passive Mode: 0 background requests sent.*  \n*Click to open menu or manual refresh.*`);
    statusBarItem.tooltip = md;
}
/**
 * Manual Quota Refresh:
 * Contacts local RPC 127.0.0.1 strictly on user demand, saves snapshot to disk, and updates status bar.
 */
async function handleManualRefreshQuota(sandboxRoot) {
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Refreshing sandbox quota from local language_server...',
    }, async () => {
        const status = await (0, lsRpcClient_1.getLocalUserStatus)(sandboxRoot);
        if (!status) {
            vscode.window.showWarningMessage('Local language_server process is currently offline or starting up.');
            updateStatusBarPassive(sandboxRoot);
            return;
        }
        const email = status.email || (0, profileStore_1.loadConfig)(sandboxRoot).activeProfile;
        if (email) {
            // Update stored profile quota snapshot with fresh live status
            let profile = (0, profileStore_1.getProfile)(sandboxRoot, email);
            if (profile) {
                profile.quotas = (0, profileStore_1.buildQuotaSnapshot)(status);
                profile.lastUsedAt = new Date().toISOString();
                (0, profileStore_1.saveProfile)(sandboxRoot, profile);
            }
            else {
                profile = await (0, profileStore_1.captureCurrentProfile)(sandboxRoot, email);
            }
            updateStatusBarPassive(sandboxRoot);
        }
        vscode.window.showInformationMessage(`Quota refreshed for ${status.email}: Min remaining: ${status.minQuotaPercentage}%`);
        updateStatusBarPassive(sandboxRoot);
    });
}
/**
 * Displays the main profile switching QuickPick menu.
 */
async function showProfileQuickPick(context, sandboxRoot) {
    const config = (0, profileStore_1.loadConfig)(sandboxRoot);
    const profiles = (0, profileStore_1.listProfiles)(sandboxRoot);
    const items = [];
    // 1. Saved profiles section
    for (const p of profiles) {
        const isActive = p.email === config.activeProfile;
        const est = (0, profileStore_1.calculateEstimatedQuota)(p);
        const quotaDesc = `5h: ${est.fiveHourPercent}% | Weekly: ${est.weeklyPercent}%`;
        const proxyDesc = p.proxyUrl ? ` [Proxy: ${p.proxyUrl}]` : '';
        items.push({
            label: isActive ? `$(check) ${p.email}` : `$(account) ${p.email}`,
            description: isActive ? `Active Profile (${quotaDesc}${proxyDesc})` : `${quotaDesc}${proxyDesc}`,
            detail: `Keys: ${p.dbItems.length} records | Last used: ${p.lastUsedAt || 'N/A'}`,
        });
    }
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    // 2. Action items
    items.push({
        label: '$(graph) 📊 Open Token Statistics',
        description: 'View interactive token charts and request logs (in Manager style)',
    }, {
        label: '$(cloud-download) 💾 Save Current Account to Pool',
        description: 'Capture active sandbox credentials and telemetry to stored profiles',
    }, {
        label: '$(add) 🔄 Switch to Blank Profile (Login New Account)',
        description: 'Prepare a fresh isolated login session with new machine ID',
    }, {
        label: '$(sync) ↻ Refresh Quota Now',
        description: 'Query local language_server RPC for latest quota snapshot',
    }, {
        label: `$(gear) ⚙️ Toggle Switch Mode (Current: ${config.mode})`,
        description: 'Toggle between in-place and isolated-dir strategies',
    }, {
        label: '$(trash) 🗑️ Delete Saved Profile',
        description: 'Permanently remove a profile and its files from disk',
    });
    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a profile to switch, or choose an action:',
    });
    if (!selected) {
        return;
    }
    if (selected.label.includes('Open Token Statistics')) {
        statsPanel_1.StatsPanel.render(context.extensionUri, sandboxRoot);
    }
    else if (selected.label.includes('Save Current Account to Pool')) {
        await handleCaptureCurrentAccount(sandboxRoot);
    }
    else if (selected.label.includes('Switch to Blank Profile')) {
        await handleSwitchToBlank(context, sandboxRoot);
    }
    else if (selected.label.includes('Refresh Quota Now')) {
        await handleManualRefreshQuota(sandboxRoot);
    }
    else if (selected.label.includes('Toggle Switch Mode')) {
        await handleToggleMode(sandboxRoot);
    }
    else if (selected.label.includes('Delete Saved Profile')) {
        await handleDeleteProfile(sandboxRoot);
    }
    else {
        // A profile was clicked
        const emailMatch = selected.label.replace(/^\$\([^)]+\)\s*/, '').trim();
        if (emailMatch) {
            await handleProfileSwitch(context, sandboxRoot, emailMatch);
        }
    }
}
/**
 * Captures current credentials and stores them into the profile pool.
 * Automatically resolves email from CLI token or RPC without prompting if available.
 */
async function handleCaptureCurrentAccount(sandboxRoot) {
    try {
        const session = (0, profileStore_1.getActiveSessionContext)(sandboxRoot);
        let cliToken = (0, profileStore_1.readCliToken)(session.cliTokenFile, sandboxRoot);
        if (!cliToken) {
            cliToken = (0, profileStore_1.readGeminiFileCredentials)(session.geminiHome, sandboxRoot);
        }
        // Priority 1: Authentic email from active session token
        let detectedEmail = cliToken?.id_token_email && !cliToken.id_token_email.startsWith('blank_')
            ? cliToken.id_token_email
            : undefined;
        // Priority 2: Authentic email from local Language Server RPC
        if (!detectedEmail) {
            try {
                const userStatus = await (0, lsRpcClient_1.getLocalUserStatus)(sandboxRoot);
                if (userStatus?.email && !userStatus.email.startsWith('blank_')) {
                    detectedEmail = userStatus.email;
                }
            }
            catch {
                // Fallback
            }
        }
        // Priority 3: Non-blank session account
        if (!detectedEmail && session.account && !session.account.startsWith('blank_')) {
            detectedEmail = session.account;
        }
        let email = detectedEmail;
        if (!email) {
            email = await vscode.window.showInputBox({
                prompt: 'Enter account email to label this profile:',
                placeHolder: 'user@example.com',
            });
        }
        if (!email) {
            return;
        }
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Saving account snapshot for ${email}...`,
        }, async () => {
            const profile = await (0, profileStore_1.captureCurrentProfile)(sandboxRoot, email);
            vscode.window.showInformationMessage(`Profile saved successfully: ${profile.email} (${profile.dbItems.length} auth records saved).`);
        });
        updateStatusBarPassive(sandboxRoot);
    }
    catch (err) {
        vscode.window.showErrorMessage(`Failed to save profile: ${err.message}`);
    }
}
/**
 * Handles switching to blank profile for clean browser login.
 */
async function handleSwitchToBlank(context, sandboxRoot) {
    const confirm = await vscode.window.showWarningMessage('Switching to a blank profile will close this IDE window, clear credentials, and reopen a clean login prompt. Proceed?', { modal: true }, 'Proceed');
    if (confirm !== 'Proceed') {
        return;
    }
    // Backup current session before wiping credentials
    try {
        await (0, profileStore_1.captureCurrentProfile)(sandboxRoot);
    }
    catch {
        // Non-fatal if no active account
    }
    await triggerSwitchWorker(context, sandboxRoot, '__BLANK__');
}
/**
 * Switches to a saved profile.
 */
async function handleProfileSwitch(context, sandboxRoot, targetEmail) {
    const config = (0, profileStore_1.loadConfig)(sandboxRoot);
    if (config.activeProfile === targetEmail) {
        vscode.window.showInformationMessage(`Account ${targetEmail} is already active.`);
        return;
    }
    const confirm = await vscode.window.showInformationMessage(`Switch to profile ${targetEmail}? This will restart the sandbox IDE window.`, 'Switch Now', 'Cancel');
    if (confirm !== 'Switch Now') {
        return;
    }
    // Save current account snapshot first
    try {
        await (0, profileStore_1.captureCurrentProfile)(sandboxRoot);
    }
    catch {
        // Non-fatal
    }
    await triggerSwitchWorker(context, sandboxRoot, targetEmail);
}
/**
 * Toggles switching mode (in-place vs isolated-dir).
 */
async function handleToggleMode(sandboxRoot) {
    const config = (0, profileStore_1.loadConfig)(sandboxRoot);
    const newMode = config.mode === 'in-place' ? 'isolated-dir' : 'in-place';
    config.mode = newMode;
    (0, profileStore_1.saveConfig)(sandboxRoot, config);
    vscode.window.showInformationMessage(`Switcher mode updated to: ${newMode}`);
    updateStatusBarPassive(sandboxRoot);
}
/**
 * Deletes a stored profile and any isolated files.
 */
async function handleDeleteProfile(sandboxRoot) {
    const profiles = (0, profileStore_1.listProfiles)(sandboxRoot);
    if (profiles.length === 0) {
        vscode.window.showInformationMessage('No saved profiles found.');
        return;
    }
    const items = profiles.map(p => ({
        label: p.email,
        description: `Last used: ${p.lastUsedAt || 'N/A'}`,
    }));
    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a profile to permanently delete:',
    });
    if (!selected) {
        return;
    }
    const config = (0, profileStore_1.loadConfig)(sandboxRoot);
    if (config.activeProfile === selected.label) {
        vscode.window.showErrorMessage(`Cannot delete profile "${selected.label}" because it is currently active. Please switch to another account or Blank Profile first.`);
        return;
    }
    const confirm = await vscode.window.showWarningMessage(`Are you sure you want to permanently delete profile ${selected.label}?`, { modal: true }, 'Delete');
    if (confirm === 'Delete') {
        try {
            await (0, profileStore_1.deleteProfile)(sandboxRoot, selected.label);
            vscode.window.showInformationMessage(`Profile ${selected.label} has been deleted.`);
            updateStatusBarPassive(sandboxRoot);
        }
        catch (err) {
            vscode.window.showErrorMessage(`Failed to delete profile: ${err.message || err}`);
        }
    }
}
/**
 * Spawns the detached background worker process and lets it restart the sandbox IDE cleanly.
 */
async function triggerSwitchWorker(context, sandboxRoot, targetEmail) {
    const config = (0, profileStore_1.loadConfig)(sandboxRoot);
    const workerScript = path.join(context.extensionPath, 'dist', 'cli', 'switchWorker.js');
    const nodeExec = process.execPath;
    const args = [
        workerScript,
        '--mode', config.mode,
        '--sandbox', sandboxRoot,
        '--target', targetEmail,
        '--ide-pid', String(process.pid),
    ];
    const spawnEnv = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
    };
    try {
        const child = (0, child_process_1.spawn)(nodeExec, args, {
            detached: true,
            stdio: 'ignore',
            env: spawnEnv,
            windowsHide: false,
        });
        child.unref();
        setTimeout(() => {
            vscode.commands.executeCommand('workbench.action.quit');
        }, 500);
    }
    catch (err) {
        vscode.window.showErrorMessage(`Failed to spawn switch worker: ${err.message}`);
    }
}
//# sourceMappingURL=extension.js.map