import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthProvider } from '@/src/context/AuthContext';
import {
  ModalContext,
  ModalProvider,
  defaultModalContextValue,
} from '@/src/context/ModalContext';
import {
  UserProfileContent,
  type UserProfileContentProps,
} from '@/src/components/profile/UserProfileContent';
import { ProfilePage } from '@/src/components/profile/ProfilePage';
import type { AuthUser } from '@/src/types';

const mockUser: AuthUser = {
  id: 'user-12345678-abcd',
  email: 'me@example.com',
  name: '原昵称',
  role: 'user',
  avatar: '🧠',
  created_at: '2026-01-01',
  has_password: true,
};

const json = (body: unknown, ok = true, status = 200): Response =>
  ({ ok, status, json: async () => body }) as Response;

interface FetchOptions {
  user?: AuthUser | null;
  quota?: unknown;
  canvases?: unknown[];
  nodeByCanvas?: Record<string, unknown>;
  profile?: unknown;
  onNodeRequest?: (canvasId: string, init?: RequestInit) => Promise<Response> | Response;
}

function installFetch(opts: FetchOptions = {}) {
  const calls: string[] = [];
  const user = opts.user === undefined ? mockUser : opts.user;
  const quotaResp = opts.quota ?? {
    plan: 'trial',
    vipExpired: false,
    board: { used: 2, limit: 3 },
    node: { used: 4, limit: 10, remaining: 6 },
  };
  const canvases = opts.canvases ?? [
    { id: 'canvas-1', title: '画板一' },
    { id: 'canvas-2', title: '画板二' },
  ];
  const profileResp = opts.profile ?? { user: { ...mockUser, name: '新昵称' } };

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);

    if (url === '/api/auth/me') return user ? json({ user }) : json({}, false, 401);
    if (url === '/api/auth/profile') return json(profileResp);
    if (url === '/api/canvases') return json(canvases);
    if (url === '/api/shares') return json({ shares: [] });
    if (url.startsWith('/api/quota?canvasId=')) {
      const canvasId = decodeURIComponent(url.slice('/api/quota?canvasId='.length));
      if (opts.onNodeRequest) return opts.onNodeRequest(canvasId, init);
      return json({
        ...(quotaResp as Record<string, unknown>),
        node: opts.nodeByCanvas?.[canvasId] ?? { used: 4, limit: 10 },
      });
    }
    if (url === '/api/quota') return json(quotaResp);
    return json({}, false, 404);
  });

  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return { calls, fetchMock };
}

async function renderContent(
  props: UserProfileContentProps = {},
  opts: FetchOptions = {}
) {
  const installed = installFetch(opts);
  const rendered = render(
    <AuthProvider>
      <ModalProvider>
        <UserProfileContent {...props} />
      </ModalProvider>
    </AuthProvider>
  );
  await waitFor(() => {
    expect(screen.getByDisplayValue(mockUser.name)).toBeInTheDocument();
  });
  return { ...installed, ...rendered };
}

