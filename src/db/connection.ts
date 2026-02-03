/**
 * SQLite Database Connection
 * Singleton pattern - one connection for entire app
 * Uses better-sqlite3 for sync performance (faster than async for SQLite)
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

let db: Database.Database | null = null;
let dbPath: string = './workspace/october.db';

/**
 * Initialize database connection (call once at startup)
 */
export function initDatabase(path?: string): Database.Database {
  if (db) return db;

  if (path) dbPath = path;

  // Ensure directory exists
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  console.log(`[db] Opening database: ${dbPath}`);

  db = new Database(dbPath);

  // Performance optimizations
  db.pragma('journal_mode = WAL');          // Write-Ahead Logging for concurrent reads
  db.pragma('synchronous = NORMAL');         // Balance between safety and speed
  db.pragma('cache_size = -64000');          // 64MB cache
  db.pragma('temp_store = MEMORY');          // Temp tables in memory
  db.pragma('mmap_size = 268435456');        // 256MB memory-mapped I/O
  db.pragma('foreign_keys = ON');            // Enforce foreign keys

  console.log('[db] Database initialized with WAL mode');

  return db;
}

/**
 * Get database instance (must call initDatabase first)
 */
export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

/**
 * Close database connection (call on shutdown)
 */
export function closeDatabase(): void {
  if (db) {
    console.log('[db] Closing database...');
    db.close();
    db = null;
  }
}

/**
 * Run a transaction (auto rollback on error)
 */
export function transaction<T>(fn: () => T): T {
  const database = getDatabase();
  return database.transaction(fn)();
}

/**
 * Check if database is initialized
 */
export function isDatabaseReady(): boolean {
  return db !== null;
}
