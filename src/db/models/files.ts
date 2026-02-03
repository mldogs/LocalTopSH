/**
 * Files Model - Uploaded files tracking
 */

import { getDatabase } from '../connection.js';

export interface FileRecord {
  id: number;
  user_id: number;
  message_id: number | null;
  telegram_file_id: string | null;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  storage_path: string | null;
  extracted_text: string | null;
  summary: string | null;
  created_at: string;
}

export interface CreateFileInput {
  user_id: number;
  message_id?: number;
  telegram_file_id?: string;
  filename: string;
  mime_type?: string;
  size_bytes?: number;
  storage_path?: string;
  extracted_text?: string;
  summary?: string;
}

/**
 * Add file record
 */
export function addFile(input: CreateFileInput): FileRecord {
  const db = getDatabase();

  const result = db.prepare(`
    INSERT INTO files (user_id, message_id, telegram_file_id, filename, mime_type, size_bytes, storage_path, extracted_text, summary, created_at)
    VALUES (@user_id, @message_id, @telegram_file_id, @filename, @mime_type, @size_bytes, @storage_path, @extracted_text, @summary, CURRENT_TIMESTAMP)
  `).run({
    user_id: input.user_id,
    message_id: input.message_id || null,
    telegram_file_id: input.telegram_file_id || null,
    filename: input.filename,
    mime_type: input.mime_type || null,
    size_bytes: input.size_bytes || null,
    storage_path: input.storage_path || null,
    extracted_text: input.extracted_text || null,
    summary: input.summary || null,
  });

  return getFileById(Number(result.lastInsertRowid))!;
}

/**
 * Get file by ID
 */
export function getFileById(id: number): FileRecord | null {
  const db = getDatabase();
  return db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRecord | null;
}

/**
 * Get user's files
 */
export function getUserFiles(
  userId: number,
  options?: { mimeType?: string; limit?: number }
): FileRecord[] {
  const db = getDatabase();

  let sql = 'SELECT * FROM files WHERE user_id = ?';
  const params: any[] = [userId];

  if (options?.mimeType) {
    sql += ' AND mime_type LIKE ?';
    params.push(`${options.mimeType}%`);
  }

  sql += ' ORDER BY created_at DESC';

  if (options?.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  return db.prepare(sql).all(...params) as FileRecord[];
}

/**
 * Search files by name or content
 */
export function searchFiles(userId: number, query: string, limit = 20): FileRecord[] {
  const db = getDatabase();

  return db.prepare(`
    SELECT * FROM files
    WHERE user_id = ? AND (filename LIKE ? OR extracted_text LIKE ?)
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, `%${query}%`, `%${query}%`, limit) as FileRecord[];
}

/**
 * Update file extracted text
 */
export function updateFileText(id: number, text: string): void {
  const db = getDatabase();
  db.prepare('UPDATE files SET extracted_text = ? WHERE id = ?').run(text, id);
}

/**
 * Update file summary
 */
export function updateFileSummary(id: number, summary: string): void {
  const db = getDatabase();
  db.prepare('UPDATE files SET summary = ? WHERE id = ?').run(summary, id);
}

/**
 * Delete file record
 */
export function deleteFile(id: number, userId: number): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM files WHERE id = ? AND user_id = ?').run(id, userId);
  return result.changes > 0;
}

/**
 * Get total storage used by user
 */
export function getUserStorageUsed(userId: number): number {
  const db = getDatabase();
  const result = db.prepare(`
    SELECT COALESCE(SUM(size_bytes), 0) as total FROM files WHERE user_id = ?
  `).get(userId) as any;
  return result.total;
}
