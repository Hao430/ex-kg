import crypto from 'node:crypto';
import { getPool } from '../core/pool.js';
import { inMemoryStore } from '../core/memory-store.js';
import type { FeedbackRecord } from '../core/records.js';

export async function createFeedback(data: {
  userId?: string;
  userEmail?: string;
  type: string;
  rating?: number;
  content: string;
  contactInfo?: string;
}): Promise<FeedbackRecord> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const type = data.type || 'suggestion';
  const rating = data.rating ?? 5;
  const content = data.content.trim();
  const contactInfo = data.contactInfo?.trim() || '';

  const p = getPool();
  if (p) {
    try {
      const res = await p.query(
        `INSERT INTO feedbacks (id, user_id, user_email, type, rating, content, contact_info, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         RETURNING *`,
        [id, data.userId || null, data.userEmail || null, type, rating, content, contactInfo]
      );
      if (res.rows.length > 0) {
        return {
          id: res.rows[0].id,
          user_id: res.rows[0].user_id,
          user_email: res.rows[0].user_email,
          type: res.rows[0].type,
          rating: res.rows[0].rating,
          content: res.rows[0].content,
          contact_info: res.rows[0].contact_info,
          created_at: res.rows[0].created_at,
        };
      }
    } catch (e) {
      console.warn('PG createFeedback fallback to in-memory:', e);
    }
  }

  const record: FeedbackRecord = {
    id,
    user_id: data.userId,
    user_email: data.userEmail,
    type,
    rating,
    content,
    contact_info: contactInfo,
    created_at: now,
  };
  inMemoryStore.feedbacks.push(record);
  return record;
}
