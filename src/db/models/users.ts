/**
 * Users Model - Database access layer for users table
 */

import { getDatabase } from '../connection.js';

export interface User {
  id: number;
  username: string | null;
  display_name: string;
  role: 'superadmin' | 'admin' | 'user';
  added_by: number | null;
  created_at: string;
  last_active_at: string | null;
  settings: Record<string, any>;
  is_active: number;
}

export interface CreateUserInput {
  id: number;
  display_name: string;
  username?: string;
  role?: 'superadmin' | 'admin' | 'user';
  added_by?: number;
  settings?: Record<string, any>;
}

/**
 * Create or update user
 */
export function upsertUser(input: CreateUserInput): User {
  const db = getDatabase();

  db.prepare(`
    INSERT INTO users (id, username, display_name, role, added_by, settings, created_at)
    VALUES (@id, @username, @display_name, @role, @added_by, @settings, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      username = COALESCE(@username, username),
      display_name = COALESCE(@display_name, display_name),
      last_active_at = CURRENT_TIMESTAMP
  `).run({
    id: input.id,
    username: input.username || null,
    display_name: input.display_name,
    role: input.role || 'user',
    added_by: input.added_by || null,
    settings: JSON.stringify(input.settings || {}),
  });

  return getUserById(input.id)!;
}

/**
 * Get user by ID
 */
export function getUserById(id: number): User | null {
  const db = getDatabase();
  const result = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
  return result ? parseUser(result) : null;
}

/**
 * Get all users with optional filters
 */
export function getUsers(options?: {
  role?: string;
  isActive?: boolean;
  limit?: number;
  offset?: number;
}): User[] {
  const db = getDatabase();

  let sql = 'SELECT * FROM users WHERE 1=1';
  const params: any[] = [];

  if (options?.role) {
    sql += ' AND role = ?';
    params.push(options.role);
  }

  if (options?.isActive !== undefined) {
    sql += ' AND is_active = ?';
    params.push(options.isActive ? 1 : 0);
  }

  sql += ' ORDER BY last_active_at DESC NULLS LAST';

  if (options?.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  if (options?.offset) {
    sql += ' OFFSET ?';
    params.push(options.offset);
  }

  const results = db.prepare(sql).all(...params) as any[];
  return results.map(parseUser);
}

/**
 * Update user activity timestamp
 */
export function updateUserActivity(id: number): void {
  const db = getDatabase();
  db.prepare('UPDATE users SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
}

/**
 * Update user role
 */
export function updateUserRole(id: number, role: 'superadmin' | 'admin' | 'user'): boolean {
  const db = getDatabase();
  const result = db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  return result.changes > 0;
}

/**
 * Deactivate user (soft delete)
 */
export function deactivateUser(id: number): boolean {
  const db = getDatabase();
  const result = db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Reactivate user
 */
export function reactivateUser(id: number): boolean {
  const db = getDatabase();
  const result = db.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Check if user is allowed (active and exists)
 */
export function isUserAllowed(id: number): boolean {
  const db = getDatabase();
  const result = db.prepare('SELECT 1 FROM users WHERE id = ? AND is_active = 1').get(id);
  return !!result;
}

/**
 * Check if user is admin or superadmin
 */
export function isUserAdmin(id: number): boolean {
  const db = getDatabase();
  const result = db.prepare(
    "SELECT 1 FROM users WHERE id = ? AND role IN ('admin', 'superadmin') AND is_active = 1"
  ).get(id);
  return !!result;
}

/**
 * Check if user is superadmin
 */
export function isUserSuperAdmin(id: number): boolean {
  const db = getDatabase();
  const result = db.prepare(
    "SELECT 1 FROM users WHERE id = ? AND role = 'superadmin' AND is_active = 1"
  ).get(id);
  return !!result;
}

/**
 * Search users by name or username
 */
export function searchUsers(query: string, limit = 20): User[] {
  const db = getDatabase();
  const searchPattern = `%${query}%`;

  const results = db.prepare(`
    SELECT * FROM users
    WHERE (display_name LIKE ? OR username LIKE ?)
      AND is_active = 1
    ORDER BY last_active_at DESC NULLS LAST
    LIMIT ?
  `).all(searchPattern, searchPattern, limit) as any[];

  return results.map(parseUser);
}

/**
 * Get user stats
 */
export function getUserStats(): {
  total: number;
  admins: number;
  activeToday: number;
  activeWeek: number;
} {
  const db = getDatabase();

  const result = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN role IN ('admin', 'superadmin') THEN 1 ELSE 0 END) as admins,
      SUM(CASE WHEN last_active_at >= date('now') THEN 1 ELSE 0 END) as active_today,
      SUM(CASE WHEN last_active_at >= date('now', '-7 days') THEN 1 ELSE 0 END) as active_week
    FROM users
    WHERE is_active = 1
  `).get() as any;

  return {
    total: result.total || 0,
    admins: result.admins || 0,
    activeToday: result.active_today || 0,
    activeWeek: result.active_week || 0,
  };
}

/**
 * Bulk import users (for migration)
 */
export function bulkImportUsers(users: CreateUserInput[]): { added: number; skipped: number } {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO users (id, username, display_name, role, added_by, settings, created_at)
    VALUES (@id, @username, @display_name, @role, @added_by, @settings, CURRENT_TIMESTAMP)
  `);

  let added = 0;
  let skipped = 0;

  const insertMany = db.transaction((users: CreateUserInput[]) => {
    for (const user of users) {
      const result = stmt.run({
        id: user.id,
        username: user.username || null,
        display_name: user.display_name,
        role: user.role || 'user',
        added_by: user.added_by || null,
        settings: JSON.stringify(user.settings || {}),
      });

      if (result.changes > 0) {
        added++;
      } else {
        skipped++;
      }
    }
  });

  insertMany(users);

  return { added, skipped };
}

// Helper to parse JSON fields
function parseUser(row: any): User {
  return {
    ...row,
    settings: row.settings ? JSON.parse(row.settings) : {},
  };
}
