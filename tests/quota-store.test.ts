/**
 * 前端 — quota-store 配额快照与新建闸门（2026-09-10 画布列表/同步重构）。
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

let online = true;
function setOnline(v: boolean): void {
  online = v;
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: v },
      configurable: true,
      writable: true,
    });
  } catch {
    /* ignore */
  }
}
setOnline(true);

interface MockRes {
  status: number;
  body?: any;
}
let nextRes: MockRes = { status: 200, body: { plan: 'trial', vipExpired: false, board: { used: 0, limit: 3 } } };
(globalThis as any).fetch = async () => {
  const r = nextRes;
  return {
    ok: r.status < 400,
    status: r.status,
    json: async () => r.body ?? {},
  };
};

const quotaStore = await import('../src/lib/quota-store.js');
const boardStore = await import('../src/lib/board-store.js');

function quota(plan: string, used: number, limit: number | null): MockRes {
  return { status: 200, body: { plan, vipExpired: false, board: { used, limit } } };
}

describe('quota-store 快照与闸门', () => {
  beforeEach(() => {
    store.clear();
    quotaStore.resetForTest();
    boardStore.resetForTest();
    setOnline(true);
    nextRes = quota('trial', 0, 3);
  });

  test('refreshQuota 解析并进入 view', async () => {
    nextRes = quota('trial', 1, 3);
    await quotaStore.refreshQuota();
    const v = quotaStore.getQuotaView();
    assert.equal(v.used, 1);
    assert.equal(v.limit, 3);
    assert.equal(v.unlimited, false);
    assert.equal(v.plan, 'trial');
  });

  test('在线额度已满 → block；未满 → allow', async () => {
    nextRes = quota('trial', 3, 3);
    await quotaStore.refreshQuota();
    assert.equal(quotaStore.canCreate(false), 'block');

    nextRes = quota('trial', 1, 3);
    await quotaStore.refreshQuota();
    assert.equal(quotaStore.canCreate(false), 'allow');
  });

  test('离线 → optimistic（离线先建草稿）', async () => {
    nextRes = quota('trial', 3, 3);
    await quotaStore.refreshQuota();
    assert.equal(quotaStore.canCreate(false), 'block');
    setOnline(false);
    quotaStore.refreshQuota(); // 触发 offline 标记路径
    assert.equal(quotaStore.canCreate(false), 'optimistic');
  });

  test('无快照（游客/未拉取）→ optimistic', () => {
    assert.equal(quotaStore.canCreate(false), 'optimistic');
  });

  test('VIP/admin 不限 → allow', async () => {
    nextRes = quota('vip', 50, null);
    await quotaStore.refreshQuota();
    assert.equal(quotaStore.canCreate(false), 'allow');
    assert.equal(quotaStore.getQuotaView().unlimited, true);
  });

  test('pendingCreates 计入展示用量并在确认创建后出列', async () => {
    nextRes = quota('trial', 2, 3);
    await quotaStore.refreshQuota();
    assert.equal(quotaStore.getQuotaView().used, 2);
    assert.equal(quotaStore.canCreate(false), 'allow');

    quotaStore.markPendingCreate('new-1');
    assert.equal(quotaStore.getQuotaView().used, 3, 'pending 应计入展示');
    assert.equal(quotaStore.canCreate(false), 'block', '待建 + 已用到顶应拦');

    quotaStore.confirmCreate('new-1');
    assert.deepEqual(quotaStore.getPendingCreateIds(), []);
    assert.equal(quotaStore.getQuotaView().used, 3, '确认创建后服务端已计数，净展示不变');
  });

  test('confirmDelete 让展示用量回落', async () => {
    nextRes = quota('trial', 3, 3);
    await quotaStore.refreshQuota();
    quotaStore.confirmDelete();
    assert.equal(quotaStore.getQuotaView().used, 2);
    assert.equal(quotaStore.canCreate(false), 'allow', '删板腾位后应可再建');
  });

  test('401 → 回退无快照', async () => {
    nextRes = quota('trial', 2, 3);
    await quotaStore.refreshQuota();
    nextRes = { status: 401 };
    await quotaStore.refreshQuota();
    assert.equal(quotaStore.getQuotaSnapshot(), null);
  });
});
