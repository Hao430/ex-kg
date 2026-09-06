import { findSessionByToken } from '../repositories/session.repository.js';
import { createFeedback } from '../repositories/feedback.repository.js';
import type { FeedbackRecord } from '../core/records.js';

/**
 * 提交反馈：可选附着当前会话用户信息
 */
export async function submitFeedback(data: {
  token?: string | null;
  type: string;
  rating?: number;
  content: string;
  contactInfo?: string;
}): Promise<FeedbackRecord> {
  let userId: string | undefined;
  let userEmail: string | undefined;

  if (data.token) {
    const sessionData = await findSessionByToken(data.token);
    if (sessionData) {
      userId = sessionData.user.id;
      userEmail = sessionData.user.email;
    }
  }

  return createFeedback({
    userId,
    userEmail,
    type: data.type,
    rating: data.rating,
    content: data.content,
    contactInfo: data.contactInfo,
  });
}
