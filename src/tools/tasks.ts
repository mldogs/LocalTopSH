/**
 * Task management tools - Pattern: Action + Object
 * manage_tasks - Create, update, list, complete tasks
 */

interface Task {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  created_at: number;
}

// In-memory task store (per session)
const taskStore: Map<string, Task[]> = new Map();

export const manageTasksDefinition = {
  type: "function" as const,
  function: {
    name: "manage_tasks",
    description: "Управление списком задач: создать, обновить статус, показать список или очистить выполненные. Удобно для планирования многошаговой работы.",
    parameters: {
      type: "object",
      properties: {
        action: { 
          type: "string", 
          enum: ["add", "update", "list", "clear"],
          description: "Действие: add (добавить), update (обновить), list (показать), clear (очистить выполненные/отмененные)" 
        },
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Уникальный ID задачи" },
              content: { type: "string", description: "Описание задачи" },
              status: { 
                type: "string", 
                enum: ["pending", "in_progress", "completed", "cancelled"],
                description: "Статус задачи"
              },
            },
          },
          description: "Список задач (для add/update)"
        },
      },
      required: ["action"],
    },
  },
};

export async function executeManageTasks(
  args: { 
    action: 'add' | 'update' | 'list' | 'clear';
    tasks?: Array<{ id: string; content?: string; status?: Task['status'] }>;
  },
  sessionId: string
): Promise<{ success: boolean; output?: string; error?: string }> {
  
  // Get or create task list for session
  if (!taskStore.has(sessionId)) {
    taskStore.set(sessionId, []);
  }
  const tasks = taskStore.get(sessionId)!;
  
  switch (args.action) {
    case 'add': {
      if (!args.tasks?.length) {
        return { success: false, error: 'Не переданы задачи' };
      }
      
      for (const t of args.tasks) {
        if (!t.id || !t.content) {
          return { success: false, error: 'Для задачи нужны поля: id и content' };
        }
        
        const existing = tasks.find(x => x.id === t.id);
        if (existing) {
          // Update existing
          if (t.content) existing.content = t.content;
          if (t.status) existing.status = t.status;
        } else {
          // Add new
          tasks.push({
            id: t.id,
            content: t.content,
            status: t.status || 'pending',
            created_at: Date.now(),
          });
        }
      }
      
      return { success: true, output: formatTasks(tasks) };
    }
    
    case 'update': {
      if (!args.tasks?.length) {
        return { success: false, error: 'Не переданы задачи' };
      }
      
      for (const t of args.tasks) {
        const existing = tasks.find(x => x.id === t.id);
        if (existing) {
          if (t.content) existing.content = t.content;
          if (t.status) existing.status = t.status;
        }
      }
      
      return { success: true, output: formatTasks(tasks) };
    }
    
    case 'list': {
      return { success: true, output: formatTasks(tasks) };
    }
    
    case 'clear': {
      const active = tasks.filter(t => t.status !== 'completed' && t.status !== 'cancelled');
      taskStore.set(sessionId, active);
      return { success: true, output: `Очищено: выполненные/отмененные. Осталось: ${active.length}.` };
    }
    
    default:
      return { success: false, error: `Неизвестное действие: ${args.action}` };
  }
}

function formatTasks(tasks: Task[]): string {
  if (!tasks.length) return '(задач нет)';
  
  const statusEmoji: Record<string, string> = {
    pending: '⬜',
    in_progress: '🔄',
    completed: '✅',
    cancelled: '❌',
  };
  
  return tasks
    .map(t => `${statusEmoji[t.status]} [${t.id}] ${t.content}`)
    .join('\n');
}

// Cleanup old sessions (call periodically)
export function cleanupSessions(maxAge: number = 3600000) {
  const now = Date.now();
  for (const [sessionId, tasks] of taskStore.entries()) {
    const newest = Math.max(...tasks.map(t => t.created_at), 0);
    if (now - newest > maxAge) {
      taskStore.delete(sessionId);
    }
  }
}
