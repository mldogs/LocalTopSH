/**
 * Database Module - Main Entry Point
 *
 * Usage:
 *   import { initDatabase, db } from './db/index.js';
 *
 *   // At startup
 *   initDatabase('./workspace/october.db');
 *
 *   // Use models
 *   const user = db.users.getUserById(123);
 *   const messages = db.messages.getRecentMessages(convId, 10);
 */

// Connection management
import {
  initDatabase as initDb,
  getDatabase,
  closeDatabase,
  transaction,
  isDatabaseReady,
} from './connection.js';

export {
  getDatabase,
  closeDatabase,
  transaction,
  isDatabaseReady,
};

// Schema & migrations
import { runMigrations as runMig, getSchemaVersion } from './schema.js';
export { getSchemaVersion };

// Models
import * as users from './models/users.js';
import * as messages from './models/messages.js';
import * as tasks from './models/tasks.js';
import * as memories from './models/memories.js';
import * as files from './models/files.js';
import * as activity from './models/activity.js';

// Export models as namespace
export const db = {
  users,
  messages,
  tasks,
  memories,
  files,
  activity,
};

// Re-export types
export type { User, CreateUserInput } from './models/users.js';
export type { Conversation, Message, CreateMessageInput } from './models/messages.js';
export type { ScheduledTask, CreateTaskInput } from './models/tasks.js';
export type { Memory, CreateMemoryInput } from './models/memories.js';
export type { FileRecord, CreateFileInput } from './models/files.js';
export type { ActivityLogEntry, UsageStats } from './models/activity.js';

/**
 * Initialize database with migrations
 * Call this once at application startup
 */
export function setupDatabase(dbPath?: string): void {
  initDb(dbPath);
  runMig();
  console.log('[db] Database setup complete');
}

// Re-export initDatabase for external use
export { initDb as initDatabase, runMig as runMigrations };

/**
 * Cleanup old data (call periodically, e.g., daily)
 */
export function cleanupOldData(options?: {
  messagesOlderThanDays?: number;
  activityOlderThanDays?: number;
  usageOlderThanDays?: number;
  tasksOlderThanDays?: number;
}): {
  messages: number;
  activity: number;
  usage: number;
  tasks: number;
  memories: number;
} {
  const defaults = {
    messagesOlderThanDays: 90,
    activityOlderThanDays: 30,
    usageOlderThanDays: 365,
    tasksOlderThanDays: 30,
  };

  const config = { ...defaults, ...options };

  return {
    messages: messages.deleteOldMessages(config.messagesOlderThanDays),
    activity: activity.deleteOldActivity(config.activityOlderThanDays),
    usage: activity.deleteOldUsage(config.usageOlderThanDays),
    tasks: tasks.deleteOldTasks(config.tasksOlderThanDays),
    memories: memories.deleteExpiredMemories(),
  };
}
