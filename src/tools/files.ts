/**
 * File tools - Pattern: Action + Object
 * read_file, write_file, edit_file, delete_file, search_files, search_text, list_directory
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname, resolve } from 'path';
import fg from 'fast-glob';
import { execSync } from 'child_process';

// ============ read_file ============
export const readDefinition = {
  type: "function" as const,
  function: {
    name: "read_file",
    description: "Read file contents. Always read before editing a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file" },
        offset: { type: "number", description: "Starting line number (1-based)" },
        limit: { type: "number", description: "Number of lines to read" },
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
  
  if (!existsSync(fullPath)) {
    return { success: false, error: `File not found: ${fullPath}` };
  }
  
  try {
    let content = readFileSync(fullPath, 'utf-8');
    
    if (args.offset !== undefined || args.limit !== undefined) {
      const lines = content.split('\n');
      const start = (args.offset || 1) - 1;
      const end = args.limit ? start + args.limit : lines.length;
      content = lines.slice(start, end).map((l, i) => `${start + i + 1}|${l}`).join('\n');
    }
    
    if (content.length > 100000) {
      content = content.slice(0, 100000) + '\n...(truncated)';
    }
    
    return { success: true, output: content || "(empty file)" };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ============ write_file ============
export const writeDefinition = {
  type: "function" as const,
  function: {
    name: "write_file",
    description: "Write content to a file. Creates the file if it doesn't exist.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file" },
        content: { type: "string", description: "Content to write" },
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
  
  try {
    const dir = dirname(fullPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(fullPath, args.content, 'utf-8');
    return { success: true, output: `Written ${args.content.length} bytes to ${args.path}` };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ============ edit_file ============
export const editDefinition = {
  type: "function" as const,
  function: {
    name: "edit_file",
    description: "Edit a file by replacing text. The old_text must match exactly.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file" },
        old_text: { type: "string", description: "Exact text to find and replace" },
        new_text: { type: "string", description: "New text to insert" },
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
  
  if (!existsSync(fullPath)) {
    return { success: false, error: `File not found: ${fullPath}` };
  }
  
  try {
    const content = readFileSync(fullPath, 'utf-8');
    
    if (!content.includes(args.old_text)) {
      const preview = content.slice(0, 2000);
      return { success: false, error: `old_text not found.\n\nFile preview:\n${preview}` };
    }
    
    const newContent = content.replace(args.old_text, args.new_text);
    writeFileSync(fullPath, newContent, 'utf-8');
    return { success: true, output: `Edited ${args.path}` };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ============ delete_file ============
export const deleteDefinition = {
  type: "function" as const,
  function: {
    name: "delete_file",
    description: "Delete a file. Only works within workspace directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to delete" },
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
  const resolved = resolve(fullPath);
  const cwdResolved = resolve(cwd);
  
  // Security: only allow deletion within workspace
  if (!resolved.startsWith(cwdResolved)) {
    return { success: false, error: `Security: cannot delete files outside workspace` };
  }
  
  if (!existsSync(fullPath)) {
    return { success: false, error: `File not found: ${fullPath}` };
  }
  
  try {
    unlinkSync(fullPath);
    return { success: true, output: `Deleted: ${args.path}` };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ============ search_files ============
export const searchFilesDefinition = {
  type: "function" as const,
  function: {
    name: "search_files",
    description: "Search for files by glob pattern. Use to discover project structure.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern (e.g. **/*.ts, src/**/*.js)" },
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
    return { success: true, output: files.slice(0, 200).join('\n') || "(no matches)" };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ============ search_text ============
export const searchTextDefinition = {
  type: "function" as const,
  function: {
    name: "search_text",
    description: "Search for text/code in files using grep/ripgrep. Find definitions, usages, patterns.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Text or regex pattern to search" },
        path: { type: "string", description: "Directory or file to search in (default: current)" },
        context_before: { type: "number", description: "Lines to show before match (like grep -B)" },
        context_after: { type: "number", description: "Lines to show after match (like grep -A)" },
        files_only: { type: "boolean", description: "Return only file paths, not content" },
        ignore_case: { type: "boolean", description: "Case insensitive search" },
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
  const searchPath = args.path 
    ? (args.path.startsWith('/') ? args.path : join(cwd, args.path))
    : cwd;
  
  try {
    const flags: string[] = ['-rn'];
    
    if (args.ignore_case) flags.push('-i');
    if (args.files_only) flags.push('-l');
    if (args.context_before) flags.push(`-B${args.context_before}`);
    if (args.context_after) flags.push(`-A${args.context_after}`);
    
    // Exclude common junk
    flags.push('--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=dist');
    
    const escapedPattern = args.pattern.replace(/"/g, '\\"');
    const cmd = `grep ${flags.join(' ')} "${escapedPattern}" "${searchPath}" 2>/dev/null | head -200`;
    const output = execSync(cmd, { encoding: 'utf-8', cwd, timeout: 30000 });
    return { success: true, output: output || "(no matches)" };
  } catch {
    return { success: true, output: "(no matches)" };
  }
}

// ============ list_directory ============
export const listDirectoryDefinition = {
  type: "function" as const,
  function: {
    name: "list_directory",
    description: "List contents of a directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path (default: current)" },
      },
      required: [],
    },
  },
};

export async function executeListDirectory(
  args: { path?: string },
  cwd: string
): Promise<{ success: boolean; output?: string; error?: string }> {
  const dir = args.path 
    ? (args.path.startsWith('/') ? args.path : join(cwd, args.path))
    : cwd;
  
  try {
    const output = execSync(`ls -la "${dir}"`, { encoding: 'utf-8', cwd });
    return { success: true, output };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}
