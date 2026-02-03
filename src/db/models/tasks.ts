/**
 * Scheduled Tasks Model
 */

import { getDatabase } from '../connection.js';

export interface ScheduledTask {
  id: string;
  user_id: number;
  chat_id: number;
  type: 'message' | 'command';
  content: string;
  execute_at: string;
  created_at: string;
  is_recurring: number;
  interval_minutes: number | null;
  end_at: string | null;
  execution_count: number;
  last_executed_at: string | null;
  status: 'pending' | 'completed' | 'cancelled' | 'failed';
}

export interface CreateTaskInput {
  id: string;
  user_id: number;
  chat_id: number;
  type: 'message' | 'command';
  content: string;
  execute_at: Date;
  is_recurring?: boolean;
  interval_minutes?: number;
  end_at?: Date;
}

const MAX_TASKS_PER_USER = 10;

/**
 * Create scheduled task
 */
export function createTask(input: CreateTaskInput): ScheduledTask {
  const db = getDatabase();

  db.prepare(`
    INSERT INTO scheduled_tasks (id, user_id, chat_id, type, content, execute_at, is_recurring, interval_minutes, end_at, created_at)
    VALUES (@id, @user_id, @chat_id, @type, @content, @execute_at, @is_recurring, @interval_minutes, @end_at, CURRENT_TIMESTAMP)
  `).run({
    id: input.id,
    user_id: input.user_id,
    chat_id: input.chat_id,
    type: input.type,
    content: input.content,
    execute_at: input.execute_at.toISOString(),
    is_recurring: input.is_recurring ? 1 : 0,
    interval_minutes: input.interval_minutes || null,
    end_at: input.end_at?.toISOString() || null,
  });

  return getTaskById(input.id)!;
}

/**
 * Get task by ID
 */
export function getTaskById(id: string): ScheduledTask | null {
  const db = getDatabase();
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as ScheduledTask | null;
}

/**
 * Get user's pending tasks
 */
export function getUserTasks(userId: number, status = 'pending'): ScheduledTask[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT * FROM scheduled_tasks
    WHERE user_id = ? AND status = ?
    ORDER BY execute_at ASC
  `).all(userId, status) as ScheduledTask[];
}

/**
 * Get user's task count
 */
export function getUserTaskCount(userId: number): number {
  const db = getDatabase();
  const result = db.prepare(`
    SELECT COUNT(*) as count FROM scheduled_tasks
    WHERE user_id = ? AND status = 'pending'
  `).get(userId) as any;
  return result.count;
}

/**
 * Check if user can add more tasks
 */
export function canUserAddTask(userId: number): boolean {
  return getUserTaskCount(userId) < MAX_TASKS_PER_USER;
}

/**
 * Get all pending tasks due for execution
 */
export function getDueTasks(): ScheduledTask[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT * FROM scheduled_tasks
    WHERE status = 'pending' AND execute_at <= datetime('now')
    ORDER BY execute_at ASC
  `).all() as ScheduledTask[];
}

/**
 * Mark task as executed (for one-time tasks, marks completed; for recurring, reschedules)
 */
export function markTaskExecuted(id: string): ScheduledTask | null {
  const db = getDatabase();

  const task = getTaskById(id);
  if (!task) return null;

  if (task.is_recurring && task.interval_minutes) {
    // Reschedule recurring task
    const nextExecute = new Date(new Date(task.execute_at).getTime() + task.interval_minutes * 60 * 1000);

    // Check if should continue
    if (!task.end_at || nextExecute <= new Date(task.end_at)) {
      db.prepare(`
        UPDATE scheduled_tasks
        SET execute_at = ?, execution_count = execution_count + 1, last_executed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(nextExecute.toISOString(), id);
    } else {
      // End of recurring period
      db.prepare(`
        UPDATE scheduled_tasks
        SET status = 'completed', execution_count = execution_count + 1, last_executed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(id);
    }
  } else {
    // One-time task
    db.prepare(`
      UPDATE scheduled_tasks
      SET status = 'completed', execution_count = 1, last_executed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);
  }

  return getTaskById(id);
}

/**
 * Cancel task
 */
export function cancelTask(id: string, userId: number): boolean {
  const db = getDatabase();

  const result = db.prepare(`
    UPDATE scheduled_tasks
    SET status = 'cancelled'
    WHERE id = ? AND user_id = ? AND status = 'pending'
  `).run(id, userId);

  return result.changes > 0;
}

/**
 * Mark task as failed
 */
export function markTaskFailed(id: string, error?: string): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE scheduled_tasks
    SET status = 'failed', last_executed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);
}

/**
 * Delete old completed/cancelled tasks (cleanup)
 */
export function deleteOldTasks(daysOld: number): number {
  const db = getDatabase();

  const result = db.prepare(`
    DELETE FROM scheduled_tasks
    WHERE status IN ('completed', 'cancelled', 'failed')
      AND last_executed_at < datetime('now', '-' || ? || ' days')
  `).run(daysOld);

  return result.changes;
}
