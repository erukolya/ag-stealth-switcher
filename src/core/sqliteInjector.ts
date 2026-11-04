import * as fs from 'fs';
import * as path from 'path';
import type { Database, SqlJsStatic } from 'sql.js';
import { assertInsideSandbox } from './sandboxEnv';

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

/**
 * Resolves the sql.js initialization factory function.
 * Supports standard module resolution and local bundled sql-wasm.js fallback.
 */
function resolveSqlJsFactory(): (config?: any) => Promise<SqlJsStatic> {
  // 1. Try standard require('sql.js')
  try {
    const mod = require('sql.js');
    return typeof mod === 'function' ? mod : mod.default || mod;
  } catch {}

  // 2. Try locally bundled sql-wasm.js in same directory
  const localJs = path.join(__dirname, 'sql-wasm.js');
  if (fs.existsSync(localJs)) {
    try {
      const mod = require(localJs);
      return typeof mod === 'function' ? mod : mod.default || mod;
    } catch {}
  }

  // 3. Try parent dist directory
  const parentJs = path.join(__dirname, '..', 'sql-wasm.js');
  if (fs.existsSync(parentJs)) {
    try {
      const mod = require(parentJs);
      return typeof mod === 'function' ? mod : mod.default || mod;
    } catch {}
  }

  throw new Error("Cannot find module 'sql.js' or bundled sql-wasm.js runtime");
}

/**
 * Initializes sql.js with robust locateFile resolution.
 * Looks for sql-wasm.wasm in:
 * 1. Current directory / dist
 * 2. Extension root / dist
 * 3. node_modules/sql.js/dist
 */
export async function getSqlInstance(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    const initSqlJs = resolveSqlJsFactory();
    sqlJsPromise = initSqlJs({
      locateFile: (file: string) => {
        // Check dist folder relative to this file
        const localDist = path.join(__dirname, file);
        if (fs.existsSync(localDist)) {
          return localDist;
        }
        // Check parent dist folder
        const parentDist = path.join(__dirname, '..', file);
        if (fs.existsSync(parentDist)) {
          return parentDist;
        }
        // Check node_modules
        const nmDist = path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', file);
        if (fs.existsSync(nmDist)) {
          return nmDist;
        }
        return file;
      },
    });
  }
  return await sqlJsPromise;
}

export interface DbItem {
  key: string;
  value: string;
}

/**
 * Normalizes SQLite buffer if created in WAL mode (PRAGMA journal_mode=WAL).
 * sql.js (WebAssembly) cannot open databases where bytes 18 & 19 are 0x02.
 * Patching them to 0x01 allows clean memory loading, followed by PRAGMA journal_mode=DELETE.
 */
export function sanitizeSqliteBuffer(buffer: Buffer): Buffer {
  if (buffer.length > 20 && buffer[18] === 2 && buffer[19] === 2) {
    buffer[18] = 1;
    buffer[19] = 1;
  }
  return buffer;
}

/**
 * Strict authentication and OAuth keys in ItemTable.
 * Strictly avoids deleting third-party extension secrets or general IDE UI/cache state.
 */
export const AUTH_ITEMS_WHERE_CLAUSE = `
  (
    key IN (
      'antigravityUnifiedStateSync.oauthToken',
      'antigravityUnifiedStateSync.userStatus',
      'jetskiStateSync.oauthToken',
      'jetskiStateSync.userStatus',
      'codeium.user',
      'codeium.apiKey',
      'storage.serviceMachineId'
    )
    OR key LIKE 'antigravityUnifiedStateSync.%'
    OR key LIKE 'jetskiStateSync.%'
    OR key LIKE 'codeium.%'
    OR key LIKE 'google.login%'
    OR key LIKE 'uss-oauth%'
    OR key LIKE 'secret://%antigravity%'
    OR key LIKE 'secret://%codeium%'
    OR key LIKE 'secret://%google%'
    OR key LIKE 'secret://%jetski%'
  )
`;

/**
 * Opens state.vscdb via sql.js (WebAssembly).
 * Safely handles WAL mode databases and atomic saves.
 */
