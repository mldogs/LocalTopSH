/**
 * Migration script - Import existing JSON data into SQLite
 * Run once: npx tsx src/db/migrate-from-json.ts
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initDatabase, closeDatabase } from './connection.js';
import { runMigrations } from './schema.js';
import { db } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function migrate() {
  console.log('='.repeat(50));
  console.log('Migration: JSON -> SQLite');
  console.log('='.repeat(50));

  // Initialize database
  const dbPath = process.env.DB_PATH || './workspace/october.db';
  console.log(`\n[1/4] Initializing database: ${dbPath}`);
  initDatabase(dbPath);
  runMigrations();

  // Migrate users from admin/users.json
  const usersJsonPath = join(__dirname, '../admin/users.json');
  if (existsSync(usersJsonPath)) {
    console.log('\n[2/4] Migrating users from admin/users.json...');

    try {
      const data = JSON.parse(readFileSync(usersJsonPath, 'utf-8'));

      // Import superadmin
      if (data.superAdmin) {
        db.users.upsertUser({
          id: data.superAdmin,
          display_name: 'Super Admin',
          role: 'superadmin',
        });
        console.log(`  ✓ Super admin: ${data.superAdmin}`);
      }

      // Import other admins
      if (data.admins) {
        for (const adminId of data.admins) {
          if (adminId !== data.superAdmin) {
            db.users.upsertUser({
              id: adminId,
              display_name: `Admin ${adminId}`,
              role: 'admin',
              added_by: data.superAdmin,
            });
          }
        }
        console.log(`  ✓ Admins: ${data.admins.length}`);
      }

      // Import regular users
      if (data.users && Array.isArray(data.users)) {
        const usersToImport = data.users.map((u: any) => ({
          id: u.id,
          display_name: u.name,
          username: u.username,
          role: 'user' as const,
          added_by: u.addedBy || data.superAdmin,
        }));

        const result = db.users.bulkImportUsers(usersToImport);
        console.log(`  ✓ Users imported: ${result.added}, skipped: ${result.skipped}`);
      }
    } catch (e: any) {
      console.error(`  ✗ Error migrating users: ${e.message}`);
    }
  } else {
    console.log('\n[2/4] No users.json found, skipping user migration');
  }

  // Migrate scheduled tasks from JSON (if exists)
  const tasksJsonPath = './workspace/_shared/scheduled_tasks.json';
  if (existsSync(tasksJsonPath)) {
    console.log('\n[3/4] Migrating scheduled tasks...');

    try {
      const data = JSON.parse(readFileSync(tasksJsonPath, 'utf-8'));

      if (data.tasks) {
        let migrated = 0;
        for (const [id, task] of Object.entries(data.tasks) as any[]) {
          try {
            db.tasks.createTask({
              id: task.id || id,
              user_id: task.userId,
              chat_id: task.chatId,
              type: task.type,
              content: task.content,
              execute_at: new Date(task.executeAt),
              is_recurring: task.recurring,
              interval_minutes: task.intervalMinutes,
              end_at: task.endAt ? new Date(task.endAt) : undefined,
            });
            migrated++;
          } catch (e) {
            // Skip duplicates
          }
        }
        console.log(`  ✓ Tasks migrated: ${migrated}`);
      }
    } catch (e: any) {
      console.error(`  ✗ Error migrating tasks: ${e.message}`);
    }
  } else {
    console.log('\n[3/4] No scheduled_tasks.json found, skipping');
  }

  // Summary
  console.log('\n[4/4] Migration summary:');
  const stats = db.users.getUserStats();
  console.log(`  • Total users: ${stats.total}`);
  console.log(`  • Admins: ${stats.admins}`);

  closeDatabase();
  console.log('\n✓ Migration complete!');
  console.log('='.repeat(50));
}

// Run if called directly
migrate().catch(console.error);
