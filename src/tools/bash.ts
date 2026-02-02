/**
 * run_command - Execute shell commands
 * Pattern: Action (run) + Object (command)
 */

import { execSync } from 'child_process';

export const definition = {
  type: "function" as const,
  function: {
    name: "run_command",
    description: "Run a shell command. Use for: git, npm, pip, system operations.",
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

export async function execute(
  args: { command: string },
  cwd: string
): Promise<{ success: boolean; output?: string; error?: string }> {
  try {
    const output = execSync(args.command, {
      cwd,
      encoding: 'utf-8',
      timeout: 180000, // 3 min
      maxBuffer: 1024 * 1024 * 10,
    });
    
    // Limit output to prevent context overflow
    const trimmed = output.length > 10000 
      ? output.slice(0, 5000) + '\n...(truncated)...\n' + output.slice(-3000)
      : output;
    
    return { success: true, output: trimmed || "(empty output)" };
  } catch (e: any) {
    const stderr = e.stderr?.toString() || '';
    const stdout = e.stdout?.toString() || '';
    const full = stderr || stdout || e.message;
    
    // Truncate error output too
    const trimmed = full.length > 5000 
      ? full.slice(0, 2500) + '\n...(truncated)...\n' + full.slice(-2000)
      : full;
    
    return { 
      success: false, 
      error: `Exit ${e.status || 1}: ${trimmed}`
    };
  }
}
