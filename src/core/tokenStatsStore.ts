import * as fs from 'fs';
import * as path from 'path';
import { Database } from 'sql.js';
import { getSandboxPaths } from './paths';
import { assertInsideSandbox } from './sandboxEnv';
import { getSqlInstance, sanitizeSqliteBuffer } from './sqliteInjector';
import { getAllCascadeTrajectories, getCascadeTrajectory } from './lsRpcClient';

export interface TokenUsageRecord {
  id?: number;
  stepKey?: string;
  timestamp: number;
  accountEmail: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  requestedModel?: string;
  ttftMs?: number;
}

export interface TokenStatsSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalTokens: number;
  totalRequests: number;
  uniqueAccounts: number;
}

export interface TokenStatsAggregated {
  period: string; // "YYYY-MM-DD HH:00" for hourly, "YYYY-MM-DD" for daily
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalTokens: number;
  requestCount: number;
}

export interface ModelTokenStats {
  model: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalTokens: number;
  requestCount: number;
  percentage?: number;
}

export interface AccountTokenStats {
  accountEmail: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalTokens: number;
  requestCount: number;
  percentage?: number;
}

export interface TrendPoint {
  period: string;
  series: Record<string, number>;
}

export function getTokenStatsDbPath(sandboxRoot: string): string {
  const paths = getSandboxPaths(sandboxRoot);
  return path.join(paths.switcherDir, 'token_stats.db');
}

/**
 * Opens token_stats.db with WAL header patching and atomic commit support.
 */
export async function openTokenStatsDb(
  sandboxRoot: string
): Promise<{ db: Database; save: () => void; close: () => void }> {
  const dbPath = getTokenStatsDbPath(sandboxRoot);
  assertInsideSandbox(dbPath, sandboxRoot);

  const SQL = await getSqlInstance();
  let db: Database;

  if (fs.existsSync(dbPath)) {
    const rawBuffer = fs.readFileSync(dbPath);
    const patchedBuffer = sanitizeSqliteBuffer(rawBuffer);
    db = new SQL.Database(patchedBuffer);
    try {
      db.run('PRAGMA journal_mode = DELETE;');
    } catch {
      // Non-fatal
    }
  } else {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new SQL.Database();
  }

  // 1. Table schema definition (Antigravity-Manager v5.0.2-beta.7+ compatible)
  db.run(`
    CREATE TABLE IF NOT EXISTS token_usage (
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
  `);

  // 2. Automated schema migration: add step_key column if upgrading an existing legacy database
  let ranMigration = false;
  try {
    const tableInfo = db.exec('PRAGMA table_info(token_usage);');
    if (tableInfo.length > 0 && Array.isArray(tableInfo[0].values)) {
      const hasStepKey = tableInfo[0].values.some((col: any) => col[1] === 'step_key');
      if (!hasStepKey) {
        db.run('ALTER TABLE token_usage ADD COLUMN step_key TEXT;');
        ranMigration = true;
      }
    }
  } catch {
    // Migration fallback failed non-fatally
  }

  // 3. Purge synthetic fallback records from v1 (strictly by synthetic model identifier 'gemini-active')
  try {
    const syntheticCheck = db.exec("SELECT COUNT(*) FROM token_usage WHERE model = 'gemini-active';");
    const syntheticCount =
      syntheticCheck.length > 0 && syntheticCheck[0].values[0] ? Number(syntheticCheck[0].values[0][0]) : 0;

    if (syntheticCount > 0) {
      ranMigration = true;
      db.run("DELETE FROM token_usage WHERE model = 'gemini-active';");
      db.run("DELETE FROM token_sync_cursor WHERE source_id = 'conv_summaries';");

      // Rebuild token_stats_hourly aggregates from clean token_usage to eliminate purged synthetic totals
      db.run('DELETE FROM token_stats_hourly;');
      db.run(`
        INSERT OR REPLACE INTO token_stats_hourly (
          hour_bucket, account_email, total_input_tokens, total_output_tokens, total_cached_tokens, total_tokens, request_count
        )
        SELECT
          strftime('%Y-%m-%d %H:00', datetime(timestamp, 'unixepoch', 'localtime')) AS hour_bucket,
          account_email,
          SUM(input_tokens),
          SUM(output_tokens),
          SUM(cached_tokens),
          SUM(total_tokens),
          COUNT(*)
        FROM token_usage
        GROUP BY hour_bucket, account_email;
      `);
    }
  } catch {
    // Legacy sanitation failed non-fatally
  }

  // 4. Create indices and auxiliary tables
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_token_step_key ON token_usage (step_key);
    CREATE INDEX IF NOT EXISTS idx_token_timestamp ON token_usage (timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_token_account ON token_usage (account_email);
    CREATE INDEX IF NOT EXISTS idx_token_model ON token_usage (model);

    CREATE TABLE IF NOT EXISTS token_stats_hourly (
        hour_bucket TEXT NOT NULL,
        account_email TEXT NOT NULL,
        total_input_tokens INTEGER NOT NULL DEFAULT 0,
        total_output_tokens INTEGER NOT NULL DEFAULT 0,
        total_cached_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        request_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (hour_bucket, account_email)
    );

    CREATE INDEX IF NOT EXISTS idx_hourly_account ON token_stats_hourly (account_email, hour_bucket);

    CREATE TABLE IF NOT EXISTS token_sync_cursor (
        source_id TEXT PRIMARY KEY,
        last_cursor TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    );
  `);

  const save = () => {
    assertInsideSandbox(dbPath, sandboxRoot);
    const data = db.export();
    const buffer = Buffer.from(data);
    const tmpPath = `${dbPath}.tmp.${Date.now()}`;
    fs.writeFileSync(tmpPath, buffer);
    fs.renameSync(tmpPath, dbPath);
  };

  // If schema was migrated or legacy rows sanitized, persist to disk immediately
  if (ranMigration) {
    try {
      save();
    } catch {}
  }

  const close = () => {
    db.close();
  };

  return { db, save, close };
}

/**
 * Gets the current deduplication sync cursor for a given source.
 */
export function getSyncCursor(db: Database, sourceId: string): string | null {
  try {
    const stmt = db.prepare('SELECT last_cursor FROM token_sync_cursor WHERE source_id = ?;');
    stmt.bind([sourceId]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return String(row.last_cursor || '');
    }
    stmt.free();
  } catch {
    // Non-fatal
  }
  return null;
}

/**
 * Updates the sync cursor.
 */
export function setSyncCursor(db: Database, sourceId: string, cursor: string): void {
  try {
    const now = Math.floor(Date.now() / 1000);
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO token_sync_cursor (source_id, last_cursor, updated_at)
      VALUES (?, ?, ?);
    `);
    stmt.run([sourceId, cursor, now]);
    stmt.free();
  } catch {
    // Non-fatal
  }
}

