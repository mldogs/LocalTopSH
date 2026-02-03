/**
 * Database Schema & Migrations
 * Run migrations on startup to ensure schema is up to date
 */

import { getDatabase } from './connection.js';

interface Migration {
  version: number;
  name: string;
  up: string;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT,
  display_name TEXT NOT NULL,
  role TEXT DEFAULT 'user',
  added_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_active_at DATETIME,
  settings TEXT DEFAULT '{}',
  is_active INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active, last_active_at);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  chat_type TEXT,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_message_at DATETIME,
  message_count INTEGER DEFAULT 0,
  summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conv_chat ON conversations(chat_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_user_chat ON conversations(user_id, chat_id);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER,
  user_id INTEGER,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  telegram_message_id INTEGER,
  tool_calls TEXT,
  tool_results TEXT,
  tokens_used INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  embedding BLOB
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_user ON messages(user_id, created_at);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT,
  importance INTEGER DEFAULT 5,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME,
  embedding BLOB
);
CREATE INDEX IF NOT EXISTS idx_mem_user ON memories(user_id, type);
CREATE INDEX IF NOT EXISTS idx_mem_importance ON memories(importance DESC);

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  execute_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_recurring INTEGER DEFAULT 0,
  interval_minutes INTEGER,
  end_at DATETIME,
  execution_count INTEGER DEFAULT 0,
  last_executed_at DATETIME,
  status TEXT DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_tasks_execute ON scheduled_tasks(execute_at, status);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON scheduled_tasks(user_id, status);

CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  priority TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'pending',
  due_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  tags TEXT DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(user_id, status);
CREATE INDEX IF NOT EXISTS idx_todos_due ON todos(due_at, status);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  message_id INTEGER,
  telegram_file_id TEXT,
  filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  storage_path TEXT,
  extracted_text TEXT,
  summary TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  embedding BLOB
);
CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id);
CREATE INDEX IF NOT EXISTS idx_files_mime ON files(mime_type);

CREATE TABLE IF NOT EXISTS integration_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  integration TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  data TEXT NOT NULL,
  fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_integ_unique ON integration_cache(integration, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_integ_expires ON integration_cache(expires_at);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  details TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_log_user ON activity_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_log_action ON activity_log(action, created_at);

CREATE TABLE IF NOT EXISTS usage_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  date DATE NOT NULL,
  messages_sent INTEGER DEFAULT 0,
  tokens_used INTEGER DEFAULT 0,
  tools_called INTEGER DEFAULT 0,
  files_uploaded INTEGER DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_unique ON usage_stats(user_id, date);
CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_stats(date);
    `
  },
];

/**
 * Run all pending migrations
 */
export function runMigrations(): void {
  const db = getDatabase();

  // Ensure migrations table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Get applied migrations
  const applied = new Set(
    db.prepare('SELECT version FROM _migrations').all().map((r: any) => r.version)
  );

  // Run pending migrations
  for (const migration of migrations) {
    if (applied.has(migration.version)) {
      continue;
    }

    console.log(`[db] Running migration ${migration.version}: ${migration.name}`);

    // Split and run each statement separately (not in transaction for CREATE)
    const statements = migration.up
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    for (const stmt of statements) {
      try {
        db.exec(stmt);
      } catch (e: any) {
        // Ignore "already exists" errors for idempotency
        if (!e.message.includes('already exists') && !e.message.includes('duplicate column')) {
          console.error(`[db] Migration error on statement: ${stmt.slice(0, 50)}...`);
          throw e;
        }
      }
    }

    // Record migration
    db.prepare('INSERT INTO _migrations (version, name) VALUES (?, ?)').run(
      migration.version,
      migration.name
    );

    console.log(`[db] Migration ${migration.version} completed`);
  }
}

/**
 * Get current schema version
 */
export function getSchemaVersion(): number {
  const db = getDatabase();
  try {
    const result = db.prepare('SELECT MAX(version) as version FROM _migrations').get() as any;
    return result?.version || 0;
  } catch {
    return 0;
  }
}
