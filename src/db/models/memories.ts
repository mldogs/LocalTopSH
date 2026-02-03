/**
 * Memories Model - Long-term user memory storage
 */

import { getDatabase } from '../connection.js';

export interface Memory {
  id: number;
  user_id: number | null;
  type: 'fact' | 'preference' | 'context' | 'note' | 'summary';
  content: string;
  source: string | null;
  importance: number;
  created_at: string;
  expires_at: string | null;
}

export interface CreateMemoryInput {
  user_id?: number;
  type: 'fact' | 'preference' | 'context' | 'note' | 'summary';
  content: string;
  source?: string;
  importance?: number;
  expires_at?: Date;
}

/**
 * Add memory
 */
export function addMemory(input: CreateMemoryInput): Memory {
  const db = getDatabase();

  const result = db.prepare(`
    INSERT INTO memories (user_id, type, content, source, importance, expires_at, created_at)
    VALUES (@user_id, @type, @content, @source, @importance, @expires_at, CURRENT_TIMESTAMP)
  `).run({
    user_id: input.user_id || null,
    type: input.type,
    content: input.content,
    source: input.source || null,
    importance: input.importance || 5,
    expires_at: input.expires_at?.toISOString() || null,
  });

  return db.prepare('SELECT * FROM memories WHERE id = ?').get(result.lastInsertRowid) as Memory;
}

/**
 * Get user's memories
 */
export function getUserMemories(
  userId: number,
  options?: { type?: string; limit?: number; minImportance?: number }
): Memory[] {
  const db = getDatabase();

  let sql = `
    SELECT * FROM memories
    WHERE user_id = ?
      AND (expires_at IS NULL OR expires_at > datetime('now'))
  `;
  const params: any[] = [userId];

  if (options?.type) {
    sql += ' AND type = ?';
    params.push(options.type);
  }

  if (options?.minImportance) {
    sql += ' AND importance >= ?';
    params.push(options.minImportance);
  }

  sql += ' ORDER BY importance DESC, created_at DESC';

  if (options?.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  return db.prepare(sql).all(...params) as Memory[];
}

/**
 * Get global memories (not user-specific)
 */
export function getGlobalMemories(limit = 20): Memory[] {
  const db = getDatabase();

  return db.prepare(`
    SELECT * FROM memories
    WHERE user_id IS NULL
      AND (expires_at IS NULL OR expires_at > datetime('now'))
    ORDER BY importance DESC, created_at DESC
    LIMIT ?
  `).all(limit) as Memory[];
}

/**
 * Get memories for AI context
 */
export function getMemoriesForContext(userId: number, limit = 10): string {
  const memories = getUserMemories(userId, { limit, minImportance: 3 });

  if (memories.length === 0) return '';

  const formatted = memories.map(m => {
    const typeLabel = {
      fact: '📌',
      preference: '❤️',
      context: '📋',
      note: '📝',
      summary: '📖',
    }[m.type] || '•';

    return `${typeLabel} ${m.content}`;
  });

  return `## User Memory\n${formatted.join('\n')}`;
}

/**
 * Search memories
 */
export function searchMemories(userId: number, query: string, limit = 10): Memory[] {
  const db = getDatabase();

  return db.prepare(`
    SELECT * FROM memories
    WHERE user_id = ? AND content LIKE ?
      AND (expires_at IS NULL OR expires_at > datetime('now'))
    ORDER BY importance DESC
    LIMIT ?
  `).all(userId, `%${query}%`, limit) as Memory[];
}

/**
 * Update memory importance
 */
export function updateMemoryImportance(id: number, importance: number): boolean {
  const db = getDatabase();
  const result = db.prepare('UPDATE memories SET importance = ? WHERE id = ?').run(
    Math.min(10, Math.max(1, importance)),
    id
  );
  return result.changes > 0;
}

/**
 * Delete memory
 */
export function deleteMemory(id: number, userId: number): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').run(id, userId);
  return result.changes > 0;
}

/**
 * Clear user's memories by type
 */
export function clearUserMemories(userId: number, type?: string): number {
  const db = getDatabase();

  if (type) {
    const result = db.prepare('DELETE FROM memories WHERE user_id = ? AND type = ?').run(userId, type);
    return result.changes;
  }

  const result = db.prepare('DELETE FROM memories WHERE user_id = ?').run(userId);
  return result.changes;
}

/**
 * Delete expired memories (cleanup)
 */
export function deleteExpiredMemories(): number {
  const db = getDatabase();

  const result = db.prepare(`
    DELETE FROM memories
    WHERE expires_at IS NOT NULL AND expires_at < datetime('now')
  `).run();

  return result.changes;
}