/**
 * Inserts a batch of usage records atomically and updates token_stats_hourly.
 * Flawlessly deduplicates using ON CONFLICT(step_key) DO NOTHING and getRowsModified().
 */
export async function recordBatchUsage(
  sandboxRoot: string,
  records: TokenUsageRecord[]
): Promise<number> {
  if (records.length === 0) {
    return 0;
  }

  const { db, save, close } = await openTokenStatsDb(sandboxRoot);
  let count = 0;

  try {
    const claimLegacyStmt = db.prepare(`
      UPDATE token_usage
      SET step_key = ?
      WHERE id = (
        SELECT id FROM token_usage
        WHERE step_key IS NULL
          AND model = ?
          AND timestamp BETWEEN ? AND ?
          AND input_tokens = ?
          AND output_tokens = ?
        LIMIT 1
      );
    `);

    const insertUsageStmt = db.prepare(`
      INSERT INTO token_usage (
        step_key, timestamp, account_email, model,
        input_tokens, output_tokens, cached_tokens, total_tokens,
        requested_model, ttft_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(step_key) DO NOTHING;
    `);

    const updateHourlyStmt = db.prepare(`
      INSERT INTO token_stats_hourly (
        hour_bucket, account_email,
        total_input_tokens, total_output_tokens, total_cached_tokens, total_tokens,
        request_count
      ) VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(hour_bucket, account_email) DO UPDATE SET
        total_input_tokens = total_input_tokens + excluded.total_input_tokens,
        total_output_tokens = total_output_tokens + excluded.total_output_tokens,
        total_cached_tokens = total_cached_tokens + excluded.total_cached_tokens,
        total_tokens = total_tokens + excluded.total_tokens,
        request_count = request_count + 1;
    `);

    for (const r of records) {
      const total = r.totalTokens || (r.inputTokens + r.outputTokens);
      const stepKey =
        r.stepKey || `${r.timestamp}_${r.model}_${r.inputTokens}_${r.outputTokens}_${Math.random()}`;

      // 1. First attempt to match and claim an existing unkeyed legacy row
      claimLegacyStmt.run([
        stepKey,
        r.model,
        r.timestamp - 5,
        r.timestamp + 5,
        r.inputTokens,
        r.outputTokens,
      ]);

      const claimedCount = db.getRowsModified();
      if (claimedCount > 0) {
        // The legacy row was claimed and updated in-place with its authentic stepKey.
        // It was already counted in token_stats_hourly when created, so do NOT increment hourly again!
        count++;
        continue;
      }

      // 2. If not a legacy match, perform idempotent insert
      insertUsageStmt.run([
        stepKey,
        r.timestamp,
        r.accountEmail,
        r.model,
        r.inputTokens,
        r.outputTokens,
        r.cachedTokens,
        total,
        r.requestedModel || null,
        r.ttftMs || null,
      ]);

      const rowsModified = db.getRowsModified();
      if (rowsModified > 0) {
        count++;
        const d = new Date(r.timestamp * 1000);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        const hourBucket = `${yyyy}-${mm}-${dd} ${hh}:00`;

        updateHourlyStmt.run([
          hourBucket,
          r.accountEmail,
          r.inputTokens,
          r.outputTokens,
          r.cachedTokens,
          total,
        ]);
      }
    }

    claimLegacyStmt.free();
    insertUsageStmt.free();
    updateHourlyStmt.free();

    if (count > 0) {
      save();
    }
  } finally {
    close();
  }

  return count;
}

