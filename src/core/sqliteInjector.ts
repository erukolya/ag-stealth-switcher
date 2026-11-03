import * as fs from 'fs';
import * as path from 'path';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import { assertInsideSandbox } from './sandboxEnv';

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

/**
 * Initializes sql.js with robust locateFile resolution.
 * Looks for sql-wasm.wasm in:
 * 1. Current directory / dist
 * 2. Extension root / dist
 * 3. node_modules/sql.js/dist
 */
export async function getSqlInstance(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
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

    // Clean up any stale -wal or -shm files so SQLite starts cleanly in DELETE mode
    try {
      if (fs.existsSync(`${dbPath}-wal`)) {
        fs.unlinkSync(`${dbPath}-wal`);
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
 */
export async function extractAuthItemsFromDb(dbPath: string, sandboxRoot: string): Promise<DbItem[]> {
  if (!fs.existsSync(dbPath)) {
    return [];
  }

  const { db, close } = await openStateDb(dbPath, sandboxRoot);
  const results: DbItem[] = [];

  try {
    const query = `
      SELECT key, value FROM ItemTable
      WHERE key LIKE '%antigravity%'
         OR key LIKE '%uss-oauth%'
         OR key LIKE '%google%'
         OR key LIKE '%jetski%'
         OR key LIKE '%codeium%'
         OR key LIKE '%secret://%'
         OR key = 'storage.serviceMachineId';
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
    // 1. Clean existing auth items
    const deleteQuery = `
      DELETE FROM ItemTable
      WHERE key LIKE '%antigravity%'
         OR key LIKE '%uss-oauth%'
         OR key LIKE '%google%'
         OR key LIKE '%jetski%'
         OR key LIKE '%codeium%'
         OR key LIKE '%secret://%'
         OR key = 'storage.serviceMachineId';
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
      WHERE key LIKE '%antigravity%'
         OR key LIKE '%uss-oauth%'
         OR key LIKE '%google%'
         OR key LIKE '%jetski%'
         OR key LIKE '%codeium%'
         OR key LIKE '%secret://%'
         OR key = 'storage.serviceMachineId';
    `;
    db.run(deleteQuery);
    save();
  } finally {
    close();
  }
}
