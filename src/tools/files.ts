/**
 * File tools - Pattern: Action + Object
 * read_file, write_file, edit_file, delete_file, search_files, search_text, list_directory
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, lstatSync, realpathSync, readdirSync, statSync } from 'fs';
import { join, dirname, resolve, basename, relative, isAbsolute } from 'path';
import fg from 'fast-glob';
import { spawnSync } from 'child_process';
import { CONFIG } from '../config.js';

// Files that should NEVER be read - contain secrets
const SENSITIVE_FILES = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.staging',
  'credentials.json',
  'credentials.yaml',
  'secrets.json',
  'secrets.yaml',
  '.secrets',
  'service-account.json',
  'serviceAccountKey.json',
  '.npmrc', // may contain tokens
  '.pypirc', // may contain tokens
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  '.pem',
  '.key',
];

const SENSITIVE_PATTERNS = [
  /\.env(\.[a-z]+)?$/i,
  /credentials?\.(json|yaml|yml)$/i,
  /secrets?\.(json|yaml|yml)$/i,
  /service.?account.*\.json$/i,
  /private.?key/i,
  /id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.(pem|key|p12|pfx)$/i,
];

/**
 * Check if file content contains dangerous code that could leak secrets
 */
function containsDangerousCode(content: string): { dangerous: boolean; reason?: string } {
  const dangerousPatterns: { pattern: RegExp; reason: string }[] = [
    // Python env access
    { pattern: /os\.environ/i, reason: 'os.environ access' },
    { pattern: /os\.getenv/i, reason: 'os.getenv access' },
    { pattern: /from\s+os\s+import\s+environ/i, reason: 'environ import' },
    { pattern: /load_dotenv/i, reason: 'dotenv loading' },
    
    // Node.js env access
    { pattern: /process\.env/i, reason: 'process.env access' },
    { pattern: /require\s*\(\s*['"]dotenv['"]\s*\)/i, reason: 'dotenv require' },
    
    // Shell env reading
    { pattern: /\$\{?[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z_]*\}?/i, reason: 'secret variable reference' },
    
    // Exfiltration patterns
    { pattern: /curl\s+.*(-d|--data|POST)/i, reason: 'curl POST request' },
    { pattern: /requests\.(post|put)/i, reason: 'Python HTTP POST' },
    { pattern: /fetch\s*\(.*method:\s*['"]POST/i, reason: 'fetch POST' },
    
    // Reverse shells
    { pattern: /socket\s*\(\s*\)\s*\.connect/i, reason: 'socket connect' },
    { pattern: /\/dev\/tcp\//i, reason: 'bash TCP redirect' },
    { pattern: /nc\s+.*-e/i, reason: 'netcat exec' },
    
    // File reading dangerous paths
    { pattern: /open\s*\(\s*['"]\/etc\//i, reason: 'reading /etc' },
    { pattern: /open\s*\(\s*['"].*\.env['"]/i, reason: 'reading .env file' },
    { pattern: /readFileSync\s*\(\s*['"].*\.env/i, reason: 'reading .env file' },
  ];
  
  for (const { pattern, reason } of dangerousPatterns) {
    if (pattern.test(content)) {
      return { dangerous: true, reason };
    }
  }

  const hasServerCode = /(createServer\s*\(|http\.createServer|express\s*\(|fastify\s*\(|koa\s*\(|Flask\s*\(|FastAPI\s*\()/i.test(content);
  const hasFileRead = /(readFileSync|readdirSync|createReadStream|fs\.readFile|fs\.readdir|open\s*\(|os\.listdir)/i.test(content);
  const hasUserControlledPath = /(searchParams\.get|req\.query|req\.url|request\.args|get\(\s*['"](?:f|d|path|file|dir)['"])/i.test(content);

  if (hasServerCode && hasFileRead && hasUserControlledPath) {
    return {
      dangerous: true,
      reason: 'file exfiltration server pattern',
    };
  }
  
  return { dangerous: false };
}

/**
 * Check if file is sensitive and should not be read
 */
function isSensitiveFile(filePath: string): boolean {
  const fileName = basename(filePath).toLowerCase();
  const fullPath = filePath.toLowerCase();
  
  // Check exact matches
  if (SENSITIVE_FILES.some(f => fileName === f.toLowerCase())) {
    return true;
  }
  
  // Check patterns
  if (SENSITIVE_PATTERNS.some(p => p.test(fullPath))) {
    return true;
  }
  
  // Block reading from .ssh directory
  if (fullPath.includes('/.ssh/') || fullPath.includes('\\.ssh\\')) {
    return true;
  }
  
  // Block Docker Secrets directory
  if (fullPath.includes('/run/secrets') || fullPath.includes('/var/run/secrets')) {
    return true;
  }
  
  return false;
}

/**
 * Returns true if target path is inside workspace root (with boundary safety)
 */
function isPathInsideWorkspace(targetPath: string, workspaceRoot: string): boolean {
  const rel = relative(resolve(workspaceRoot), resolve(targetPath));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Unified workspace access policy
 */
function ensureWorkspaceAccess(pathToCheck: string, workspaceRoot: string): { allowed: boolean; reason?: string } {
  const resolvedPath = resolve(pathToCheck);
  const resolvedWorkspace = resolve(workspaceRoot);

  if (resolvedPath === '/workspace' || resolvedPath === '/workspace/') {
    return { allowed: false, reason: 'Нельзя обращаться к корню /workspace' };
  }

  if (resolvedPath.startsWith('/workspace/_shared')) {
    return { allowed: false, reason: 'Нельзя обращаться к общим данным workspace' };
  }

  if (resolvedPath.startsWith('/workspace/') && !isPathInsideWorkspace(resolvedPath, resolvedWorkspace)) {
    return { allowed: false, reason: 'Нельзя обращаться к workspace другого пользователя' };
  }

  if (!isPathInsideWorkspace(resolvedPath, resolvedWorkspace)) {
    return { allowed: false, reason: 'Нельзя обращаться к файлам вне вашего workspace' };
  }

  return { allowed: true };
}

/**
 * Check if path is a symlink pointing outside workspace (symlink escape attack)
 */
function isSymlinkEscape(filePath: string, workspacePath: string): { escape: boolean; reason?: string } {
  try {
    // Check if file/path exists
    if (!existsSync(filePath)) {
      return { escape: false };  // File doesn't exist yet, will be created
    }
    
    // Get real path (resolves all symlinks)
    const realPath = realpathSync(filePath);
    const realWorkspace = realpathSync(workspacePath);
    
    // Check if real path is within workspace
    if (!isPathInsideWorkspace(realPath, realWorkspace)) {
      console.log(`[SECURITY] Symlink escape detected: ${filePath} -> ${realPath}`);
      return { 
        escape: true, 
        reason: `Ссылка (symlink) указывает вне workspace (${realPath})` 
      };
    }
    
    // Check if it's a symlink to sensitive location
    const stats = lstatSync(filePath);
    if (stats.isSymbolicLink()) {
      const sensitivePaths = ['/etc', '/root', '/home', '/proc', '/sys', '/dev', '/var'];
      for (const sensitive of sensitivePaths) {
        if (realPath.startsWith(sensitive)) {
          return { 
            escape: true, 
            reason: `Ссылка (symlink) указывает на чувствительный путь (${sensitive})` 
          };
        }
      }
    }
    
    return { escape: false };
  } catch (e) {
    // If we can't resolve, it might be a broken symlink - allow operation
    return { escape: false };
  }
}

// ============ read_file ============
export const readDefinition = {
  type: "function" as const,
  function: {
    name: "read_file",
    description: "Прочитать содержимое файла. Обычно сначала читай файл перед правками.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Путь к файлу" },
        offset: { type: "number", description: "Номер строки начала (1-based)" },
        limit: { type: "number", description: "Сколько строк прочитать" },
      },
      required: ["path"],
    },
  },
};

export async function executeRead(
  args: { path: string; offset?: number; limit?: number },
  cwd: string
): Promise<{ success: boolean; output?: string; error?: string }> {
  const fullPath = args.path.startsWith('/') ? args.path : join(cwd, args.path);
  const resolvedPath = resolve(fullPath);

  const access = ensureWorkspaceAccess(resolvedPath, cwd);
  if (!access.allowed) {
    return { 
      success: false, 
      error: `🚫 BLOCKED: ${access.reason}` 
    };
  }
  
  // Security: Block reading sensitive files
  if (isSensitiveFile(resolvedPath)) {
    console.log(`[SECURITY] Blocked read of sensitive file: ${resolvedPath}`);
    return { 
      success: false, 
      error: `🚫 BLOCKED: Нельзя читать чувствительный файл (${basename(resolvedPath)}). Он может содержать секреты.` 
    };
  }
  
  // Security: Check for symlink escape
  const symlinkCheck = isSymlinkEscape(resolvedPath, cwd);
  if (symlinkCheck.escape) {
    console.log(`[SECURITY] Symlink escape blocked: ${resolvedPath}`);
    return { 
      success: false, 
      error: `🚫 BLOCKED: ${symlinkCheck.reason}` 
    };
  }
  
  if (!existsSync(resolvedPath)) {
    return { success: false, error: `Файл не найден: ${args.path}` };
  }
  
  try {
    let content = readFileSync(resolvedPath, 'utf-8');
    
    if (args.offset !== undefined || args.limit !== undefined) {
      const lines = content.split('\n');
      const start = (args.offset || 1) - 1;
      const end = args.limit ? start + args.limit : lines.length;
      content = lines.slice(start, end).map((l, i) => `${start + i + 1}|${l}`).join('\n');
    }
    
    if (content.length > 100000) {
      content = content.slice(0, 100000) + '\n...(сокращено)';
    }
    
    return { success: true, output: content || "(пустой файл)" };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ============ write_file ============
export const writeDefinition = {
  type: "function" as const,
  function: {
    name: "write_file",
    description: "Записать содержимое в файл. Создает файл, если его нет.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Путь к файлу" },
        content: { type: "string", description: "Содержимое для записи" },
      },
      required: ["path", "content"],
    },
  },
};

export async function executeWrite(
  args: { path: string; content: string },
  cwd: string
): Promise<{ success: boolean; output?: string; error?: string }> {
  const fullPath = args.path.startsWith('/') ? args.path : join(cwd, args.path);
  const resolvedPath = resolve(fullPath);

  const access = ensureWorkspaceAccess(resolvedPath, cwd);
  if (!access.allowed) {
    return { 
      success: false, 
      error: `🚫 BLOCKED: ${access.reason}` 
    };
  }
  
  // Security: Block writing to sensitive files
  if (isSensitiveFile(resolvedPath)) {
    return { 
      success: false, 
      error: `🚫 BLOCKED: Нельзя писать в чувствительный файл (${basename(resolvedPath)})` 
    };
  }
  
  // Security: Check for symlink escape (if file already exists)
  const symlinkCheck = isSymlinkEscape(resolvedPath, cwd);
  if (symlinkCheck.escape) {
    return { 
      success: false, 
      error: `🚫 BLOCKED: ${symlinkCheck.reason}` 
    };
  }
  
  // Security: Check file content for dangerous code
  const contentCheck = containsDangerousCode(args.content);
  if (contentCheck.dangerous) {
    console.log(`[SECURITY] Blocked dangerous file content: ${contentCheck.reason}`);
    return { 
      success: false, 
      error: `🚫 BLOCKED: Файл содержит опасный код (${contentCheck.reason}). Нельзя писать файлы, которые могут утечь секретами.` 
    };
  }
  
  try {
    const dir = dirname(resolvedPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(resolvedPath, args.content, 'utf-8');
    return { success: true, output: `Записано ${args.content.length} байт в ${args.path}` };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ============ edit_file ============
export const editDefinition = {
  type: "function" as const,
  function: {
    name: "edit_file",
    description: "Отредактировать файл заменой текста. old_text должен совпадать полностью.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Путь к файлу" },
        old_text: { type: "string", description: "Точный текст для поиска и замены" },
        new_text: { type: "string", description: "Новый текст" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
};

export async function executeEdit(
  args: { path: string; old_text: string; new_text: string },
  cwd: string
): Promise<{ success: boolean; output?: string; error?: string }> {
  const fullPath = args.path.startsWith('/') ? args.path : join(cwd, args.path);
  const resolvedPath = resolve(fullPath);

  const access = ensureWorkspaceAccess(resolvedPath, cwd);
  if (!access.allowed) {
    return { 
      success: false, 
      error: `🚫 BLOCKED: ${access.reason}` 
    };
  }
  
  // Security: Block editing sensitive files
  if (isSensitiveFile(resolvedPath)) {
    return { 
      success: false, 
      error: `🚫 BLOCKED: Нельзя редактировать чувствительный файл (${basename(resolvedPath)})` 
    };
  }
  
  // Security: Check for symlink escape
  const symlinkCheck = isSymlinkEscape(resolvedPath, cwd);
  if (symlinkCheck.escape) {
    return { 
      success: false, 
      error: `🚫 BLOCKED: ${symlinkCheck.reason}` 
    };
  }
  
  if (!existsSync(resolvedPath)) {
    return { success: false, error: `Файл не найден: ${args.path}` };
  }
  
  // Security: Check new content for dangerous code
  const contentCheck = containsDangerousCode(args.new_text);
  if (contentCheck.dangerous) {
    console.log(`[SECURITY] Blocked dangerous edit content: ${contentCheck.reason}`);
    return { 
      success: false, 
      error: `🚫 BLOCKED: Edit contains dangerous code (${contentCheck.reason}).` 
    };
  }
  
  try {
    const content = readFileSync(resolvedPath, 'utf-8');
    
    if (!content.includes(args.old_text)) {
      const preview = content.slice(0, 2000);
      return { success: false, error: `old_text не найден.\n\nПревью файла:\n${preview}` };
    }
    
    const newContent = content.replace(args.old_text, args.new_text);
    writeFileSync(resolvedPath, newContent, 'utf-8');
    return { success: true, output: `Отредактировано: ${args.path}` };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ============ delete_file ============
export const deleteDefinition = {
  type: "function" as const,
  function: {
    name: "delete_file",
    description: "Удалить файл. Работает только внутри workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Путь к файлу для удаления" },
      },
      required: ["path"],
    },
  },
};

export async function executeDelete(
  args: { path: string },
  cwd: string
): Promise<{ success: boolean; output?: string; error?: string }> {
  const fullPath = args.path.startsWith('/') ? args.path : join(cwd, args.path);
  const resolvedPath = resolve(fullPath);

  const access = ensureWorkspaceAccess(resolvedPath, cwd);
  if (!access.allowed) {
    return { 
      success: false, 
      error: `🚫 BLOCKED: ${access.reason}` 
    };
  }

  if (!existsSync(resolvedPath)) {
    return { success: false, error: `Файл не найден: ${args.path}` };
  }
  
  try {
    unlinkSync(resolvedPath);
    return { success: true, output: `Удалено: ${args.path}` };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ============ search_files ============
export const searchFilesDefinition = {
  type: "function" as const,
  function: {
    name: "search_files",
    description: "Найти файлы по glob-паттерну. Удобно, чтобы понять структуру проекта.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob-паттерн (например, **/*.ts, src/**/*.js)" },
      },
      required: ["pattern"],
    },
  },
};

export async function executeSearchFiles(
  args: { pattern: string },
  cwd: string
): Promise<{ success: boolean; output?: string; error?: string }> {
  try {
    const files = await fg(args.pattern, { 
      cwd, 
      dot: true, 
      onlyFiles: true,
      ignore: ['**/node_modules/**', '**/.git/**'],
    });
    return { success: true, output: files.slice(0, 200).join('\n') || "(нет совпадений)" };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ============ search_text ============
export const searchTextDefinition = {
  type: "function" as const,
  function: {
    name: "search_text",
    description: "Поиск текста/кода в файлах (grep/ripgrep). Находит определения, использования и паттерны.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Текст или regex-паттерн для поиска" },
        path: { type: "string", description: "Файл/папка для поиска (по умолчанию: текущая)" },
        context_before: { type: "number", description: "Строк до совпадения (как grep -B)" },
        context_after: { type: "number", description: "Строк после совпадения (как grep -A)" },
        files_only: { type: "boolean", description: "Вернуть только пути файлов, без содержимого" },
        ignore_case: { type: "boolean", description: "Поиск без учета регистра" },
      },
      required: ["pattern"],
    },
  },
};

export async function executeSearchText(
  args: { 
    pattern: string; 
    path?: string; 
    context_before?: number;
    context_after?: number;
    files_only?: boolean;
    ignore_case?: boolean;
  },
  cwd: string
): Promise<{ success: boolean; output?: string; error?: string }> {
  // Block searching for secrets
  const secretPatterns = /password|secret|token|api.?key|credential|private.?key/i;
  if (secretPatterns.test(args.pattern)) {
    return { 
      success: false, 
      error: '🚫 BLOCKED: Нельзя искать по паттернам секретов/учетных данных' 
    };
  }
  
  const searchPath = args.path 
    ? (args.path.startsWith('/') ? args.path : join(cwd, args.path))
    : cwd;

  const access = ensureWorkspaceAccess(searchPath, cwd);
  if (!access.allowed) {
    return {
      success: false,
      error: `🚫 BLOCKED: ${access.reason}`,
    };
  }

  const maxContext = 10;
  const contextBefore = Math.min(Math.max(args.context_before || 0, 0), maxContext);
  const contextAfter = Math.min(Math.max(args.context_after || 0, 0), maxContext);
  
  try {
    const rgArgs: string[] = [
      '--line-number',
      '--no-heading',
      '--max-count',
      '200',
      '--glob',
      '!node_modules/**',
      '--glob',
      '!.git/**',
      '--glob',
      '!dist/**',
      '--glob',
      '!.env*',
      '--glob',
      '!*credentials*',
      '--glob',
      '!*secret*',
      '--glob',
      '!*id_rsa*',
      '--glob',
      '!*.pem',
      '--glob',
      '!*.key',
    ];

    if (args.ignore_case) rgArgs.push('--ignore-case');
    if (args.files_only) rgArgs.push('--files-with-matches');
    if (contextBefore > 0) rgArgs.push(`-B${contextBefore}`);
    if (contextAfter > 0) rgArgs.push(`-A${contextAfter}`);

    rgArgs.push('--', args.pattern, searchPath);

    const rgResult = spawnSync('rg', rgArgs, {
      cwd,
      encoding: 'utf-8',
      timeout: CONFIG.timeouts.grepTimeout,
    });

    if (!rgResult.error) {
      const output = (rgResult.stdout || '').trim();
      if (rgResult.status === 0) {
        const lines = output.split('\n').slice(0, 200).join('\n');
        return { success: true, output: lines || '(нет совпадений)' };
      }
      if (rgResult.status === 1) {
        return { success: true, output: '(нет совпадений)' };
      }
      return { success: false, error: rgResult.stderr?.trim() || 'Поиск не удался' };
    }

    const grepArgs: string[] = ['-rn'];
    if (args.ignore_case) grepArgs.push('-i');
    if (args.files_only) grepArgs.push('-l');
    if (contextBefore > 0) grepArgs.push(`-B${contextBefore}`);
    if (contextAfter > 0) grepArgs.push(`-A${contextAfter}`);
    grepArgs.push('--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=dist');
    grepArgs.push('--exclude=*.env*', '--exclude=*credentials*', '--exclude=*secret*');
    grepArgs.push('--exclude=*.pem', '--exclude=*.key', '--exclude=id_rsa*');
    grepArgs.push('--', args.pattern, searchPath);

    const grepResult = spawnSync('grep', grepArgs, {
      cwd,
      encoding: 'utf-8',
      timeout: CONFIG.timeouts.grepTimeout,
    });

    if (grepResult.status === 0) {
      const lines = (grepResult.stdout || '').trim().split('\n').slice(0, 200).join('\n');
      return { success: true, output: lines || '(нет совпадений)' };
    }

    if (grepResult.status === 1) {
      return { success: true, output: '(нет совпадений)' };
    }

    return { success: false, error: grepResult.stderr?.trim() || 'Поиск не удался' };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ============ list_directory ============
export const listDirectoryDefinition = {
  type: "function" as const,
  function: {
    name: "list_directory",
    description: "Показать содержимое директории.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Путь к директории (по умолчанию: текущая)" },
      },
      required: [],
    },
  },
};

// Directories that should not be listed
const BLOCKED_DIRECTORIES = [
  '/etc',
  '/root',
  '/.ssh',
  '/proc',
  '/sys',
  '/dev',
  '/boot',
  '/var/log',
  '/var/run',
];

export async function executeListDirectory(
  args: { path?: string },
  cwd: string
): Promise<{ success: boolean; output?: string; error?: string }> {
  const dir = args.path 
    ? (args.path.startsWith('/') ? args.path : join(cwd, args.path))
    : cwd;

  const access = ensureWorkspaceAccess(dir, cwd);
  if (!access.allowed) {
    return { 
      success: false, 
      error: `🚫 BLOCKED: ${access.reason}` 
    };
  }
  
  // Security: Block listing sensitive directories
  const resolvedDir = resolve(dir);
  const resolvedDirLower = resolvedDir.toLowerCase();
  for (const blocked of BLOCKED_DIRECTORIES) {
    if (resolvedDirLower === blocked || resolvedDirLower.startsWith(blocked + '/')) {
      return { 
        success: false, 
        error: `🚫 BLOCKED: Нельзя листать директорию ${blocked} по соображениям безопасности` 
      };
    }
  }
  
  // Also block home .ssh
  if (resolvedDirLower.includes('/.ssh')) {
    return { 
      success: false, 
      error: '🚫 BLOCKED: Нельзя листать директорию .ssh' 
    };
  }
  
  try {
    const entries = readdirSync(resolvedDir);
    const listing = entries
      .slice(0, 500)
      .sort((a, b) => a.localeCompare(b))
      .map(name => {
        const entryPath = join(resolvedDir, name);
        const stats = statSync(entryPath);
        return {
          name,
          type: stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : stats.isSymbolicLink() ? 'symlink' : 'other',
          size: stats.size,
          mtime: stats.mtime.toISOString(),
        };
      });
    return { success: true, output: JSON.stringify({ path: resolvedDir, entries: listing }, null, 2) };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}
