/**
 * Telegram Bot - interface to ReAct Agent
 * Features: groups, reply, traces
 */

import { Telegraf, Context } from 'telegraf';
import { ReActAgent } from '../agent/react.js';
import { toolNames } from '../tools/index.js';

export interface BotConfig {
  telegramToken: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  cwd: string;
  zaiApiKey?: string;
  tavilyApiKey?: string;
  allowedUsers?: number[];
}

// Escape HTML
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Markdown → Telegram HTML
function mdToHtml(text: string): string {
  const codeBlocks: string[] = [];
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre>${escapeHtml(code.trim())}</pre>`);
    return `__CODE_BLOCK_${idx}__`;
  });
  
  const inlineCode: string[] = [];
  result = result.replace(/`([^`]+)`/g, (_, code) => {
    const idx = inlineCode.length;
    inlineCode.push(`<code>${escapeHtml(code)}</code>`);
    return `__INLINE_CODE_${idx}__`;
  });
  
  result = escapeHtml(result);
  
  codeBlocks.forEach((block, i) => {
    result = result.replace(`__CODE_BLOCK_${i}__`, block);
  });
  inlineCode.forEach((code, i) => {
    result = result.replace(`__INLINE_CODE_${i}__`, code);
  });
  
  result = result
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\*(.+?)\*/g, '<i>$1</i>')
    .replace(/__(.+?)__/g, '<b>$1</b>')
    .replace(/_(.+?)_/g, '<i>$1</i>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>');
  
  return result;
}

// Split long messages
function splitMessage(text: string, maxLen = 4000): string[] {
  if (text.length <= maxLen) return [text];
  
  const parts: string[] = [];
  let current = '';
  
  for (const line of text.split('\n')) {
    if (current.length + line.length + 1 > maxLen) {
      if (current) parts.push(current);
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  if (current) parts.push(current);
  
  return parts;
}

// Tool name → emoji
function toolEmoji(name: string): string {
  const map: Record<string, string> = {
    'run_command': '⚡',
    'read_file': '📖',
    'write_file': '✏️',
    'edit_file': '🔧',
    'search_files': '🔍',
    'search_text': '🔎',
    'list_directory': '📁',
    'search_web': '🌐',
    'fetch_page': '📥',
  };
  return map[name] || '🔧';
}

export function createBot(config: BotConfig) {
  const bot = new Telegraf(config.telegramToken);
  let botUsername = '';
  
  bot.telegram.getMe().then(me => {
    botUsername = me.username || '';
    console.log(`[bot] @${botUsername}`);
  });
  
  const agent = new ReActAgent({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    cwd: config.cwd,
    zaiApiKey: config.zaiApiKey,
    tavilyApiKey: config.tavilyApiKey,
  });
  
  // Check if should respond
  function shouldRespond(ctx: Context & { message?: any }): { respond: boolean; text: string } {
    const msg = ctx.message;
    if (!msg?.text) return { respond: false, text: '' };
    
    const chatType = msg.chat?.type;
    const isPrivate = chatType === 'private';
    const isGroup = chatType === 'group' || chatType === 'supergroup';
    
    if (isPrivate) {
      return { respond: true, text: msg.text };
    }
    
    if (isGroup) {
      const replyToBot = msg.reply_to_message?.from?.username === botUsername;
      const mentionsBot = botUsername && msg.text.includes(`@${botUsername}`);
      
      if (replyToBot || mentionsBot) {
        const cleanText = msg.text.replace(new RegExp(`@${botUsername}\\s*`, 'gi'), '').trim();
        return { respond: true, text: cleanText || msg.text };
      }
    }
    
    return { respond: false, text: '' };
  }
  
  // Auth middleware
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    
    if (config.allowedUsers?.length && !config.allowedUsers.includes(userId)) {
      const chatType = (ctx.message as any)?.chat?.type;
      if (chatType === 'private') {
        return ctx.reply('🚫 Access denied');
      }
      return;
    }
    
    return next();
  });
  
  // /start
  bot.command('start', async (ctx) => {
    const chatType = ctx.message?.chat?.type;
    const msg = `<b>🤖 Coding Agent</b>\n\n` +
      `<b>Tools:</b>\n<code>${toolNames.join('\n')}</code>\n\n` +
      (chatType !== 'private' ? `💬 In groups: @${botUsername} or reply\n\n` : '') +
      `/clear - Reset session\n` +
      `/status - Status`;
    await ctx.reply(msg, { parse_mode: 'HTML' });
  });
  
  // /clear
  bot.command('clear', async (ctx) => {
    const id = ctx.from?.id?.toString();
    if (id) {
      agent.clear(id);
      await ctx.reply('🗑 Session cleared');
    }
  });
  
  // /status
  bot.command('status', async (ctx) => {
    const id = ctx.from?.id?.toString();
    if (!id) return;
    
    const info = agent.getInfo(id);
    const msg = `<b>📊 Status</b>\n` +
      `Model: <code>${config.model}</code>\n` +
      `History: ${info.messages} msgs\n` +
      `Tools: ${info.tools}`;
    await ctx.reply(msg, { parse_mode: 'HTML' });
  });
  
  // Text messages
  bot.on('text', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    
    const { respond, text } = shouldRespond(ctx);
    if (!respond || !text) return;
    
    const sessionId = userId.toString();
    const messageId = ctx.message.message_id;
    console.log(`[bot] ${userId}: ${text.slice(0, 50)}...`);
    
    await ctx.sendChatAction('typing');
    const typing = setInterval(() => ctx.sendChatAction('typing').catch(() => {}), 4000);
    
    // Status message with traces
    let statusMsg: any = null;
    const traces: string[] = [];
    
    try {
      const response = await agent.run(sessionId, text, async (toolName) => {
        const emoji = toolEmoji(toolName);
        traces.push(`${emoji} ${toolName}`);
        
        const statusText = `<b>Working...</b>\n\n${traces.join('\n')}`;
        
        try {
          if (statusMsg) {
            await ctx.telegram.editMessageText(
              ctx.chat.id, 
              statusMsg.message_id, 
              undefined, 
              statusText, 
              { parse_mode: 'HTML' }
            );
          } else {
            // Reply to user's message
            statusMsg = await ctx.reply(statusText, { 
              parse_mode: 'HTML',
              reply_parameters: { message_id: messageId }
            });
          }
        } catch {}
      });
      
      clearInterval(typing);
      
      // Delete status message
      if (statusMsg) {
        try { 
          await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); 
        } catch {}
      }
      
      // Send response as reply to user
      const finalResponse = response || '(no response from model)';
      const html = mdToHtml(finalResponse);
      const parts = splitMessage(html);
      
      for (let i = 0; i < parts.length; i++) {
        try {
          await ctx.reply(parts[i], { 
            parse_mode: 'HTML',
            reply_parameters: i === 0 ? { message_id: messageId } : undefined
          });
        } catch {
          // Fallback to plain text
          await ctx.reply(finalResponse.slice(0, 4000), {
            reply_parameters: i === 0 ? { message_id: messageId } : undefined
          });
          break;
        }
      }
    } catch (e: any) {
      clearInterval(typing);
      console.error('[bot] Error:', e);
      await ctx.reply(`❌ ${e.message}`, {
        reply_parameters: { message_id: messageId }
      });
    }
  });
  
  return bot;
}
