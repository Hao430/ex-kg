/**
 * 画板编辑锁（ADR-0025 配套，技术债 #0097）：同一浏览器同一时刻只允许**一个标签页**编辑同一块画板。
 *
 * 为什么需要：画板 blob、服务端版本小键、节点级差分基线与同步队列都是 **localStorage 共享、
 * 不按标签隔离**，而两个标签的内存状态各自独立。于是出现两条互相破坏的路径：
 * 1. 后写的标签用自己内存里的整块板覆盖共享 blob（抹掉另一标签刚保存的节点）；
 * 2. 基线被另一标签推进后，本标签按新基线做差分，会把自己「没见过」的节点判成本地删除
 *    → 在服务端**真删掉**对方的内容。
 *
 * 选型：**单写者锁**（而不是跨标签合并/按标签隔离存储）。理由：这是唯一能把上面两条路径
 * 一起消掉、且不引入新状态模型的做法；代价（第二个标签不能编辑该板）与 ADR-0021 已接受的
 * 「无网不可编辑」同一性质——宁可明确不可编辑，也不要静默互相覆盖。
 *
 * 协议（单频道 + 按 boardId 过滤）：
 * - 进入某画板时发 `claim`；**tabId 字典序小者胜**，双方各自按同一规则收敛，无需协商；
 * - 持有者每 `heartbeatMs` 广播一次 `claim` 作为心跳；非持有者超过 `leaseMs` 没收到任何
 *   对方消息，就认为对方标签已关闭，自己接管（浏览器直接杀标签时没有 `release` 可发）；
 * - 用户显式「在此标签页继续编辑」→ 发 `force: true` 的 `claim`，持有者无条件让出
 *   （这是用户意图，不是竞态，不再比 tabId）；
 * - 收到 `release` 且当前无主 → 立即 `claim`，避免出现「两个标签都只读」的空档。
 *
 * 依赖注入（channel 工厂 / 时钟 / 周期）是为了可测：两个实例共用一个假频道即可模拟两个标签。
 */

export interface LockMessage {
  type: 'claim' | 'release';
  boardId: string;
  tabId: string;
  /** 用户显式接管：持有者无条件让出 */
  force?: boolean;
  ts: number;
}

/** 只用到 BroadcastChannel 的这三个成员，便于测试替换 */
export interface LockChannel {
  postMessage(message: LockMessage): void;
  close(): void;
  onmessage: ((ev: { data: LockMessage }) => void) | null;
}

export type LockListener = (isOwner: boolean) => void;

export interface BoardEditLockDeps {
  /** 标签标识；缺省随机生成（同一标签内稳定） */
  tabId?: string;
  channelFactory?: (name: string) => LockChannel | null;
  now?: () => number;
  heartbeatMs?: number;
  leaseMs?: number;
}

export interface BoardEditLock {
  /** 进入某画板：释放上一块、尝试占有这一块。同一 boardId 重复调用是 no-op */
  acquire(boardId: string): void;
  /** 离开画板（切走/卸载）：让出 */
  release(): void;
  /** 用户显式接管（另一个标签会收到 force 让出） */
  takeOver(): void;
  isOwner(): boolean;
  currentBoardId(): string | null;
  subscribe(cb: LockListener): () => void;
  dispose(): void;
}

export const EDIT_LOCK_CHANNEL_NAME = 'deepdive_board_edit_lock';

/** 心跳与租约缺省值：心跳 2s、租约 5s（容忍一次丢帧 + 调度抖动） */
const DEFAULT_HEARTBEAT_MS = 2000;
const DEFAULT_LEASE_MS = 5000;

function randomTabId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* ignore */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 环境缺 BroadcastChannel（老 Safari/测试环境）→ 返回 null，调用方退化为「永远持有」 */
function defaultChannelFactory(name: string): LockChannel | null {
  const Ctor = (globalThis as any).BroadcastChannel;
  if (typeof Ctor !== 'function') return null;
  try {
    return new Ctor(name) as LockChannel;
  } catch {
    return null;
  }
}

