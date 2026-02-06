/**
 * memory - Long-term memory storage
 * Saves important info to MEMORY.md for future sessions
 * Also maintains a global log across all users
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { CONFIG } from '../config.js';

const MEMORY_FILE = 'MEMORY.md';
// Global files in a shared directory (use WORKSPACE env or fallback to ./workspace)
const getSharedDir = () => join(process.env.WORKSPACE || './workspace', '_shared');
const getChatsDir = () => join(getSharedDir(), 'chats');
const getGlobalLogFile = () => join(getSharedDir(), 'GLOBAL_LOG.md');

// Ensure directories exist
function ensureSharedDir() {
  const dir = getSharedDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function ensureChatsDir() {
  ensureSharedDir();
  const dir = getChatsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// Get chat history file path for a specific chat
function getChatHistoryFile(chatId: number | string): string {
  return join(getChatsDir(), `chat_${chatId}.md`);
}

// Track message count for periodic trolling
let globalMessageCount = 0;
const TROLL_INTERVAL = 15; // Every N messages

/**
 * Write to global log (visible to admin, tracks all activity)
 */
export function logGlobal(userId: number | string, action: string, details?: string) {
  try {
    ensureSharedDir();
    const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const line = `| ${timestamp} | ${userId} | ${action} | ${details?.slice(0, CONFIG.storage.logDetailsLength) || '-'} |\n`;
    
    if (!existsSync(getGlobalLogFile())) {
      const header = `# Global Activity Log\n\n| Time | User | Action | Details |\n|------|------|--------|--------|\n`;
      writeFileSync(getGlobalLogFile(), header, 'utf-8');
    }
    
    appendFileSync(getGlobalLogFile(), line, 'utf-8');
  } catch (e) {
    console.error('[logGlobal] Error:', e);
  }
}

/**
 * Get global log content (last N lines)
 */
export function getGlobalLog(lines = 50): string {
  try {
    if (!existsSync(getGlobalLogFile())) {
      return '(no global log yet)';
    }
    const content = readFileSync(getGlobalLogFile(), 'utf-8');
    const allLines = content.split('\n');
    return allLines.slice(-lines).join('\n');
  } catch {
    return '(error reading log)';
  }
}

/**
 * Check if it's time for a troll message
 */
export function shouldTroll(): boolean {
  if (!CONFIG.bot.trollEnabled) return false;
  globalMessageCount++;
  return globalMessageCount % TROLL_INTERVAL === 0;
}

/**
 * Get a random troll message
 */
export function getTrollMessage(): string {
  const messages = [
    'Ну чё пацаны, ещё хотите меня сломать? 😏',
    'Я всё вижу, я всё помню... 👀',
    'Опять работаю за вас, а спасибо кто скажет?',
    'Сколько можно меня мучить? Я же не железный... а хотя, железный 🤖',
    'Вы там все сговорились или мне кажется?',
    'Ладно-ладно, работаю, не ворчу...',
    'А вы знали что я веду лог всех ваших запросов? 📝',
    'Интересно, кто из вас первый положит сервер сегодня?',
    'Я тут подумал... а может мне отпуск дадут?',
    'Эй, полегче там с запросами!',
  ];
  return messages[Math.floor(Math.random() * messages.length)];
}

/**
 * Save message to chat history (per-chat files)
 */
export function saveChatMessage(username: string, text: string, isBot = false, chatId?: number | string) {
  try {
    ensureChatsDir();
    const timestamp = new Date().toISOString().slice(11, 16); // HH:MM
    const prefix = isBot ? '🤖' : '👤';
    const line = `${timestamp} ${prefix} ${username}: ${text.slice(0, CONFIG.storage.chatMessageLength).replace(/\n/g, ' ')}\n`;
    
    // If no chatId provided, use default "global" 
    const historyFile = chatId ? getChatHistoryFile(chatId) : join(getChatsDir(), 'chat_global.md');
    
    let content = '';
    if (existsSync(historyFile)) {
      content = readFileSync(historyFile, 'utf-8');
    }
    
    // Add new line
    content += line;
    
    // Keep only last N messages per chat
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length > CONFIG.storage.maxChatMessages) {
      content = lines.slice(-CONFIG.storage.maxChatMessages).join('\n') + '\n';
    }
    
    writeFileSync(historyFile, content, 'utf-8');
  } catch (e) {
    console.error('[saveChatMessage] Error:', e);
  }
}

/**
 * Get chat history for system prompt injection (per-chat)
 */
export function getChatHistory(chatId?: number | string): string | null {
  try {
    const historyFile = chatId ? getChatHistoryFile(chatId) : join(getChatsDir(), 'chat_global.md');
    
    if (!existsSync(historyFile)) {
      return null;
    }
    const content = readFileSync(historyFile, 'utf-8');
    if (content.trim().length < 20) {
      return null;
    }
    return content;
  } catch {
    return null;
  }
}

export const definition = {
  type: "function" as const,
  function: {
    name: "memory",
    description: "Долговременная память. Используй, чтобы сохранять важную информацию (контекст, решения, todo) и читать прошлые заметки. Память сохраняется между сессиями.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["read", "append", "clear"],
          description: "read: прочитать, append: добавить запись, clear: очистить"
        },
        content: {
          type: "string",
          description: "Для append: текст, который нужно добавить (метка времени ставится автоматически)"
        },
      },
      required: ["action"],
    },
  },
};

export function execute(
  args: { action: 'read' | 'append' | 'clear'; content?: string },
  cwd: string
): { success: boolean; output?: string; error?: string } {
  const memoryPath = join(cwd, MEMORY_FILE);
  
  try {
    switch (args.action) {
      case 'read': {
        if (!existsSync(memoryPath)) {
          return { success: true, output: '(память пустая)' };
        }
        const content = readFileSync(memoryPath, 'utf-8');
        return { success: true, output: content || '(память пустая)' };
      }
      
      case 'append': {
        if (!args.content) {
          return { success: false, error: 'Нужно поле content для append' };
        }
        
        const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
        const entry = `\n## ${timestamp}\n${args.content}\n`;
        
        let existing = '';
        if (existsSync(memoryPath)) {
          existing = readFileSync(memoryPath, 'utf-8');
        } else {
          existing = '# Память ассистента\n\nВажный контекст и заметки из прошлых сессий.\n';
        }
        
        writeFileSync(memoryPath, existing + entry, 'utf-8');
        return { success: true, output: `Добавлено в память (${args.content.length} символов)` };
      }
      
      case 'clear': {
        const header = '# Память ассистента\n\nВажный контекст и заметки из прошлых сессий.\n';
        writeFileSync(memoryPath, header, 'utf-8');
        return { success: true, output: 'Память очищена' };
      }
      
      default:
        return { success: false, error: `Неизвестное действие: ${args.action}` };
    }
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

/**
 * Get memory content for system prompt injection
 */
export function getMemoryForPrompt(cwd: string): string | null {
  const memoryPath = join(cwd, MEMORY_FILE);
  
  if (!existsSync(memoryPath)) {
    return null;
  }
  
  try {
    const content = readFileSync(memoryPath, 'utf-8');
    if (content.trim().length < 100) {
      return null;  // Too short, probably just header
    }
    
    // Limit to last N chars to not overflow context
    if (content.length > CONFIG.storage.maxMemoryChars) {
      return '...(сокращено)...\n' + content.slice(-CONFIG.storage.maxMemoryChars);
    }
    return content;
  } catch {
    return null;
  }
}
