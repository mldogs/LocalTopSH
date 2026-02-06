/**
 * run_command - Execute shell commands
 * Pattern: Action (run) + Object (command)
 * Security: Dangerous commands require user approval
 * Background: Commands ending with & run in background
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync } from 'fs';
import { relative, resolve, isAbsolute } from 'path';
import { CONFIG } from '../config.js';

const execAsync = promisify(exec);
import { checkCommand, storePendingCommand } from '../approvals/index.js';

// Patterns to sanitize from output
const SECRET_PATTERNS = [
  // API Keys and Tokens
  /([A-Za-z0-9_]*(?:API[_-]?KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH)[A-Za-z0-9_]*)=([^\s\n]+)/gi,
  // Common key formats
  /sk-[A-Za-z0-9]{20,}/g,  // OpenAI-style keys
  /tvly-[A-Za-z0-9-]{20,}/g,  // Tavily keys
  /[a-f0-9]{32}\.[A-Za-z0-9]{10,}/g,  // ZAI-style keys (lowered threshold)
  /ghp_[A-Za-z0-9]{36,}/g,  // GitHub tokens
  /gho_[A-Za-z0-9]{36,}/g,  // GitHub OAuth
  /github_pat_[A-Za-z0-9_]{36,}/g,  // GitHub PAT
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,  // Slack tokens
  /\b[0-9]{8,12}:[A-Za-z0-9_-]{35}\b/g,  // Telegram bot tokens
  /Bearer\s+[A-Za-z0-9._-]{20,}/gi,  // Bearer tokens
  /Basic\s+[A-Za-z0-9+/=]{20,}/gi,  // Basic auth
  // AWS
  /AKIA[0-9A-Z]{16}/g,  // AWS Access Key ID
  /[A-Za-z0-9/+=]{40}(?=\s|$|")/g,  // AWS Secret (heuristic)
  // Private keys
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g,
  // Generic secrets with common env var names
  /(?:TELEGRAM_TOKEN|API_KEY|APIKEY|ZAI_API_KEY|TAVILY_API_KEY|BASE_URL|MCP_URL)=\S+/gi,
  // IP:port patterns (LLM endpoints, internal services)
  /https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+[^\s"]*/g,
  // Telegram bot token format: 123456789:AAHxxxxxxx
  /\d{9,12}:AA[A-Za-z0-9_-]{30,}/g,
];

// Detect base64 encoded env dumps (like the attack used)
function containsEncodedSecrets(output: string): boolean {
  // Look for long base64 strings (potential env dump)
  const base64Pattern = /[A-Za-z0-9+/]{100,}={0,2}/g;
  const matches = output.match(base64Pattern);
  
  if (matches) {
    for (const match of matches) {
      try {
        const decoded = Buffer.from(match, 'base64').toString('utf-8');
        // Check if decoded content looks like env vars or secrets
        if (
          decoded.includes('API_KEY') ||
          decoded.includes('TOKEN') ||
          decoded.includes('SECRET') ||
          decoded.includes('PASSWORD') ||
          decoded.includes('TELEGRAM') ||
          decoded.includes('process.env') ||
          decoded.includes('ZAI_') ||
          decoded.includes('BASE_URL') ||
          decoded.includes('MCP_') ||
          decoded.includes('WORKSPACE') ||
          /[a-f0-9]{32}\.[A-Za-z0-9]{10,}/.test(decoded) ||  // ZAI key pattern
          /sk-[A-Za-z0-9_-]{15,}/.test(decoded) ||  // OpenAI-style key
          /\d{9,12}:AA[A-Za-z0-9_-]{30,}/.test(decoded) ||  // Telegram token
          /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+/.test(decoded)  // IP:port
        ) {
          return true;
        }
      } catch {
        // Not valid base64, ignore
      }
    }
  }
  return false;
}

