/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ReactFlowProvider, Node, Edge } from '@xyflow/react';
import { Topbar } from './components/ui/Topbar';
import { Toast } from './components/ui/base/Toast';
import { BoardLockedNotice } from './components/ui/BoardLockedNotice';
import { DeepDiveCanvas } from './components/canvas/DeepDiveCanvas';
import { LandingPage } from './components/landing/LandingPage';
import {
  loadBoard,
  saveBoard,
  deleteBoardLocally,
  updateBoardMetaLocally,
  exportBoardToJson,
  exportBoardToMarkdown,
  fetchBoardFromServer,
  fetchBoardListFromServer,
  StoredBoard,
} from './lib/storage';
import { exportCanvasAsPng } from './lib/canvas-image-export';
import { ChatNodeData } from './types';
import { onSyncState } from './lib/sync-queue';
import * as boardStore from './lib/board-store';
import * as boardScope from './lib/board-scope';
import * as boardMigrate from './lib/board-migrate';
import * as quotaStore from './lib/quota-store';
import {
  resolveInitialLocation,
  resolvePopLocation,
  practiceDetailHref,
  PRACTICE_LIST_HREF,
  CANVAS_HREF,
  HOME_HREF,
} from './lib/practice-route';
import * as syncQueue from './lib/sync-queue';
import * as folderStore from './lib/folder-store';
import { useBoards, useFolders } from './hooks/useBoards';
import { useTheme } from './hooks/useTheme';
import { useConfirmDialog } from './hooks/useConfirmDialog';
import { extractErrorMessage } from './lib/api';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ModalProvider, useModal } from './context/ModalContext';
import { trackEvent } from './lib/analytics';
import { getBoardEditLock } from './lib/board-edit-lock';
import { markChecklistStep } from './lib/checklist';
import {
  isShareCloned,
  markShareCloned,
  peekCloneIntent,
  takeCloneFreshFlag,
  takeCloneIntent,
} from './lib/share-clone';
import { remapBoardIds } from './lib/board-remap';
import { uuidv7 } from './lib/uuid.js';
import { SampleBoardViewer } from './components/sample/SampleBoardViewer';
import { ShareLinkModal } from './components/ui/ShareLinkModal';
import { StarterChecklist } from './components/canvas/StarterChecklist';
import { AuthModal } from './components/auth/AuthModal';
import { RechargeModal } from './components/ui/RechargeModal';
import { AdminDashboardModal } from './components/admin/AdminDashboardModal';
import { UserProfileModal } from './components/ui/UserProfileModal';
import { MySharesModal } from './components/ui/MySharesModal';
import { FeedbackModal } from './components/ui/FeedbackModal';
import { BoardLibraryModal } from './components/ui/BoardLibraryModal';
import { PracticeWorkspace } from './components/practice/PracticeWorkspace';
import { useAppModals } from './hooks/useAppModals';

/**
 * 新画布引导（H2）：注入一个待填写的主题根节点，避免新用户/新建画板面对纯空白画布。
 * 节点 question 为空 → ChatCardNode 渲染首个提问表单（「输入你想探索的议题」+ 推荐议题 pills），
 * 与 Topbar「添加主题节点」（DeepDiveCanvas.handleAddRootNode）的空根卡形态一致。
 */
function createStarterRootNode(): Node[] {
  return [
    {
      id: uuidv7(),
      type: 'chat',
      position: { x: 120, y: 160 },
      draggable: false,
      data: {
        title: '新探索主题',
        depth: 0,
        question: '',
        answer: '',
        status: 'idle',
        model: '',
      },
    },
  ];
}

/** 自动命名：视为「默认名」的画板名（命中才允许 LLM 自动命名，之后永不覆盖） */
const DEFAULT_BOARD_NAMES = ['未命名思维画布', '未命名思维探索', '新建思维画布'];
const isDefaultBoardName = (name: string): boolean =>
  DEFAULT_BOARD_NAMES.includes(name) || /^探索课题 #\d+$/.test(name);

