/**
 * Admin module - Now uses SQLite database
 * Provides backward-compatible exports
 */

import { db } from '../db/index.js';

// Re-export from database
export const isAllowed = db.users.isUserAllowed;
export const isAdmin = db.users.isUserAdmin;
export const isSuperAdmin = db.users.isUserSuperAdmin;

// User management
export function addUser(
  userId: number,
  name: string,
  addedBy: number,
  username?: string
): { success: boolean; message: string } {
  try {
    // Check if exists
    const existing = db.users.getUserById(userId);
    if (existing) {
      return { success: false, message: 'Пользователь уже в списке' };
    }

    db.users.upsertUser({
      id: userId,
      display_name: name,
      username,
      role: 'user',
      added_by: addedBy,
    });

    return { success: true, message: `Добавлен: ${name} (${userId})` };
  } catch (e: any) {
    return { success: false, message: e.message };
  }
}

export function removeUser(userId: number, removedBy: number): { success: boolean; message: string } {
  try {
    const user = db.users.getUserById(userId);
    if (!user) {
      return { success: false, message: 'Пользователь не найден' };
    }

    if (user.role === 'superadmin') {
      return { success: false, message: 'Нельзя удалить владельца бота' };
    }

    if (user.role === 'admin' && !db.users.isUserSuperAdmin(removedBy)) {
      return { success: false, message: 'Только владелец может удалить админа' };
    }

    db.users.deactivateUser(userId);
    return { success: true, message: `Удалён: ${user.display_name} (${userId})` };
  } catch (e: any) {
    return { success: false, message: e.message };
  }
}

export function promoteToAdmin(userId: number, promotedBy: number): { success: boolean; message: string } {
  if (!db.users.isUserSuperAdmin(promotedBy)) {
    return { success: false, message: 'Только владелец может назначать админов' };
  }

  const user = db.users.getUserById(userId);
  if (!user) {
    return { success: false, message: 'Пользователь не найден' };
  }

  if (user.role === 'admin' || user.role === 'superadmin') {
    return { success: false, message: 'Уже является админом' };
  }

  db.users.updateUserRole(userId, 'admin');
  return { success: true, message: `Пользователь ${userId} теперь админ` };
}

export function demoteAdmin(userId: number, demotedBy: number): { success: boolean; message: string } {
  if (!db.users.isUserSuperAdmin(demotedBy)) {
    return { success: false, message: 'Только владелец может снимать админов' };
  }

  const user = db.users.getUserById(userId);
  if (!user) {
    return { success: false, message: 'Пользователь не найден' };
  }

  if (user.role === 'superadmin') {
    return { success: false, message: 'Нельзя снять владельца' };
  }

  if (user.role !== 'admin') {
    return { success: false, message: 'Не является админом' };
  }

  db.users.updateUserRole(userId, 'user');
  return { success: true, message: `Админ ${userId} понижен до пользователя` };
}

export function listUsers() {
  const users = db.users.getUsers({ isActive: true });
  const superAdmin = users.find(u => u.role === 'superadmin');
  const admins = users.filter(u => u.role === 'admin').map(u => u.id);
  const regularUsers = users.filter(u => u.role === 'user').map(u => ({
    id: u.id,
    name: u.display_name,
    username: u.username || undefined,
    addedBy: u.added_by || 0,
    addedAt: u.created_at,
    lastActive: u.last_active_at || undefined,
    messageCount: 0, // Will be filled from usage stats if needed
  }));

  return {
    superAdmin: superAdmin?.id || 0,
    admins,
    users: regularUsers,
  };
}

export function getUser(userId: number) {
  const user = db.users.getUserById(userId);
  if (!user) return null;

  return {
    id: user.id,
    name: user.display_name,
    username: user.username || undefined,
    addedBy: user.added_by || 0,
    addedAt: user.created_at,
    lastActive: user.last_active_at || undefined,
    messageCount: 0,
  };
}

export function getUserStats() {
  return db.users.getUserStats();
}

export function updateUserActivity(userId: number) {
  db.users.updateUserActivity(userId);
}

export function searchUsers(query: string) {
  return db.users.searchUsers(query).map(u => ({
    id: u.id,
    name: u.display_name,
    username: u.username || undefined,
    addedBy: u.added_by || 0,
    addedAt: u.created_at,
    lastActive: u.last_active_at || undefined,
    messageCount: 0,
  }));
}

// Keep setupAdminCommands export
export { setupAdminCommands } from './commands.js';