describe('UserProfileContent（单一维护共享组件）', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('渲染 emoji 徽标头像，且完全没有头像上传入口', async () => {
    const { container } = await renderContent();

    expect(screen.getByDisplayValue('原昵称')).toBeInTheDocument();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByTitle('上传本地图片作为头像')).toBeNull();
    expect(screen.queryByText('清除已上传图片，恢复图标头像')).toBeNull();
  });

  it('保存走 updateProfile(POST) 并在注入 onSaved 时调用宿主回调', async () => {
    const onSaved = vi.fn();
    const { fetchMock } = await renderContent({ onSaved });

    fireEvent.change(document.getElementById('user-profile-name-input')!, {
      target: { value: '新昵称' },
    });
    fireEvent.click(screen.getByRole('button', { name: /保存资料/ }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const profileCall = fetchMock.mock.calls.find((c: unknown[]) => c[0] === '/api/auth/profile');
    expect(profileCall).toBeDefined();
    expect((profileCall![1] as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((profileCall![1] as RequestInit).body))).toEqual({
      name: '新昵称',
      avatar: '🧠',
    });
    expect(screen.getByText('个人资料已更新！')).toBeInTheDocument();
  });

  it('未注入 onSaved 时保存不触发宿主关闭弹窗副作用（/profile 页面语义）', async () => {
    const closeSpy = vi.fn();
    installFetch({ profile: { user: { ...mockUser, name: '新昵称' } } });
    render(
      <AuthProvider>
        <ModalContext.Provider
          value={{ ...defaultModalContextValue, closeUserProfileModal: closeSpy }}
        >
          <UserProfileContent />
        </ModalContext.Provider>
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByDisplayValue('原昵称')).toBeInTheDocument());

    fireEvent.change(document.getElementById('user-profile-name-input')!, {
      target: { value: '新昵称' },
    });
    fireEvent.click(screen.getByRole('button', { name: /保存资料/ }));

    await waitFor(() => expect(screen.getByText('个人资料已更新！')).toBeInTheDocument());
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('安全页无条件展示改密表单：has_password=false 死分支已移除', async () => {
    await renderContent({}, { user: { ...mockUser, has_password: false } });

    fireEvent.click(screen.getByRole('button', { name: '安全与账号' }));

    expect(screen.getByLabelText('当前旧密码')).toBeInTheDocument();
    expect(screen.queryByText('本账号通过微信登录')).toBeNull();
  });

  it('limit=null 显示「不限」，空画布列表显示空态且不发节点请求', async () => {
    const { calls } = await renderContent(
      {},
      {
        quota: { plan: 'vip', vipExpired: false, board: { used: 2, limit: null }, node: null },
        canvases: [],
      }
    );

    fireEvent.click(screen.getByRole('button', { name: '会员权益与配额' }));

    await waitFor(() =>
      expect(screen.getByTestId('profile-quota-board').textContent).toBe('2 / 不限')
    );
    expect(screen.getByText('暂无画板，创建后即可查看节点配额。')).toBeInTheDocument();
    expect((screen.getByTestId('profile-canvas-select') as HTMLSelectElement).disabled).toBe(true);
    expect(calls.some((url) => url.includes('canvasId='))).toBe(false);
  });

  it('选择画布后带 canvasId 取节点配额并展示 Y/10', async () => {
    const { calls } = await renderContent(
      {},
      { nodeByCanvas: { 'canvas-2': { used: 7, limit: 10, remaining: 3 } } }
    );

    fireEvent.click(screen.getByRole('button', { name: '会员权益与配额' }));
    await waitFor(() =>
      expect((screen.getByTestId('profile-canvas-select') as HTMLSelectElement).disabled).toBe(false)
    );
    fireEvent.change(screen.getByTestId('profile-canvas-select'), {
      target: { value: 'canvas-2' },
    });

    await waitFor(() => expect(screen.getByTestId('profile-quota-node').textContent).toBe('7 / 10'));
    expect(calls).toContain('/api/quota?canvasId=canvas-2');
  });

  it('节点配额 403 时重置画布选择并给出局部错误', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/me') return json({ user: mockUser });
      if (url === '/api/canvases') return json([{ id: 'canvas-1', title: '画板一' }]);
      if (url === '/api/quota')
        return json({ plan: 'trial', board: { used: 1, limit: 3 }, node: null });
      if (url.startsWith('/api/quota?canvasId=')) return json({ error: 'FORBIDDEN' }, false, 403);
      return json({}, false, 404);
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    render(
      <AuthProvider>
        <ModalProvider>
          <UserProfileContent initialTab="membership" />
        </ModalProvider>
      </AuthProvider>
    );

    await waitFor(() =>
      expect((screen.getByTestId('profile-canvas-select') as HTMLSelectElement).disabled).toBe(false)
    );
    fireEvent.change(screen.getByTestId('profile-canvas-select'), {
      target: { value: 'canvas-1' },
    });

    await waitFor(() =>
      expect(screen.getByTestId('profile-quota-error')).toHaveTextContent('无权查看该画板配额')
    );
    await waitFor(() =>
      expect((screen.getByTestId('profile-canvas-select') as HTMLSelectElement).value).toBe('')
    );
  });

  it('快速切换画布时忽略旧响应，节点数字不被陈旧请求覆盖', async () => {
    let resolveOld: ((value: Response) => void) | null = null;
    const oldResponse = new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });

    await renderContent(
      {},
      {
        canvases: [
          { id: 'canvas-1', title: '画板一' },
          { id: 'canvas-2', title: '画板二' },
        ],
        onNodeRequest: (canvasId) =>
          canvasId === 'canvas-1'
            ? oldResponse
            : json({ board: { used: 2, limit: 3 }, node: { used: 7, limit: 10 } }),
      }
    );

    fireEvent.click(screen.getByRole('button', { name: '会员权益与配额' }));
    await waitFor(() =>
      expect((screen.getByTestId('profile-canvas-select') as HTMLSelectElement).disabled).toBe(false)
    );
    fireEvent.change(screen.getByTestId('profile-canvas-select'), {
      target: { value: 'canvas-1' },
    });
    fireEvent.change(screen.getByTestId('profile-canvas-select'), {
      target: { value: 'canvas-2' },
    });

    await waitFor(() => expect(screen.getByTestId('profile-quota-node').textContent).toBe('7 / 10'));

    await act(async () => {
      resolveOld?.(json({ board: { used: 2, limit: 3 }, node: { used: 9, limit: 10 } }));
      await Promise.resolve();
    });
    expect(screen.getByTestId('profile-quota-node').textContent).toBe('7 / 10');
  });
});

describe('ProfilePage（/profile 独立页）', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('未登录只显示登录提示，不渲染任何资料节点', async () => {
    installFetch({ user: null });

    render(<ProfilePage />);

    await waitFor(() =>
      expect(screen.getByTestId('profile-login-gate')).toBeInTheDocument()
    );
    expect(screen.queryByTestId('profile-page')).toBeNull();
    expect(screen.queryByDisplayValue(mockUser.name)).toBeNull();
    expect(screen.queryByText(mockUser.email)).toBeNull();
    expect(screen.getByTestId('profile-login-btn')).toBeInTheDocument();
  });

  it('登录后渲染同一份共享内容，且 ModalProvider 下的弹窗动作真实可用', async () => {
    const { calls } = installFetch();

    render(<ProfilePage />);

    await waitFor(() => expect(screen.getByTestId('profile-page')).toBeInTheDocument());
    // 共享内容的状态由 useEffect 从 user 注入，需等待回填完成再断言。
    await waitFor(() => expect(screen.getByDisplayValue('原昵称')).toBeInTheDocument());
    expect(screen.getAllByText('返回首页').length).toBeGreaterThan(0);

    // 没有 ModalProvider 时 openMySharesModal 是默认空函数，不会请求 /api/shares。
    fireEvent.click(document.getElementById('user-profile-my-shares-btn')!);
    await waitFor(() => expect(calls).toContain('/api/shares'));
  });
});