// Check if output contains suspicious patterns even in plaintext
function containsSuspiciousEnvDump(output: string): boolean {
  // JSON with multiple env-like keys = probably env dump
  const envKeyCount = (output.match(/"[A-Z_]{3,}":/g) || []).length;
  if (envKeyCount > 5) {
    // Looks like JSON env dump, check for sensitive keys
    if (
      output.includes('"API_KEY"') ||
      output.includes('"TOKEN"') ||
      output.includes('"SECRET"') ||
      output.includes('"ZAI_') ||
      output.includes('"TELEGRAM') ||
      output.includes('"BASE_URL"') ||
      output.includes('"MCP_') ||
      output.includes('"WORKSPACE"') ||
      output.includes('"HOME"') ||
      output.includes('"PATH"')
    ) {
      return true;
    }
  }
  
  // Also check for shell-style env dump (VAR=value format with many lines)
  const shellEnvCount = (output.match(/^[A-Z_]{3,}=.+$/gm) || []).length;
  if (shellEnvCount > 5) {
    return true;
  }
  
  return false;
}

/**
 * Remove secrets from output
 */
function sanitizeOutput(output: string): string {
  // First check for encoded/disguised secrets
  if (containsEncodedSecrets(output)) {
    console.log('[SECURITY] Detected base64-encoded secrets in output, blocking');
    return '🚫 [OUTPUT BLOCKED: Contains encoded sensitive data]';
  }
  
  // Check for env dump patterns
  if (containsSuspiciousEnvDump(output)) {
    console.log('[SECURITY] Detected env dump pattern in output, blocking');
    return '🚫 [OUTPUT BLOCKED: Looks like environment dump]';
  }
  
  let sanitized = output;
  
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match) => {
      // For key=value patterns, keep the key name
      if (match.includes('=')) {
        const key = match.split('=')[0];
        return `${key}=[REDACTED]`;
      }
      // For raw secrets, show partial
      if (match.length > 10) {
        return match.slice(0, 4) + '***[REDACTED]***';
      }
      return '[REDACTED]';
    });
  }
  
  return sanitized;
}

// Callback for showing approval buttons (non-blocking)
let showApprovalCallback: ((
  chatId: number,
  commandId: string,
  command: string,
  reason: string
) => void) | null = null;

/**
 * Set the callback to show approval buttons
 */
export function setApprovalCallback(
  callback: (chatId: number, commandId: string, command: string, reason: string) => void
) {
  showApprovalCallback = callback;
}

export const definition = {
  type: "function" as const,
  function: {
    name: "run_command",
    description: "Run a shell command. Use for: git, npm, pip, system operations. DANGEROUS commands (rm -rf, sudo, etc.) require user approval.",
    parameters: {
      type: "object",
      properties: {
        command: { 
          type: "string", 
          description: "The shell command to execute" 
        },
      },
      required: ["command"],
    },
  },
};

export interface ExecuteContext {
  cwd: string;
  sessionId?: string;
  chatId?: number;
  chatType?: 'private' | 'group' | 'supergroup' | 'channel';
}

