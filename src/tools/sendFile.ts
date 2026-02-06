/**
 * send_file - Send a file from workspace to the chat
 * Agent can use this to share files with user
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { join, resolve, basename, relative, isAbsolute } from 'path';

// Callback for sending file (set from bot)
let sendFileCallback: ((
  chatId: number,
  filePath: string,
  caption?: string
) => Promise<void>) | null = null;

/**
 * Set the send file callback (called from bot)
 */
export function setSendFileCallback(
  callback: (chatId: number, filePath: string, caption?: string) => Promise<void>
) {
  sendFileCallback = callback;
}

export const definition = {
  type: "function" as const,
  function: {
    name: "send_file",
    description: "Отправить файл из вашего workspace в чат. Используй, чтобы поделиться файлами, которые ты создал(а) или нашел(а). Макс. размер: 50MB.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Путь к файлу (относительно workspace или абсолютный)"
        },
        caption: {
          type: "string",
          description: "Необязательная подпись/описание к файлу"
        },
      },
      required: ["path"],
    },
  },
};

// Files that should NOT be sent (security)
const BLOCKED_PATTERNS = [
  /\.env/i,
  /credentials/i,
  /secrets/i,
  /password/i,
  /token/i,
  /\.pem$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /\.key$/i,
  /serviceaccount/i,
];

// Max file size (50MB)
const MAX_FILE_SIZE = 50 * 1024 * 1024;

function isPathInsideWorkspace(targetPath: string, workspaceRoot: string): boolean {
  const rel = relative(resolve(workspaceRoot), resolve(targetPath));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export async function execute(
  args: { path: string; caption?: string },
  cwd: string,
  chatId: number
): Promise<{ success: boolean; output?: string; error?: string }> {
  if (!sendFileCallback) {
    return {
      success: false,
      error: 'Не настроен callback отправки файла',
    };
  }
  
  // Resolve path
  const fullPath = args.path.startsWith('/') 
    ? args.path 
    : join(cwd, args.path);
  const resolved = resolve(fullPath);
  const cwdResolved = resolve(cwd);
  
  // Security: only allow files within workspace
  if (!isPathInsideWorkspace(resolved, cwdResolved)) {
    return {
      success: false,
      error: '🚫 BLOCKED: Можно отправлять только файлы из вашего workspace',
    };
  }
  
  // Security: block sensitive files
  const filename = basename(resolved).toLowerCase();
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(filename) || pattern.test(resolved)) {
      console.log(`[SECURITY] Blocked sending sensitive file: ${resolved}`);
      return {
        success: false,
        error: '🚫 BLOCKED: Нельзя отправлять чувствительные файлы (ключи, токены и т.п.)',
      };
    }
  }
  
  // Check file exists
  if (!existsSync(resolved)) {
    return {
      success: false,
      error: `Файл не найден: ${args.path}`,
    };
  }
  
  // Check file size
  const stat = statSync(resolved);
  if (stat.size > MAX_FILE_SIZE) {
    return {
      success: false,
      error: `Файл слишком большой (${Math.round(stat.size / 1024 / 1024)}MB). Максимум: 50MB`,
    };
  }
  
  if (stat.size === 0) {
    return {
      success: false,
      error: 'Файл пустой',
    };
  }
  
  try {
    await sendFileCallback(chatId, resolved, args.caption);
    return {
      success: true,
      output: `Файл отправлен: ${basename(resolved)} (${formatSize(stat.size)})`,
    };
  } catch (e: any) {
    // Check if it's a permission error (group restrictions)
    if (e.message?.includes('not enough rights') || e.message?.includes('CHAT_SEND_MEDIA_FORBIDDEN')) {
      return {
        success: false,
        error: 'Нельзя отправлять файлы в этой группе (не хватает прав). Варианты: прочитать файл и вставить содержимое, или попросить написать в личку для отправки файла.',
      };
    }
    return {
      success: false,
      error: `Не удалось отправить файл: ${e.message}`,
    };
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
