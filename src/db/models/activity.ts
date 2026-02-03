/**
 * Activity Log & Usage Stats Model
 */

import { getDatabase } from '../connection.js';

export interface ActivityLogEntry {
  id: number;
  user_id: number | null;
  action: string;
  details: Record<string, any> | null;
  created_at: string;
}

export interface UsageStats {
  id: number;
  user_id: number;
  date: string;
  messages_sent: number;
  tokens_used: number;
  tools_called: number;
  files_uploaded: number;
}

// =============================================
// ACTIVITY LOG
// =============================================

/**
 * Log activity
 */
export function logActivity(
  userId: number | null,
  action: string,
  details?: Record<string, any>
): void {
  const db = getDatabase();

  db.prepare(`
    INSERT INTO activity_log (user_id, action, details, created_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  `).run(userId, action, details ? JSON.stringify(details) : null);
}

/**
 * Get user's activity log
 */
export function getUserActivity(
  userId: number,
  options?: { action?: string; limit?: number; since?: Date }
): ActivityLogEntry[] {
  const db = getDatabase();

  let sql = 'SELECT * FROM activity_log WHERE user_id = ?';
  const params: any[] = [userId];

  if (options?.action) {
    sql += ' AND action = ?';
    params.push(options.action);
  }

  if (options?.since) {
    sql += ' AND created_at >= ?';
    params.push(options.since.toISOString());
  }

  sql += ' ORDER BY created_at DESC';

  if (options?.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  const results = db.prepare(sql).all(...params) as any[];
  return results.map(r => ({
    ...r,
    details: r.details ? JSON.parse(r.details) : null,
  }));
}

/**
 * Get recent activity (all users)
 */
export function getRecentActivity(limit = 50): ActivityLogEntry[] {
  const db = getDatabase();

  const results = db.prepare(`
    SELECT * FROM activity_log
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as any[];

  return results.map(r => ({
    ...r,
    details: r.details ? JSON.parse(r.details) : null,
  }));
}

/**
 * Delete old activity logs (cleanup)
 */
export function deleteOldActivity(daysOld: number): number {
  const db = getDatabase();

  const result = db.prepare(`
    DELETE FROM activity_log
    WHERE created_at < datetime('now', '-' || ? || ' days')
  `).run(daysOld);

  return result.changes;
}

// =============================================
// USAGE STATS
// =============================================

/**
 * Increment usage stat for today
 */
export function incrementUsage(
  userId: number,
  field: 'messages_sent' | 'tokens_used' | 'tools_called' | 'files_uploaded',
  amount = 1
): void {
  const db = getDatabase();
  const today = new Date().toISOString().split('T')[0];

  // Upsert usage record
  db.prepare(`
    INSERT INTO usage_stats (user_id, date, ${field})
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, date) DO UPDATE SET ${field} = ${field} + ?
  `).run(userId, today, amount, amount);
}

/**
 * Get user's usage stats for a period
 */
export function getUserUsage(
  userId: number,
  days = 30
): UsageStats[] {
  const db = getDatabase();

  return db.prepare(`
    SELECT * FROM usage_stats
    WHERE user_id = ? AND date >= date('now', '-' || ? || ' days')
    ORDER BY date DESC
  `).all(userId, days) as UsageStats[];
}

/**
 * Get aggregated usage stats for user
 */
export function getUserTotalUsage(userId: number, days = 30): {
  messages: number;
  tokens: number;
  tools: number;
  files: number;
} {
  const db = getDatabase();

  const result = db.prepare(`
    SELECT
      COALESCE(SUM(messages_sent), 0) as messages,
      COALESCE(SUM(tokens_used), 0) as tokens,
      COALESCE(SUM(tools_called), 0) as tools,
      COALESCE(SUM(files_uploaded), 0) as files
    FROM usage_stats
    WHERE user_id = ? AND date >= date('now', '-' || ? || ' days')
  `).get(userId, days) as any;

  return {
    messages: result.messages,
    tokens: result.tokens,
    tools: result.tools,
    files: result.files,
  };
}

/**
 * Get top users by usage
 */
export function getTopUsers(
  field: 'messages_sent' | 'tokens_used' | 'tools_called',
  days = 7,
  limit = 10
): Array<{ user_id: number; total: number }> {
  const db = getDatabase();

  return db.prepare(`
    SELECT user_id, SUM(${field}) as total
    FROM usage_stats
    WHERE date >= date('now', '-' || ? || ' days')
    GROUP BY user_id
    ORDER BY total DESC
    LIMIT ?
  `).all(days, limit) as any[];
}

/**
 * Get daily usage totals
 */
export function getDailyUsage(days = 7): Array<{
  date: string;
  messages: number;
  tokens: number;
  tools: number;
  users: number;
}> {
  const db = getDatabase();

  return db.prepare(`
    SELECT
      date,
      SUM(messages_sent) as messages,
      SUM(tokens_used) as tokens,
      SUM(tools_called) as tools,
      COUNT(DISTINCT user_id) as users
    FROM usage_stats
    WHERE date >= date('now', '-' || ? || ' days')
    GROUP BY date
    ORDER BY date DESC
  `).all(days) as any[];
}

/**
 * Delete old usage stats (cleanup)
 */
export function deleteOldUsage(daysOld: number): number {
  const db = getDatabase();

  const result = db.prepare(`
    DELETE FROM usage_stats
    WHERE date < date('now', '-' || ? || ' days')
  `).run(daysOld);

  return result.changes;
}