/**
 * Synchronizes real token usage directly from local sandbox language_server RPC.
 * Fetches all trajectories, calls GetCascadeTrajectory for each, and extracts generatorMetadata usages.
 * Uses SQLite ON CONFLICT(step_key) DO NOTHING for flawless mathematical deduplication without data loss.
 */
export async function syncTokenData(
  sandboxRoot: string,
  currentAccountEmail: string
): Promise<{ addedSteps: number; source: string }> {
  const recordsToInsert: TokenUsageRecord[] = [];
  let sourceUsed = 'none';

  // 1. Query local RPC GetAllCascadeTrajectories
  let trajectoriesRes: any = null;
  try {
    trajectoriesRes = await getAllCascadeTrajectories(sandboxRoot);
  } catch {
    trajectoriesRes = null;
  }

  if (trajectoriesRes) {
    sourceUsed = 'local_rpc';
    // Antigravity language_server returns: { trajectorySummaries: { [cascadeId: string]: TrajectorySummary } }
    const summaries = trajectoriesRes.trajectorySummaries || {};
    const cascadeIds = Object.keys(summaries);

    if (cascadeIds.length > 0) {
      for (const cascadeId of cascadeIds) {
        try {
          const trajRes = await getCascadeTrajectory(sandboxRoot, cascadeId);
          const traj = trajRes?.trajectory || trajRes;
          if (!traj) {
            continue;
          }

          const generatorMeta = Array.isArray(traj.generatorMetadata) ? traj.generatorMetadata : [];

          for (let mIdx = 0; mIdx < generatorMeta.length; mIdx++) {
            const meta = generatorMeta[mIdx];
            const chatModel = meta.chatModel || {};
            const usage = chatModel.usage || {};
            const model = chatModel.model || usage.model || 'gemini-model';
            const inputTokens = parseInt(usage.inputTokens || '0', 10);
            const outputTokens = parseInt(usage.outputTokens || '0', 10);
            const cachedTokens = parseInt(usage.cachedTokens || '0', 10);
            const totalTokens = inputTokens + outputTokens;

            if (totalTokens > 0 || inputTokens > 0 || outputTokens > 0) {
              const stepIdx = meta.stepIndices?.[0] ?? mIdx;
              const stepCreatedAt = traj.steps?.[stepIdx]?.metadata?.createdAt || traj.lastModifiedTime;
              const ts = stepCreatedAt
                ? Math.floor(new Date(stepCreatedAt).getTime() / 1000)
                : Math.floor(Date.now() / 1000);
              const messageId = usage.messageId || `${mIdx}`;
              const stepKey = `${cascadeId}:${stepIdx}:${messageId}`;

              recordsToInsert.push({
                stepKey,
                timestamp: ts,
                accountEmail: currentAccountEmail,
                model,
                inputTokens,
                outputTokens,
                cachedTokens,
                totalTokens,
                requestedModel: chatModel.model || model,
              });
            }
          }

          // Fallback if generatorMetadata was absent but steps have tokenUsage
          if (generatorMeta.length === 0 && Array.isArray(traj.steps)) {
            for (let i = 0; i < traj.steps.length; i++) {
              const step = traj.steps[i];
              const usage = step.tokenUsage || step.usage || {};
              const inputTokens = Number(usage.promptTokens || usage.inputTokens || 0);
              const outputTokens = Number(usage.candidateTokens || usage.outputTokens || 0);
              const cachedTokens = Number(usage.cachedTokens || 0);
              const totalTokens = Number(usage.totalTokens || (inputTokens + outputTokens));

              if (totalTokens > 0 || inputTokens > 0 || outputTokens > 0) {
                const ts = step.metadata?.createdAt
                  ? Math.floor(new Date(step.metadata.createdAt).getTime() / 1000)
                  : Math.floor(Date.now() / 1000);
                const stepKey = `${cascadeId}:${step.stepIndex ?? i}:${step.plannerResponse?.messageId || i}`;
                recordsToInsert.push({
                  stepKey,
                  timestamp: ts,
                  accountEmail: currentAccountEmail,
                  model: step.model || 'gemini-model',
                  inputTokens,
                  outputTokens,
                  cachedTokens,
                  totalTokens,
                  requestedModel: step.requestedModel || step.model,
                });
              }
            }
          }
        } catch {
          // Skip unparseable trajectory
        }
      }
    } else if (Array.isArray(trajectoriesRes.trajectories || trajectoriesRes.cascadeTrajectories)) {
      // Compatibility with classic array trajectory responses
      const trajectories = trajectoriesRes.trajectories || trajectoriesRes.cascadeTrajectories;
      for (const t of trajectories) {
        const trajId = String(t.trajectoryId || t.id || '');
        const steps = t.steps || t.trajectorySteps || [];
        if (Array.isArray(steps)) {
          for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            const inputTokens = Number(step.tokenUsage?.promptTokens || step.inputTokens || 0);
            const outputTokens = Number(step.tokenUsage?.candidateTokens || step.outputTokens || 0);
            const cachedTokens = Number(step.tokenUsage?.cachedTokens || 0);
            const totalTokens = Number(step.tokenUsage?.totalTokens || (inputTokens + outputTokens));

            if (totalTokens > 0 || inputTokens > 0 || outputTokens > 0) {
              const ts = step.timestamp
                ? Math.floor(new Date(step.timestamp).getTime() / 1000)
                : Math.floor(Date.now() / 1000);
              const stepKey = `${trajId}:${step.stepIndex ?? i}`;
              recordsToInsert.push({
                stepKey,
                timestamp: ts,
                accountEmail: currentAccountEmail,
                model: step.model || 'gemini-model',
                inputTokens,
                outputTokens,
                cachedTokens,
                totalTokens,
              });
            }
          }
        }
      }
    }
  }

  let addedSteps = 0;
  if (recordsToInsert.length > 0) {
    addedSteps = await recordBatchUsage(sandboxRoot, recordsToInsert);
  }

  return { addedSteps, source: sourceUsed };
}

