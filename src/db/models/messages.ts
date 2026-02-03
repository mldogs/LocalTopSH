/**
 * Messages & Conversations Model
 */

import { getDatabase } from '../connection.js';

export interface Conversation {
  id: number;
  user_id: number;
  chat_id: number;
  chat_type: 'private' | 'group' | 'supergroup' | 'channel' | null;
  started_at: string;
  last_message_at: string | null;
  message_count: number;
  summary: string | null;
}

export interface Message {
  id: number;
  conversation_id: number;
  user_id: number | null;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  telegram_message_id: number | null;
  tool_calls: any[] | null;
  tool_results: any[] | null;
  tokens_used: number | null;
  created_at: string;
}

export interface CreateMessageInput {
  conversation_id: number;
  user_id?: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  telegram_message_id?: number;
  tool_calls?: any[];
  tool_results?: any[];
  tokens_used?: number;
}

// =============================================
// CONVERSATIONS
// =============================================

/**
 * Get or create conversation for user+chat pair
 */
export function getOrCreateConversation(
  userId: number,
  chatId: number,
  chatType?: 'private' | 'group' | 'supergroup' | 'channel'
): Conversation {
  const db = getDatabase();

  // Try to get existing
  let conv = db.prepare(
    'SELECT * FROM conversations WHERE user_id = ? AND chat_id = ?'
  ).get(userId, chatId) as Conversation | undefined;

  if (!conv) {
    // Create new
    const result = db.prepare(`
      INSERT INTO conversations (user_id, chat_id, chat_type, started_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `).run(userId, chatId, chatType || null);

    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(result.lastInsertRowid) as Conversation;
    console.log(`[db] Created conversation ${conv.id} for user ${userId} in chat ${chatId}`);
  }

  return conv;
}

/**
 * Get conversation by ID
 */
export function getConversationById(id: number): Conversation | null {
  const db = getDatabase();
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Conversation | null;
}

/**
 * Get user's recent conversations
 */
export function getUserConversations(userId: number, limit = 10): Conversation[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT * FROM conversations
    WHERE user_id = ?
    ORDER BY last_message_at DESC NULLS LAST
    LIMIT ?
  `).all(userId, limit) as Conversation[];
}

/**
 * Update conversation summary
 */
export function updateConversationSummary(id: number, summary: string): void {
  const db = getDatabase();
  db.prepare('UPDATE conversations SET summary = ? WHERE id = ?').run(summary, id);
}

// =============================================
// MESSAGES
// =============================================

/**
 * Add message to conversation
 */
export function addMessage(input: CreateMessageInput): Message {
  const db = getDatabase();

  const result = db.prepare(`
    INSERT INTO messages (conversation_id, user_id, role, content, telegram_message_id, tool_calls, tool_results, tokens_used, created_at)
    VALUES (@conversation_id, @user_id, @role, @content, @telegram_message_id, @tool_calls, @tool_results, @tokens_used, CURRENT_TIMESTAMP)
  `).run({
    conversation_id: input.conversation_id,
    user_id: input.user_id || null,
    role: input.role,
    content: input.content,
    telegram_message_id: input.telegram_message_id || null,
    tool_calls: input.tool_calls ? JSON.stringify(input.tool_calls) : null,
    tool_results: input.tool_results ? JSON.stringify(input.tool_results) : null,
    tokens_used: input.tokens_used || null,
  });

  // Update conversation stats
  db.prepare(`
    UPDATE conversations
    SET last_message_at = CURRENT_TIMESTAMP, message_count = message_count + 1
    WHERE id = ?
  `).run(input.conversation_id);

  return getMessageById(Number(result.lastInsertRowid))!;
}

/**
 * Get messages from conversation
 */
export function getConversationMessages(
  conversationId: number,
  options?: { limit?: number; offset?: number; roles?: string[] }
): Message[] {
  const db = getDatabase();

  let sql = 'SELECT * FROM messages WHERE conversation_id = ?';
  const params: any[] = [conversationId];

  if (options?.roles && options.roles.length > 0) {
    sql += ` AND role IN (${options.roles.map(() => '?').join(',')})`;
    params.push(...options.roles);
  }

  sql += ' ORDER BY created_at ASC';

  if (options?.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  if (options?.offset) {
    sql += ' OFFSET ?';
    params.push(options.offset);
  }

  const results = db.prepare(sql).all(...params) as any[];
  return results.map(parseMessage);
}

/**
 * Get last N messages from conversation (for context window)
 */
export function getRecentMessages(conversationId: number, limit = 20): Message[] {
  const db = getDatabase();

  const results = db.prepare(`
    SELECT * FROM (
      SELECT * FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    ) ORDER BY created_at ASC
  `).all(conversationId, limit) as any[];

  return results.map(parseMessage);
}

/**
 * Get message by ID
 */
export function getMessageById(id: number): Message | null {
  const db = getDatabase();
  const result = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as any;
  return result ? parseMessage(result) : null;
}

/**
 * Search messages by content
 */
export function searchMessages(
  userId: number,
  query: string,
  limit = 20
): (Message & { conversation_id: number })[] {
  const db = getDatabase();

  const results = db.prepare(`
    SELECT m.* FROM messages m
    JOIN conversations c ON m.conversation_id = c.id
    WHERE c.user_id = ? AND m.content LIKE ?
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(userId, `%${query}%`, limit) as any[];

  return results.map(parseMessage);
}

/**
 * Get message count for user
 */
export function getUserMessageCount(userId: number, since?: Date): number {
  const db = getDatabase();

  if (since) {
    const result = db.prepare(`
      SELECT COUNT(*) as count FROM messages m
      JOIN conversations c ON m.conversation_id = c.id
      WHERE c.user_id = ? AND m.created_at >= ?
    `).get(userId, since.toISOString()) as any;
    return result.count;
  }

  const result = db.prepare(`
    SELECT COUNT(*) as count FROM messages m
    JOIN conversations c ON m.conversation_id = c.id
    WHERE c.user_id = ?
  `).get(userId) as any;

  return result.count;
}

/**
 * Delete old messages (cleanup)
 */
export function deleteOldMessages(daysOld: number): number {
  const db = getDatabase();

  const result = db.prepare(`
    DELETE FROM messages
    WHERE created_at < datetime('now', '-' || ? || ' days')
  `).run(daysOld);

  return result.changes;
}

/**
 * Get messages for AI context (formatted)
 */
export function getMessagesForContext(
  conversationId: number,
  limit = 10
): Array<{ role: string; content: string }> {
  const messages = getRecentMessages(conversationId, limit);

  return messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({
      role: m.role,
      content: m.content,
    }));
}

// Helper to parse JSON fields
function parseMessage(row: any): Message {
  return {
    ...row,
    tool_calls: row.tool_calls ? JSON.parse(row.tool_calls) : null,
    tool_results: row.tool_results ? JSON.parse(row.tool_results) : null,
  };
}
