const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Require compiled dist modules
const {
  getActiveSessionContext,
  captureCurrentProfile,
  writeCliToken,
  writeGeminiFileCredentials,
  saveConfig,
  loadConfig,
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
    fs.writeFileSync(
      path.join(isolatedBCli, 'oauth_token.json'),
      JSON.stringify({ id_token_email: 'accountB@gmail.com', access_token: 'token_B' })
    );

    // Save config in isolated-dir mode
    saveConfig(TEST_ROOT, {
      mode: 'isolated-dir',
      activeProfile: 'accountB_gmail_com',
    });

    // Simulate process running with isolated environment
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

    // Restore env
    if (origUserProfile) {
      process.env.USERPROFILE = origUserProfile;
    } else {
      delete process.env.USERPROFILE;
    }
    console.log('  -> PASS: isolated-dir context prevents overwriting other accounts.');
  }

  // -------------------------------------------------------------
  // TEST 2: Toggle Mode does NOT change running process session paths
  // -------------------------------------------------------------
  console.log('\n[Test 2] Verifying Toggle Mode does NOT alter running process session paths...');
  {
    // Start running in in-place mode (default SandboxHome and data/user-data)
    saveConfig(TEST_ROOT, {
      mode: 'in-place',
      activeProfile: 'inplace_user@example.com',
    });

    const origUserProfile = process.env.USERPROFILE;
    const defaultHome = path.join(TEST_ROOT, 'SandboxHome');
    process.env.USERPROFILE = defaultHome;

    // Check initial context
    const ctxBefore = getActiveSessionContext(TEST_ROOT);
    assert.strictEqual(ctxBefore.mode, 'in-place', 'Initially running mode is in-place');
    assert.strictEqual(ctxBefore.userHome, defaultHome, 'User home is SandboxHome');

    // User toggles mode in UI to 'isolated-dir'
    const cfg = loadConfig(TEST_ROOT);
    cfg.mode = 'isolated-dir';
    saveConfig(TEST_ROOT, cfg);

    // Re-check active session context while IDE is STILL RUNNING with original process env
    const ctxAfter = getActiveSessionContext(TEST_ROOT);
    assert.strictEqual(ctxAfter.mode, 'in-place', 'Running mode MUST remain in-place (immutable during process lifecycle)');
    assert.strictEqual(ctxAfter.configuredMode, 'isolated-dir', 'Configured mode for NEXT launch is isolated-dir');
    assert.strictEqual(ctxAfter.userHome, defaultHome, 'User home MUST remain SandboxHome without creating isolated dir');

    // Restore env
    if (origUserProfile) {
      process.env.USERPROFILE = origUserProfile;
    } else {
      delete process.env.USERPROFILE;
    }
    console.log('  -> PASS: Toggle Mode applies only to next launch; running session paths remain immutable.');
  }

  // -------------------------------------------------------------
  // TEST 3: Blank Profile separation of instanceId and account email
  // -------------------------------------------------------------
  console.log('\n[Test 3] Verifying Blank Profile directory ID (blank_*) is not taken for account email...');
  {
    const blankId = `blank_${Date.now()}`;
    const blankHome = path.join(TEST_ROOT, 'SandboxHome', '.ag-stealth-switcher', 'isolated_envs', blankId, 'home');
    const blankCli = path.join(blankHome, '.antigravity-cli');
    fs.mkdirSync(blankCli, { recursive: true });

    // Simulate user logs in through browser, Antigravity writes real token
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

    // Capture profile without emailOverride
    const profile = await captureCurrentProfile(TEST_ROOT);
    assert.strictEqual(profile.email, realEmail, 'Profile email must be alice.developer@gmail.com, NOT blank_*');
    assert.strictEqual(profile.cliToken.id_token_email, realEmail);

    // Restore env
    if (origUserProfile) {
      process.env.USERPROFILE = origUserProfile;
    } else {
      delete process.env.USERPROFILE;
    }
    console.log('  -> PASS: Blank profile directory name is properly separated from authentic user email.');
  }

  // -------------------------------------------------------------
  // TEST 4: Reading profile items from live uncheckpointed WAL
  // -------------------------------------------------------------
  console.log('\n[Test 4] Verifying extraction of live WAL frames via MVCC...');
  {
    const dbDir = path.join(TEST_ROOT, 'data', 'user-data', 'User', 'globalStorage');
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'state.vscdb');

    // Create DB with native SQLite in WAL mode
    const sdb = new DatabaseSync(dbPath);
    sdb.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
      INSERT INTO ItemTable VALUES ('antigravityUnifiedStateSync.oauthToken', 'live_wal_secret_123');
      INSERT INTO ItemTable VALUES ('jetskiStateSync.userStatus', 'active_live');
    `);

    // Verify WAL file exists and has data
    const walPath = `${dbPath}-wal`;
    assert.ok(fs.existsSync(walPath), 'WAL file must exist');
    assert.ok(fs.statSync(walPath).size > 0, 'WAL file must have non-zero size');

    // Extract auth items while database remains in WAL mode with live uncheckpointed frames
    const extracted = await extractAuthItemsFromDb(dbPath, TEST_ROOT);
    const tokenItem = extracted.find((it) => it.key === 'antigravityUnifiedStateSync.oauthToken');
    assert.ok(tokenItem, 'Must find live WAL oauth token item');
    assert.strictEqual(tokenItem.value, 'live_wal_secret_123', 'Must accurately read live uncheckpointed WAL value');

    sdb.close();
    console.log('  -> PASS: extractAuthItemsFromDb captures uncheckpointed WAL items without errors.');
  }

  // -------------------------------------------------------------
  // TEST 5: Strict targeted auth cleaning (preserving third-party secrets)
  // -------------------------------------------------------------
  console.log('\n[Test 5] Verifying strict targeted auth cleaning (preserving third-party secrets)...');
  {
    const dbDir = path.join(TEST_ROOT, 'data', 'user-data', 'User', 'globalStorage');
    const dbPath = path.join(dbDir, 'state.vscdb');

    // Insert third-party extension secrets and general IDE layout keys
    const sdb = new DatabaseSync(dbPath);
    sdb.exec(`
      INSERT OR REPLACE INTO ItemTable VALUES ('secret://{"extensionId":"ms-vscode.azure-account"}', 'azure_vault_secret');
      INSERT OR REPLACE INTO ItemTable VALUES ('secret://{"extensionId":"github.copilot"}', 'copilot_github_secret');
      INSERT OR REPLACE INTO ItemTable VALUES ('workbench.action.antigravity.panelLayout', 'sidebar_left_compact');
      INSERT OR REPLACE INTO ItemTable VALUES ('antigravityUnifiedStateSync.oauthToken', 'delete_this_token');
      INSERT OR REPLACE INTO ItemTable VALUES ('secret://antigravity_token', 'delete_this_secret');
    `);
    sdb.close();

    // Perform clearAuthItemsInDb
    await clearAuthItemsInDb(dbPath, TEST_ROOT);

    // Inspect remaining items
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
  // TEST 6: Authentic token lifetime (no fake Date.now() + 1h synthesis)
  // -------------------------------------------------------------
  console.log('\n[Test 6] Verifying token lifetime preservation...');
  {
    const userHome = path.join(TEST_ROOT, 'SandboxHome');
    const authenticExpiry = 1600000000000; // Past expired timestamp

    writeGeminiFileCredentials(
      userHome,
      'test@example.com',
      {
        access_token: 'auth_token_xyz',
        refresh_token: 'refresh_xyz',
        expiry_date: authenticExpiry,
      },
      TEST_ROOT
    );

    const credsFile = path.join(userHome, '.gemini', 'oauth_creds.json');
    const savedCreds = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
    assert.strictEqual(savedCreds.expiry_date, authenticExpiry, 'Must preserve authentic expiry_date');

    // When expiry is absent:
    writeGeminiFileCredentials(
      userHome,
      'test@example.com',
      {
        access_token: 'auth_token_no_expiry',
        refresh_token: 'refresh_xyz',
      },
      TEST_ROOT
    );
    const savedNoExpiry = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
    assert.strictEqual(savedNoExpiry.expiry_date, 0, 'Must set 0 when expiry absent so language_server refreshes');

    console.log('  -> PASS: authentic token lifetime preserved, no synthetic lifetime assigned.');
  }

  // -------------------------------------------------------------
  // TEST 7: Accurate Statistics Migration & Seamless Deduplication
  // -------------------------------------------------------------
  console.log('\n[Test 7] Verifying statistics migration (no modulo deletion flaw, seamless legacy claiming)...');
  {
    const statsDbPath = path.join(TEST_ROOT, 'SandboxHome', '.ag-stealth-switcher', 'token_stats.db');
    fs.mkdirSync(path.dirname(statsDbPath), { recursive: true });

    // Seed a legacy database without step_key column
    const sdb = new DatabaseSync(statsDbPath);
    sdb.exec(`
      CREATE TABLE token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      -- 1. Real request that happened to have 500 input and 180 output tokens (must NOT be purged!)
      INSERT INTO token_usage VALUES (1, 1700000000, 'legacy@example.com', 'gemini-1.5-pro', 500, 180, 0, 680, 'gemini-1.5-pro', 100);
      -- 2. Synthetic multiplier row from v1 (identified strictly by model = 'gemini-active')
      INSERT INTO token_usage VALUES (2, 1700000010, 'legacy@example.com', 'gemini-active', 250, 180, 0, 430, 'gemini', 150);
      -- 3. Another authentic legacy request
      INSERT INTO token_usage VALUES (3, 1700000020, 'legacy@example.com', 'gemini-2.0-flash', 150, 250, 50, 400, 'gemini-2.0-flash', 120);
    `);
    sdb.close();

    // Open via openTokenStatsDb: triggers deterministic migration
    const { db, close } = await openTokenStatsDb(TEST_ROOT);
    close();

    // Verify migration results
    const checkDb = new DatabaseSync(statsDbPath, { readOnly: true });
    const rows = checkDb.prepare('SELECT id, model, total_tokens, step_key FROM token_usage ORDER BY id').all();
    checkDb.close();

    // Row 2 ('gemini-active') must be purged
    // Row 1 (500/180) and Row 3 must be preserved!
    assert.strictEqual(rows.length, 2, 'Exactly 2 authentic rows must remain; gemini-active purged');
    assert.strictEqual(rows[0].id, 1, 'Authentic row 1 (500/180) must be preserved without false-positive purge');
    assert.strictEqual(rows[0].model, 'gemini-1.5-pro');
    assert.strictEqual(rows[0].total_tokens, 680);
    assert.strictEqual(rows[0].step_key, null, 'Legacy rows remain unkeyed until claimed by authentic sync');

    assert.strictEqual(rows[1].id, 3, 'Authentic row 3 must be preserved');
    assert.strictEqual(rows[1].model, 'gemini-2.0-flash');

    // Simulate Language Server RPC trajectory sync: re-imports row 1 with authentic step_key
    await recordBatchUsage(TEST_ROOT, [
      {
        stepKey: 'cascade_real_traj_1:0:msg_1',
        timestamp: 1700000000,
        accountEmail: 'legacy@example.com',
        model: 'gemini-1.5-pro',
        inputTokens: 500,
        outputTokens: 180,
        cachedTokens: 0,
        totalTokens: 680,
      },
    ]);

    // Inspect database after sync
    const checkDb2 = new DatabaseSync(statsDbPath, { readOnly: true });
    const rowsAfterSync = checkDb2.prepare('SELECT id, model, total_tokens, step_key FROM token_usage ORDER BY id').all();
    checkDb2.close();

    // Row 1 should have been claimed in-place with its authentic stepKey!
    assert.strictEqual(rowsAfterSync.length, 2, 'No new row inserted! Legacy row was claimed in-place');
    assert.strictEqual(rowsAfterSync[0].id, 1);
    assert.strictEqual(rowsAfterSync[0].step_key, 'cascade_real_traj_1:0:msg_1', 'Authentic stepKey successfully claimed');

    // Check summary totals: 680 + 400 = 1080 (zero double counting!)
    const summary = await getStatsSummary(TEST_ROOT);
    assert.strictEqual(summary.totalTokens, 1080, 'Total tokens must equal 1080 with zero double counting');

    console.log('  -> PASS: Statistics migration purges only synthetic records and claims legacy rows without double counting.');
  }

  cleanDir(TEST_ROOT);
  console.log('\n=== ALL AUDIT VERIFICATION TESTS PASSED SUCCESSFULLY! ===');
}

runTests().catch((err) => {
  console.error('\n[FAIL] Test failure:', err);
  process.exit(1);
});