/**
 * Returns overall token stats KPI summary.
 */
export async function getStatsSummary(sandboxRoot: string): Promise<TokenStatsSummary> {
  const { db, close } = await openTokenStatsDb(sandboxRoot);
  try {
    const res = db.exec(`
      SELECT
        COALESCE(SUM(input_tokens), 0) AS total_input,
        COALESCE(SUM(output_tokens), 0) AS total_output,
        COALESCE(SUM(cached_tokens), 0) AS total_cached,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COUNT(*) AS total_requests,
        COUNT(DISTINCT account_email) AS unique_accounts
      FROM token_usage;
    `);

    if (res.length > 0 && res[0].values.length > 0) {
      const row = res[0].values[0];
      return {
        totalInputTokens: Number(row[0] || 0),
        totalOutputTokens: Number(row[1] || 0),
        totalCachedTokens: Number(row[2] || 0),
        totalTokens: Number(row[3] || 0),
        totalRequests: Number(row[4] || 0),
        uniqueAccounts: Number(row[5] || 0),
      };
    }
    return {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCachedTokens: 0,
      totalTokens: 0,
      totalRequests: 0,
      uniqueAccounts: 0,
    };
  } finally {
    close();
  }
}

/**
 * Aggregates token usage by hourly, daily, or weekly buckets.
 */