export function createBoardEditLock(deps: BoardEditLockDeps = {}): BoardEditLock {
  const tabId = deps.tabId ?? randomTabId();
  const now = deps.now ?? (() => Date.now());
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const channelFactory = deps.channelFactory ?? defaultChannelFactory;

  let channel: LockChannel | null = null;
  let channelReady = false;
  let boardId: string | null = null;
  let owner = false;
  let peerTabId: string | null = null;
  let lastPeerAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<LockListener>();

  function notify(): void {
    for (const cb of listeners) {
      try {
        cb(owner);
      } catch {
        /* 监听者异常不得影响锁本身 */
      }
    }
  }

  function setOwner(next: boolean): void {
    if (owner === next) return;
    owner = next;
    if (owner) peerTabId = null;
    notify();
  }

  function ensureChannel(): void {
    if (channelReady) return;
    channelReady = true;
    channel = channelFactory(EDIT_LOCK_CHANNEL_NAME);
    if (channel) channel.onmessage = (ev) => onMessage(ev?.data);
  }

  function post(type: LockMessage['type'], force?: boolean, target: string | null = boardId): void {
    if (!target || !channel) return;
    try {
      channel.postMessage({ type, boardId: target, tabId, force, ts: now() });
    } catch {
      /* 频道被关闭：锁退化为本标签独占，不影响编辑 */
    }
  }

  function onMessage(msg: LockMessage | undefined): void {
    if (!msg || !boardId || msg.boardId !== boardId) return;
    if (msg.tabId === tabId) return; // 自己的回声（部分实现会回投）
    lastPeerAt = now();

    if (msg.type === 'release') {
      // 无主了：立刻占上，避免两个标签都只读
      if (!owner) {
        setOwner(true);
        post('claim');
      }
      return;
    }

    // claim：
    if (msg.force) {
      // 用户显式接管：无条件让出，并把对方记为当前持有者
      peerTabId = msg.tabId;
      setOwner(false);
      return;
    }
    peerTabId = msg.tabId;
    if (owner) {
      // 我持有：tabId 小的胜。对方更小 → 让出；我更小 → 重申（对方会按同一规则让出）
      if (msg.tabId < tabId) setOwner(false);
      else post('claim');
      return;
    }
    // 我不持有：若我 tabId 更小，说明对面那个不比我小，收敛到最小的那个
    if (msg.tabId > tabId) {
      setOwner(true);
      post('claim');
    }
  }

  function startTimer(): void {
    if (timer !== null) return;
    timer = setInterval(() => {
      if (!boardId) return;
      if (owner) {
        post('claim'); // 心跳
        return;
      }
      // 非持有者：租约超时说明持有者标签已消失（没有 release 可发），接管
      if (lastPeerAt === 0 || now() - lastPeerAt > leaseMs) {
        setOwner(true);
        post('claim');
      }
    }, heartbeatMs);
  }

  function stopTimer(): void {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  function onPageHide(): void {
    release();
  }

  function attachUnloadListener(): void {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    window.addEventListener('pagehide', onPageHide);
  }
  function detachUnloadListener(): void {
    if (typeof window === 'undefined' || typeof window.removeEventListener !== 'function') return;
    window.removeEventListener('pagehide', onPageHide);
  }

  function release(): void {
    const leaving = boardId;
    if (!leaving) return;
    // ⚠️ 先清本地状态再广播：对方收到 release 会立刻 claim，那条 claim 会被同步回投给我；
    // 若此时我仍认为「我在这块板上且还是持有者」，就会重申 claim 把对方刚拿到的锁打掉，
    // 两边一起退回「都不是持有者」的空档。boardId 清空后，回投的 claim 会被首行直接忽略。
    const wasOwner = owner;
    boardId = null;
    owner = false;
    peerTabId = null;
    lastPeerAt = 0;
    stopTimer();
    post('release', undefined, leaving);
    if (wasOwner) notify();
  }

  return {
    acquire(nextBoardId: string): void {
      if (boardId === nextBoardId) return;
      ensureChannel();
      if (boardId) this.release();
      boardId = nextBoardId;
      peerTabId = null;
      lastPeerAt = 0;
      // 乐观持有（本标签是唯一在编辑的），竞争者会用 claim 把它纠正过来
      owner = false;
      setOwner(true);
      post('claim');
      startTimer();
      attachUnloadListener();
    },
    release(): void {
      detachUnloadListener();
      release();
    },
    takeOver(): void {
      if (!boardId) return;
      setOwner(true);
      post('claim', true);
      startTimer();
    },
    isOwner(): boolean {
      return owner;
    },
    currentBoardId(): string | null {
      return boardId;
    },
    subscribe(cb: LockListener): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    dispose(): void {
      detachUnloadListener();
      release();
      stopTimer();
      if (channel) {
        channel.onmessage = null;
        try {
          channel.close();
        } catch {
          /* ignore */
        }
      }
      channel = null;
      channelReady = false;
      listeners.clear();
    },
  };
}

// ---- 应用单例（App 全程只锁「当前打开的这块板」）----
let singleton: BoardEditLock | null = null;

export function getBoardEditLock(): BoardEditLock {
  if (!singleton) singleton = createBoardEditLock();
  return singleton;
}

/** 仅供测试：丢弃单例（含频道与定时器） */
export function resetBoardEditLockForTest(): void {
  if (singleton) singleton.dispose();
  singleton = null;
}
