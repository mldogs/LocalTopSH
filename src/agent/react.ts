/**
 * ReAct Agent - Reasoning + Acting loop
 * Core: Think → Act → Observe → Repeat
 */

import OpenAI from 'openai';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import * as tools from '../tools/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT_FILE = join(__dirname, 'system.txt');

export interface AgentConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  cwd: string;
  zaiApiKey?: string;
  tavilyApiKey?: string;
  maxIterations?: number;
  maxHistory?: number;
}

export interface Session {
  messages: OpenAI.ChatCompletionMessageParam[];
  summaryFile: string;
}

const DATA_DIR = join(homedir(), '.agent');

export class ReActAgent {
  private openai: OpenAI;
  private config: AgentConfig;
  private sessions = new Map<string, Session>();
  
  constructor(config: AgentConfig) {
    this.config = {
      maxIterations: 30,
      maxHistory: 20,
      ...config,
    };
    
    this.openai = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
    
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
  }
  
  private getSession(id: string): Session {
    if (!this.sessions.has(id)) {
      this.sessions.set(id, {
        messages: [],
        summaryFile: join(DATA_DIR, `summary_${id}.md`),
      });
    }
    return this.sessions.get(id)!;
  }
  
  private loadSummary(session: Session): string {
    return existsSync(session.summaryFile) 
      ? readFileSync(session.summaryFile, 'utf-8') 
      : '';
  }
  
  private saveSummary(session: Session, summary: string) {
    writeFileSync(session.summaryFile, summary, 'utf-8');
  }
  
  private getSystemPrompt(): string {
    let prompt = readFileSync(SYSTEM_PROMPT_FILE, 'utf-8');
    
    // Replace placeholders
    prompt = prompt
      .replace('{{cwd}}', this.config.cwd)
      .replace('{{date}}', new Date().toISOString().slice(0, 10))
      .replace('{{tools}}', tools.toolNames.join(', '));
    
    return prompt;
  }
  
  // Compress history when too long
  private async summarize(session: Session): Promise<void> {
    if (session.messages.length < this.config.maxHistory!) return;
    
    console.log(`[agent] Compressing ${session.messages.length} messages...`);
    
    const toSummarize = session.messages.slice(0, -6);
    const toKeep = session.messages.slice(-6);
    
    const prompt = `Summarize briefly (max 500 chars):
- Task: what was requested
- Actions: what was done  
- State: current status

${toSummarize.map(m => 
  `${m.role}: ${typeof m.content === 'string' ? m.content?.slice(0, 200) : '...'}`
).join('\n')}`;

    try {
      const response = await this.openai.chat.completions.create({
        model: this.config.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
      });
      
      const summary = response.choices[0]?.message?.content || '';
      const prev = this.loadSummary(session);
      const full = prev 
        ? `${prev}\n\n---\n${new Date().toISOString().slice(0, 16)}\n${summary}`
        : summary;
      
      this.saveSummary(session, full);
      session.messages = [
        { role: 'system', content: `Previous context:\n${full}` },
        ...toKeep,
      ];
      
      console.log(`[agent] Compressed to ${session.messages.length} messages`);
    } catch (e) {
      console.error('[agent] Summary failed:', e);
    }
  }
  
  // Main ReAct loop
  async run(
    sessionId: string,
    userMessage: string,
    onToolCall?: (name: string) => void
  ): Promise<string> {
    const session = this.getSession(sessionId);
    
    // Initialize with system prompt
    if (session.messages.length === 0) {
      const summary = this.loadSummary(session);
      session.messages.push({
        role: 'system',
        content: summary 
          ? `${this.getSystemPrompt()}\n\n## Previous Context\n${summary}`
          : this.getSystemPrompt(),
      });
    }
    
    // Add user message with current date
    const dateStr = new Date().toISOString().slice(0, 10);
    session.messages.push({ 
      role: 'user', 
      content: `[${dateStr}] ${userMessage}` 
    });
    
    let iteration = 0;
    
    // ReAct loop: Think → Act → Observe
    while (iteration < this.config.maxIterations!) {
      iteration++;
      
      try {
        // Log request (full, no truncation)
        console.log('\n' + '='.repeat(80));
        console.log(`[TURN ${iteration}] REQUEST → ${this.config.model}`);
        console.log('='.repeat(80));
        console.log('\nMESSAGES:');
        for (const m of session.messages) {
          console.log(`\n[${m.role.toUpperCase()}]`);
          if (typeof m.content === 'string') {
            console.log(m.content);
          }
          if ((m as any).tool_calls) {
            console.log('tool_calls:', JSON.stringify((m as any).tool_calls, null, 2));
          }
          if ((m as any).tool_call_id) {
            console.log(`tool_call_id: ${(m as any).tool_call_id}`);
          }
        }
        console.log('\nTOOLS:', tools.toolNames.join(', '));
        
        // Think: LLM decides what to do
        const response = await this.openai.chat.completions.create({
          model: this.config.model,
          messages: session.messages,
          tools: tools.definitions as any[],
          tool_choice: 'auto',
        });
        
        const message = response.choices[0].message;
        
        // Log response
        console.log('\n' + '-'.repeat(60));
        console.log(`[TURN ${iteration}] RESPONSE`);
        console.log('-'.repeat(60));
        console.log(JSON.stringify({
          content: message.content,
          tool_calls: message.tool_calls?.map(tc => ({
            id: tc.id,
            function: tc.function.name,
            arguments: tc.function.arguments,
          })),
          usage: response.usage,
        }, null, 2));
        
        session.messages.push(message);
        
        // No tool calls = task complete or model stalled
        if (!message.tool_calls?.length) {
          // If empty response, nudge the model to continue
          if (!message.content) {
            console.log('\n[WARN] Empty response, nudging model to continue...');
            session.messages.push({
              role: 'user',
              content: 'Continue. Finish the task or explain what you did.',
            });
            continue;
          }
          console.log('\n[DONE] Final response');
          return message.content;
        }
        
        // Act: Execute tools
        for (const call of message.tool_calls) {
          const name = call.function.name;
          const args = JSON.parse(call.function.arguments || '{}');
          
          console.log(`\n[TOOL] ${name}(${JSON.stringify(args)})`);
          
          onToolCall?.(name);
          
          // Observe: Get tool result
          const result = await tools.execute(name, args, {
            cwd: this.config.cwd,
            sessionId,
            zaiApiKey: this.config.zaiApiKey,
            tavilyApiKey: this.config.tavilyApiKey,
          });
          
          const output = result.success 
            ? (result.output || 'Success') 
            : `Error: ${result.error}`;
          
          console.log(`[RESULT] ${output.slice(0, 500)}${output.length > 500 ? '...' : ''}`);
          
          session.messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: output,
          });
        }
        
        // Compress if needed
        await this.summarize(session);
        
      } catch (e: any) {
        console.error('[agent] Error:', e);
        return `Error: ${e.message}`;
      }
    }
    
    return '⚠️ Max iterations reached';
  }
  
  clear(sessionId: string) {
    this.sessions.delete(sessionId);
  }
  
  getInfo(sessionId: string) {
    const session = this.sessions.get(sessionId);
    return {
      messages: session?.messages.length || 0,
      tools: tools.toolNames.length,
    };
  }
}
