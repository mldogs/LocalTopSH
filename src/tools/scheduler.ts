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
  type: 'message' | 'command';
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
let executeCommandCallback: ((userId: number, command: string) => Promise<string>) | null = null;

export function setSendMessageCallback(cb: (chatId: number, text: string) => Promise<void>) {
  sendMessageCallback = cb;
}

export function setExecuteCommandCallback(cb: (userId: number, command: string) => Promise<string>) {
  executeCommandCallback = cb;
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
          } else if (task.type === 'command' && executeCommandCallback) {
            const result = await executeCommandCallback(task.userId, task.content);
            await sendMessageCallback?.(task.chatId, `⏰ Запланированная команда:\n\`${task.content}\`\n\nРезультат:\n${result.slice(0, 500)}`);
            console.log(`[scheduler] Executed command for ${task.userId}: ${task.content.slice(0, 30)}`);
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
    description: `Schedule reminders or delayed commands. Supports one-time and RECURRING tasks.
- One-time: "remind me in 2 hours to call mom"
- Recurring: "remind me every 30 min to drink water" (use repeat_every_minutes)
- Max ${MAX_TASKS_PER_USER} tasks per user
- Delay: 1 min to 30 days
- Repeat interval: min ${MIN_INTERVAL_MINUTES} minutes`,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "list", "cancel"],
          description: "add = create task, list = show tasks, cancel = cancel by id"
        },
        type: {
          type: "string",
          enum: ["message", "command"],
          description: "message = send reminder, command = run shell command"
        },
        content: {
          type: "string",
          description: "Reminder text or shell command"
        },
        delay_minutes: {
          type: "number",
          description: "Delay before first execution (1 to 43200 = 30 days)"
        },
        repeat_every_minutes: {
          type: "number",
          description: "OPTIONAL: Repeat every N minutes (min 5). Makes task recurring."
        },
        repeat_for_hours: {
          type: "number",
          description: "OPTIONAL: Stop repeating after N hours (default: 24h, max: 720h = 30 days)"
        },
        task_id: {
          type: "string",
          description: "Task ID (for cancel action)"
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
        return { success: false, error: 'Need type, content, and delay_minutes' };
      }

      // Validate delay
      const delay = Math.min(Math.max(args.delay_minutes, MIN_DELAY_MINUTES), MAX_DELAY_MINUTES);

      // Check user task limit
      const userTaskSet = userTasks.get(userId) || new Set();
      if (userTaskSet.size >= MAX_TASKS_PER_USER) {
        return { success: false, error: `Max ${MAX_TASKS_PER_USER} tasks. Cancel some first (/list to see).` };
      }

      // Create task
      const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const now = Date.now();

      const task: ScheduledTask = {
        id,
        userId,
        chatId,
        type: args.type as 'message' | 'command',
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
        return { success: false, error: 'Need task_id to cancel' };
      }

      const task = scheduledTasks.get(args.task_id);
      if (!task) {
        return { success: false, error: 'Task not found' };
      }

      if (task.userId !== userId) {
        return { success: false, error: 'Cannot cancel other user\'s task' };
      }

      scheduledTasks.delete(args.task_id);
      const userTaskSet = userTasks.get(userId);
      if (userTaskSet) userTaskSet.delete(args.task_id);
      saveTasks();

      return { success: true, output: `🗑 Задача отменена: ${task.content.slice(0, 30)}` };
    }

    default:
      return { success: false, error: `Unknown action: ${args.action}` };
  }
}
