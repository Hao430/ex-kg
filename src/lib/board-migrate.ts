/**
 * 阶段 5b：旧共享默认板（`default-board`）的存量内容再落位（ADR-0018）。
 *
 * 服务端翻 `SAVE_DEFAULT_BOARD_MODE=private` 后，`default-board` 退化为「首个认领者的普通画板」：
 * 对其他人那一行不再可读（GET 404）、也不可写（save 403）。而本地绘制缓存里那份内容，此刻往往
 * 是用户自己画的东西**唯一剩下的副本**（共享行已读不到）——不能默默丢。于是整份搬到一块自己的
 * 新画板（新 uuidv7 id）并排队上传，再把旧条目从本地列表摘掉。
 *
 * 触发条件刻意收得很紧，只有「服务端**明确拒绝**访问且本地确有用户内容」才搬：
 * - 服务端仍可读（legacy 共享期、或自己就是认领者）→ 什么都不做；否则会把共享板复制成一堆副本；
 * - 离线 / 5xx / 401 → 一律不打标记，下次启动重试（401 是会话失效，不是「这行不属于我」的证据）；
 * - 只有引导态（一棵待填写的主题根节点）→ 没有内容可搬，也不该白得一块空板。
 *
 * 幂等：按账号一次性标记（成功才置位）；同一账号并发调用共享同一个 Promise，StrictMode 双跑
 * 不会搬出两块板。发布顺序要求客户端先行（见 ADR-0018）：本模块在 legacy 服务端上是空操作。
 */
import type { StoredBoard } from './storage';
import { loadBoard, saveBoard } from './storage';
import * as boardScope from './board-scope';
import * as boardStore from './board-store';
import * as quotaStore from './quota-store';
import { uuidv7 } from './uuid';

/** 服务端对该画板的可达性：ok=可读；denied=明确拒绝（404/403）；unknown=没问出来，不代表任何结论 */
export type BoardAccess = 'ok' | 'denied' | 'unknown';

export interface RehomeOutcome {
  /**
   * - `migrated`：旧板的内容已搬进新板（`newBoardId`）
   * - `dropped`：列表里挂着但本地没内容，直接摘掉即可（调用方给用户一块新画布）
   * - `skipped`：什么都没做（见 reason）
   */
  status: 'migrated' | 'dropped' | 'skipped';
  reason?:
    | 'guest'
    | 'already-migrated'
    | 'server-reachable'
    | 'not-listed'
    | 'unknown-access'
    | 'copy-failed';
  /** status === 'migrated' 时给出新板 id */
  newBoardId?: string;
}

export interface RehomeDeps {
  /** 可达性探针（测试注入；默认真发一次 GET） */
  probe?: (boardId: string) => Promise<BoardAccess>;
  /** 新板 id 生成（测试注入，便于断言） */
  generateId?: () => string;
  /** 本地内容读写（测试注入；默认走 storage 的真实 blob 路径） */
  load?: (boardId: string) => StoredBoard | null;
  save?: (board: StoredBoard) => void;
}

/**
 * 默认探针：只读一次「能不能访问」，不落盘、不碰绘制缓存（这正是与 fetchBoardFromServer 的区别
 * ——后者成功即把服务端内容写进本地缓存，而我们在判定「要不要搬本地那份」前不能先覆盖它）。
 */
export async function probeBoardAccess(boardId: string): Promise<BoardAccess> {
  if (typeof fetch !== 'function') return 'unknown';
  try {
    const res = await fetch(`/api/canvases/${encodeURIComponent(boardId)}`, {
      credentials: 'include',
    });
    if (res.ok) return 'ok';
    // 404 = 这行不存在或不属于我；403 = 存在但拒绝——私有化后两者都是「不是我的板」
    if (res.status === 404 || res.status === 403) return 'denied';
    // 401（会话失效）/5xx/429：都不是「这行不属于我」的证据
    return 'unknown';
  } catch {
    return 'unknown'; // 离线 / 请求被拦截
  }
}

/**
 * 是否值得搬走的「用户内容」：**引导态不算**。
 * 新板只有一棵待填写的主题根节点（question/answer 皆空、无对话、无记事文本），把它搬过去只会让
 * 从没画过东西的用户在 cutover 时白得一块空板。
 */