export async function openStateDb(
  dbPath: string,
  sandboxRoot: string
): Promise<{ db: Database; save: () => void; close: () => void }> {
  assertInsideSandbox(dbPath, sandboxRoot);
  const SQL = await getSqlInstance();

  let db: Database;
  if (fs.existsSync(dbPath)) {
    // Safety check: if an unmerged non-empty WAL file exists, consolidate transactions before loading memory buffer
    const walFile = `${dbPath}-wal`;
    if (fs.existsSync(walFile)) {
      try {
        const stat = fs.statSync(walFile);
        if (stat.size > 0) {
          const { DatabaseSync } = require('node:sqlite');
          if (typeof DatabaseSync === 'function') {
            const sdb = new DatabaseSync(dbPath);
            try {
              sdb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
            } finally {
              sdb.close();
            }
          }
        }
      } catch (err: any) {
        // If checkpoint failed on a non-empty WAL file, throw error rather than reading stale main db
        if (fs.existsSync(walFile) && fs.statSync(walFile).size > 0) {
          throw new Error(
            `Cannot open SQLite database: WAL checkpoint failed (${err.message}). Database may be locked by a running process.`
          );
        }
      }
    }

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
    db.run('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);');
  }

  const save = () => {
    assertInsideSandbox(dbPath, sandboxRoot, 'write');
    const data = db.export();
    const buffer = Buffer.from(data);
    // Ensure bytes 18 & 19 are 1 (DELETE journal mode) in exported SQLite buffer
    if (buffer.length > 20) {
      buffer[18] = 1;
      buffer[19] = 1;
    }
    const tmpPath = `${dbPath}.tmp.${Date.now()}`;
    fs.writeFileSync(tmpPath, buffer);
    fs.renameSync(tmpPath, dbPath);

    // Clean up residual -wal file ONLY if truncated/clean to strictly avoid destroying transactions
    try {
      const walFile = `${dbPath}-wal`;
      if (fs.existsSync(walFile)) {
        const stat = fs.statSync(walFile);
        if (stat.size === 0) {
          fs.unlinkSync(walFile);
        } else {
          // Attempt checkpoint before removing
          try {
            const { DatabaseSync } = require('node:sqlite');
            if (typeof DatabaseSync === 'function') {
              const sdb = new DatabaseSync(dbPath);
              try {
                sdb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
              } finally {
                sdb.close();
              }
            }
          } catch {}
          if (fs.existsSync(walFile) && fs.statSync(walFile).size === 0) {
            fs.unlinkSync(walFile);
          }
        }
      }
      if (fs.existsSync(`${dbPath}-shm`)) {
        fs.unlinkSync(`${dbPath}-shm`);
      }
    } catch {
      // Best-effort cleanup
    }
  };

  const close = () => {
    db.close();
  };

  return { db, save, close };
}

/**
 * Extracts all authentication, session and OAuth rows from ItemTable.
 * Leverages native node:sqlite readOnly MVCC connection first to read active WAL transactions live.
 */
export async function extractAuthItemsFromDb(dbPath: string, sandboxRoot: string): Promise<DbItem[]> {
  if (!fs.existsSync(dbPath)) {
    return [];
  }
  assertInsideSandbox(dbPath, sandboxRoot, 'read');

  // 1. Primary extraction via native node:sqlite with readOnly: true (supports MVCC live WAL reads)
  try {
    const { DatabaseSync } = require('node:sqlite');
    if (typeof DatabaseSync === 'function') {
      const sdb = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const query = `
          SELECT key, value FROM ItemTable
          WHERE ${AUTH_ITEMS_WHERE_CLAUSE};
        `;
        const stmt = sdb.prepare(query);
        const rows = stmt.all() as any[];
        return rows.map((row: any) => ({
          key: String(row.key),
          value: typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf-8'),
        }));
      } finally {
        sdb.close();
      }
    }
  } catch {
    // If native node:sqlite unavailable or fails, fall through to sql.js fallback
  }

  // 2. Fallback via sql.js (WebAssembly)
  const { db, close } = await openStateDb(dbPath, sandboxRoot);
  const results: DbItem[] = [];

  try {
    const query = `
      SELECT key, value FROM ItemTable
      WHERE ${AUTH_ITEMS_WHERE_CLAUSE};
    `;
    const stmt = db.prepare(query);
    while (stmt.step()) {
      const row = stmt.getAsObject();
      results.push({
        key: String(row.key),
        value: typeof row.value === 'string' ? row.value : Buffer.from(row.value as any).toString('utf-8'),
      });
    }
    stmt.free();
  } finally {
    close();
  }

  return results;
}

/**
 * Injects stored authentication items into state.vscdb.
 * Also synchronizes storage.serviceMachineId to eliminate ID divergence with storage.json (Argon fix #5).
 */
export async function injectAuthItemsIntoDb(
  dbPath: string,
  items: DbItem[],
  sandboxRoot: string,
  devDeviceId?: string
): Promise<void> {
  const { db, save, close } = await openStateDb(dbPath, sandboxRoot);

  try {
    // 1. Clean existing auth items strictly matching authentication keys
    const deleteQuery = `
      DELETE FROM ItemTable
      WHERE ${AUTH_ITEMS_WHERE_CLAUSE};
    `;
    db.run(deleteQuery);

    // 2. Insert target profile items
    const insertStmt = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?);');
    for (const item of items) {
      insertStmt.run([item.key, item.value]);
    }

    // 3. Argon Fix #5: Synchronize storage.serviceMachineId inside state.vscdb
    if (devDeviceId) {
      insertStmt.run(['storage.serviceMachineId', devDeviceId]);
    }
    insertStmt.free();

    // 4. Persist atomically
    save();
  } finally {
    close();
  }
}

/**
 * Clears all authentication rows to prepare a blank/fresh login session.
 */
export async function clearAuthItemsInDb(dbPath: string, sandboxRoot: string): Promise<void> {
  if (!fs.existsSync(dbPath)) {
    return;
  }
  const { db, save, close } = await openStateDb(dbPath, sandboxRoot);
  try {
    const deleteQuery = `
      DELETE FROM ItemTable
      WHERE ${AUTH_ITEMS_WHERE_CLAUSE};
    `;
    db.run(deleteQuery);
    save();
  } finally {
    close();
  }
}
