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
exports.getSqlInstance = getSqlInstance;
exports.sanitizeSqliteBuffer = sanitizeSqliteBuffer;
exports.openStateDb = openStateDb;
exports.extractAuthItemsFromDb = extractAuthItemsFromDb;
exports.injectAuthItemsIntoDb = injectAuthItemsIntoDb;
exports.clearAuthItemsInDb = clearAuthItemsInDb;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const sandboxEnv_1 = require("./sandboxEnv");
let sqlJsPromise = null;
/**
 * Resolves the sql.js initialization factory function.
 * Supports standard module resolution and local bundled sql-wasm.js fallback.
 */
function resolveSqlJsFactory() {
    // 1. Try standard require('sql.js')
    try {
        const mod = require('sql.js');
        return typeof mod === 'function' ? mod : mod.default || mod;
    }
    catch { }
    // 2. Try locally bundled sql-wasm.js in same directory
    const localJs = path.join(__dirname, 'sql-wasm.js');
    if (fs.existsSync(localJs)) {
        try {
            const mod = require(localJs);
            return typeof mod === 'function' ? mod : mod.default || mod;
        }
        catch { }
    }
    // 3. Try parent dist directory
    const parentJs = path.join(__dirname, '..', 'sql-wasm.js');
    if (fs.existsSync(parentJs)) {
        try {
            const mod = require(parentJs);
            return typeof mod === 'function' ? mod : mod.default || mod;
        }
        catch { }
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
async function getSqlInstance() {
    if (!sqlJsPromise) {
        const initSqlJs = resolveSqlJsFactory();
        sqlJsPromise = initSqlJs({
            locateFile: (file) => {
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
/**
 * Normalizes SQLite buffer if created in WAL mode (PRAGMA journal_mode=WAL).
 * sql.js (WebAssembly) cannot open databases where bytes 18 & 19 are 0x02.
 * Patching them to 0x01 allows clean memory loading, followed by PRAGMA journal_mode=DELETE.
 */
function sanitizeSqliteBuffer(buffer) {
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
async function openStateDb(dbPath, sandboxRoot) {
    (0, sandboxEnv_1.assertInsideSandbox)(dbPath, sandboxRoot);
    const SQL = await getSqlInstance();
    let db;
    if (fs.existsSync(dbPath)) {
        const rawBuffer = fs.readFileSync(dbPath);
        const patchedBuffer = sanitizeSqliteBuffer(rawBuffer);
        db = new SQL.Database(patchedBuffer);
        try {
            db.run('PRAGMA journal_mode = DELETE;');
        }
        catch {
            // Non-fatal
        }
    }
    else {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        db = new SQL.Database();
        db.run('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);');
    }
    const save = () => {
        (0, sandboxEnv_1.assertInsideSandbox)(dbPath, sandboxRoot, 'write');
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
        }
        catch {
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
async function extractAuthItemsFromDb(dbPath, sandboxRoot) {
    if (!fs.existsSync(dbPath)) {
        return [];
    }
    const { db, close } = await openStateDb(dbPath, sandboxRoot);
    const results = [];
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
                value: typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf-8'),
            });
        }
        stmt.free();
    }
    finally {
        close();
    }
    return results;
}
/**
 * Injects stored authentication items into state.vscdb.
 * Also synchronizes storage.serviceMachineId to eliminate ID divergence with storage.json (Argon fix #5).
 */
async function injectAuthItemsIntoDb(dbPath, items, sandboxRoot, devDeviceId) {
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
    }
    finally {
        close();
    }
}
/**
 * Clears all authentication rows to prepare a blank/fresh login session.
 */
async function clearAuthItemsInDb(dbPath, sandboxRoot) {
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
    }
    finally {
        close();
    }
}
//# sourceMappingURL=sqliteInjector.js.map