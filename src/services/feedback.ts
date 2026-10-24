/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { FeedbackPayload, MyFeedback } from '../types';
import { extractErrorMessage } from '../lib/api';

export interface FeedbackSubmitResult {
  success: boolean;
  message?: string;
  error?: string;
}

export interface FeedbackListResult {
  success: boolean;
  feedbacks?: MyFeedback[];
  error?: string;
}

export async function submitFeedback(payload: FeedbackPayload): Promise<FeedbackSubmitResult> {
  try {
    const res = await fetch('/api/auth/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      return { success: false, error: await extractErrorMessage(res, '提交反馈失败') };
    }
    const data = await res.json().catch(() => null) as { message?: string } | null;
    return { success: true, message: data?.message };
  } catch (e: any) {
    return { success: false, error: e?.message || '网络连接异常' };
  }
}

export async function listMyFeedbacks(): Promise<FeedbackListResult> {
  try {
    const res = await fetch('/api/feedback', { credentials: 'include' });
    if (!res.ok) {
      return { success: false, error: await extractErrorMessage(res, '获取反馈记录失败') };
    }
    const data = await res.json().catch(() => null) as { feedbacks?: MyFeedback[] } | null;
    return { success: true, feedbacks: (data?.feedbacks || []) as MyFeedback[] };
  } catch (e: any) {
    return { success: false, error: e?.message || '网络连接异常' };
  }
}
