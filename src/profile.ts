export type BotProfile = 'october' | 'lab';

export const BOT_PROFILE: BotProfile =
  (process.env.BOT_PROFILE || '').toLowerCase() === 'lab' ? 'lab' : 'october';

export function isLabProfile(): boolean {
  return BOT_PROFILE === 'lab';
}