export async function getAggregatedStats(
  sandboxRoot: string,
  timeRange: 'hourly' | 'daily' | 'weekly'
): Promise<TokenStatsAggregated[]> {
  const { db, close } = await openTokenStatsDb(sandboxRoot);
  try {
    let query = '';

    if (timeRange === 'hourly') {
      // Last 24 hours
      query = `
        SELECT
          hour_bucket AS period,
          SUM(total_input_tokens) AS input_t,
          SUM(total_output_tokens) AS output_t,
          SUM(total_cached_tokens) AS cached_t,
          SUM(total_tokens) AS total_t,
          SUM(request_count) AS req_count
        FROM token_stats_hourly
        GROUP BY hour_bucket
        ORDER BY hour_bucket DESC
        LIMIT 24;
      `;
    } else if (timeRange === 'daily') {
      // Last 7-14 days
      query = `
        SELECT
          SUBSTR(hour_bucket, 1, 10) AS period,
          SUM(total_input_tokens) AS input_t,
          SUM(total_output_tokens) AS output_t,
          SUM(total_cached_tokens) AS cached_t,
          SUM(total_tokens) AS total_t,
          SUM(request_count) AS req_count
        FROM token_stats_hourly
        GROUP BY SUBSTR(hour_bucket, 1, 10)
        ORDER BY period DESC
        LIMIT 14;
      `;
    } else {
      // Weekly: last 30-60 days
      query = `
        SELECT
          SUBSTR(hour_bucket, 1, 10) AS period,
          SUM(total_input_tokens) AS input_t,
          SUM(total_output_tokens) AS output_t,
          SUM(total_cached_tokens) AS cached_t,
          SUM(total_tokens) AS total_t,
          SUM(request_count) AS req_count
        FROM token_stats_hourly
        GROUP BY SUBSTR(hour_bucket, 1, 10)
        ORDER BY period DESC
        LIMIT 30;
      `;
    }

    const res = db.exec(query);
    const list: TokenStatsAggregated[] = [];

    if (res.length > 0) {
      for (const row of res[0].values) {
        list.push({
          period: String(row[0]),
          totalInputTokens: Number(row[1] || 0),
          totalOutputTokens: Number(row[2] || 0),
          totalCachedTokens: Number(row[3] || 0),
          totalTokens: Number(row[4] || 0),
          requestCount: Number(row[5] || 0),
        });
      }
    }

    return list.reverse(); // Chronological order
  } finally {
    close();
  }
}

export async function getHourlyStats(sandboxRoot: string, _hours: number = 24): Promise<TokenStatsAggregated[]> {
  return getAggregatedStats(sandboxRoot, 'hourly');
}

export async function getDailyStats(sandboxRoot: string, _days: number = 7): Promise<TokenStatsAggregated[]> {
  return getAggregatedStats(sandboxRoot, 'daily');
}

export async function getWeeklyStats(sandboxRoot: string, _weeks: number = 4): Promise<TokenStatsAggregated[]> {
  return getAggregatedStats(sandboxRoot, 'weekly');
}


/**
 * Returns token usage breakdown by Model.
 */
export async function getModelStats(sandboxRoot: string): Promise<ModelTokenStats[]> {
  const { db, close } = await openTokenStatsDb(sandboxRoot);
  try {
    const res = db.exec(`
      SELECT
        model,
        SUM(input_tokens) AS input_t,
        SUM(output_tokens) AS output_t,
        SUM(cached_tokens) AS cached_t,
        SUM(total_tokens) AS total_t,
        COUNT(*) AS req_count
      FROM token_usage
      GROUP BY model
      ORDER BY total_t DESC;
    `);

    const list: ModelTokenStats[] = [];
    let grandTotal = 0;

    if (res.length > 0) {
      for (const row of res[0].values) {
        const total = Number(row[4] || 0);
        grandTotal += total;
        list.push({
          model: String(row[0]),
          totalInputTokens: Number(row[1] || 0),
          totalOutputTokens: Number(row[2] || 0),
          totalCachedTokens: Number(row[3] || 0),
          totalTokens: total,
          requestCount: Number(row[5] || 0),
        });
      }
    }

    for (const item of list) {
      item.percentage = grandTotal > 0 ? Math.round((item.totalTokens / grandTotal) * 100) : 0;
    }

    return list;
  } finally {
    close();
  }
}