function MainApp() {
  const [initialLocation] = useState(() => {
    let storedView: string | null = null;
    try {
      storedView = sessionStorage.getItem('deepdive_active_view');
    } catch (e) {
      // ignore
    }
    return resolveInitialLocation(window.location.pathname, window.location.search, storedView);
  });
  const [viewMode, setViewMode] = useState<'landing' | 'canvas' | 'practice'>(initialLocation.view);
  const [practiceAttemptId, setPracticeAttemptId] = useState<string | null>(initialLocation.attemptId);

  // 浏览器前进/后退：只信当前 URL，不读 sessionStorage（否则后退到 / 会被残留产品拦住）
  useEffect(() => {
    const onPopState = () => {
      const loc = resolvePopLocation(window.location.pathname, window.location.search);
      setViewMode(loc.view);
      setPracticeAttemptId(loc.attemptId);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const boards = useBoards();
  const foldersView = useFolders();
  const [currentBoardId, setCurrentBoardId] = useState<string>(''); // boot 时由 applyLoadedBoard 落定
  const [boardName, setBoardName] = useState<string>('量子计算深度探索');
  const [initialNodes, setInitialNodes] = useState<Node[] | undefined>(undefined);
  const [initialEdges, setInitialEdges] = useState<Edge[] | undefined>(undefined);
  const {
    sampleViewerOpen,
    setSampleViewerOpen,
    libraryOpen,
    setLibraryOpen,
    shareDialog,
    setShareDialog,
    toastMessage,
    showToast,
  } = useAppModals();
  const [nodeCount, setNodeCount] = useState<number>(1);
  /**
   * 本标签是否持有当前画板的编辑权（技术债 #0097）。false = 同一块画板已在另一个标签页打开，
   * 此标签**不渲染编辑画布**——两个标签共享同一份本地存储，同时编辑会互相覆盖，更糟的是会
   * 把对方刚保存的节点误判成「本地删除」并在云端真删掉。
   */
  const [boardEditOwner, setBoardEditOwner] = useState(true);

  const { isVip, user, resendVerification, loading: authLoading } = useAuth();
  const { openRechargeModal } = useModal();
  // Promise 化确认框（替代 window.confirm）；element 挂在 JSX 根部
  const { confirm: confirmAction, element: confirmElement } = useConfirmDialog();

  // Unified Dark Mode hook ('light' | 'dark')
  const { theme, toggleTheme } = useTheme({
    onToggleNotice: (next) => {
      showToast(next === 'dark' ? '已开启深色模式 · 适配深夜深度思考' : '已切换为明亮模式');
    },
  });

  // Spec Q1：探索灵感开关是**画板级**属性，**服务端唯一真源**（`canvases.suggestions_enabled`
  // 经 PATCH /api/canvases/:id/meta 读写，与 isFavorite/isArchived/folderId 同一条 meta 通道）。
  // 本地列表只是绘制缓存/待确认投影（#0082 云优先口径），不得另立本地偏好裁决——
  // 否则同一块板在两台设备上会各记各的，正是本项目明令避免的本地/服务端分叉。
  const currentBoardMeta = useMemo(
    () => boards.find((b) => b.id === currentBoardId),
    [boards, currentBoardId]
  );
  const suggestionsEnabled = currentBoardMeta?.suggestionsEnabled ?? true;
  /** 共享默认画板（legacy）不支持画板级个性化设置：服务端 PATCH 会 403，故前置禁用开关 */
  const currentBoardIsShared = currentBoardMeta?.isShared === true;
  /** Spec Q1：关闭方向的命令桥（需先确认+清理，可能有副作用），由画布侧赋值 */
  const requestDisableSuggestionsRef = useRef<(() => void) | null>(null);

  /** 画布确认清理完成后回调：经 meta 通道落服务端 + 提示（cleanedCount 为实际清理数） */
  const handleSuggestionsDisabled = useCallback(
    (cleanedCount: number) => {
      if (!currentBoardId) return;
      updateBoardMetaLocally(currentBoardId, { suggestionsEnabled: false });
      showToast(cleanedCount > 0 ? `已清理 ${cleanedCount} 个灵感节点` : '已关闭探索灵感');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentBoardId]
  );

  // Trigger refs for Canvas actions
  const triggerAutoLayoutRef = useRef<(() => void) | null>(null);
  const triggerFitViewRef = useRef<(() => void) | null>(null);
  const triggerAddRootRef = useRef<(() => void) | null>(null);
  const triggerAddNoteRef = useRef<(() => void) | null>(null);
  /** 节点搜索结果跳转：Topbar 搜索浮层点击结果 → 画布聚焦并高亮该节点 */
  const triggerFocusNodeRef = useRef<((nodeId: string) => void) | null>(null);
  const triggerExportPngRef = useRef<
    ((title: string) => Promise<{ ok: boolean; error?: string }>) | null
  >(null);

  const handleShareLink = async () => {
    try {
      const res = await fetch(`/api/canvases/${encodeURIComponent(currentBoardId)}/share`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        showToast(await extractErrorMessage(res, '分享创建失败，请重试'));
        return;
      }
      const body = await res.json().catch(() => null);
      if (body?.shareCode) {
        setShareDialog({ url: String(body.url), recreated: Boolean(body.recreated) });
      } else {
        showToast('分享创建失败，请重试');
      }
    } catch {
      showToast('网络异常，分享创建失败');
    }
  };

  const handleRevokeShare = async () => {
    try {
      const res = await fetch(`/api/canvases/${encodeURIComponent(currentBoardId)}/share`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (res.ok) {
        setShareDialog(null);
        showToast('已停止分享，原链接即刻失效');
      } else {
        showToast(await extractErrorMessage(res, '停止分享失败，请重试'));
      }
    } catch {
      showToast('网络异常，操作失败');
    }
  };

  const currentNodesRef = useRef<Node[]>([]);
  const currentEdgesRef = useRef<Edge[]>([]);
  const saveTimeoutRef = useRef<number | null>(null);

  /**
   * Spec Q1：灵感开关分方向处理。
   * 开方向无副作用，直接经 meta 通道置 true；关方向有副作用（清理占位、不可恢复），
   * 交给画布先确认再执行——用户取消则开关保持开启，零改动。
   * 共享默认画板（legacy）服务端 PATCH 会 403，开关在前端即禁用（见 Topbar）。
   */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const toggleSuggestions = useCallback(() => {
    if (!currentBoardId || currentBoardIsShared) return;
    // 关闭方向会清理占位节点（= 删除）——非编辑权标签不得动手
    if (!boardEditOwner) {
      showToast('该画板正在另一个标签页中编辑，请先在此标签页点「继续编辑」');
      return;
    }
    if (!suggestionsEnabled) {
      updateBoardMetaLocally(currentBoardId, { suggestionsEnabled: true });
      showToast('已开启探索灵感：本画板之后的新回答会附带灵感节点');
      return;
    }
    requestDisableSuggestionsRef.current?.();
  }, [suggestionsEnabled, currentBoardId, currentBoardIsShared, boardEditOwner]);

  // 保存冲突提示（Spec A4 乐观锁）+ 同步状态订阅（Spec A5，仅指示当前画板）
  const [syncState, setSyncState] = useState<'idle' | 'saved' | 'pending' | 'error' | 'conflict'>('idle');
  /** 网络可达性：离线时「改动存不下」必须说出来（见下面的 unsavedDiscardRisk） */
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine !== false
  );
  const [boardReady, setBoardReady] = useState(false); // Spec A2：画布数据就绪前不挂载画布
  /**
   * 画布重挂载计数。`DeepDiveCanvas` 用 `useNodesState(initialNodes)` 取初值——**只在首次
   * 渲染读一次**，之后改 `initialNodes` 这个 prop 是空操作；重挂载又只由 `key` 变化触发，
   * 而 key 里的 `currentBoardId` 在「同一块画板重新播种内容」时并不变。所以必须把本计数
   * 并入 key，光换 initialNodes 没有用（换画板时 id 本身就变了，不依赖它）。
   */
  const [canvasEpoch, setCanvasEpoch] = useState(0);
  const currentBoardIdRef = useRef(currentBoardId);
  const boardNameRef = useRef(boardName);
  useEffect(() => {
    currentBoardIdRef.current = currentBoardId;
    boardNameRef.current = boardName;
  }, [currentBoardId, boardName]);
  /**
   * 立刻落盘当前画板「还没到防抖窗口」的改动（纯 ref 读取，故恒稳定）。
   *
   * 为什么必须显式收口：改动先落在 React state，600ms 后才写 blob 并入队。切换画板 /
   * 删除其他画板 / 页面隐藏都发生在窗口内时，那段改动**只存在于内存**，而「载入以服务端
   * 为准」（ADR-0025）会把没传上去的内容丢弃——等于直接丢内容。便签因为点击外部会触发
   * 失焦（走立即保存）侥幸安全，但没有失焦提交点的变更（最典型是 AI 流式回答）不保。
   *
   * 无待发改动（定时器已空）时 no-op，不会平白多写一次本地。
   */
  const flushPendingCanvasSave = useCallback(() => {
    if (saveTimeoutRef.current === null) return;
    window.clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = null;
    saveBoard({
      id: currentBoardIdRef.current,
      name: boardNameRef.current,
      updatedAt: Date.now(),
      nodes: currentNodesRef.current,
      edges: currentEdgesRef.current,
    });
  }, []);
  /**
   * 当前画板是否有未确认内容。`isDirty` 是 board-store 里那个「提示」（ADR-0025 后不再参与
   * 裁决），这里正是它的正当用途：告诉用户「有东西还没到云端」。
   */
  const currentBoardHasUnsynced = !!currentBoardId && boardStore.isDirty(currentBoardId);
  /**
   * 「改动会被丢」的风险态：离线 / 同步已停止重试 / 冲突待刷新。
   *
   * 为什么单列出来：ADR-0025 之后载入以服务端为准，**没传上去的改动会被丢弃**。正常在线时
   * 保存只是「稍后就好」，不值得打扰；但上面三种状态下，离开当前画板或刷新页面就是永久丢。
   */
  const unsavedDiscardRisk =
    currentBoardHasUnsynced && (!online || syncState === 'error' || syncState === 'conflict');
  const riskReason = !online
    ? '当前无网络'
    : syncState === 'conflict'
    ? '画板已在其他窗口被修改'
    : '同步已停止自动重试';
  /** 离开当前画板/导入/新建前拦一下；无风险时不弹，不打扰正常使用 */
  const confirmDiscardRisk = async (action: string): Promise<boolean> => {
    if (!unsavedDiscardRisk) return true;
    return confirmAction({
      title: `「${boardName}」有改动尚未保存到云端`,
      description: `${riskReason}。${action}后这些改动会丢失，仍要继续吗？`,
      confirmLabel: '仍要继续',
      tone: 'warning',
    });
  };
  // 风险态下刷新/关闭页面也要拦一下（浏览器原生确认框，不能自定义文案）
  useEffect(() => {
    if (!unsavedDiscardRisk) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [unsavedDiscardRisk]);

  // ---- 多标签编辑权（技术债 #0097）：同一块画板同时只允许一个标签编辑 ----
  useEffect(() => {
    const lock = getBoardEditLock();
    const off = lock.subscribe((owner) => {
      setBoardEditOwner(owner);
      // 让出编辑权时先把待发改动落盘：紧接着画布会被闸门替换掉（卸载），不 flush 就是丢内容
      if (!owner) flushPendingCanvasSave();
    });
    setBoardEditOwner(lock.isOwner());
    return off;
  }, [flushPendingCanvasSave]);

  // 切到哪块板就申请哪块板的编辑权（内部会先释放上一块）
  useEffect(() => {
    if (!currentBoardId) return;
    getBoardEditLock().acquire(currentBoardId);
  }, [currentBoardId]);

  // 卸载让出：心跳租约过期虽然也能自愈，但显式释放更快，不让另一个标签空等一轮
  useEffect(() => {
    const lock = getBoardEditLock();
    return () => lock.release();
  }, []);

  // 未持有编辑权时不保留画布触发桥：画布已卸载，refs 里剩的是上一轮的陈旧闭包
  useEffect(() => {
    if (boardEditOwner) return;
    triggerAutoLayoutRef.current = null;
    triggerFitViewRef.current = null;
    triggerAddRootRef.current = null;
    triggerAddNoteRef.current = null;
    triggerFocusNodeRef.current = null;
  }, [boardEditOwner]);

  /** 只有持有编辑权的标签才能改动当前画板；否则给出可操作的提示，而不是静默无反应 */
  const ensureEditable = (): boolean => {
    if (boardEditOwner) return true;
    showToast('该画板正在另一个标签页中编辑，请先在此标签页点「继续编辑」');
    return false;
  };

  /**
   * 在此标签页接管编辑权。⚠️ 顺序不能反：**先按服务端对齐，再拿锁**。
   * 上一个编辑者可能刚把它的改动传上去，我们手里的画面与差分基线是旧的；若先拿锁再对齐，
   * 中间那一次防抖保存会带着旧画面做差分，把对方的节点当成「本地删除」并在云端删掉。
   * 对齐期间拿不到编辑权，`handleCanvasChange` 直接返回，所以不会写入。
   */
  const handleTakeOverEdit = async () => {
    const id = currentBoardIdRef.current;
    if (!id) return;
    const loaded = await fetchBoardFromServer(id);
    if (loaded && currentBoardIdRef.current === id) applyLoadedBoard(loaded);
    getBoardEditLock().takeOver();
    showToast('已在此标签页继续编辑，另一个标签页转为只读');
  };

  // 冲突收敛后需要刷新当前画板画面；applyLoadedBoard 定义在组件靠后位置，
  // 用 ref 转一手，避免在 effect 依赖数组里引用它而踩 TDZ。
  const applyLoadedBoardRef = useRef<((board: StoredBoard) => void) | null>(null);
  const syncIdleTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const onConflict = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        boardId?: string;
        message?: string;
        code?: string;
      };
      // 配额/会员类：引导升级，草稿保留待升级后自动补传
      if (detail?.code === 'BOARD_LIMIT_REACHED' || detail?.code === 'VIP_EXPIRED') {
        openRechargeModal(detail?.message || '免费版画板额度已用完，升级 Pro 解锁无限画板');
        return;
      }
      if (detail?.code === 'NOT_FOUND') {
        showToast(detail?.message || '画板已在其他设备被删除');
        return;
      }
      if (detail?.code === 'UNAUTHORIZED') {
        showToast(detail?.message || '登录状态已失效，请重新登录');
        return;
      }
      // 旧协议客户端/服务端配置不一致时才会出现的 409：重发不会变好，提示刷新
      //（刷新即走「载入以服务端为准」的路径收敛，ADR-0025）。
      if (detail?.code === 'CLIENT_OUTDATED') {
        showToast(detail?.message || '画板已在其他窗口被修改，请刷新页面后重试');
        return;
      }
      showToast(detail?.message || '画板已在其他窗口被修改，请刷新后重试');
    };
    /**
     * 服务端以「跨板撞 id」（NODE_CANVAS_MISMATCH）拒收后，storage 层已就地重映射本板
     * 节点/边的 id（画板 id 不变，用户看到的还是同一块板、同一份内容）。内存里的画布还
     * 攥着旧 id，必须重新播种——否则下一次防抖保存会带着旧 id 打回来，再撞一次 → 又重
     * 映射一次，变成「重映射—保存」死循环。
     */
    const onIdsRemapped = (e: Event) => {
      const detail = (e as CustomEvent).detail as { boardId?: string };
      if (!detail?.boardId || detail.boardId !== currentBoardIdRef.current) return;
      if (saveTimeoutRef.current !== null) {
        window.clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      const reloaded = loadBoard(detail.boardId);
      if (reloaded) applyLoadedBoardRef.current?.(reloaded);
      showToast('画板此前与另一块画板标识冲突、存不上去；已自动重新编号并同步到云端');
    };
    const onRemoteDeleted = (e: Event) => {
      const detail = (e as CustomEvent).detail as { name?: string };
      showToast(`画板「${detail?.name || ''}」已在其他设备被删除`);
    };
    const offSync = onSyncState((state, boardId) => {
      if (boardId !== currentBoardIdRef.current) return;
      if (syncIdleTimerRef.current !== null) {
        clearTimeout(syncIdleTimerRef.current);
        syncIdleTimerRef.current = null;
      }
      setSyncState(state);
      if (state === 'error') {
        // 慢速自愈入口只 emit 一次，不会刷屏；这句是「改动没存上」的唯一显式告知
        showToast('有改动尚未保存到云端，请检查网络后重试');
      }
      if (state === 'saved') {
        syncIdleTimerRef.current = window.setTimeout(() => setSyncState('idle'), 3000);
      }
    });
    const onPersistFailed = () => {
      showToast('本地保存失败：浏览器存储空间不足或被禁用，请勿关闭页面');
    };
    window.addEventListener('deepdive:canvas-save-conflict', onConflict);
    window.addEventListener('deepdive:board-ids-remapped', onIdsRemapped);
    window.addEventListener('deepdive:board-remote-deleted', onRemoteDeleted);
    window.addEventListener('deepdive:local-persist-failed', onPersistFailed);
    return () => {
      window.removeEventListener('deepdive:canvas-save-conflict', onConflict);
      window.removeEventListener('deepdive:board-ids-remapped', onIdsRemapped);
      window.removeEventListener('deepdive:board-remote-deleted', onRemoteDeleted);
      window.removeEventListener('deepdive:local-persist-failed', onPersistFailed);
      offSync();
      if (syncIdleTimerRef.current !== null) clearTimeout(syncIdleTimerRef.current);
    };
  }, []);

  // 网络恢复立即刷新配额；页面隐藏/卸载前用 keepalive 补传最后一段编辑
  useEffect(() => {
    const onOnline = () => {
      void quotaStore.refreshQuota();
      void syncQueue.flush();
    };
    // pagehide：页面即将消失，普通 fetch 会被浏览器掐掉，必须走 keepalive 单次补传。
    // ⚠️ 顺序不能反：keepalive 补传读的是**已落盘的 blob**，而最后一段编辑还压在防抖
    // 定时器里——不先 flush 就补传的是旧内容，最后那几百毫秒照样丢。
    const onPageHide = () => {
      flushPendingCanvasSave();
      syncQueue.flushForPageHide();
    };
    // 切回前台：顺带给失败任务兜底，不等慢速自愈的长间隔
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushPendingCanvasSave();
        syncQueue.flushForPageHide();
      } else {
        void syncQueue.flush();
      }
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [flushPendingCanvasSave]);

  // 网络可达性：离线时明确告知「现在的编辑存不下」——ADR-0025 之后载入以服务端为准，
  // 没传上去的改动会被丢弃，不能只用「稍后自动补传」这种轻描淡写的口径。
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => {
      setOnline(false);
      showToast('当前无网络，改动暂时无法保存到云端');
    };
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 升级成功（isVip 变 true）：刷新配额并重试被额度拦下的草稿/克隆
  useEffect(() => {
    if (!isVip) return;
    void quotaStore.refreshQuota();
    syncQueue.recoverDirtyDrafts(boardStore.getDirtyIds());
    void syncQueue.flush();
  }, [isVip]);

  const applyLoadedBoard = useCallback((loaded: StoredBoard) => {
    setCurrentBoardId(loaded.id);
    setBoardName(loaded.name);
    setInitialNodes(loaded.nodes);
    setInitialEdges(loaded.edges);
    currentNodesRef.current = loaded.nodes;
    currentEdgesRef.current = loaded.edges;
    setNodeCount(loaded.nodes.length);
    setBoardReady(true);
    // 必须换 key 才会重挂载：initialNodes 只在首次渲染生效（见 canvasEpoch 注释）。
    // 少了这一句，本函数对**已挂载**的画布等于什么都没做——内容没换，只是 ref 被改写，
    // 画布内部仍旧攥着旧节点。
    setCanvasEpoch((n) => n + 1);
  }, []);

  useEffect(() => {
    applyLoadedBoardRef.current = applyLoadedBoard;
  }, [applyLoadedBoard]);

  /** 服务端与本地均无内容时：给引导节点，绝不复用被删画布的内容 */
  const applyStarterBoard = useCallback(
    (id: string, name: string) => {
      const starter = createStarterRootNode();
      applyLoadedBoard({
        id,
        name,
        updatedAt: Date.now(),
        nodes: starter,
        edges: [],
      });
    },
    [applyLoadedBoard]
  );

  // Load boards on startup（local-first：本地立即出画面，服务端后台对账）
  const loadSeqRef = useRef(0);
  const boundScopeRef = useRef<string | null>(null);
  useEffect(() => {
    if (authLoading) return; // 身份未定，避免 guest→user 双 boot
    let cancelled = false;
    const seq = ++loadSeqRef.current;

    const scopeKey = boardScope.scopeKeyFor(user?.id);
    const scopeChanged = boundScopeRef.current !== scopeKey;
    boardStore.bindScope(scopeKey); // 幂等，StrictMode 双跑安全
    syncQueue.bindQueueScope(scopeKey);
    folderStore.bindScope(scopeKey);
    boundScopeRef.current = scopeKey;

    if (scopeChanged) {
      quotaStore.setScope(scopeKey);
      // 游客 → 账号：自动认领纯本地草稿并上传
      if (user && scopeKey !== 'guest' && !boardScope.isGuestClaimed(user.id)) {
        const { claimable } = boardScope.planGuestClaim(user.id);
        if (claimable.length > 0) {
          boardStore.hydrateClaimedDrafts(claimable, user.id);
          for (const m of claimable) {
            quotaStore.markPendingCreate(m.id);
            syncQueue.enqueue(m.id);
          }
          showToast(`已将 ${claimable.length} 个本地画板同步到你的账号`);
        } else {
          boardScope.markGuestClaimed(user.id);
        }
      }
      // 持久化队列续跑 + dirty 兜底
      try {
        syncQueue.hydrateQueue(boardScope.readJson(boardScope.queueKey(scopeKey), []));
      } catch { /* ignore */ }
      syncQueue.recoverDirtyDrafts(boardStore.getDirtyIds());

      // 阶段 5b（ADR-0018）：服务端翻私有化开关后，旧共享默认板（default-board）对本账号不再可读，
      // 而本地那份内容此刻往往是用户唯一剩下的副本——不可访问时落成一块自己的新板（见 board-migrate）。
      // 与游客认领同理，只在绑定 scope 时跑一次；服务端仍可读（legacy 共享期）时是空操作。
      if (user && scopeKey !== 'guest') {
        void boardMigrate.rehomeLegacyDefaultBoard(user.id).then((r) => {
          if (cancelled || seq !== loadSeqRef.current) return;
          if (r.status === 'skipped') return;
          // 正看着这块板的人要跟着换走，否则后续编辑会写进一块存不上去的板
          if (currentBoardIdRef.current === boardScope.LEGACY_DEFAULT_BOARD_ID) {
            const moved = r.newBoardId ? loadBoard(r.newBoardId) : null;
            if (moved) applyLoadedBoard(moved);
            else applyStarterBoard(uuidv7(), '未命名思维画布');
          }
          showToast(
            r.status === 'migrated' ? '默认画板已迁移为你自己的画板' : '默认画板已失效，已为你开启一块新画板'
          );
        });
      }
    }

    const boot = async () => {
      // 1) 本地列表立即决定活动画板（无网络等待）
      const localList = boardStore.getBoardList();
      const hadLocalList = localList.length > 0;
      // 空列表时用一块**新 id** 当引导态占位：等服务端确认「一块都没有」后才真的落地成画板。
      // 阶段 5b 起不再硬编码 default-board——那是旧共享板 id，私有化后未必归自己（ADR-0018）。
      const activeId: string = localList[0]?.id ?? uuidv7();
      const STARTER_META = (id: string) => ({
        id,
        name: '未命名思维画布',
        updatedAt: Date.now(),
        nodeCount: 1,
      });
      // 游客直接落一块引导板；登录用户先渲染引导态，等服务端列表确认后再落（避免已有画板者多出空板）
      if (!hadLocalList && !user) boardStore.upsertLocal(STARTER_META(activeId), { dirty: false });

      // 2) 本地内容立即渲染
      const cached = loadBoard(activeId);
      if (cached) {
        applyLoadedBoard(cached);
      } else {
        const starter = createStarterRootNode();
        applyLoadedBoard({
          id: activeId,
          name: boardStore.getBoardList().find((b) => b.id === activeId)?.name || '未命名思维画布',
          updatedAt: Date.now(),
          nodes: starter,
          edges: [],
        });
      }
      if (cancelled || seq !== loadSeqRef.current) return;

      // 3) 后台对账（不阻塞 UI）
      if (!user) return;
      void quotaStore.refreshQuota();
      void folderStore.refreshFolders();
      void fetchBoardListFromServer().then((serverList) => {
        if (cancelled || seq !== loadSeqRef.current) return;
        if (serverList && serverList.length > 0) {
          // 冷启动引导态（不在服务端列表里、本地无内容、无未同步改动）→ 自动切到最近一块真实画板，
          // 免得已有画板的人停在刚生成的占位空板上。本地草稿有 blob、dirty 板有改动，两种都不会误切。
          const bootId = currentBoardIdRef.current;
          const onEmptyPlaceholder =
            !serverList.some((b) => b.id === bootId) &&
            !boardStore.isDirty(bootId) &&
            !loadBoard(bootId);
          if (onEmptyPlaceholder) {
            void fetchBoardFromServer(serverList[0].id).then((loaded) => {
              if (cancelled || seq !== loadSeqRef.current || !loaded) return;
              applyLoadedBoard(loaded);
            });
          }
          return;
        }
        // 服务端确认为空：把引导态那块板落地，保证列表里有画板可用。
        // 离线（serverList === null）不动本地缓存，也不凭空多出一块板。
        if (serverList && serverList.length === 0 && boardStore.getBoardList().length === 0) {
          boardStore.upsertLocal(STARTER_META(activeId), { dirty: false });
        }
      });
      void fetchBoardFromServer(activeId).then((loaded) => {
        if (cancelled || seq !== loadSeqRef.current || !loaded) return;
        // 载入以服务端为准（ADR-0025）：取到就采用，不再裁决「本地领先/真冲突」。
        // 404 / 断网时 fetch 返回 null，本地画面（含未上传内容）原样保留。
        applyLoadedBoard(loaded);
      });
    };
    void boot();
    return () => {
      cancelled = true;
    };
  }, [user?.id, authLoading, applyLoadedBoard]);

  /**
   * 画布变更自动保存。
   *
   * 内容类变更（打字、AI 流式回答）走 600ms 防抖——没必要每个字都发一次。
   * **结构操作与提交点走 `immediate`**（新增/删除节点或边、连边、拖拽结束、失焦提交）：
   * 这些是离散动作，没有「还在输入」的中间态，压着不发只是白留未上传窗口（ADR-0025 之后
   * 载入以服务端为准，那个窗口里的内容会被丢弃，所以窗口越短越好）。
   */
  const handleCanvasChange = useCallback(
    (nodes: Node[], edges: Edge[], opts?: { immediate?: boolean }) => {
      if (!boardReady) return; // Spec A2：数据就绪前不触发自动保存，防模板/旧数据污染
      if (!boardEditOwner) return; // 非编辑权标签不得写入（闸门下画布本未挂载，这里是兜底）
      currentNodesRef.current = nodes;
      currentEdgesRef.current = edges;
      setNodeCount(nodes.length);

      if (saveTimeoutRef.current) {
        window.clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }

      const doSave = () => {
        saveTimeoutRef.current = null;
        const boardToSave: StoredBoard = {
          id: currentBoardId,
          name: boardName,
          updatedAt: Date.now(),
          nodes,
          edges,
        };
        saveBoard(boardToSave); // board-store 订阅自动刷新列表
      };
      if (opts?.immediate) {
        doSave();
        return;
      }
      saveTimeoutRef.current = window.setTimeout(doSave, 600);
    },
    [currentBoardId, boardName, boardReady, boardEditOwner]
  );

  // 删除画板：confirm → 服务端 DELETE（若已登录）+ 本地清理；删当前画板时切到剩余第一个或空白画布
  const handleDeleteBoard = async (targetId: string) => {
    const target = boards.find((b) => b.id === targetId);
    if (!target) return;
    // 删当前画板是破坏性操作：非编辑权标签不得删（另一个标签可能正拿着它编辑）
    if (targetId === currentBoardId && !ensureEditable()) return;
    if (
      !(await confirmAction({
        title: `确定要删除画板「${target.name}」吗？`,
        description: '该操作无法撤销。',
        confirmLabel: '删除画板',
        tone: 'danger',
      }))
    )
      return;

    // 删的是**别的**画板：当前板还没到防抖窗口的改动与这次删除无关，先落盘——
    // 否则紧接着的重挂载会清掉待发定时器，那段改动只存在于内存里，下次载入按
    // 「服务端为准」丢弃（ADR-0025）。
    // 删的是**当前**画板：绝不能 flush（那正是要删掉的内容），只作废待发保存防写回。
    if (targetId === currentBoardId) {
      if (saveTimeoutRef.current !== null) {
        window.clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
    } else {
      flushPendingCanvasSave();
    }
    // 冻结自动保存：删除/切换加载完成前，任何节点变更不得写入任何画板
    //（否则加载窗口内被删内容会经挂载 effect + handleCanvasChange 污染下一块画板）
    setBoardReady(false);

    // 乐观删除：本地立即隐藏（墓碑）；服务端画板后台确认，失败自动回滚
    deleteBoardLocally(targetId);
    const remaining = boardStore.getBoardList().filter((b) => b.id !== targetId);
    showToast(`已删除画板「${target.name}」`);

    if (targetId !== currentBoardId) {
      setBoardReady(true); // 删除的是非当前画板：当前画布不受影响
      return;
    }
    if (remaining.length > 0) {
      const nextId = remaining[0].id;
      const seq = ++loadSeqRef.current;
      // 本地先出画面；无缓存再拉服务端（载入以服务端为准，ADR-0025）
      const cached = loadBoard(nextId);
      if (cached) {
        applyLoadedBoard(cached);
      } else if (user) {
        const loaded = await fetchBoardFromServer(nextId);
        if (seq !== loadSeqRef.current) return; // 期间用户已手动切换画板，丢弃本次结果
        if (loaded) applyLoadedBoard(loaded);
        else applyStarterBoard(nextId, remaining[0].name);
      } else {
        applyStarterBoard(nextId, remaining[0].name);
      }
    } else {
      // 全部删除：初始化「新画布 + 待填写主题」引导节点（对齐新账号语义；新 id，不复活旧共享板）
      applyStarterBoard(uuidv7(), '未命名思维画布');
    }
  };

  const handleRenameBoard = (newName: string) => {
    if (!ensureEditable()) return;
    setBoardName(newName);
    const boardToSave: StoredBoard = {
      id: currentBoardId,
      name: newName,
      updatedAt: Date.now(),
      nodes: currentNodesRef.current,
      edges: currentEdgesRef.current,
    };
    saveBoard(boardToSave);
    showToast(`画板已重命名为「${newName}」`);
  };

  // Spec L1：画板库管理操作（收藏/归档/改名）走轻量 meta 通道，本地乐观 + 队列同步
  const handleRenameBoardById = (id: string, newName: string) => {
    if (id === currentBoardId) {
      if (!ensureEditable()) return;
      setBoardName(newName);
    }
    updateBoardMetaLocally(id, { name: newName });
    showToast(`画板已重命名为「${newName}」`);
  };

  const handleToggleFavorite = (id: string, value: boolean) => {
    updateBoardMetaLocally(id, { isFavorite: value });
    showToast(value ? '已收藏画板（置顶显示）' : '已取消收藏');
  };

  const handleToggleArchive = (id: string, value: boolean) => {
    updateBoardMetaLocally(id, { isArchived: value });
    showToast(value ? '画板已归档，可在画板库「包含归档」中找回' : '画板已恢复');
  };

  // Spec L1：分组操作（在线优先，失败回滚由 folder-store 负责，此处只做反馈）
  const handleMoveBoard = (boardId: string, folderId: string | null) => {
    updateBoardMetaLocally(boardId, { folderId });
    if (folderId) {
      const name = foldersView.folders.find((f) => f.id === folderId)?.name;
      showToast(name ? `已移动到分组「${name}」` : '已移动到分组');
    } else {
      showToast('已移出分组');
    }
  };

  const handleCreateFolder = async (name: string) => {
    const r = await folderStore.createFolder(name);
    if (r.ok) showToast(`已创建分组「${name}」`);
    return r;
  };

  const handleRenameFolder = async (id: string, name: string) => {
    const r = await folderStore.renameFolder(id, name);
    if (r.ok) showToast(`分组已重命名为「${name}」`);
    return r;
  };

  const handleDeleteFolder = async (id: string) => {
    const name = foldersView.folders.find((f) => f.id === id)?.name;
    const r = await folderStore.deleteFolder(id);
    if (r.ok) showToast(name ? `已删除分组「${name}」，组内画板回到未分组` : '已删除分组');
    return r;
  };

  // 自动命名：画布首节点完成后，DeepDiveCanvas 经事件回传 LLM 生成的画板名。
  // 双重「只命名一次」保险：画板名已非默认名（含用户手动改过）则直接忽略
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ boardId?: string; title?: string }>).detail || {};
      if (!detail.title || detail.boardId !== currentBoardId) return;
      if (!isDefaultBoardName(boardName)) return;
      const safe = detail.title.slice(0, 15);
      setBoardName(safe);
      saveBoard({
        id: currentBoardId,
        name: safe,
        updatedAt: Date.now(),
        nodes: currentNodesRef.current,
        edges: currentEdgesRef.current,
      });
      showToast(`画板已自动命名为「${safe}」`);
    };
    window.addEventListener('deepdive:board-autotitle', handler);
    return () => window.removeEventListener('deepdive:board-autotitle', handler);
  }, [currentBoardId, boardName]);

  // App 树外的组件（如 UserProfileModal）请求全局 toast：沿用 deepdive:* 自定义事件先例
  useEffect(() => {
    const handler = (e: Event) => {
      const message = (e as CustomEvent<{ message?: string }>).detail?.message;
      if (message) showToast(message);
    };
    window.addEventListener('deepdive:toast', handler);
    return () => window.removeEventListener('deepdive:toast', handler);
  }, [showToast]);

  const handleSwitchBoard = async (targetId: string) => {
    if (targetId === currentBoardId) return;
    // 风险态下（离线/停止重试/冲突）先让用户确认：此时切走 = 永久丢掉那部分改动
    if (!(await confirmDiscardRisk('切换画板'))) return;
    // 离开当前画板前先把压在防抖窗口里的改动落盘：紧接着的重挂载会让新板的变更清掉
    // 待发定时器，那段改动只存在于内存里，下次载入按「服务端为准」丢弃（ADR-0025）。
    flushPendingCanvasSave();
    const seq = ++loadSeqRef.current; // 过期的加载结果直接丢弃（Spec A2 审计修复）
    // 本地先出画面（无网络等待）
    const cached = loadBoard(targetId);
    if (cached) {
      applyLoadedBoard(cached);
      showToast(`已载入画板「${cached.name}」`);
    }
    // 载入以服务端为准（ADR-0025）：取到就采用，本地未上传内容按设计丢弃。
    if (user) {
      const loaded = await fetchBoardFromServer(targetId);
      if (seq !== loadSeqRef.current) return;
      if (!loaded) {
        if (!cached) showToast('画板加载失败，请稍后重试');
        return;
      }
      applyLoadedBoard(loaded);
      if (!cached) showToast(`已载入画板「${loaded.name}」`);
    } else if (!cached) {
      showToast('画板加载失败，请稍后重试');
    }
  };

  const handleNewBoard = async () => {
    if (!(await confirmDiscardRisk('新建画板'))) return; // 风险态下先让用户确认，别默默丢掉存不上的改动
    if (quotaStore.canCreate(isVip) === 'block') {
      openRechargeModal('免费版用户最多支持创建 3 个独立画板。升级 Pro 会员解锁无限画板与无限节点！');
      return;
    }
    flushPendingCanvasSave(); // 离开当前画板前先把防抖窗口里的改动落盘
    const newId = uuidv7();
    const newName = `探索课题 #${boards.length + 1}`;
    const starterNodes = createStarterRootNode();
    const emptyBoard: StoredBoard = {
      id: newId,
      name: newName,
      updatedAt: Date.now(),
      nodes: starterNodes,
      edges: [],
    };
    quotaStore.markPendingCreate(newId);
    saveBoard(emptyBoard);
    setCurrentBoardId(newId);
    setBoardName(newName);
    setInitialNodes(starterNodes);
    setInitialEdges([]);
    currentNodesRef.current = starterNodes;
    currentEdgesRef.current = [];
    setNodeCount(1);
    showToast(`已创建新思考画板「${newName}」`);
  };

  const handleEnterCanvas = (presetTopic?: string) => {
    try {
      sessionStorage.setItem('deepdive_active_view', 'canvas');
    } catch (e) {}
    try {
      window.history.replaceState({}, '', CANVAS_HREF);
    } catch (e) {}
    setPracticeAttemptId(null);

    if (presetTopic) {
      const existing = boards.find(
        (b) => b.name.toLowerCase() === presetTopic.toLowerCase() || b.name.includes(presetTopic)
      );
      if (existing) {
        handleSwitchBoard(existing.id);
      } else {
        if (quotaStore.canCreate(isVip) === 'block') {
          openRechargeModal('免费版用户最多支持创建 3 个独立画板。升级 Pro 会员解锁无限画板！');
          return;
        }
        const newId = uuidv7();
        const newBoard: StoredBoard = {
          id: newId,
          name: presetTopic,
          updatedAt: Date.now(),
          nodes: [
            {
              id: uuidv7(),
              type: 'chat',
              position: { x: 120, y: 160 },
              draggable: false,
              data: {
                title: presetTopic,
                depth: 0,
                question: presetTopic,
                answer: '',
                status: 'idle',
                model: 'gemini-3.1-flash-lite',
              },
            },
          ],
          edges: [],
        };
        quotaStore.markPendingCreate(newId);
        saveBoard(newBoard);
        trackEvent('board_create'); // K4 事件 5：画板创建（不携带画板名，避免 PII）
        markChecklistStep('board'); // K5/D1：checklist 第 1 步
        setCurrentBoardId(newId);
        setBoardName(presetTopic);
        setInitialNodes(newBoard.nodes);
        setInitialEdges([]);
        currentNodesRef.current = newBoard.nodes;
        currentEdgesRef.current = [];
        showToast(`已开启新探索课题「${presetTopic}」`);
      }
    }
    setViewMode('canvas');
  };

  /** 练习详情开关：打开时 push（可后退回列表），关闭时 replace（不回退到已关闭的详情） */
  const handlePracticeAttemptChange = useCallback((attemptId: string | null) => {
    setPracticeAttemptId(attemptId);
    try {
      sessionStorage.setItem('deepdive_active_view', 'practice');
    } catch (e) {}
    try {
      const href = attemptId ? practiceDetailHref(attemptId) : PRACTICE_LIST_HREF;
      if (attemptId) window.history.pushState({}, '', href);
      else window.history.replaceState({}, '', href);
    } catch (e) {}
  }, []);

  const handleSwitchProduct = (product: 'canvas' | 'practice') => {
    if (product === 'canvas') {
      try {
        sessionStorage.setItem('deepdive_active_view', 'canvas');
      } catch (e) {}
      try {
        window.history.replaceState({}, '', CANVAS_HREF);
      } catch (e) {}
      setPracticeAttemptId(null);
      setViewMode('canvas');
    } else {
      flushPendingCanvasSave();
      try {
        sessionStorage.setItem('deepdive_active_view', 'practice');
      } catch (e) {}
      try {
        window.history.replaceState({}, '', PRACTICE_LIST_HREF);
      } catch (e) {}
      setPracticeAttemptId(null);
      setViewMode('practice');
    }
  };

  const handleEnterPractice = (presetTopic?: string) => {
    try {
      sessionStorage.setItem('deepdive_active_view', 'practice');
    } catch (e) {}
    try {
      window.history.replaceState({}, '', PRACTICE_LIST_HREF);
    } catch (e) {}
    setPracticeAttemptId(null);
    setViewMode('practice');
  };

  const handleGoToLanding = () => {
    try {
      sessionStorage.setItem('deepdive_active_view', 'landing');
    } catch (e) {}
    try {
      window.history.replaceState({}, '', HOME_HREF);
    } catch (e) {}
    setPracticeAttemptId(null);
    setViewMode('landing');
  };

  // Spec K6（B1 方案 B）：分享画布一键克隆。
  // 用户在分享页点过 CTA（deepdive_clone_code 意图记录）后，登录/注册成功
  // 且本地画板就绪时执行：拉公开快照 → 构造 StoredBoard → saveBoard 走既有
  // 同步队列（服务端 assertCanCreateBoard 配额拦截 + 客户端预检双保险）→
  // 直接切入克隆画布，制造「注册即拥有第一个画板」的激活时刻。
  //
  // 意图生命周期（K6 修复）：peek 不焚毁——配额预检失败/网络失败保留意图，
  // 充值成功/删板腾位（boards.length/isVip 变化触发重试）后自动克隆；
  // 仅克隆成功 markShareCloned 后或分享确认失效时才焚毁。
  const tryCloneSharedBoard = async (): Promise<void> => {
    const intent = peekCloneIntent(); // 只读不焚毁
    if (!intent) return;
    if (isShareCloned(intent.code)) {
      takeCloneIntent(); // 已克隆过：清理残留意图
      return;
    }

    let body: any;
    try {
      // countViews=0：克隆是转化动作而非浏览，不递增浏览计数
      const res = await fetch(
        `/api/shares/${encodeURIComponent(intent.code)}?countViews=0`
      );
      if (!res.ok) {
        showToast('分享内容已失效，未能克隆画板');
        takeCloneIntent(); // 分享已失效：意图作废
        return;
      }
      body = await res.json();
    } catch {
      return; // 网络失败：意图保留，待下次就绪自动重试
    }

    // 画板配额客户端预检（与 handleEnterCanvas 同口径；服务端 save 仍有硬拦截）。
    // 预检失败意图保留：充值成功（isVip 变化）或删板腾位（boards.length 变化）后本钩子自动重试
    if (quotaStore.canCreate(isVip) === 'block') {
      openRechargeModal('免费版用户最多支持创建 3 个独立画板，升级 Pro 会员解锁无限画板后再来克隆吧！');
      return;
    }

    // 快照节点 → 画布节点：先归一化遗留的 generating 态（分享者中途生成就分享的极端情况），
    // 再由 remapBoardIds 全量重映射 id —— 服务端 nodes.id 是全局主键，
    // 直通快照 id 会与源画板撞主键导致整板保存失败（Spec M2）
    const snapshotNodes = (body.nodes || []).map((n: Node) => {
      if (n.type !== 'chat') return n;
      const d = n.data as unknown as ChatNodeData;
      if (d.status !== 'generating') return n;
      return { ...n, data: { ...d, status: 'idle' as const, errorMessage: undefined } };
    });
    const remap = remapBoardIds(snapshotNodes, (body.edges || []) as Edge[], { generateId: uuidv7 });
    const nodes = remap.nodes;
    const edges = remap.edges;
    if (nodes.length === 0) {
      showToast('分享内容为空，未能克隆画板');
      return;
    }

    const boardId = remap.boardId;
    const boardName = String(body.title || '克隆的分享画板').slice(0, 60);
    quotaStore.markPendingCreate(boardId);
    saveBoard({ id: boardId, name: boardName, updatedAt: Date.now(), nodes, edges });
    markShareCloned(intent.code);
    takeCloneIntent(); // 克隆成功：焚毁意图

    setCurrentBoardId(boardId);
    setBoardName(boardName);
    setInitialNodes(nodes);
    setInitialEdges(edges);
    currentNodesRef.current = nodes;
    currentEdgesRef.current = edges;
    setNodeCount(nodes.length); // 同步 Topbar 计数，否则沿用旧画板的值直到首次编辑

    // 仅「本次会话刚点过 CTA」才切入画布视图（激活时刻）；
    // 陈旧意图（7 天内登录的其他场景）不打断用户当前浏览，画板已在列表中
    if (takeCloneFreshFlag()) {
      try {
        sessionStorage.setItem('deepdive_active_view', 'canvas');
      } catch (e) {}
      setViewMode('canvas');
    }
    trackEvent('share_clone'); // K4 扩展事件：克隆转化（无 PII，不含画板名）
    showToast(`已将分享画板《${boardName}》克隆到我的画板`);
  };

  // 克隆钩子：用户就绪（登录/注册完成）且本地画板数据就绪后执行；
  // boards.length/isVip 变化（充值成功/删板腾位）时重试被配额拦下的克隆意图
  useEffect(() => {
    if (!boardReady || !user) return;
    void tryCloneSharedBoard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardReady, user, boards.length, isVip]);

  const handleExportJson = () => {
    trackEvent('export', { format: 'json' }); // K4 事件 8：导出点击
    markChecklistStep('export'); // K5/D1：checklist 第 4 步
    const currentBoard: StoredBoard = {
      id: currentBoardId,
      name: boardName,
      updatedAt: Date.now(),
      nodes: currentNodesRef.current,
      edges: currentEdgesRef.current,
    };
    exportBoardToJson(currentBoard);
    showToast('已导出 JSON 画板备份');
  };

  // Spec M1：JSON 备份导入——浏览器内解析（懒加载解析器，避免校验库进入主包），
  // 生成全新 id 的新画板后走既有 saveBoard 同步链路；非法文件与配额在落库前拦截。
  const handleImportJson = async (file: File) => {
    let mod: typeof import('./lib/board-import');
    try {
      mod = await import('./lib/board-import');
    } catch {
      showToast('导入功能暂不可用，请刷新后重试');
      return;
    }
    if (file.size > mod.MAX_IMPORT_BYTES) {
      showToast('备份文件过大，暂支持 2MB 以内');
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      showToast('读取文件失败，请重试');
      return;
    }
    const result = mod.parseBoardBackup(text);
    if (result.ok === false) {
      showToast(result.error);
      return;
    }
    if (quotaStore.canCreate(isVip) === 'block') {
      openRechargeModal('免费版用户最多支持创建 3 个独立画板，升级 Pro 会员解锁无限画板后再导入吧！');
      return;
    }
    if (!ensureEditable()) return;
    if (!(await confirmDiscardRisk('导入备份'))) return;
    const imported = result.board;
    flushPendingCanvasSave(); // 切到导入的新板前，先落盘当前板压在防抖窗口里的改动
    quotaStore.markPendingCreate(imported.id);
    saveBoard(imported);
    applyLoadedBoard(imported);
    try {
      sessionStorage.setItem('deepdive_active_view', 'canvas');
    } catch {}
    setViewMode('canvas');
    showToast(`已导入画板《${imported.name}》`);
  };

  const handleExportMarkdown = () => {
    trackEvent('export', { format: 'markdown' }); // K4 事件 8：导出点击
    markChecklistStep('export'); // K5/D1：checklist 第 4 步
    const currentBoard: StoredBoard = {
      id: currentBoardId,
      name: boardName,
      updatedAt: Date.now(),
      nodes: currentNodesRef.current,
      edges: currentEdgesRef.current,
    };
    exportBoardToMarkdown(currentBoard);
    showToast('已导出 Markdown 研报大纲');
  };

  // Spec K1（B2）：PNG 图片导出——html-to-image 捕获画布 + 品牌水印；失败时 toast 中文原因。
  // 经 DeepDiveCanvas 的 trigger ref 走「临时关闭虚拟化全量渲染」路径，修复导出图丢连线
  const handleExportPng = async () => {
    trackEvent('export', { format: 'png' }); // K4 事件 8：导出点击
    markChecklistStep('export'); // K5/D1：checklist 第 4 步
    const result = triggerExportPngRef.current
      ? await triggerExportPngRef.current(boardName)
      : await exportCanvasAsPng(currentNodesRef.current, boardName); // 兜底：ref 未接线时旧路径
    if (result.ok) {
      showToast('已导出 PNG 画板图片，可直接分享');
    } else {
      showToast(result.error || '图片导出失败，请重试');
    }
  };

  const handleResetBoard = async () => {
    if (!ensureEditable()) return; // 清空 = 大量删除，非编辑权标签不得动手
    if (
      await confirmAction({
        title: '确定要清空当前画板的所有节点吗？',
        description: '此操作无法撤销。',
        confirmLabel: '清空画板',
        tone: 'danger',
      })
    ) {
      const starter = createStarterRootNode();
      const resetBoard: StoredBoard = {
        id: currentBoardId,
        name: boardName,
        updatedAt: Date.now(),
        nodes: starter,
        edges: [],
      };
      saveBoard(resetBoard); // 走 scope 正确的持久化 + 同步（不再裸删键 + reload）
      applyLoadedBoard(resetBoard);
      showToast('已清空当前画板');
    }
  };

  // Spec B3/B4：VIP 到期提醒横幅（即将到期 ≤3 天 / 宽限期内）；关闭后当天不再提示
  const [vipBannerDismissed, setVipBannerDismissed] = useState(() => {
    try {
      return sessionStorage.getItem('deepdive_vip_banner_dismissed') === new Date().toDateString();
    } catch {
      return false;
    }
  });
  const dismissVipBanner = () => {
    setVipBannerDismissed(true);
    try {
      sessionStorage.setItem('deepdive_vip_banner_dismissed', new Date().toDateString());
    } catch { /* ignore */ }
  };
  // Spec D3：未验证邮箱横幅（非 admin 且 email_verified=false），提供重发验证邮件入口
  const [verifyResendState, setVerifyResendState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const needsEmailVerification = Boolean(user && user.role !== 'admin' && user.email_verified === false);
  const handleResendVerification = async () => {
    setVerifyResendState('sending');
    const res = await resendVerification();
    if (res.success) {
      setVerifyResendState('sent');
      showToast(res.message || '验证邮件已重新发送，请查收');
    } else {
      setVerifyResendState('idle');
      showToast(res.error || '发送失败，请稍后重试');
    }
  };
  const ent = user?.entitlements;
  let vipBanner: { type: 'expiring' | 'grace' | 'expired'; text: string } | null = null;
  if (ent?.plan === 'trial' && ent.vipExpired) {
    // 硬锁定：已超宽限期。role 仍为 'vip' 但权益已降 trial——没有这条横幅，
    // 用户只会无提示地吃到 403 VIP_EXPIRED（顶栏徽章此时也已翻转为「升级 VIP」）
    vipBanner = {
      type: 'expired',
      text: 'VIP 会员已过期且超出宽限期，AI 推理与新建画板已受限，续费后立即恢复',
    };
  } else if (ent?.plan === 'vip' && ent.vipExpired) {
    vipBanner = {
      type: 'grace',
      text: `VIP 会员已过期，宽限期剩余 ${ent.vipGraceDaysRemaining ?? 0} 天，到期后将无法使用 AI 推理与新建画板`,
    };
  } else if (ent?.plan === 'vip' && user?.vip_expires_at) {
    const daysLeft = Math.ceil((new Date(user.vip_expires_at).getTime() - Date.now()) / 86400000);
    if (daysLeft <= 3) {
      vipBanner = { type: 'expiring', text: `VIP 会员将于 ${Math.max(0, daysLeft)} 天后到期，请及时续费以免影响使用` };
    }
  }

  if (viewMode === 'landing') {
    return (
      <LandingPage
        onEnterCanvas={handleEnterCanvas}
        onEnterPractice={handleEnterPractice}
      />
    );
  }

  // Spec R1：AI 练习独立产品工作台
  if (viewMode === 'practice') {
    return (
      <div className="w-screen h-screen overflow-hidden bg-slate-50 dark:bg-[#070b14] text-slate-900 dark:text-slate-100 flex flex-col font-sans select-none transition-colors duration-200">
        <PracticeWorkspace
          userId={user?.id ?? null}
          user={user}
          theme={theme}
          onToggleTheme={toggleTheme}
          activeProduct="practice"
          onSwitchProduct={handleSwitchProduct}
          onGoToLanding={handleGoToLanding}
          initialAttemptId={practiceAttemptId}
          onAttemptChange={handlePracticeAttemptChange}
          onExploreInCanvas={(presetTopic) => {
            handleEnterCanvas(presetTopic);
          }}
        />
        {/* Floating Status Toast */}
        <Toast message={toastMessage} />
      </div>
    );
  }

  // Spec A2：画布数据就绪前不挂载画布，避免初始模板/旧数据触发自动保存污染服务端画板
  if (!boardReady) {
    return (
      <div className="w-screen h-screen flex items-center justify-center bg-slate-100 dark:bg-[#070b14] text-slate-500 dark:text-slate-400">
        <div className="flex items-center gap-3 text-sm">
          <span className="w-4 h-4 rounded-full border-2 border-slate-300 dark:border-slate-700 border-t-indigo-500 animate-spin" />
          正在载入画板…
        </div>
      </div>
    );
  }

  return (
    <div className="w-screen h-screen overflow-hidden bg-slate-100 dark:bg-[#070b14] text-slate-900 dark:text-slate-100 flex flex-col font-sans select-none transition-colors duration-200">
      {/* 提醒横幅（未验证邮箱 Spec D3 / VIP 到期 Spec B3/B4），堆叠避免重叠 */}
      {(needsEmailVerification || (vipBanner && !vipBannerDismissed)) && (
        <div className="absolute top-14 left-0 right-0 z-30 flex flex-col gap-px">
          {needsEmailVerification && (
            <div
              data-testid="email-verify-banner"
              className="w-full flex items-center justify-center gap-3 px-4 py-2 text-sm bg-indigo-600/95 text-white"
            >
              <span>
                邮箱尚未验证，验证后才能使用 AI 推理
                {user?.email ? `（${user.email}）` : ''}
              </span>
              {verifyResendState === 'sent' ? (
                <span className="font-semibold">验证邮件已发送，请查收</span>
              ) : (
                <button
                  onClick={() => void handleResendVerification()}
                  disabled={verifyResendState === 'sending'}
                  className="underline font-semibold hover:opacity-80 disabled:opacity-50"
                >
                  {verifyResendState === 'sending' ? '发送中…' : '重新发送验证邮件'}
                </button>
              )}
            </div>
          )}
          {vipBanner && !vipBannerDismissed && (
            <div
              data-testid="vip-banner"
              className={`w-full flex items-center justify-center gap-3 px-4 py-2 text-sm ${
                vipBanner.type === 'grace'
                  ? 'bg-amber-500/95 text-white'
                  : vipBanner.type === 'expired'
                  ? 'bg-rose-600/95 text-white'
                  : 'bg-yellow-400/95 text-slate-900'
              }`}
            >
              <span>{vipBanner.text}</span>
              <button
                onClick={() => openRechargeModal('VIP 到期提醒')}
                className="underline font-semibold hover:opacity-80"
              >
                立即续费
              </button>
              <button
                onClick={dismissVipBanner}
                aria-label="关闭提醒"
                className="ml-1 hover:opacity-70"
              >
                ✕
              </button>
            </div>
          )}
        </div>
      )}
      {/* Top Bar Navigation */}
      <Topbar
        boardName={boardName}
        onRenameBoard={handleRenameBoard}
        boards={boards}
        folders={foldersView.folders}
        currentBoardId={currentBoardId}
        onSwitchBoard={(id) => void handleSwitchBoard(id)}
        onNewBoard={handleNewBoard}
        onDeleteBoard={(id) => void handleDeleteBoard(id)}
        onAddRootNode={() => triggerAddRootRef.current?.()}
        onAddNoteNode={() => triggerAddNoteRef.current?.()}
        onAutoLayout={() => {
          triggerAutoLayoutRef.current?.();
          showToast('已自动按思维树重新规整排版');
        }}
        onFitView={() => triggerFitViewRef.current?.()}
        onSearchResultClick={(nodeId) => triggerFocusNodeRef.current?.(nodeId)}
        onExportJson={handleExportJson}
        onImportJson={handleImportJson}
        onExportMarkdown={handleExportMarkdown}
        onExportPng={handleExportPng}
        onShareLink={() => void handleShareLink()}
        onResetBoard={handleResetBoard}
        onGoToLanding={handleGoToLanding}
        onOpenSamples={() => setSampleViewerOpen(true)}
        onOpenLibrary={() => setLibraryOpen(true)}
        theme={theme}
        syncState={syncState}
        offline={!online}
        onToggleTheme={toggleTheme}
        nodeCount={nodeCount}
        suggestionsEnabled={suggestionsEnabled}
        suggestionsToggleDisabled={currentBoardIsShared}
        onToggleSuggestions={toggleSuggestions}
        activeProduct="canvas"
        onSwitchProduct={handleSwitchProduct}
        quizEnabled={Boolean(user?.features?.quiz ?? true)}
      />

      {/* Main Infinite Canvas Viewport */}
      <main className="flex-1 w-full h-full pt-14 relative bg-slate-50/50 dark:bg-[#070b14] transition-colors duration-200">
        {boardEditOwner ? (
          <ReactFlowProvider>
            <DeepDiveCanvas
              key={`${currentBoardId}:${canvasEpoch}`}
              initialNodes={initialNodes}
              initialEdges={initialEdges}
              onCanvasChange={handleCanvasChange}
              triggerAutoLayoutRef={triggerAutoLayoutRef}
              triggerFitViewRef={triggerFitViewRef}
              triggerAddRootRef={triggerAddRootRef}
              triggerAddNoteRef={triggerAddNoteRef}
              triggerFocusNodeRef={triggerFocusNodeRef}
              theme={theme}
              canvasId={currentBoardId}
              boardNeedsAutoName={isDefaultBoardName(boardName)}
              triggerExportPngRef={triggerExportPngRef}
              suggestionsEnabled={suggestionsEnabled}
              onSuggestionsDisabled={handleSuggestionsDisabled}
              requestDisableSuggestionsRef={requestDisableSuggestionsRef}
            />
          </ReactFlowProvider>
        ) : (
          /* 同一块画板已在另一个标签页编辑：不渲染画布，避免两个标签互相覆盖/误删（#0097） */
          <BoardLockedNotice
            boardName={boardName}
            onTakeOver={() => void handleTakeOverEdit()}
            onOpenLibrary={() => setLibraryOpen(true)}
          />
        )}
        {/* Spec K5（D1）：空态新手 4 步 checklist（全完成/手动关闭后不再显示） */}
        {boardEditOwner && <StarterChecklist hasBoards={boards.length > 0} />}
      </main>

      {/* Spec K5（D1）：示例画布只读查看器（纯前端静态内容，不占用户配额） */}
      {sampleViewerOpen && (
        <SampleBoardViewer onClose={() => setSampleViewerOpen(false)} />
      )}

      {/* Spec L1：画板库（搜索 / 收藏 / 归档；归档画板在此找回） */}
      {libraryOpen && (
        <BoardLibraryModal
          boards={boards}
          folders={foldersView.folders}
          foldersOffline={foldersView.offline}
          currentBoardId={currentBoardId}
          onClose={() => setLibraryOpen(false)}
          onSwitchBoard={(id) => void handleSwitchBoard(id)}
          onNewBoard={() => {
            setLibraryOpen(false);
            handleNewBoard();
          }}
          onDeleteBoard={(id) => void handleDeleteBoard(id)}
          onRenameBoard={handleRenameBoardById}
          onToggleFavorite={handleToggleFavorite}
          onToggleArchive={handleToggleArchive}
          onMoveBoard={handleMoveBoard}
          onCreateFolder={handleCreateFolder}
          onRenameFolder={handleRenameFolder}
          onDeleteFolder={handleDeleteFolder}
        />
      )}

      {/* Spec K2：分享链接弹窗（创建/重建提示/撤销） */}
      {shareDialog && (
        <ShareLinkModal
          url={shareDialog.url}
          recreated={shareDialog.recreated}
          onRevoke={() => void handleRevokeShare()}
          onClose={() => setShareDialog(null)}
        />
      )}

      {/* Floating Status Toast */}
      <Toast message={toastMessage} />

      {/* Promise 化确认框（window.confirm 替代） */}
      {confirmElement}
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ModalProvider>
        <MainApp />
        <AuthModal />
        <UserProfileModal />
        <MySharesModal />
        <FeedbackModal />
        <RechargeModal />
        <AdminDashboardModal />
      </ModalProvider>
    </AuthProvider>
  );
}
