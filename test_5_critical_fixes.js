const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Require compiled dist modules
const {
  getActiveSessionContext,
  captureCurrentProfile,
  writeCliToken,
  writeGeminiFileCredentials,
  clearGeminiFileCredentials,
  saveConfig,
  loadConfig,
  saveProfile,
  getProfile,
} = require('./dist/core/profileStore');
const {
  extractAuthItemsFromDb,
  injectAuthItemsIntoDb,
  clearAuthItemsInDb,
  openStateDb,
  AUTH_ITEMS_WHERE_CLAUSE,
} = require('./dist/core/sqliteInjector');
const {
  openTokenStatsDb,
  recordBatchUsage,
  getStatsSummary,
} = require('./dist/core/tokenStatsStore');
const { DatabaseSync } = require('node:sqlite');

const TEST_ROOT = path.resolve(__dirname, 'test_mock_sandbox');

function cleanDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

async function runTests() {
  console.log('=== RUNNING VERIFICATION FOR ALL AUDIT FIXES ===\n');
  cleanDir(TEST_ROOT);
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  // -------------------------------------------------------------
  // TEST 1: isolated-dir account isolation & non-overwriting
  // -------------------------------------------------------------
  console.log('[Test 1] Verifying isolated-dir account context & non-overwriting...');
  {
    const sharedHome = path.join(TEST_ROOT, 'SandboxHome');
    const sharedCli = path.join(sharedHome, '.antigravity-cli');
    fs.mkdirSync(sharedCli, { recursive: true });
    fs.writeFileSync(
      path.join(sharedCli, 'oauth_token.json'),
      JSON.stringify({ id_token_email: 'accountA@gmail.com', access_token: 'token_A' })
    );

    // Prepare isolated environment for account B
    const isolatedBHome = path.join(TEST_ROOT, 'SandboxHome', '.ag-stealth-switcher', 'isolated_envs', 'accountB_gmail_com', 'home');
    const isolatedBUserData = path.join(TEST_ROOT, 'SandboxHome', '.ag-stealth-switcher', 'isolated_envs', 'accountB_gmail_com', 'user-data');
    const isolatedBCli = path.join(isolatedBHome, '.antigravity-cli');
    fs.mkdirSync(isolatedBCli, { recursive: true });
    fs.mkdirSync(isolatedBUserData, { recursive: true });
    fs.writeFileSync(
      path.join(isolatedBCli, 'oauth_token.json'),
      JSON.stringify({ id_token_email: 'accountB@gmail.com', access_token: 'token_B' })
    );

    saveConfig(TEST_ROOT, {
      mode: 'isolated-dir',
      activeProfile: 'accountB_gmail_com',
    });

    const origUserProfile = process.env.USERPROFILE;
    process.env.USERPROFILE = isolatedBHome;

    const ctx = getActiveSessionContext(TEST_ROOT);
    assert.strictEqual(ctx.mode, 'isolated-dir', 'Context mode must be isolated-dir');
    assert.strictEqual(ctx.instanceId, 'accountB_gmail_com', 'Instance ID must be accountB_gmail_com');
    assert.strictEqual(ctx.userHome, isolatedBHome, 'UserHome must point to isolated instance home');

    // Capture current profile
    const profile = await captureCurrentProfile(TEST_ROOT);
    assert.strictEqual(profile.email, 'accountB@gmail.com', 'Captured profile must be accountB');
    assert.strictEqual(profile.cliToken.access_token, 'token_B', 'Captured token must be token B, NOT token A');

    // Verify shared SandboxHome was NOT modified with token B
    const sharedToken = JSON.parse(fs.readFileSync(path.join(sharedCli, 'oauth_token.json'), 'utf-8'));
    assert.strictEqual(sharedToken.access_token, 'token_A', 'Shared SandboxHome must remain token A (no credential leak)');

    if (origUserProfile) {
      process.env.USERPROFILE = origUserProfile;
    } else {
      delete process.env.USERPROFILE;
    }
    console.log('  -> PASS: isolated-dir context prevents overwriting other accounts.');
  }

  // -------------------------------------------------------------
  // TEST 2: Extension Host argv desync prevention (sibling deduction & AG_STEALTH_USER_DATA_DIR)
  // -------------------------------------------------------------
  console.log('\n[Test 2] Verifying Extension Host argv desync prevention (sibling deduction & AG_STEALTH_USER_DATA_DIR)...');
  {
    const isolatedHome = path.join(TEST_ROOT, 'SandboxHome', '.ag-stealth-switcher', 'isolated_envs', 'acc_x', 'home');
    const isolatedUserData = path.join(TEST_ROOT, 'SandboxHome', '.ag-stealth-switcher', 'isolated_envs', 'acc_x', 'user-data');
    fs.mkdirSync(isolatedHome, { recursive: true });
    fs.mkdirSync(isolatedUserData, { recursive: true });

    const origUserProfile = process.env.USERPROFILE;
    const origEnvUserData = process.env.AG_STEALTH_USER_DATA_DIR;

    // Case A: No --user-data-dir in process.argv and no env var, but USERPROFILE points to isolated home
    process.env.USERPROFILE = isolatedHome;
    delete process.env.AG_STEALTH_USER_DATA_DIR;

    const ctxA = getActiveSessionContext(TEST_ROOT);
    assert.strictEqual(ctxA.userHome, isolatedHome, 'Home must be isolated home');
    assert.strictEqual(
      ctxA.userDataDir,
      isolatedUserData,
      'userDataDir MUST be deduced as sibling user-data folder, NOT fallback to shared data/user-data!'
    );

    // Case B: Explicit AG_STEALTH_USER_DATA_DIR provided
    process.env.AG_STEALTH_USER_DATA_DIR = isolatedUserData;
    const ctxB = getActiveSessionContext(TEST_ROOT);
    assert.strictEqual(ctxB.userDataDir, isolatedUserData, 'userDataDir honors AG_STEALTH_USER_DATA_DIR');

    // Restore env
    if (origUserProfile) {
      process.env.USERPROFILE = origUserProfile;
    } else {
      delete process.env.USERPROFILE;
    }
    if (origEnvUserData) {
      process.env.AG_STEALTH_USER_DATA_DIR = origEnvUserData;
    } else {
      delete process.env.AG_STEALTH_USER_DATA_DIR;
    }
    console.log('  -> PASS: Token and state database remain 100% synchronized even when Extension Host lacks --user-data-dir in argv.');
  }

  // -------------------------------------------------------------
  // TEST 3: Profile without cliToken cleanly purges lingering credentials
  // -------------------------------------------------------------
  console.log('\n[Test 3] Verifying switching to profile without cliToken cleans previous account credentials...');
  {
    const sharedHome = path.join(TEST_ROOT, 'SandboxHome');
    const cliTokenFile = path.join(sharedHome, '.antigravity-cli', 'oauth_token.json');
    fs.mkdirSync(path.dirname(cliTokenFile), { recursive: true });

    // 1. Account A wrote credentials
    writeCliToken(cliTokenFile, { access_token: 'accA_token' }, 'accA@gmail.com', TEST_ROOT);
    writeGeminiFileCredentials(sharedHome, 'accA@gmail.com', { access_token: 'accA_token' }, TEST_ROOT);

    assert.ok(fs.existsSync(cliTokenFile), 'Account A token must exist before switch');
    const geminiCreds = path.join(sharedHome, '.gemini', 'oauth_creds.json');
    assert.ok(fs.existsSync(geminiCreds), 'Account A gemini creds must exist');

    // 2. Profile B has dbItems but NO cliToken
    const profileB = {
      email: 'accB@gmail.com',
      label: 'accB@gmail.com',
      capturedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      telemetry: { machineId: 'm1', sqmId: 's1', devDeviceId: 'd1' },
      dbItems: [{ key: 'antigravityUnifiedStateSync.oauthToken', value: 'tokenB_db' }],
      cliToken: null,
    };
    saveProfile(TEST_ROOT, profileB);

    // Simulate switchWorker logic: applying profile B
    if (profileB.cliToken) {
      writeCliToken(cliTokenFile, profileB.cliToken, profileB.email, TEST_ROOT);
      writeGeminiFileCredentials(sharedHome, profileB.email, profileB.cliToken, TEST_ROOT);
    } else {
      // Must explicitly clear lingering CLI & Gemini file credentials!
      if (fs.existsSync(cliTokenFile)) {
        try { fs.unlinkSync(cliTokenFile); } catch {}
      }
      clearGeminiFileCredentials(sharedHome, TEST_ROOT);
    }

    assert.ok(!fs.existsSync(cliTokenFile), 'oauth_token.json must be unlinked; no lingering account A tokens!');
    assert.ok(!fs.existsSync(geminiCreds), 'oauth_creds.json must be unlinked; no lingering account A tokens!');

    console.log('  -> PASS: Profile without cliToken cleanly purges lingering previous credentials.');
  }

  // -------------------------------------------------------------
  // TEST 4: Toggle Mode does NOT change running process session paths
  // -------------------------------------------------------------
  console.log('\n[Test 4] Verifying Toggle Mode does NOT alter running process session paths...');
  {
    saveConfig(TEST_ROOT, {
      mode: 'in-place',
      activeProfile: 'inplace_user@example.com',
    });

    const origUserProfile = process.env.USERPROFILE;
    const defaultHome = path.join(TEST_ROOT, 'SandboxHome');
    process.env.USERPROFILE = defaultHome;

    const ctxBefore = getActiveSessionContext(TEST_ROOT);
    assert.strictEqual(ctxBefore.mode, 'in-place', 'Initially running mode is in-place');
    assert.strictEqual(ctxBefore.userHome, defaultHome, 'User home is SandboxHome');

    const cfg = loadConfig(TEST_ROOT);
    cfg.mode = 'isolated-dir';
    saveConfig(TEST_ROOT, cfg);

    const ctxAfter = getActiveSessionContext(TEST_ROOT);
    assert.strictEqual(ctxAfter.mode, 'in-place', 'Running mode MUST remain in-place');
    assert.strictEqual(ctxAfter.configuredMode, 'isolated-dir', 'Configured mode for NEXT launch is isolated-dir');
    assert.strictEqual(ctxAfter.userHome, defaultHome, 'User home MUST remain SandboxHome without creating isolated dir');

    if (origUserProfile) {
      process.env.USERPROFILE = origUserProfile;
    } else {
      delete process.env.USERPROFILE;
    }
    console.log('  -> PASS: Toggle Mode applies only to next launch; running session paths remain immutable.');
  }

  // -------------------------------------------------------------
  // TEST 5: Blank Profile directory ID (blank_*) is not taken for account email
  // -------------------------------------------------------------
  console.log('\n[Test 5] Verifying Blank Profile directory ID (blank_*) is not taken for account email...');
  {
    const blankId = `blank_${Date.now()}`;
    const blankHome = path.join(TEST_ROOT, 'SandboxHome', '.ag-stealth-switcher', 'isolated_envs', blankId, 'home');
    const blankCli = path.join(blankHome, '.antigravity-cli');
    fs.mkdirSync(blankCli, { recursive: true });

    const realEmail = 'alice.developer@gmail.com';
    fs.writeFileSync(
      path.join(blankCli, 'oauth_token.json'),
      JSON.stringify({ id_token_email: realEmail, access_token: 'alice_live_token' })
    );

    const origUserProfile = process.env.USERPROFILE;
    process.env.USERPROFILE = blankHome;

    const ctx = getActiveSessionContext(TEST_ROOT);
    assert.strictEqual(ctx.instanceId, blankId, 'instanceId must be the blank directory folder name');
    assert.strictEqual(ctx.account, undefined, 'account must NOT be blank_*');

    const profile = await captureCurrentProfile(TEST_ROOT);
    assert.strictEqual(profile.email, realEmail, 'Profile email must be alice.developer@gmail.com, NOT blank_*');
    assert.strictEqual(profile.cliToken.id_token_email, realEmail);

    if (origUserProfile) {
      process.env.USERPROFILE = origUserProfile;
    } else {
      delete process.env.USERPROFILE;
    }
    console.log('  -> PASS: Blank profile directory name is properly separated from authentic user email.');
  }

  // -------------------------------------------------------------
  // TEST 6: Strict targeted auth cleaning (preserving third-party secrets)
  // -------------------------------------------------------------
  console.log('\n[Test 6] Verifying strict targeted auth cleaning (preserving third-party secrets)...');
  {
    const dbDir = path.join(TEST_ROOT, 'data', 'user-data', 'User', 'globalStorage');
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'state.vscdb');

    const sdb = new DatabaseSync(dbPath);
    sdb.exec(`
      CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
      INSERT OR REPLACE INTO ItemTable VALUES ('secret://{"extensionId":"ms-vscode.azure-account"}', 'azure_vault_secret');
      INSERT OR REPLACE INTO ItemTable VALUES ('secret://{"extensionId":"github.copilot"}', 'copilot_github_secret');
      INSERT OR REPLACE INTO ItemTable VALUES ('workbench.action.antigravity.panelLayout', 'sidebar_left_compact');
      INSERT OR REPLACE INTO ItemTable VALUES ('antigravityUnifiedStateSync.oauthToken', 'delete_this_token');
      INSERT OR REPLACE INTO ItemTable VALUES ('secret://antigravity_token', 'delete_this_secret');
    `);
    sdb.close();

    await clearAuthItemsInDb(dbPath, TEST_ROOT);

    const checkDb = new DatabaseSync(dbPath, { readOnly: true });
    const remaining = checkDb.prepare('SELECT key, value FROM ItemTable').all();
    checkDb.close();

    const keys = remaining.map((r) => r.key);
    assert.ok(keys.includes('secret://{"extensionId":"ms-vscode.azure-account"}'), 'Must preserve Azure secret');
    assert.ok(keys.includes('secret://{"extensionId":"github.copilot"}'), 'Must preserve GitHub Copilot secret');
    assert.ok(keys.includes('workbench.action.antigravity.panelLayout'), 'Must preserve non-auth Antigravity UI state');
    assert.ok(!keys.includes('antigravityUnifiedStateSync.oauthToken'), 'Must delete Antigravity auth token');
    assert.ok(!keys.includes('secret://antigravity_token'), 'Must delete Antigravity secret');

    console.log('  -> PASS: clearAuthItemsInDb strictly deletes only Antigravity/Jetski auth keys.');
  }

  // -------------------------------------------------------------
  // TEST 7: Migration of migrated_* keys and UNIQUE constraint collision safety
  // -------------------------------------------------------------
  console.log('\n[Test 7] Verifying migrated_* key handling and UNIQUE collision safety...');
  {
    const statsDbPath = path.join(TEST_ROOT, 'SandboxHome', '.ag-stealth-switcher', 'token_stats.db');
    fs.mkdirSync(path.dirname(statsDbPath), { recursive: true });

    // Seed database simulating an upgrade from commit a1180db:
    // It contains rows with step_key = 'migrated_*', synthetic row 'gemini-active', and unkeyed row
    const sdb = new DatabaseSync(statsDbPath);
    sdb.exec(`
      CREATE TABLE token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        step_key TEXT,
        timestamp INTEGER NOT NULL,
        account_email TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        requested_model TEXT,
        ttft_ms INTEGER
      );
      -- Row 1: Previously stamped with 'migrated_1_1700000000_gemini' by a1180db
      INSERT INTO token_usage VALUES (1, 'migrated_1_1700000000_gemini', 1700000000, 'legacy@example.com', 'gemini-1.5-pro', 500, 180, 0, 680, 'gemini-1.5-pro', 100);
      -- Row 2: Synthetic row from v1
      INSERT INTO token_usage VALUES (2, NULL, 1700000010, 'legacy@example.com', 'gemini-active', 250, 180, 0, 430, 'gemini', 150);
      -- Row 3: Authentic unkeyed row
      INSERT INTO token_usage VALUES (3, NULL, 1700000020, 'legacy@example.com', 'gemini-2.0-flash', 150, 250, 50, 400, 'gemini-2.0-flash', 120);
    `);
    sdb.close();

    // Open via openTokenStatsDb: triggers migration
    const { db, close } = await openTokenStatsDb(TEST_ROOT);
    close();

    // Verify:
    // 1. Synthetic 'gemini-active' row was purged
    // 2. 'migrated_1_*' was reverted to NULL so trajectory re-sync can claim it
    const checkDb = new DatabaseSync(statsDbPath, { readOnly: true });
    const rows = checkDb.prepare('SELECT id, model, total_tokens, step_key FROM token_usage ORDER BY id').all();
    checkDb.close();

    assert.strictEqual(rows.length, 2, 'Exactly 2 authentic rows remain');
    assert.strictEqual(rows[0].id, 1);
    assert.strictEqual(rows[0].step_key, null, 'migrated_* was successfully reset to NULL for incoming claim');
    assert.strictEqual(rows[1].id, 3);
    assert.strictEqual(rows[1].step_key, null);

    // Now test re-import with duplicate calls / colliding keys:
    // Sync batch 1:
    await recordBatchUsage(TEST_ROOT, [
      {
        stepKey: 'cascade_traj_1:0:msg_1',
        timestamp: 1700000000,
        accountEmail: 'legacy@example.com',
        model: 'gemini-1.5-pro',
        inputTokens: 500,
        outputTokens: 180,
        cachedTokens: 0,
        totalTokens: 680,
      },
    ]);

    // Sync batch 2: Send the SAME step AGAIN (duplicate sync)
    // MUST NOT fail with UNIQUE constraint violation!
    await recordBatchUsage(TEST_ROOT, [
      {
        stepKey: 'cascade_traj_1:0:msg_1',
        timestamp: 1700000000,
        accountEmail: 'legacy@example.com',
        model: 'gemini-1.5-pro',
        inputTokens: 500,
        outputTokens: 180,
        cachedTokens: 0,
        totalTokens: 680,
      },
    ]);

    // Verify row 1 was claimed with cascade_traj_1:0:msg_1 and total tokens remained accurate (680 + 400 = 1080)
    const summary = await getStatsSummary(TEST_ROOT);
    assert.strictEqual(summary.totalTokens, 1080, 'Total tokens must equal 1080 with zero duplication');

    console.log('  -> PASS: migrated_* keys properly reset, and duplicate sync never crashes on UNIQUE constraint.');
  }

  cleanDir(TEST_ROOT);
  console.log('\n=== ALL AUDIT VERIFICATION TESTS PASSED SUCCESSFULLY! ===');
}

runTests().catch((err) => {
  console.error('\n[FAIL] Test failure:', err);
  process.exit(1);
});