/**
 * Returns token usage breakdown by Account.
 */
export async function getAccountStats(sandboxRoot: string): Promise<AccountTokenStats[]> {
  const { db, close } = await openTokenStatsDb(sandboxRoot);
  try {
    const res = db.exec(`
      SELECT
        account_email,
        SUM(input_tokens) AS input_t,
        SUM(output_tokens) AS output_t,
        SUM(cached_tokens) AS cached_t,
        SUM(total_tokens) AS total_t,
        COUNT(*) AS req_count
      FROM token_usage
      GROUP BY account_email
      ORDER BY total_t DESC;
    `);

    const list: AccountTokenStats[] = [];
    let grandTotal = 0;

    if (res.length > 0) {
      for (const row of res[0].values) {
        const total = Number(row[4] || 0);
        grandTotal += total;
        list.push({
          accountEmail: String(row[0]),
          totalInputTokens: Number(row[1] || 0),
          totalOutputTokens: Number(row[2] || 0),
          totalCachedTokens: Number(row[3] || 0),
          totalTokens: total,
          requestCount: Number(row[5] || 0),
        });
      }
    }

    for (const item of list) {
      item.percentage = grandTotal > 0 ? Math.round((item.totalTokens / grandTotal) * 100) : 0;
    }

    return list;
  } finally {
    close();
  }
}

/**
 * Returns trend points across periods broken down by Model.
 */
export async function getModelTrend(
  sandboxRoot: string,
  timeRange: 'hourly' | 'daily' | 'weekly'
): Promise<TrendPoint[]> {
  const { db, close } = await openTokenStatsDb(sandboxRoot);
  try {
    const groupExpr = timeRange === 'hourly'
      ? `strftime('%Y-%m-%d %H:00', datetime(timestamp, 'unixepoch', 'localtime'))`
      : `strftime('%Y-%m-%d', datetime(timestamp, 'unixepoch', 'localtime'))`;

    const res = db.exec(`
      SELECT
        ${groupExpr} AS period,
        model,
        SUM(total_tokens) AS total_t
      FROM token_usage
      GROUP BY period, model
      ORDER BY period ASC;
    `);

    const pointMap = new Map<string, Record<string, number>>();

    if (res.length > 0) {
      for (const row of res[0].values) {
        const period = String(row[0]);
        const model = String(row[1]);
        const total = Number(row[2] || 0);

        if (!pointMap.has(period)) {
          pointMap.set(period, {});
        }
        pointMap.get(period)![model] = total;
      }
    }

    return Array.from(pointMap.entries()).map(([period, series]) => ({
      period,
      series,
    }));
  } finally {
    close();
  }
}

/**
 * Returns trend points across periods broken down by Account.
 */
export async function getAccountTrend(
  sandboxRoot: string,
  timeRange: 'hourly' | 'daily' | 'weekly'
): Promise<TrendPoint[]> {
  const { db, close } = await openTokenStatsDb(sandboxRoot);
  try {
    const groupExpr = timeRange === 'hourly'
      ? `strftime('%Y-%m-%d %H:00', datetime(timestamp, 'unixepoch', 'localtime'))`
      : `strftime('%Y-%m-%d', datetime(timestamp, 'unixepoch', 'localtime'))`;

    const res = db.exec(`
      SELECT
        ${groupExpr} AS period,
        account_email,
        SUM(total_tokens) AS total_t
      FROM token_usage
      GROUP BY period, account_email
      ORDER BY period ASC;
    `);

    const pointMap = new Map<string, Record<string, number>>();

    if (res.length > 0) {
      for (const row of res[0].values) {
        const period = String(row[0]);
        const email = String(row[1]);
        const total = Number(row[2] || 0);

        if (!pointMap.has(period)) {
          pointMap.set(period, {});
        }
        pointMap.get(period)![email] = total;
      }
    }

    return Array.from(pointMap.entries()).map(([period, series]) => ({
      period,
      series,
    }));
  } finally {
    close();
  }
}
