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
  console.log('=== RUNNING VERIFICATION FOR 5 REMAINING AUDIT FIXES ===\n');
  cleanDir(TEST_ROOT);
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  // -------------------------------------------------------------
  // TEST 1: isolated-dir account isolation & unified session context
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
    assert.strictEqual(ctx.account, 'accountB_gmail_com', 'Detected account must be accountB');
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
  // TEST 2: Reading profile items from live uncheckpointed WAL
  // -------------------------------------------------------------
  console.log('\n[Test 2] Verifying extraction of live WAL frames via MVCC...');
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
  // TEST 3: Strict targeted database cleaning (no wiping other secrets)
  // -------------------------------------------------------------
  console.log('\n[Test 3] Verifying strict targeted auth cleaning (preserving third-party secrets)...');
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
  // TEST 4: Authentic token lifetime (no fake Date.now() + 1h synthesis)
  // -------------------------------------------------------------
  console.log('\n[Test 4] Verifying token lifetime preservation...');
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
  // TEST 5: Statistics migration (purging synthetic & deduplicating)
  // -------------------------------------------------------------
  console.log('\n[Test 5] Verifying statistics migration & duplicate prevention...');
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
      -- Insert synthetic multiplier row from v1 (250 / 180 / 430)
      INSERT INTO token_usage VALUES (1, 1700000000, 'legacy@example.com', 'gemini-pro', 250, 180, 0, 430, 'gemini', 100);
      -- Insert authentic legacy row
      INSERT INTO token_usage VALUES (2, 1700000010, 'legacy@example.com', 'gemini-pro', 345, 678, 50, 1073, 'gemini', 150);
    `);
    sdb.close();

    // Open via openTokenStatsDb: triggers migration
    const { db, close } = await openTokenStatsDb(TEST_ROOT);
    close();

    // Verify migration results
    const checkDb = new DatabaseSync(statsDbPath, { readOnly: true });
    const rows = checkDb.prepare('SELECT id, step_key, total_tokens FROM token_usage').all();
    checkDb.close();

    assert.strictEqual(rows.length, 1, 'Synthetic row must be purged; exactly 1 authentic row remains');
    assert.strictEqual(rows[0].id, 2, 'Authentic row #2 must be preserved');
    assert.ok(rows[0].step_key && rows[0].step_key.startsWith('migrated_2_'), 'Authentic row must have deterministic step_key');

    // Test recordBatchUsage with new unique step keys: ensure no double counting
    await recordBatchUsage(TEST_ROOT, [
      {
        stepKey: 'step_real_1',
        timestamp: 1700000020,
        accountEmail: 'legacy@example.com',
        model: 'gemini-pro',
        inputTokens: 100,
        outputTokens: 200,
        cachedTokens: 0,
        totalTokens: 300,
      },
      // Re-insert same step: must deduplicate and not increase total
      {
        stepKey: 'step_real_1',
        timestamp: 1700000020,
        accountEmail: 'legacy@example.com',
        model: 'gemini-pro',
        inputTokens: 100,
        outputTokens: 200,
        cachedTokens: 0,
        totalTokens: 300,
      },
    ]);

    const summary = await getStatsSummary(TEST_ROOT);
    // Total tokens should be: 1073 (migrated authentic row) + 300 (step_real_1 once) = 1373
    assert.strictEqual(summary.totalTokens, 1373, 'Total tokens must equal 1373 with zero duplication');

    console.log('  -> PASS: Statistics migration purges synthetic rows and deduplicates flawlessly.');
  }

  cleanDir(TEST_ROOT);
  console.log('\n=== ALL 5 AUDIT VERIFICATION TESTS PASSED SUCCESSFULLY! ===');
}

runTests().catch((err) => {
  console.error('\n[FAIL] Test failure:', err);
  process.exit(1);
});
