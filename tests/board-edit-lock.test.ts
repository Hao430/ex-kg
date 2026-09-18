/**
 * 多标签画板编辑锁（`src/lib/board-edit-lock.ts`，技术债 #0097）。
 *
 * 用两个实例 + 一个共享的假频道模拟「同一浏览器的两个标签」。断言的核心不变量是
 * **同一块画板任何时刻至多一个持有者**，且各种进入方式（同时申请、显式接管、对方让出、
 * 对方标签消失）都能收敛到唯一持有者——否则两个标签会同时写同一份本地存储并互相删内容。
 *
 * 注意：模块内部有心跳定时器（正是它让「对方标签被系统杀掉」也能自愈），所以每个用例
 * 结束必须 `dispose()`，否则进程不会退出。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBoardEditLock,
  type BoardEditLock,
  type LockChannel,
  type LockMessage,
} from '../src/lib/board-edit-lock.ts';

class FakeBus {
  channels: FakeChannel[] = [];
  readonly factory = (name: string): LockChannel => new FakeChannel(this, name);
  deliver(from: FakeChannel, msg: LockMessage): void {
    for (const c of [...this.channels]) {
      if (c !== from) c.onmessage?.({ data: msg });
    }
  }
}
class FakeChannel implements LockChannel {
  onmessage: ((ev: { data: LockMessage }) => void) | null = null;
  constructor(private bus: FakeBus, public name: string) {
    bus.channels.push(this);
  }
  postMessage(msg: LockMessage): void {
    this.bus.deliver(this, msg);
  }
  close(): void {
    this.bus.channels = this.bus.channels.filter((c) => c !== this);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 显式 tabId：字典序小者胜，测试要能精确预期谁赢 */
function twoTabs(bus: FakeBus, tabA: string, tabB: string, heartbeatMs = 1000, leaseMs = 3000) {
  const a = createBoardEditLock({ tabId: tabA, channelFactory: bus.factory, heartbeatMs, leaseMs });
  const b = createBoardEditLock({ tabId: tabB, channelFactory: bus.factory, heartbeatMs, leaseMs });
  return { a, b };
}

const BOARD = 'board-1';

describe('多标签画板编辑锁', () => {
  test('单独一个标签：申请即持有，release 后不再持有', (t) => {
    const bus = new FakeBus();
    const { a } = twoTabs(bus, 'aaa', 'zzz');
    t.after(() => a.dispose());
    a.acquire(BOARD);
    assert.equal(a.isOwner(), true);
    assert.equal(a.currentBoardId(), BOARD);
    a.release();
    assert.equal(a.isOwner(), false);
    assert.equal(a.currentBoardId(), null);
  });

  test('两个标签先后打开同一画板 → 只有 tabId 小的那个持有', (t) => {
    const bus = new FakeBus();
    const { a, b } = twoTabs(bus, 'aaa', 'zzz');
    t.after(() => {
      a.dispose();
      b.dispose();
    });
    a.acquire(BOARD);
    assert.equal(a.isOwner(), true);

    b.acquire(BOARD); // 乐观持有后会被对方的 claim 纠正

    assert.equal(a.isOwner(), true, 'tabId 小的持有');
    assert.equal(b.isOwner(), false, 'tabId 大的让出');
  });

  test('顺序反过来（先打开的是大 tabId）→ 后打开的小 tabId 胜出', (t) => {
    const bus = new FakeBus();
    const { a, b } = twoTabs(bus, 'zzz', 'aaa');
    t.after(() => {
      a.dispose();
      b.dispose();
    });
    a.acquire(BOARD);
    assert.equal(a.isOwner(), true);

    b.acquire(BOARD);

    assert.equal(b.isOwner(), true, 'smaller tabId wins，与打开顺序无关');
    assert.equal(a.isOwner(), false);
  });

  test('显式接管：非持有者 force 接管后，原持有者让出', (t) => {
    const bus = new FakeBus();
    const { a, b } = twoTabs(bus, 'aaa', 'zzz');
    t.after(() => {
      a.dispose();
      b.dispose();
    });
    a.acquire(BOARD);
    b.acquire(BOARD);
    assert.equal(a.isOwner(), true);

    b.takeOver(); // 用户点「在此标签页继续编辑」

    assert.equal(b.isOwner(), true, '接管是用户意图，不再比 tabId');
    assert.equal(a.isOwner(), false);
  });

  test('持有者让出（切走/关标签）→ 等待中的标签自动接手，不留空档', (t) => {
    const bus = new FakeBus();
    const { a, b } = twoTabs(bus, 'aaa', 'zzz');
    t.after(() => {
      a.dispose();
      b.dispose();
    });
    a.acquire(BOARD);
    b.acquire(BOARD);
    assert.equal(b.isOwner(), false);

    a.release();

    assert.equal(b.isOwner(), true, '不能出现两个标签都只读的空档');
  });

  test('持有者标签直接消失（没有 release）→ 租约过期后由等待者接管', async (t) => {
    const bus = new FakeBus();
    // 心跳/租约放小，便于在测试里等到过期
    const { a, b } = twoTabs(bus, 'aaa', 'zzz', 10, 25);
    t.after(() => {
      a.dispose();
      b.dispose();
    });
    a.acquire(BOARD);
    const aChannel = bus.channels[bus.channels.length - 1] as FakeChannel;
    assert.ok(aChannel);

    b.acquire(BOARD);
    assert.equal(b.isOwner(), false, '前置：b 已被 a 的 claim 说服让出');

    // a 的标签被系统杀掉：收不到也发不出（不是「关标签」那样还能发 release）。
    // 只清 onmessage 不够——它的心跳仍会送到 b，反而把租约一直续上。
    aChannel.onmessage = null;
    (aChannel as unknown as { postMessage: () => void }).postMessage = () => {};
    await sleep(80);

    assert.equal(b.isOwner(), true, '租约过期 = 对方标签已消失，必须能接管');
  });

  test('频道不可用（老浏览器）→ 退化为始终持有，不抛错', (t) => {
    const lock: BoardEditLock = createBoardEditLock({ tabId: 'solo', channelFactory: () => null });
    t.after(() => lock.dispose());
    assert.doesNotThrow(() => lock.acquire(BOARD));
    assert.equal(lock.isOwner(), true, '没有频道就不能因为「抢不到锁」把用户挡在外面');
  });

  test('切画板：释放上一块、申请下一块；不同画板互不干扰', (t) => {
    const bus = new FakeBus();
    const { a, b } = twoTabs(bus, 'aaa', 'zzz');
    t.after(() => {
      a.dispose();
      b.dispose();
    });
    a.acquire('board-1');
    b.acquire('board-2');
    assert.equal(a.isOwner(), true);
    assert.equal(b.isOwner(), true, '不同画板互不干扰');

    b.acquire('board-1'); // b 切到 a 正在编辑的那块
    assert.equal(a.isOwner(), true);
    assert.equal(b.isOwner(), false);
    assert.equal(b.currentBoardId(), 'board-1');
  });

  test('订阅能收到持有权变化（App 靠它切到只读闸门）', (t) => {
    const bus = new FakeBus();
    const { a, b } = twoTabs(bus, 'aaa', 'zzz');
    t.after(() => {
      a.dispose();
      b.dispose();
    });
    const seen: boolean[] = [];
    const off = b.subscribe((owner) => seen.push(owner));

    a.acquire(BOARD);
    b.acquire(BOARD);
    b.takeOver();

    assert.deepEqual(seen, [true, false, true], '乐观持有 → 让出 → 接管');
    off();
    a.release();
    assert.equal(seen.length, 3, '退订后不再回调');
  });
});
