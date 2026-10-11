import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { submitFeedback, listMyFeedbacks } from '@/src/services/feedback';
import { FeedbackPayload } from '@/src/types';

describe('Feedback Service (src/services/feedback.ts) Empirical Tests', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('submitFeedback Endpoint', () => {
    it('sends correct request parameters (POST, /api/auth/feedback, credentials, JSON body)', async () => {
      let capturedUrl = '';
      let capturedInit: RequestInit | undefined;

      globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedInit = init;
        return {
          ok: true,
          status: 200,
          json: async () => ({ message: '反馈已收到，感谢您的支持！' }),
        } as unknown as Response;
      });

      const payload: FeedbackPayload = {
        type: 'suggestion',
        rating: 5,
        content: '希望支持快捷键拖拽节点',
        contactInfo: 'user@example.com',
      };

      const result = await submitFeedback(payload);

      expect(result).toEqual({
        success: true,
        message: '反馈已收到，感谢您的支持！',
      });
      expect(capturedUrl).toBe('/api/auth/feedback');
      expect(capturedInit?.method).toBe('POST');
      expect(capturedInit?.credentials).toBe('include');
      expect(capturedInit?.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(JSON.parse(capturedInit?.body as string)).toEqual(payload);
    });

    it('returns error message from server when response is not ok (e.g. 400)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: '反馈内容过短（至少 5 个字符）' }),
      } as unknown as Response);

      const result = await submitFeedback({ type: 'bug', rating: 1, content: '短' });

      expect(result).toEqual({
        success: false,
        error: '反馈内容过短（至少 5 个字符）',
      });
    });

    it('falls back to default error string if server returns non-ok without error message', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
      } as unknown as Response);

      const result = await submitFeedback({ type: 'other', rating: 3, content: '测试内容五字以上' });

      expect(result).toEqual({
        success: false,
        error: '提交反馈失败',
      });
    });

    it('handles non-JSON error response gracefully without crashing', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => { throw new Error('Bad Gateway HTML body'); },
      } as unknown as Response);

      const result = await submitFeedback({ type: 'other', rating: 3, content: '测试内容五字以上' });

      expect(result).toEqual({
        success: false,
        error: '提交反馈失败',
      });
    });

    it('handles network-level fetch exceptions and returns error', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Failed to fetch'));

      const result = await submitFeedback({ type: 'bug', rating: 2, content: '网络离线测试' });

      expect(result).toEqual({
        success: false,
        error: 'Failed to fetch',
      });
    });

    it('handles non-Error rejection object gracefully', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue('unknown string error');

      const result = await submitFeedback({ type: 'bug', rating: 2, content: '网络离线测试' });

      expect(result).toEqual({
        success: false,
        error: '网络连接异常',
      });
    });
  });

  describe('listMyFeedbacks Endpoint', () => {
    it('sends correct request parameters (GET, /api/feedback, credentials) and returns feedbacks', async () => {
      let capturedUrl = '';
      let capturedInit: RequestInit | undefined;

      const mockFeedbacks = [
        {
          id: 'fb-1',
          type: 'bug',
          rating: 2,
          content: '无法导出图片',
          status: 'resolved',
          admin_reply: '已在最新版本修复',
          resolved_at: '2026-10-10T12:00:00Z',
          created_at: '2026-10-10T10:00:00Z',
          updated_at: '2026-10-10T12:00:00Z',
        },
      ];

      globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedInit = init;
        return {
          ok: true,
          status: 200,
          json: async () => ({ feedbacks: mockFeedbacks }),
        } as unknown as Response;
      });

      const result = await listMyFeedbacks();

      expect(result).toEqual({
        success: true,
        feedbacks: mockFeedbacks,
      });
      expect(capturedUrl).toBe('/api/feedback');
      expect(capturedInit?.credentials).toBe('include');
    });

    it('defaults to empty array if feedbacks property is missing in response JSON', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      } as unknown as Response);

      const result = await listMyFeedbacks();

      expect(result).toEqual({
        success: true,
        feedbacks: [],
      });
    });

    it('returns server error message when response is not ok', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: '请先登录后再查看工单记录' }),
      } as unknown as Response);

      const result = await listMyFeedbacks();

      expect(result).toEqual({
        success: false,
        error: '请先登录后再查看工单记录',
      });
    });

    it('falls back to default error string if server returns non-ok without error message', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => null,
      } as unknown as Response);

      const result = await listMyFeedbacks();

      expect(result).toEqual({
        success: false,
        error: '获取反馈记录失败',
      });
    });

    it('handles network failure gracefully', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('DNS lookup failed'));

      const result = await listMyFeedbacks();

      expect(result).toEqual({
        success: false,
        error: 'DNS lookup failed',
      });
    });
  });
});
