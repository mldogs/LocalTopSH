/**
 * Bot commands (/start, /clear, /status, /pending, /afk)
 */

import { Telegraf, Context } from 'telegraf';
import { join } from 'path';
import { ReActAgent } from '../agent/react.js';
import { toolNames, saveChatMessage } from '../tools/index.js';
import { getSessionPendingCommands } from '../approvals/index.js';
import { escapeHtml } from './formatters.js';
import type { BotConfig } from './types.js';
import { CONFIG } from '../config.js';
import { isAdmin } from '../admin/index.js';
import { BOT_PROFILE } from '../profile.js';

// AFK state
let afkUntil = 0;
let afkReason = '';

export function isAfk(): boolean {
  return afkUntil > 0 && Date.now() < afkUntil;
}

export function getAfkReason(): string {
  return afkReason;
}

export function clearAfk() {
  afkUntil = 0;
  afkReason = '';
}

export function setAfk(minutes: number, reason: string) {
  afkUntil = Date.now() + minutes * 60 * 1000;
  afkReason = reason;
}

export function getAfkUntil(): number {
  return afkUntil;
}

// Setup /start command
export function setupStartCommand(bot: Telegraf, botUsername: string) {
  bot.command('start', async (ctx) => {
    const chatType = ctx.message?.chat?.type;

    const isLab = BOT_PROFILE === 'lab';
    let msg = isLab
      ? `<b>🤖 Coding Agent</b>\n\nУчебный агент с доступом к изолированному workspace.\n\n`
      : `<b>Октябрина Силиконова</b>\n\nВнутренний ассистент October Group.\n\n`;

    if (chatType !== 'private') {
      msg += `В группах: упомяните @${botUsername} или ответьте на мое сообщение.\n\n`;
    }

    msg += `<b>Команды:</b>\n` +
      `/clear - очистить диалог\n` +
      `/status - статус`;

    if (isLab) {
      msg += `\n/pending - ожидают подтверждения\n\n` +
        `<b>Инструменты:</b>\n<code>${toolNames.join('\n')}</code>\n\n` +
        `🛡️ <b>Безопасность:</b> опасные команды требуют подтверждения`;
    }

    await ctx.reply(msg, { parse_mode: 'HTML' });
  });
}

// Setup /clear command
export function setupClearCommand(bot: Telegraf, getAgent: (userId: number) => ReActAgent) {
  bot.command('clear', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId) {
      const agent = getAgent(userId);
      agent.clear(String(userId));
      await ctx.reply('🗑 Диалог очищен');
    }
  });
}

// Setup /status command
export function setupStatusCommand(bot: Telegraf, config: BotConfig, getAgent: (userId: number) => ReActAgent) {
  bot.command('status', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    
    const agent = getAgent(userId);
    const info = agent.getInfo(String(userId));
    const pending = getSessionPendingCommands(String(userId));
    const userCwd = join(config.cwd, String(userId));
    const msg = `<b>📊 Статус</b>\n` +
      `Модель: <code>${config.model}</code>\n` +
      `Рабочая директория: <code>${userCwd}</code>\n` +
      `История: ${info.messages} сообщений\n` +
      `Инструменты: ${info.tools}\n` +
      `🛡️ Ожидают подтверждения: ${pending.length}`;
    await ctx.reply(msg, { parse_mode: 'HTML' });
  });
}

// Setup /pending command
export function setupPendingCommand(bot: Telegraf) {
  bot.command('pending', async (ctx) => {
    const id = ctx.from?.id?.toString();
    if (!id) return;
    
    const pending = getSessionPendingCommands(id);
    if (pending.length === 0) {
      await ctx.reply('✅ Нет ожидающих подтверждений');
      return;
    }
    
    for (const cmd of pending) {
      const message = `⏳ <b>Ожидает подтверждения</b>\n\n` +
        `<b>Причина:</b> ${escapeHtml(cmd.reason)}\n\n` +
        `<pre>${escapeHtml(cmd.command)}</pre>`;
      
      await ctx.reply(message, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Выполнить', callback_data: `exec:${cmd.id}` },
            { text: '❌ Отклонить', callback_data: `deny:${cmd.id}` },
          ]],
        },
      });
    }
  });
}

// Setup /afk command (admin only)
export function setupAfkCommand(bot: Telegraf) {
  bot.command('afk', async (ctx) => {
    const userId = ctx.from?.id;
    // Only allow admins
    if (!userId || !isAdmin(userId)) {
      await ctx.reply('Только админы могут меня отправить по делам 😏');
      return;
    }
    
    const args = ctx.message?.text?.split(' ').slice(1) || [];
    const minutes = parseInt(args[0]) || CONFIG.afk.defaultMinutes;
    const reason = args.slice(1).join(' ') || 'ушёл по делам';
    
    if (minutes <= 0) {
      // Cancel AFK
      clearAfk();
      await ctx.reply('Я вернулся! 🎉');
      return;
    }
    
    // Set AFK (max from config)
    const actualMinutes = Math.min(minutes, CONFIG.afk.maxMinutes);
    setAfk(actualMinutes, reason);
    
    await ctx.reply(`Ладно, ${reason}. Буду через ${actualMinutes} мин ✌️`);
    saveChatMessage('LocalTopSH', `[AFK] ${reason}, вернусь через ${actualMinutes} мин`, true);
    
    // Auto-return message
    setTimeout(async () => {
      if (isAfk() && Date.now() >= getAfkUntil()) {
        clearAfk();
        try {
          await bot.telegram.sendMessage(ctx.chat.id, 'Вернулся! Что я пропустил? 👀');
          saveChatMessage('LocalTopSH', 'Вернулся! Что я пропустил? 👀', true);
        } catch {}
      }
    }, actualMinutes * 60 * 1000);
  });
}

// Setup all commands
export function setupAllCommands(
  bot: Telegraf, 
  config: BotConfig, 
  botUsername: string,
  getAgent: (userId: number) => ReActAgent
) {
  setupStartCommand(bot, botUsername);
  setupClearCommand(bot, getAgent);
  setupStatusCommand(bot, config, getAgent);
  setupPendingCommand(bot);
  setupAfkCommand(bot);
}
