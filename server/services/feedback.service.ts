import { findSessionByToken } from '../repositories/session.repository.js';
import {
  createFeedback,
  listUserFeedbacks,
  listAdminFeedbacks,
  getFeedbackById,
  updateFeedbackByAdmin,
  FEEDBACK_TERMINAL_STATUSES,
} from '../repositories/feedback.repository.js';
import type { AdminFeedbackView, MyFeedbackView } from '../repositories/feedback.repository.js';
import type { FeedbackRecord } from '../core/records.js';
import { recordAuditLog } from '../repositories/audit.repository.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';

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

/**
 * 状态机（Spec P1）：`pending → processing → resolved | rejected`，`pending` 可直达终态。
 * 终态**不可逆**——`resolved → pending` 之类一律 400，工单的定案结果不能被悄悄推翻；
 * 需要重开时是新增一条工单。
 */
const FEEDBACK_TRANSITIONS: Record<string, readonly string[]> = {
  pending: ['processing', 'resolved', 'rejected'],
  processing: ['resolved', 'rejected'],
  resolved: [],
  rejected: [],
};

/** 用户自查自己提交的工单（登录作用域，RLS 天然只回本人行） */
export async function listMyFeedbacks(userId: string): Promise<MyFeedbackView[]> {
  return listUserFeedbacks(userId);
}

/** 运营台工单列表（跨租户，仅在 admin system 作用域下调用） */
export async function listFeedbacksForAdmin(params: {
  status?: string;
  type?: string;
  page?: number;
  limit?: number;
}): Promise<{ feedbacks: AdminFeedbackView[]; total: number; statusCounts: Record<string, number> }> {
  return listAdminFeedbacks(params);
}

/**
 * 运营台流转 + 回复（Spec P1）。
 * 「已解决」必须带非空回复——回复是「已处理」的载体，只改状态不写回复等于把工单静默丢掉。
 * 「已驳回」回复选填（不采纳也常有理由，但不强制）。
 */
export async function updateFeedbackStatus(data: {
  id: string;
  status: string;
  adminReply?: string;
  adminUserId: string;
}): Promise<AdminFeedbackView> {
  const existing = await getFeedbackById(data.id);
  if (!existing) throw new NotFoundError('反馈工单不存在');

  const current = existing.status || 'pending';
  const allowed = FEEDBACK_TRANSITIONS[current] ?? [];
  // 同状态提交 = 幂等修订回复（终态后改措辞的通道），不算「流转」；换状态才查转移表
  if (data.status !== current && !allowed.includes(data.status)) {
    throw new ValidationError(
      `工单状态不能从「${current}」流转到「${data.status}」`,
      'FEEDBACK_INVALID_TRANSITION'
    );
  }

  const reply = (data.adminReply ?? '').trim();
  if (data.status === 'resolved' && !reply) {
    throw new ValidationError('标记为已解决时必须填写回复内容', 'FEEDBACK_REPLY_REQUIRED');
  }

  const updated = await updateFeedbackByAdmin({
    id: data.id,
    status: data.status,
    adminReply: reply,
    resolvedBy: FEEDBACK_TERMINAL_STATUSES.includes(data.status) ? data.adminUserId : null,
  });
  if (!updated) throw new NotFoundError('反馈工单不存在');

  // 审计只记流转与操作者，**不落工单正文与联系方式**（同类纪律：审计详情不得落只读凭据）
  await recordAuditLog({
    userId: data.adminUserId,
    action: 'admin_feedback_update',
    targetType: 'feedback',
    targetId: data.id,
    details: { from: current, to: data.status },
  });

  return updated;
}
