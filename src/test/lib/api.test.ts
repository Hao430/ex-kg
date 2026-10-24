import { describe, it, expect } from 'vitest';
import { extractErrorMessage } from '@/src/lib/api';

function jsonResponse(payload: unknown, status = 400): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('extractErrorMessage', () => {
  it('prefers body.error (errorHandler 契约 {error, code})', async () => {
    const res = jsonResponse({ error: '画板数量已达上限', code: 'BOARD_LIMIT_REACHED' });

    await expect(extractErrorMessage(res, 'fallback')).resolves.toBe('画板数量已达上限');
  });

  it('falls back to body.message when error is absent (F4 路径 {message})', async () => {
    const res = jsonResponse({ message: '账号已注销' });

    await expect(extractErrorMessage(res, 'fallback')).resolves.toBe('账号已注销');
  });

  it('returns fallback for non-JSON responses', async () => {
    const res = new Response('<html>502</html>', { status: 502 });

    await expect(extractErrorMessage(res, '网络异常')).resolves.toBe('网络异常');
  });

  it('returns fallback when body has neither error nor message', async () => {
    const res = jsonResponse({ code: 'SOMETHING' });

    await expect(extractErrorMessage(res, '操作失败')).resolves.toBe('操作失败');
  });

  it('ignores non-string error/message values', async () => {
    const res = jsonResponse({ error: { text: 'obj' }, message: 42 });

    await expect(extractErrorMessage(res, 'fallback')).resolves.toBe('fallback');
  });
});