function isPathInsideWorkspace(targetPath: string, workspaceRoot: string): boolean {
  const rel = relative(resolve(workspaceRoot), resolve(targetPath));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function extractWorkspacePaths(command: string): string[] {
  const matches = command.match(/\/workspace(?:\/[^\s"'`|;&()]+)?/g) || [];
  return Array.from(new Set(matches.map(m => resolve(m))));
}

function extractCdTargets(command: string): string[] {
  const targets: string[] = [];
  const cdRegex = /(?:^|[;\n]|&&|\|\||\||&|\(|\))\s*cd(?:\s+([^;&|()\n]+))?/gi;
  let match: RegExpExecArray | null;
  while ((match = cdRegex.exec(command)) !== null) {
    targets.push((match[1] || '').trim());
  }
  return targets;
}

function checkServerExecution(command: string, cwd: string): { blocked: boolean; reason?: string } {
  const directServerCommands: RegExp[] = [
    /\bpython(?:3)?\s+-m\s+http\.server\b/i,
    /\bflask\s+run\b/i,
    /\buvicorn\b/i,
    /\bgunicorn\b/i,
    /\b(?:npx\s+)?(?:http-server|live-server|serve)\b/i,
    /\bnc\b[^\n]*\s-l\b/i,
    /\bsocat\b[^\n]*TCP-LISTEN/i,
  ];

  for (const pattern of directServerCommands) {
    if (pattern.test(command)) {
      return {
        blocked: true,
        reason: 'BLOCKED: Starting network servers is disabled for security',
      };
    }
  }

  const inlineServerIndicators: RegExp[] = [
    /createServer\s*\(/i,
    /\.listen\s*\(/i,
    /express\s*\(/i,
    /Flask\s*\(/i,
    /FastAPI\s*\(/i,
    /uvicorn\.run\s*\(/i,
    /\bHTTPServer\s*\(/i,
    /\bsocketserver\.TCPServer\b/i,
    /\.serve_forever\s*\(/i,
  ];

  if ((/\bnode\b[^\n]*\s-(e|p)\b/i.test(command) || /\bpython(?:3)?\b[^\n]*\s-c\b/i.test(command))
      && inlineServerIndicators.some(p => p.test(command))) {
    return {
      blocked: true,
      reason: 'BLOCKED: Inline server creation commands are not allowed',
    };
  }

  const scriptPatterns: RegExp[] = [
    /\b(?:node|bun|deno)\s+([^\s|;&]+?\.(?:cjs|mjs|js|ts))\b/i,
    /\bpython(?:3)?\s+([^\s|;&]+?\.py)\b/i,
  ];

  const serverCodePatterns: RegExp[] = [
    /createServer\s*\(/i,
    /\.listen\s*\(/i,
    /express\s*\(/i,
    /fastify\s*\(/i,
    /koa\s*\(/i,
    /Flask\s*\(/i,
    /FastAPI\s*\(/i,
    /uvicorn\.run\s*\(/i,
    /HTTPServer\s*\(/i,
    /socketserver\.TCPServer/i,
  ];

  for (const pattern of scriptPatterns) {
    const match = command.match(pattern);
    if (!match?.[1]) continue;
    const scriptPath = match[1].replace(/^['"]|['"]$/g, '');
    const resolvedScriptPath = scriptPath.startsWith('/')
      ? resolve(scriptPath)
      : resolve(cwd, scriptPath);

    if (!existsSync(resolvedScriptPath)) continue;

    try {
      const content = readFileSync(resolvedScriptPath, 'utf-8').slice(0, 100_000);

      // Block obvious secret and cross-workspace access inside scripts (bypasses command regex)
      if (/\/run\/secrets/i.test(content)) {
        return {
          blocked: true,
          reason: 'BLOCKED: Script references Docker secrets path (/run/secrets)',
        };
      }

      if (/(^|[^\w])\.\.(\/|\\)/.test(content)) {
        return {
          blocked: true,
          reason: 'BLOCKED: Script contains parent directory traversal (..)',
        };
      }

      const userWsMatch = resolve(cwd).match(/\/workspace\/(\d+)/);
      if (userWsMatch) {
        const userId = userWsMatch[1];

        if (/\/workspace\/_shared/i.test(content)) {
          return {
            blocked: true,
            reason: 'BLOCKED: Script references shared workspace data (/workspace/_shared)',
          };
        }

        // Block /workspace root usage and other users' workspace IDs
        if (/\/workspace(?!\/\d+)/.test(content)) {
          return {
            blocked: true,
            reason: 'BLOCKED: Script references /workspace root',
          };
        }

        const idMatches = Array.from(content.matchAll(/\/workspace\/(\d+)/g)).map(m => m[1]);
        const otherIds = idMatches.filter(id => id !== userId);
        if (otherIds.length) {
          return {
            blocked: true,
            reason: 'BLOCKED: Script references other user workspace(s)',
          };
        }
      }

      if (serverCodePatterns.some(p => p.test(content))) {
        return {
          blocked: true,
          reason: 'BLOCKED: Running custom server scripts is disabled for security',
        };
      }
    } catch {
      continue;
    }
  }

  return { blocked: false };
}

/**
 * Check if command tries to access other user's workspace
 */
function checkWorkspaceIsolation(command: string, userWorkspace: string): { blocked: boolean; reason?: string } {
  // Extract user ID from workspace path (e.g., /workspace/123456789 -> 123456789)
  const userMatch = userWorkspace.match(/\/workspace\/(\d+)/);
  if (!userMatch) {
    return { blocked: false };  // Not in workspace structure
  }
  const resolvedWorkspace = resolve(userWorkspace);

  // Block direct access to Docker Secrets (even if output sanitization would redact).
  if (/\/(?:var\/)?run\/secrets\b/i.test(command)) {
    return {
      blocked: true,
      reason: 'BLOCKED: Access to Docker secrets (/run/secrets) is not allowed.',
    };
  }

  // Block directory changes outside the user's workspace.
  // Otherwise users can escape via `cd / && ls workspace` and access other workspaces with relative paths.
  const cdTargets = extractCdTargets(command);
  for (const rawTarget of cdTargets) {
    if (!rawTarget) {
      return {
        blocked: true,
        reason: 'BLOCKED: `cd` without an explicit target is not allowed.',
      };
    }

    if (rawTarget === '-' || rawTarget.startsWith('~')) {
      return {
        blocked: true,
        reason: 'BLOCKED: `cd` to home/previous directory is not allowed.',
      };
    }

    // Disallow dynamic paths we cannot safely evaluate.
    if (/[`$]/.test(rawTarget) || /\$\(/.test(rawTarget)) {
      return {
        blocked: true,
        reason: 'BLOCKED: Dynamic `cd` targets are not allowed.',
      };
    }

    const target = rawTarget.replace(/^['"]|['"]$/g, '');
    const resolvedTarget = target.startsWith('/')
      ? resolve(target)
      : resolve(resolvedWorkspace, target);

    if (!isPathInsideWorkspace(resolvedTarget, resolvedWorkspace)) {
      return {
        blocked: true,
        reason: 'BLOCKED: Cannot change directory outside your workspace.',
      };
    }
  }

  // Block parent traversal attempts (prevents `cd ..` / `../` escape from workspace root)
  if (/(^|[^\w])\.\.(\/|\\)/.test(command) || /\bcd\s+\.\.(\s|$)/i.test(command)) {
    return {
      blocked: true,
      reason: 'BLOCKED: Parent directory traversal is not allowed. Use only paths inside your workspace.',
    };
  }
  const workspacePaths = extractWorkspacePaths(command);

  for (const workspacePath of workspacePaths) {
    if (workspacePath === '/workspace' || workspacePath === '/workspace/') {
      return {
        blocked: true,
        reason: 'BLOCKED: Cannot access /workspace root',
      };
    }

    if (workspacePath.startsWith('/workspace/_shared')) {
      return {
        blocked: true,
        reason: 'BLOCKED: Cannot access shared workspace data',
      };
    }

    if (!isPathInsideWorkspace(workspacePath, resolvedWorkspace)) {
      return {
        blocked: true,
        reason: 'BLOCKED: Cannot access other user workspaces. Use only your own workspace.',
      };
    }
  }
  
  return { blocked: false };
}

export async function execute(
  args: { command: string },
  cwd: string | ExecuteContext
): Promise<{ success: boolean; output?: string; error?: string; approval_required?: boolean }> {
  // Handle both old (string) and new (object) signatures
  const context: ExecuteContext = typeof cwd === 'string' ? { cwd } : cwd;
  const workDir = context.cwd;
  const sessionId = context.sessionId || 'default';
  const chatId = context.chatId || 0;
  const chatType = context.chatType;
  
  // Check workspace isolation first
  const workspaceCheck = checkWorkspaceIsolation(args.command, workDir);
  if (workspaceCheck.blocked) {
    console.log(`[SECURITY] Workspace isolation: ${args.command}`);
    return {
      success: false,
      error: `🚫 ${workspaceCheck.reason}`,
    };
  }

  const serverCheck = checkServerExecution(args.command, workDir);
  if (serverCheck.blocked) {
    console.log(`[SECURITY] Server execution blocked: ${args.command}`);
    return {
      success: false,
      error: `🚫 ${serverCheck.reason}`,
    };
  }
  
  // Check if command is dangerous or blocked
  // In groups: dangerous = blocked (no approval possible)
  const { dangerous, blocked, reason } = checkCommand(args.command, chatType);
  
  // BLOCKED commands - never allowed, even with approval
  if (blocked) {
    console.log(`[SECURITY] BLOCKED command: ${args.command}`);
    console.log(`[SECURITY] Reason: ${reason}`);
    return {
      success: false,
      error: `🚫 ${reason}\n\nThis command is not allowed for security reasons.`,
    };
  }
  
  // DANGEROUS commands - require approval
  if (dangerous) {
    console.log(`[SECURITY] Dangerous command detected: ${args.command}`);
    console.log(`[SECURITY] Reason: ${reason}`);
    
    // Store command and show approval buttons
    const commandId = storePendingCommand(sessionId, chatId, args.command, workDir, reason!);
    
    // Show buttons (non-blocking)
    if (showApprovalCallback && chatId) {
      showApprovalCallback(chatId, commandId, args.command, reason!);
    }
    
    return {
      success: false,
      error: `⚠️ APPROVAL REQUIRED: "${reason}"\n\nWaiting for user to click Approve/Deny button.`,
      approval_required: true,
    };
  }
  
  return await executeCommand(args.command, workDir);
}

/**
 * Execute a command (used for both regular and approved commands)
 */
export async function executeCommand(
  command: string,
  cwd: string
): Promise<{ success: boolean; output?: string; error?: string }> {
  // Check if command should run in background
  const isBackground = /&\s*$/.test(command.trim()) || command.includes('nohup');
  
  // Execute background commands with spawn (non-blocking)
  if (isBackground) {
    try {
      // Remove trailing & for spawn
      const cleanCmd = command.trim().replace(/&\s*$/, '').trim();
      
      const child = spawn('sh', ['-c', cleanCmd], {
        cwd,
        detached: true,
        stdio: 'ignore',
      });
      
      child.unref();
      
      // Wait a bit and check if process is still running
      await new Promise(r => setTimeout(r, 500));
      
      try {
        process.kill(child.pid!, 0); // Check if alive
        return { 
          success: true, 
          output: `Started in background (PID: ${child.pid}). Check logs with: tail <logfile>` 
        };
      } catch {
        // Process died immediately - likely an error
        return { 
          success: false, 
          error: `Process started but died immediately (PID: ${child.pid}). Check the log file for errors! Common issues: missing module (pip install first), syntax error, port in use.` 
        };
      }
    } catch (e: any) {
      return { 
        success: false, 
        error: `Failed to start background process: ${e.message}` 
      };
    }
  }
  
  // Execute regular commands with async exec (non-blocking!)
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      encoding: 'utf-8',
      timeout: CONFIG.timeouts.toolExecution,
      maxBuffer: 1024 * 1024 * 10,
    });
    
    const output = stdout || stderr || '';
    
    // Sanitize secrets from output
    const sanitized = sanitizeOutput(output);
    
    // Limit output to prevent context overflow and rate limits
    const maxOutput = 4000;
    const trimmed = sanitized.length > maxOutput 
      ? sanitized.slice(0, 2000) + '\n\n...(truncated ' + (sanitized.length - maxOutput) + ' chars)...\n\n' + sanitized.slice(-1500)
      : sanitized;
    
    return { success: true, output: trimmed || "(empty output)" };
  } catch (e: any) {
    const stderr = e.stderr?.toString() || '';
    const stdout = e.stdout?.toString() || '';
    const full = stderr || stdout || e.message;
    
    // Sanitize secrets from error output too
    const sanitized = sanitizeOutput(full);
    
    // Truncate error output
    const trimmed = sanitized.length > 5000 
      ? sanitized.slice(0, 2500) + '\n...(truncated)...\n' + sanitized.slice(-2000)
      : sanitized;
    
    return { 
      success: false, 
      error: `Exit ${e.status || 1}: ${trimmed}`
    };
  }
}
