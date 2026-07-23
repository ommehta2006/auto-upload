import { query } from '../db.js';

export async function addLog(userId, level, message, details = {}) {
  const safeLevel = ['info', 'warning', 'error', 'success'].includes(level) ? level : 'info';
  try {
    await query(
      `INSERT INTO activity_logs (user_id, level, message, details)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [userId || null, safeLevel, String(message).slice(0, 500), JSON.stringify(details || {})]
    );
  } catch (error) {
    console.error('Failed to persist activity log:', error);
  }
}
