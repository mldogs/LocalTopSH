/**
 * User management for October Group corporate bot
 * Handles whitelist, admin operations, and user tracking
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const USERS_FILE = join(__dirname, 'users.json');

// User record structure
export interface AllowedUser {
  id: number;
  name: string;
  username?: string;
  addedBy: number;
  addedAt: string;
  lastActive?: string;
  messageCount?: number;
}

// Users database structure
interface UsersDB {
  admins: number[];           // Admin user IDs (can manage users)
  superAdmin: number;         // Super admin (cannot be removed)
  users: AllowedUser[];       // Allowed users
}

// Default database
const DEFAULT_DB: UsersDB = {
  superAdmin: 166898548,      // Mark Konakov - owner
  admins: [166898548],        // Initial admins
  users: []
};

// Load users from file
function loadDB(): UsersDB {
  if (!existsSync(USERS_FILE)) {
    saveDB(DEFAULT_DB);
    return DEFAULT_DB;
  }

  try {
    const data = readFileSync(USERS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    console.error('[admin] Failed to load users.json:', e);
    return DEFAULT_DB;
  }
}

// Save users to file
function saveDB(db: UsersDB): void {
  try {
    writeFileSync(USERS_FILE, JSON.stringify(db, null, 2), 'utf-8');
  } catch (e) {
    console.error('[admin] Failed to save users.json:', e);
  }
}

// Check if user is super admin
export function isSuperAdmin(userId: number): boolean {
  const db = loadDB();
  return userId === db.superAdmin;
}

// Check if user is admin
export function isAdmin(userId: number): boolean {
  const db = loadDB();
  return userId === db.superAdmin || db.admins.includes(userId);
}

// Check if user is allowed (in whitelist)
export function isAllowed(userId: number): boolean {
  const db = loadDB();

  // Admins are always allowed
  if (isAdmin(userId)) return true;

  // Check whitelist
  return db.users.some(u => u.id === userId);
}

// Add user to whitelist
export function addUser(
  userId: number,
  name: string,
  addedBy: number,
  username?: string
): { success: boolean; message: string } {
  const db = loadDB();

  // Check if already exists
  if (db.users.some(u => u.id === userId)) {
    return { success: false, message: 'Пользователь уже в списке' };
  }

  // Check if admin
  if (isAdmin(userId)) {
    return { success: false, message: 'Пользователь является админом' };
  }

  const newUser: AllowedUser = {
    id: userId,
    name,
    username,
    addedBy,
    addedAt: new Date().toISOString(),
    messageCount: 0
  };

  db.users.push(newUser);
  saveDB(db);

  return { success: true, message: `Добавлен: ${name} (${userId})` };
}

// Remove user from whitelist
export function removeUser(userId: number, removedBy: number): { success: boolean; message: string } {
  const db = loadDB();

  // Cannot remove super admin
  if (userId === db.superAdmin) {
    return { success: false, message: 'Нельзя удалить владельца бота' };
  }

  // Cannot remove admins (only super admin can)
  if (db.admins.includes(userId) && removedBy !== db.superAdmin) {
    return { success: false, message: 'Только владелец может удалить админа' };
  }

  // Remove from admins if present
  const adminIdx = db.admins.indexOf(userId);
  if (adminIdx !== -1) {
    db.admins.splice(adminIdx, 1);
    saveDB(db);
    return { success: true, message: `Админ ${userId} удалён` };
  }

  // Remove from users
  const userIdx = db.users.findIndex(u => u.id === userId);
  if (userIdx === -1) {
    return { success: false, message: 'Пользователь не найден' };
  }

  const removed = db.users.splice(userIdx, 1)[0];
  saveDB(db);

  return { success: true, message: `Удалён: ${removed.name} (${userId})` };
}

// Promote user to admin
export function promoteToAdmin(userId: number, promotedBy: number): { success: boolean; message: string } {
  const db = loadDB();

  // Only super admin can promote
  if (promotedBy !== db.superAdmin) {
    return { success: false, message: 'Только владелец может назначать админов' };
  }

  if (db.admins.includes(userId)) {
    return { success: false, message: 'Уже является админом' };
  }

  db.admins.push(userId);

  // Remove from regular users if present
  const userIdx = db.users.findIndex(u => u.id === userId);
  if (userIdx !== -1) {
    db.users.splice(userIdx, 1);
  }

  saveDB(db);
  return { success: true, message: `Пользователь ${userId} теперь админ` };
}

// Demote admin to regular user
export function demoteAdmin(userId: number, demotedBy: number): { success: boolean; message: string } {
  const db = loadDB();

  // Only super admin can demote
  if (demotedBy !== db.superAdmin) {
    return { success: false, message: 'Только владелец может снимать админов' };
  }

  if (userId === db.superAdmin) {
    return { success: false, message: 'Нельзя снять владельца' };
  }

  const idx = db.admins.indexOf(userId);
  if (idx === -1) {
    return { success: false, message: 'Не является админом' };
  }

  db.admins.splice(idx, 1);
  saveDB(db);

  return { success: true, message: `Админ ${userId} понижен до пользователя` };
}

// List all users
export function listUsers(): { admins: number[]; users: AllowedUser[]; superAdmin: number } {
  const db = loadDB();
  return {
    superAdmin: db.superAdmin,
    admins: db.admins,
    users: db.users
  };
}

// Get user by ID
export function getUser(userId: number): AllowedUser | null {
  const db = loadDB();
  return db.users.find(u => u.id === userId) || null;
}

// Update user activity
export function updateUserActivity(userId: number): void {
  const db = loadDB();
  const user = db.users.find(u => u.id === userId);

  if (user) {
    user.lastActive = new Date().toISOString();
    user.messageCount = (user.messageCount || 0) + 1;
    saveDB(db);
  }
}

// Get user stats
export function getUserStats(): {
  totalUsers: number;
  totalAdmins: number;
  activeToday: number;
  activeWeek: number;
} {
  const db = loadDB();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

  let activeToday = 0;
  let activeWeek = 0;

  for (const user of db.users) {
    if (user.lastActive) {
      const lastActive = new Date(user.lastActive);
      if (lastActive >= today) activeToday++;
      if (lastActive >= weekAgo) activeWeek++;
    }
  }

  return {
    totalUsers: db.users.length,
    totalAdmins: db.admins.length,
    activeToday,
    activeWeek
  };
}

// Bulk import users (for initial setup)
export function bulkImportUsers(
  users: Array<{ id: number; name: string; username?: string }>,
  importedBy: number
): { added: number; skipped: number } {
  const db = loadDB();
  let added = 0;
  let skipped = 0;

  for (const u of users) {
    // Skip if already exists
    if (db.users.some(existing => existing.id === u.id) || isAdmin(u.id)) {
      skipped++;
      continue;
    }

    db.users.push({
      id: u.id,
      name: u.name,
      username: u.username,
      addedBy: importedBy,
      addedAt: new Date().toISOString(),
      messageCount: 0
    });
    added++;
  }

  saveDB(db);
  return { added, skipped };
}

// Search users by name or username
export function searchUsers(query: string): AllowedUser[] {
  const db = loadDB();
  const q = query.toLowerCase();

  return db.users.filter(u =>
    u.name.toLowerCase().includes(q) ||
    (u.username && u.username.toLowerCase().includes(q))
  );
}