export function hasUserContent(board: StoredBoard | null | undefined): boolean {
  const nodes = (board?.nodes ?? []) as any[];
  if (nodes.length === 0) return false;
  if (nodes.length > 1) return true; // 多于一棵根节点 = 用户加过东西
  const data = nodes[0]?.data ?? {};
  const hasText = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;
  if (hasText(data.question) || hasText(data.answer) || hasText(data.text)) return true;
  if (hasText(data.branchTriggerPhrase)) return true;
  const messages = Array.isArray(data.messages) ? data.messages : [];
  return messages.some((m: any) => hasText(m?.content));
}

const inFlight = new Map<string, Promise<RehomeOutcome>>();

/**
 * 旧共享默认板存量迁移：服务端明确不可访问且本地确有用户内容时，落成一块自己的新板。
 * 幂等（按账号一次性标记），并发调用共享同一 Promise。
 */
export function rehomeLegacyDefaultBoard(
  userId: string,
  deps: RehomeDeps = {}
): Promise<RehomeOutcome> {
  const running = inFlight.get(userId);
  if (running) return running;
  const run = doRehome(userId, deps).finally(() => inFlight.delete(userId));
  inFlight.set(userId, run);
  return run;
}

async function doRehome(userId: string, deps: RehomeDeps): Promise<RehomeOutcome> {
  const probe = deps.probe ?? probeBoardAccess;
  const generateId = deps.generateId ?? uuidv7;
  const load = deps.load ?? loadBoard;
  const save = deps.save ?? saveBoard;
  const legacyId = boardScope.LEGACY_DEFAULT_BOARD_ID;

  if (!userId || boardScope.scopeKeyFor(userId) === 'guest') {
    return { status: 'skipped', reason: 'guest' }; // 游客没有服务端账号可判定，不搬
  }
  if (boardScope.isDefaultBoardMigrated(userId)) {
    return { status: 'skipped', reason: 'already-migrated' };
  }

  const access = await probe(legacyId);
  if (access === 'unknown') {
    return { status: 'skipped', reason: 'unknown-access' }; // 不打标记：下次启动再问
  }
  if (access === 'ok') {
    // 服务端仍能读到这行（legacy 共享期 / 自己就是认领者）：本地那份只是绘制缓存，不搬
    boardScope.markDefaultBoardMigrated(userId);
    return { status: 'skipped', reason: 'server-reachable' };
  }

  // 到这一步说明服务端明确拒绝，且用户已经登录；此刻才读本地内容（越晚读越新）
  const cached = load(legacyId);
  const listed = boardStore.getBoardList().some((b) => b.id === legacyId);
  if (!listed) {
    // 本账号列表里根本没有它：本地那份 blob 可能只是**同浏览器上一个账号**留下的绘制缓存
    // （内容 blob 按画板 id 全局存放、不随 scope 隔离），不能当成本账号的内容搬走。
    boardScope.markDefaultBoardMigrated(userId);
    return { status: 'skipped', reason: 'not-listed' };
  }

  if (hasUserContent(cached)) {
    const newBoardId = generateId();
    const moved: StoredBoard = {
      ...(cached as StoredBoard),
      id: newBoardId,
      updatedAt: Date.now(),
      // 版本号是**旧板**（共享行）的，绝不能带给新板：带着它首次保存会拿别人的版本当乐观锁，
      // 而且会让 seedBase 误以为服务端已有这块板。
      serverUpdatedAt: undefined,
    };
    save(moved); // 写 blob + 标脏 + 入上传队列（storage.saveBoard）

    const copied = load(newBoardId);
    if (!copied || copied.nodes.length !== moved.nodes.length) {
      // 复制没落地（配额/隐私模式）：源内容一个字都不动，标记也不打，下次启动重试
      boardStore.dropLocalEntry(newBoardId);
      return { status: 'skipped', reason: 'copy-failed' };
    }

    quotaStore.markPendingCreate(newBoardId);
    // 旧条目已不属于本账号：摘掉它（含 blob），否则列表里会一直挂着一条读写都 404/403 的板
    boardStore.dropLocalEntry(legacyId);
    boardScope.markDefaultBoardMigrated(userId);
    return { status: 'migrated', newBoardId };
  }

  // 列表里挂着、但本地只剩引导态：没有内容要带走，摘掉这条旧引用即可（调用方给用户一块新画布）
  boardStore.dropLocalEntry(legacyId);
  boardScope.markDefaultBoardMigrated(userId);
  return { status: 'dropped' };
}
