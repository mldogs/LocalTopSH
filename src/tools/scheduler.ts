/**
 * schedule_task - Schedule delayed and recurring messages/commands
 * Supports one-time and repeating reminders with file persistence
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

interface ScheduledTask {
  id: string;
  userId: number;
  chatId: number;
  type: 'message' | 'command'; // 'command' kept only for backward compatibility (will be dropped)
  content: string;
  executeAt: number;
  createdAt: number;
  // Recurring settings
  recurring?: boolean;
  intervalMinutes?: number;  // Repeat every N minutes
  endAt?: number;            // Stop repeating after this time
  executionCount?: number;   // How many times executed
}

// Storage file path (set from workspace)
let storageFile = './workspace/_shared/scheduled_tasks.json';

export function setSchedulerStorage(workspacePath: string) {
  storageFile = join(workspacePath, '_shared', 'scheduled_tasks.json');
}

// In-memory task storage (synced with file)
let scheduledTasks = new Map<string, ScheduledTask>();
const userTasks = new Map<number, Set<string>>(); // userId -> taskIds

// Load tasks from file
function loadTasks() {
  try {
    if (existsSync(storageFile)) {
      const data = JSON.parse(readFileSync(storageFile, 'utf-8'));
      scheduledTasks = new Map(Object.entries(data.tasks || {}));

      // Rebuild userTasks index
      userTasks.clear();
      for (const [id, task] of scheduledTasks.entries()) {
        const t = task as ScheduledTask;
        if (!userTasks.has(t.userId)) {
          userTasks.set(t.userId, new Set());
        }
        userTasks.get(t.userId)!.add(id);
      }
      console.log(`[scheduler] Loaded ${scheduledTasks.size} tasks from file`);
    }
  } catch (e) {
    console.error('[scheduler] Failed to load tasks:', e);
  }
}

// Save tasks to file
function saveTasks() {
  try {
    const dir = storageFile.substring(0, storageFile.lastIndexOf('/'));
    if (!existsSync(dir)) {
      const { mkdirSync } = require('fs');
      mkdirSync(dir, { recursive: true });
    }

    const data = {
      tasks: Object.fromEntries(scheduledTasks),
      savedAt: new Date().toISOString()
    };
    writeFileSync(storageFile, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error('[scheduler] Failed to save tasks:', e);
  }
}

// Callbacks (set from bot)
let sendMessageCallback: ((chatId: number, text: string) => Promise<void>) | null = null;

export function setSendMessageCallback(cb: (chatId: number, text: string) => Promise<void>) {
  sendMessageCallback = cb;
}

// Format time remaining
function formatTimeRemaining(minutes: number): string {
  if (minutes < 60) return `${minutes} мин`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return `${days} дн ${hours} ч`;
}

// Start the scheduler loop
let schedulerRunning = false;
export function startScheduler() {
  if (schedulerRunning) return;
  schedulerRunning = true;

  // Load existing tasks
  loadTasks();

  setInterval(async () => {
    const now = Date.now();
    let tasksModified = false;

    for (const [id, task] of scheduledTasks.entries()) {
      if (task.executeAt <= now) {
        // Execute task
        try {
          if (task.type === 'message' && sendMessageCallback) {
            const repeatInfo = task.recurring ? ' 🔁' : '';
            await sendMessageCallback(task.chatId, `⏰ Напоминание${repeatInfo}: ${task.content}`);
            console.log(`[scheduler] Sent reminder to ${task.userId}: ${task.content.slice(0, 30)}`);
          } else if (task.type === 'command') {
            // Previously supported; kept for backward compatibility. Never execute commands.
            console.log(`[scheduler] Dropping legacy command task ${id} for ${task.userId}`);
          }
        } catch (e: any) {
          console.log(`[scheduler] Task ${id} failed: ${e.message}`);
        }

        // Handle recurring tasks
        if (task.recurring && task.intervalMinutes) {
          const nextExecute = now + task.intervalMinutes * 60 * 1000;

          // Check if should continue recurring
          if (!task.endAt || nextExecute <= task.endAt) {
            task.executeAt = nextExecute;
            task.executionCount = (task.executionCount || 0) + 1;
            scheduledTasks.set(id, task);
            console.log(`[scheduler] Rescheduled recurring task ${id} for ${new Date(nextExecute).toLocaleTimeString()}`);
          } else {
            // End of recurring period
            scheduledTasks.delete(id);
            const userTaskSet = userTasks.get(task.userId);
            if (userTaskSet) userTaskSet.delete(id);
            console.log(`[scheduler] Recurring task ${id} completed (end time reached)`);
          }
        } else {
          // One-time task - remove
          scheduledTasks.delete(id);
          const userTaskSet = userTasks.get(task.userId);
          if (userTaskSet) userTaskSet.delete(id);
        }

        tasksModified = true;
      }
    }

    // Save if modified
    if (tasksModified) {
      saveTasks();
    }
  }, 5000); // Check every 5 seconds

  console.log('[scheduler] Started');
}

// Limits
const MAX_TASKS_PER_USER = 10;
const MIN_DELAY_MINUTES = 1;
const MAX_DELAY_MINUTES = 43200; // 30 days
const MIN_INTERVAL_MINUTES = 5;

export const definition = {
  type: "function" as const,
  function: {
    name: "schedule_task",
    description: `Планировщик напоминаний (сообщения). Поддерживает разовые и повторяющиеся задачи.
- Разово: "напомни через 2 часа позвонить клиенту"
- Повтор: "напоминай каждые 30 минут пить воду" (используй repeat_every_minutes)
- Лимит: до ${MAX_TASKS_PER_USER} задач на пользователя
- Задержка: 1 минута ... 30 дней
- Интервал повтора: минимум ${MIN_INTERVAL_MINUTES} минут`,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "list", "cancel"],
          description: "add = создать, list = показать, cancel = отменить по id"
        },
        type: {
          type: "string",
          enum: ["message"],
          description: "message = отправить напоминание"
        },
        content: {
          type: "string",
          description: "Текст напоминания"
        },
        delay_minutes: {
          type: "number",
          description: "Задержка до первого срабатывания (1..43200 минут = до 30 дней)"
        },
        repeat_every_minutes: {
          type: "number",
          description: "ОПЦИОНАЛЬНО: повторять каждые N минут (мин. 5). Делает задачу повторяющейся."
        },
        repeat_for_hours: {
          type: "number",
          description: "ОПЦИОНАЛЬНО: прекратить повтор через N часов (по умолчанию 24ч, максимум 720ч = 30 дней)"
        },
        task_id: {
          type: "string",
          description: "ID задачи (для cancel)"
        },
      },
      required: ["action"],
    },
  },
};

export async function execute(
  args: {
    action: string;
    type?: string;
    content?: string;
    delay_minutes?: number;
    repeat_every_minutes?: number;
    repeat_for_hours?: number;
    task_id?: string;
  },
  userId: number,
  chatId: number
): Promise<{ success: boolean; output?: string; error?: string }> {

  switch (args.action) {
    case 'add': {
      if (!args.type || !args.content || args.delay_minutes === undefined) {
        return { success: false, error: 'Нужны поля: type, content, delay_minutes' };
      }

      if (args.type !== 'message') {
        return { success: false, error: 'Поддерживаются только напоминания типа "message"' };
      }

      // Validate delay
      const delay = Math.min(Math.max(args.delay_minutes, MIN_DELAY_MINUTES), MAX_DELAY_MINUTES);

      // Check user task limit
      const userTaskSet = userTasks.get(userId) || new Set();
      if (userTaskSet.size >= MAX_TASKS_PER_USER) {
        return {
          success: false,
          error: `Лимит: максимум ${MAX_TASKS_PER_USER} задач. Отмени лишнее (schedule_task(action="list") чтобы посмотреть).`,
        };
      }

      // Create task
      const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const now = Date.now();

      const task: ScheduledTask = {
        id,
        userId,
        chatId,
        type: 'message',
        content: args.content,
        executeAt: now + delay * 60 * 1000,
        createdAt: now,
        executionCount: 0,
      };

      // Handle recurring
      if (args.repeat_every_minutes) {
        const interval = Math.max(args.repeat_every_minutes, MIN_INTERVAL_MINUTES);
        const repeatHours = Math.min(args.repeat_for_hours || 24, 720); // Default 24h, max 30 days

        task.recurring = true;
        task.intervalMinutes = interval;
        task.endAt = now + repeatHours * 60 * 60 * 1000;
      }

      scheduledTasks.set(id, task);
      userTaskSet.add(id);
      userTasks.set(userId, userTaskSet);
      saveTasks();

      const executeTime = new Date(task.executeAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      const executeDate = new Date(task.executeAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

      let output = `✅ Запланировано на ${executeDate} ${executeTime} (через ${formatTimeRemaining(delay)})`;

      if (task.recurring) {
        const endDate = new Date(task.endAt!).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
        output += `\n🔁 Повтор каждые ${task.intervalMinutes} мин до ${endDate}`;
      }

      output += `\nID: ${id}`;
      output += `\n📝 ${args.content.slice(0, 50)}${args.content.length > 50 ? '...' : ''}`;

      return { success: true, output };
    }

    case 'list': {
      const userTaskSet = userTasks.get(userId);
      if (!userTaskSet || userTaskSet.size === 0) {
        return { success: true, output: '📭 Нет запланированных задач' };
      }

      const tasks: string[] = [];
      for (const id of userTaskSet) {
        const task = scheduledTasks.get(id);
        if (task) {
          const timeLeft = Math.round((task.executeAt - Date.now()) / 60000);
          const recurring = task.recurring ? ' 🔁' : '';
          const execCount = task.executionCount ? ` (выполнено: ${task.executionCount}x)` : '';
          tasks.push(`• <code>${task.id}</code>${recurring}\n  ⏰ через ${formatTimeRemaining(Math.max(0, timeLeft))}${execCount}\n  📝 "${task.content.slice(0, 40)}"`);
        }
      }

      return {
        success: true,
        output: `📋 Задачи (${tasks.length}/${MAX_TASKS_PER_USER}):\n\n${tasks.join('\n\n')}\n\nОтменить: schedule_task(action="cancel", task_id="...")`,
      };
    }

    case 'cancel': {
      if (!args.task_id) {
        return { success: false, error: 'Нужно указать task_id для отмены' };
      }

      const task = scheduledTasks.get(args.task_id);
      if (!task) {
        return { success: false, error: 'Задача не найдена' };
      }

      if (task.userId !== userId) {
        return { success: false, error: 'Нельзя отменять задачу другого пользователя' };
      }

      scheduledTasks.delete(args.task_id);
      const userTaskSet = userTasks.get(userId);
      if (userTaskSet) userTaskSet.delete(args.task_id);
      saveTasks();

      return { success: true, output: `🗑 Задача отменена: ${task.content.slice(0, 30)}` };
    }

    default:
      return { success: false, error: `Неизвестное действие: ${args.action}` };
  }
}
