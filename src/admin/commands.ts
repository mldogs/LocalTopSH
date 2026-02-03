/**
 * Admin commands for October Group bot
 * /admin - main admin menu
 * /admin_add - add user
 * /admin_remove - remove user
 * /admin_list - list users
 * /admin_stats - usage statistics
 * /admin_promote - make admin
 * /admin_demote - remove admin
 * /admin_search - search users
 */

import { Telegraf, Context } from 'telegraf';
import {
  isAdmin,
  isSuperAdmin,
  addUser,
  removeUser,
  listUsers,
  getUserStats,
  promoteToAdmin,
  demoteAdmin,
  searchUsers,
  getUser
} from './users.js';
import { escapeHtml } from '../bot/formatters.js';

// Setup all admin commands
export function setupAdminCommands(bot: Telegraf) {

  // /admin - show admin menu
  bot.command('admin', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isAdmin(userId)) {
      return; // Silently ignore non-admins
    }

    const isSA = isSuperAdmin(userId);
    const stats = getUserStats();

    let msg = `<b>🔐 Админ-панель October Group</b>\n\n`;
    msg += `<b>Статистика:</b>\n`;
    msg += `👥 Пользователей: ${stats.totalUsers}\n`;
    msg += `👑 Админов: ${stats.totalAdmins}\n`;
    msg += `📊 Активны сегодня: ${stats.activeToday}\n`;
    msg += `📈 Активны за неделю: ${stats.activeWeek}\n\n`;
    msg += `<b>Команды:</b>\n`;
    msg += `/admin_add &lt;user_id&gt; &lt;имя&gt; - добавить\n`;
    msg += `/admin_remove &lt;user_id&gt; - удалить\n`;
    msg += `/admin_list - список пользователей\n`;
    msg += `/admin_search &lt;запрос&gt; - поиск\n`;
    msg += `/admin_stats - статистика\n`;

    if (isSA) {
      msg += `\n<b>🔑 Только для владельца:</b>\n`;
      msg += `/admin_promote &lt;user_id&gt; - назначить админом\n`;
      msg += `/admin_demote &lt;user_id&gt; - снять админа\n`;
    }

    await ctx.reply(msg, { parse_mode: 'HTML' });
  });

  // /admin_add <user_id> <name> - add user
  bot.command('admin_add', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isAdmin(userId)) return;

    const args = ctx.message?.text?.split(' ').slice(1) || [];

    if (args.length < 2) {
      await ctx.reply(
        '❌ Использование: /admin_add <user_id> <имя>\n\n' +
        'Пример: /admin_add 123456789 Иван Иванов',
        { parse_mode: 'HTML' }
      );
      return;
    }

    const targetId = parseInt(args[0]);
    if (isNaN(targetId)) {
      await ctx.reply('❌ Неверный user_id');
      return;
    }

    const name = args.slice(1).join(' ');
    const result = addUser(targetId, name, userId);

    await ctx.reply(
      result.success ? `✅ ${result.message}` : `❌ ${result.message}`
    );
  });

  // /admin_remove <user_id> - remove user
  bot.command('admin_remove', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isAdmin(userId)) return;

    const args = ctx.message?.text?.split(' ').slice(1) || [];

    if (args.length < 1) {
      await ctx.reply('❌ Использование: /admin_remove <user_id>');
      return;
    }

    const targetId = parseInt(args[0]);
    if (isNaN(targetId)) {
      await ctx.reply('❌ Неверный user_id');
      return;
    }

    // Confirm with inline button
    await ctx.reply(
      `⚠️ Удалить пользователя ${targetId}?`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Да, удалить', callback_data: `admin_rm:${targetId}` },
            { text: '❌ Отмена', callback_data: 'admin_cancel' },
          ]]
        }
      }
    );
  });

  // Handle remove confirmation
  bot.action(/^admin_rm:(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isAdmin(userId)) return;

    const match = (ctx.callbackQuery as any).data.match(/^admin_rm:(\d+)$/);
    if (!match) return;

    const targetId = parseInt(match[1]);
    const result = removeUser(targetId, userId);

    await ctx.editMessageText(
      result.success ? `✅ ${result.message}` : `❌ ${result.message}`
    );
    await ctx.answerCbQuery();
  });

  // Handle cancel
  bot.action('admin_cancel', async (ctx) => {
    await ctx.editMessageText('❌ Отменено');
    await ctx.answerCbQuery();
  });

  // /admin_list - list all users (paginated)
  bot.command('admin_list', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isAdmin(userId)) return;

    const { superAdmin, admins, users } = listUsers();

    let msg = `<b>👥 Список пользователей October Group</b>\n\n`;

    // Super admin
    msg += `<b>👑 Владелец:</b>\n`;
    msg += `• <code>${superAdmin}</code>\n\n`;

    // Admins
    if (admins.length > 0) {
      msg += `<b>🔑 Админы (${admins.length}):</b>\n`;
      for (const adminId of admins) {
        if (adminId !== superAdmin) {
          msg += `• <code>${adminId}</code>\n`;
        }
      }
      msg += '\n';
    }

    // Users (show first 30)
    msg += `<b>👤 Пользователи (${users.length}):</b>\n`;
    const displayUsers = users.slice(0, 30);

    for (const u of displayUsers) {
      const username = u.username ? `@${u.username}` : '';
      const active = u.lastActive ? '✓' : '';
      msg += `• ${escapeHtml(u.name)} ${username} <code>${u.id}</code> ${active}\n`;
    }

    if (users.length > 30) {
      msg += `\n<i>...и ещё ${users.length - 30} пользователей</i>\n`;
      msg += `Используй /admin_search для поиска`;
    }

    // Split if too long
    if (msg.length > 4000) {
      const parts = msg.match(/[\s\S]{1,4000}/g) || [];
      for (const part of parts) {
        await ctx.reply(part, { parse_mode: 'HTML' });
      }
    } else {
      await ctx.reply(msg, { parse_mode: 'HTML' });
    }
  });

  // /admin_search <query> - search users
  bot.command('admin_search', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isAdmin(userId)) return;

    const query = ctx.message?.text?.split(' ').slice(1).join(' ') || '';

    if (!query) {
      await ctx.reply('❌ Использование: /admin_search <имя или username>');
      return;
    }

    const results = searchUsers(query);

    if (results.length === 0) {
      await ctx.reply(`🔍 По запросу "${escapeHtml(query)}" ничего не найдено`, { parse_mode: 'HTML' });
      return;
    }

    let msg = `<b>🔍 Результаты поиска "${escapeHtml(query)}":</b>\n\n`;

    for (const u of results.slice(0, 20)) {
      const username = u.username ? `@${u.username}` : '';
      const lastActive = u.lastActive
        ? new Date(u.lastActive).toLocaleDateString('ru-RU')
        : 'никогда';
      msg += `• <b>${escapeHtml(u.name)}</b> ${username}\n`;
      msg += `  ID: <code>${u.id}</code>\n`;
      msg += `  Сообщений: ${u.messageCount || 0}, последняя активность: ${lastActive}\n\n`;
    }

    await ctx.reply(msg, { parse_mode: 'HTML' });
  });

  // /admin_stats - detailed statistics
  bot.command('admin_stats', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isAdmin(userId)) return;

    const stats = getUserStats();
    const { users } = listUsers();

    // Top active users
    const topUsers = [...users]
      .filter(u => u.messageCount && u.messageCount > 0)
      .sort((a, b) => (b.messageCount || 0) - (a.messageCount || 0))
      .slice(0, 10);

    let msg = `<b>📊 Статистика October Group Bot</b>\n\n`;
    msg += `👥 Всего пользователей: <b>${stats.totalUsers}</b>\n`;
    msg += `👑 Админов: <b>${stats.totalAdmins}</b>\n`;
    msg += `📊 Активны сегодня: <b>${stats.activeToday}</b>\n`;
    msg += `📈 Активны за неделю: <b>${stats.activeWeek}</b>\n\n`;

    if (topUsers.length > 0) {
      msg += `<b>🏆 Топ активных пользователей:</b>\n`;
      for (let i = 0; i < topUsers.length; i++) {
        const u = topUsers[i];
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        msg += `${medal} ${escapeHtml(u.name)} — ${u.messageCount} сообщений\n`;
      }
    }

    await ctx.reply(msg, { parse_mode: 'HTML' });
  });

  // /admin_promote <user_id> - promote to admin (super admin only)
  bot.command('admin_promote', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isSuperAdmin(userId)) {
      if (isAdmin(userId)) {
        await ctx.reply('❌ Только владелец может назначать админов');
      }
      return;
    }

    const args = ctx.message?.text?.split(' ').slice(1) || [];

    if (args.length < 1) {
      await ctx.reply('❌ Использование: /admin_promote <user_id>');
      return;
    }

    const targetId = parseInt(args[0]);
    if (isNaN(targetId)) {
      await ctx.reply('❌ Неверный user_id');
      return;
    }

    const result = promoteToAdmin(targetId, userId);
    await ctx.reply(
      result.success ? `✅ ${result.message}` : `❌ ${result.message}`
    );
  });

  // /admin_demote <user_id> - demote admin (super admin only)
  bot.command('admin_demote', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isSuperAdmin(userId)) {
      if (isAdmin(userId)) {
        await ctx.reply('❌ Только владелец может снимать админов');
      }
      return;
    }

    const args = ctx.message?.text?.split(' ').slice(1) || [];

    if (args.length < 1) {
      await ctx.reply('❌ Использование: /admin_demote <user_id>');
      return;
    }

    const targetId = parseInt(args[0]);
    if (isNaN(targetId)) {
      await ctx.reply('❌ Неверный user_id');
      return;
    }

    const result = demoteAdmin(targetId, userId);
    await ctx.reply(
      result.success ? `✅ ${result.message}` : `❌ ${result.message}`
    );
  });

  // /admin_user <user_id> - get user info
  bot.command('admin_user', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isAdmin(userId)) return;

    const args = ctx.message?.text?.split(' ').slice(1) || [];

    if (args.length < 1) {
      await ctx.reply('❌ Использование: /admin_user <user_id>');
      return;
    }

    const targetId = parseInt(args[0]);
    if (isNaN(targetId)) {
      await ctx.reply('❌ Неверный user_id');
      return;
    }

    const user = getUser(targetId);

    if (!user) {
      // Check if admin
      if (isAdmin(targetId)) {
        await ctx.reply(`👑 Пользователь ${targetId} является админом`);
      } else {
        await ctx.reply(`❌ Пользователь ${targetId} не найден в whitelist`);
      }
      return;
    }

    const username = user.username ? `@${user.username}` : 'не указан';
    const addedAt = new Date(user.addedAt).toLocaleDateString('ru-RU');
    const lastActive = user.lastActive
      ? new Date(user.lastActive).toLocaleString('ru-RU')
      : 'никогда';

    let msg = `<b>👤 Информация о пользователе</b>\n\n`;
    msg += `<b>Имя:</b> ${escapeHtml(user.name)}\n`;
    msg += `<b>Username:</b> ${username}\n`;
    msg += `<b>ID:</b> <code>${user.id}</code>\n`;
    msg += `<b>Добавлен:</b> ${addedAt}\n`;
    msg += `<b>Добавил:</b> <code>${user.addedBy}</code>\n`;
    msg += `<b>Последняя активность:</b> ${lastActive}\n`;
    msg += `<b>Сообщений:</b> ${user.messageCount || 0}\n`;

    await ctx.reply(msg, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '🗑 Удалить', callback_data: `admin_rm:${user.id}` }
        ]]
      }
    });
  });

  console.log('[admin] Commands registered: /admin, /admin_add, /admin_remove, /admin_list, /admin_search, /admin_stats, /admin_promote, /admin_demote, /admin_user');
}

// Export for use in bot
export { isAllowed, isAdmin, updateUserActivity } from './users.js';
