/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { ReactFlowProvider, Node, Edge } from '@xyflow/react';
import { Topbar } from './components/ui/Topbar';
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
import * as quotaStore from './lib/quota-store';
import * as syncQueue from './lib/sync-queue';
import * as folderStore from './lib/folder-store';
import { useBoards, useFolders } from './hooks/useBoards';
import { AuthProvider, useAuth } from './context/AuthContext';
import { trackEvent } from './lib/analytics';
import { markChecklistStep } from './lib/checklist';
import {
  isShareCloned,
  markShareCloned,
  peekCloneIntent,
  takeCloneFreshFlag,
  takeCloneIntent,
} from './lib/share-clone';
import { deduplicateNodes, deduplicateEdges } from './lib/storage';
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
  const [viewMode, setViewMode] = useState<'landing' | 'canvas'>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('view') === 'canvas') return 'canvas';
      const storedView = sessionStorage.getItem('deepdive_active_view');
      if (storedView === 'canvas') return 'canvas';
    } catch (e) {
      // ignore
    }
    return 'landing';
  });

  const boards = useBoards();
  const foldersView = useFolders();
  const [currentBoardId, setCurrentBoardId] = useState<string>('default-board');
  const [boardName, setBoardName] = useState<string>('量子计算深度探索');
  const [initialNodes, setInitialNodes] = useState<Node[] | undefined>(undefined);
  const [initialEdges, setInitialEdges] = useState<Edge[] | undefined>(undefined);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [nodeCount, setNodeCount] = useState<number>(1);

  const { isVip, openRechargeModal, user, resendVerification, loading: authLoading } = useAuth();

  // Spec K5（D1）：示例画布只读查看器开关（Topbar「示例画布」入口）
  const [sampleViewerOpen, setSampleViewerOpen] = useState(false);

  // Spec L1：画板库弹窗（搜索/收藏/归档）
  const [libraryOpen, setLibraryOpen] = useState(false);

  // Global Dark Mode state ('light' | 'dark')
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const savedTheme = localStorage.getItem('deepdive_theme');
      if (savedTheme === 'light' || savedTheme === 'dark') return savedTheme;
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        return 'dark';
      }
    } catch (e) {
      // ignore
    }
    return 'light';
  });

  // Synchronize 'dark' class on <html> documentElement
  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    try {
      localStorage.setItem('deepdive_theme', theme);
    } catch (e) {}
  }, [theme]);

  // 探索灵感节点显示开关（默认展示）：localStorage 记忆偏好，视图级隐藏不影响画板数据
  const [showSuggestions, setShowSuggestions] = useState<boolean>(() => {
    try {
      return localStorage.getItem('deepdive_suggestions_visible') !== '0';
    } catch (e) {
      return true;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('deepdive_suggestions_visible', showSuggestions ? '1' : '0');
    } catch (e) {}
  }, [showSuggestions]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'light' ? 'dark' : 'light';
      showToast(next === 'dark' ? '已开启深色模式 · 适配深夜深度思考' : '已切换为明亮模式');
      return next;
    });
  }, []);

  // Trigger refs for Canvas actions
  const triggerAutoLayoutRef = useRef<(() => void) | null>(null);
  const triggerFitViewRef = useRef<(() => void) | null>(null);
  const triggerAddRootRef = useRef<(() => void) | null>(null);
  const triggerAddNoteRef = useRef<(() => void) | null>(null);
  const triggerExportPngRef = useRef<
    ((title: string) => Promise<{ ok: boolean; error?: string }>) | null
  >(null);

  // Spec K2：分享链接弹窗（创建/重建提示/撤销）
  const [shareDialog, setShareDialog] = useState<{ url: string; recreated: boolean } | null>(null);

  const handleShareLink = async () => {
    try {
      const res = await fetch(`/api/canvases/${encodeURIComponent(currentBoardId)}/share`, {
        method: 'POST',
        credentials: 'include',
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.shareCode) {
        setShareDialog({ url: String(body.url), recreated: Boolean(body.recreated) });
      } else {
        showToast(body?.error || '分享创建失败，请重试');
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
        const body = await res.json().catch(() => null);
        showToast(body?.error || '停止分享失败，请重试');
      }
    } catch {
      showToast('网络异常，操作失败');
    }
  };

  const currentNodesRef = useRef<Node[]>([]);
  const currentEdgesRef = useRef<Edge[]>([]);
  const saveTimeoutRef = useRef<number | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 2500);
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const toggleSuggestions = useCallback(() => {
    setShowSuggestions((prev) => {
      const next = !prev;
      showToast(next ? '已展示探索灵感节点' : '已隐藏探索灵感节点，画板内容不受影响');
      return next;
    });
  }, []);

  // 保存冲突提示（Spec A4 乐观锁）+ 同步状态订阅（Spec A5，仅指示当前画板）
  const [syncState, setSyncState] = useState<'idle' | 'saved' | 'pending' | 'error' | 'conflict'>('idle');
  const [boardReady, setBoardReady] = useState(false); // Spec A2：画布数据就绪前不挂载画布
  const currentBoardIdRef = useRef(currentBoardId);
  useEffect(() => {
    currentBoardIdRef.current = currentBoardId;
  }, [currentBoardId]);
  const syncIdleTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const onConflict = (e: Event) => {
      const detail = (e as CustomEvent).detail as { message?: string; code?: string };
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
      showToast(detail?.message || '画板已在其他窗口被修改，请刷新后重试');
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
      if (state === 'saved') {
        syncIdleTimerRef.current = window.setTimeout(() => setSyncState('idle'), 3000);
      }
    });
    window.addEventListener('deepdive:canvas-save-conflict', onConflict);
    window.addEventListener('deepdive:board-remote-deleted', onRemoteDeleted);
    return () => {
      window.removeEventListener('deepdive:canvas-save-conflict', onConflict);
      window.removeEventListener('deepdive:board-remote-deleted', onRemoteDeleted);
      offSync();
      if (syncIdleTimerRef.current !== null) clearTimeout(syncIdleTimerRef.current);
    };
  }, []);

  // 网络恢复立即刷新配额；页面隐藏/卸载前尽力 flush 同步队列（防丢最后一段编辑）
  useEffect(() => {
    const onOnline = () => {
      void quotaStore.refreshQuota();
      void syncQueue.flush();
    };
    const onPageHide = () => {
      void syncQueue.flush();
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('visibilitychange', onPageHide);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('visibilitychange', onPageHide);
    };
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
  }, []);

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
    }

    const boot = async () => {
      // 1) 本地列表立即决定活动画板（无网络等待）
      const localList = boardStore.getBoardList();
      let activeId: string | undefined = localList[0]?.id;
      const DEFAULT_META = () => ({
        id: 'default-board',
        name: '未命名思维画布',
        updatedAt: Date.now(),
        nodeCount: 1,
      });
      if (!activeId) {
        activeId = 'default-board';
        // 游客直接落一棵默认板；登录用户先渲染引导态，等服务端列表确认后再落（避免已有画板者多出空板）
        if (!user) boardStore.upsertLocal(DEFAULT_META(), { dirty: false });
      }

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
          // 冷启动引导态（未编辑、未落盘）→ 自动切到最近一块真实画板
          const onFreshDefault =
            currentBoardIdRef.current === 'default-board' &&
            !loadBoard('default-board') &&
            !boardStore.isDirty('default-board');
          if (onFreshDefault) {
            void fetchBoardFromServer(serverList[0].id).then((loaded) => {
              if (cancelled || seq !== loadSeqRef.current || !loaded) return;
              applyLoadedBoard(loaded);
            });
          }
          return;
        }
        // 服务端确认为空（或离线拉取失败）：落一棵默认板，保证列表可见
        if (!boardStore.getBoardList().some((b) => b.id === 'default-board')) {
          boardStore.upsertLocal(DEFAULT_META(), { dirty: false });
        }
      });
      void fetchBoardFromServer(activeId).then((loaded) => {
        if (cancelled || seq !== loadSeqRef.current || !loaded) return;
        if (boardStore.isDirty(loaded.id)) return; // 本地未同步改动优先
        applyLoadedBoard(loaded);
      });
    };
    void boot();
    return () => {
      cancelled = true;
    };
  }, [user?.id, authLoading, applyLoadedBoard]);

  // Debounced auto-save whenever nodes or edges change
  const handleCanvasChange = useCallback(
    (nodes: Node[], edges: Edge[]) => {
      if (!boardReady) return; // Spec A2：数据就绪前不触发自动保存，防模板/旧数据污染
      currentNodesRef.current = nodes;
      currentEdgesRef.current = edges;
      setNodeCount(nodes.length);

      if (saveTimeoutRef.current) {
        window.clearTimeout(saveTimeoutRef.current);
      }

      saveTimeoutRef.current = window.setTimeout(() => {
        const boardToSave: StoredBoard = {
          id: currentBoardId,
          name: boardName,
          updatedAt: Date.now(),
          nodes,
          edges,
        };
        saveBoard(boardToSave); // board-store 订阅自动刷新列表
      }, 600);
    },
    [currentBoardId, boardName, boardReady]
  );

  // 删除画板：confirm → 服务端 DELETE（若已登录）+ 本地清理；删当前画板时切到剩余第一个或空白画布
  const handleDeleteBoard = async (targetId: string) => {
    const target = boards.find((b) => b.id === targetId);
    if (!target) return;
    if (!window.confirm(`确定要删除画板「${target.name}」吗？该操作无法撤销。`)) return;

    // 防止待触发的防抖自动保存把已删除的画板重新写回本地
    if (saveTimeoutRef.current) {
      window.clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
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
      // 本地先出画面；无缓存再拉服务端（有未同步改动则本地版胜出）
      const cached = loadBoard(nextId);
      if (cached) {
        applyLoadedBoard(cached);
      } else if (user && !boardStore.isDirty(nextId)) {
        const loaded = await fetchBoardFromServer(nextId);
        if (seq !== loadSeqRef.current) return; // 期间用户已手动切换画板，丢弃本次结果
        if (loaded && !boardStore.isDirty(loaded.id)) applyLoadedBoard(loaded);
        else applyStarterBoard(nextId, remaining[0].name);
      } else {
        applyStarterBoard(nextId, remaining[0].name);
      }
    } else {
      // 全部删除：初始化「新画布 + 待填写主题」引导节点（对齐新账号语义）
      applyStarterBoard('default-board', '未命名思维画布');
    }
  };

  const handleRenameBoard = (newName: string) => {
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
    if (id === currentBoardId) setBoardName(newName);
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

  const handleSwitchBoard = async (targetId: string) => {
    if (targetId === currentBoardId) return;
    const seq = ++loadSeqRef.current; // 过期的加载结果直接丢弃（Spec A2 审计修复）
    // 本地先出画面（无网络等待）
    const cached = loadBoard(targetId);
    if (cached) {
      applyLoadedBoard(cached);
      showToast(`已载入画板「${cached.name}」`);
    }
    // 后台校验服务端版本（有未同步改动则本地版胜出，不覆盖）
    if (user && (!cached || !boardStore.isDirty(targetId))) {
      const loaded = await fetchBoardFromServer(targetId);
      if (seq !== loadSeqRef.current || !loaded) {
        if (!cached && seq === loadSeqRef.current) showToast('画板加载失败，请稍后重试');
        return;
      }
      if (boardStore.isDirty(loaded.id)) return;
      applyLoadedBoard(loaded);
      if (!cached) showToast(`已载入画板「${loaded.name}」`);
    } else if (!cached) {
      showToast('画板加载失败，请稍后重试');
    }
  };

  const handleNewBoard = () => {
    if (quotaStore.canCreate(isVip) === 'block') {
      openRechargeModal('免费版用户最多支持创建 3 个独立画板。升级 Pro 会员解锁无限画板与无限节点！');
      return;
    }
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

  const handleGoToLanding = () => {
    try {
      sessionStorage.setItem('deepdive_active_view', 'landing');
    } catch (e) {}
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

    // 快照节点 → 画布节点：数据为属主画布保存时的白名单形状，直通即可；
    // 仅归一化遗留的 generating 态（分享者中途生成就分享的极端情况），避免克隆后永久转圈
    const nodes = deduplicateNodes(body.nodes || []).map((n: Node) => {
      if (n.type !== 'chat') return n;
      const d = n.data as unknown as ChatNodeData;
      if (d.status !== 'generating') return n;
      return { ...n, data: { ...d, status: 'idle' as const, errorMessage: undefined } };
    });
    const edges = deduplicateEdges(body.edges || []);
    if (nodes.length === 0) {
      showToast('分享内容为空，未能克隆画板');
      return;
    }

    const boardId = uuidv7();
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

  const handleResetBoard = () => {
    if (window.confirm('确定要清空当前画板的所有节点吗？此操作无法撤销。')) {
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
  let vipBanner: { type: 'expiring' | 'grace'; text: string } | null = null;
  if (ent?.plan === 'vip' && ent.vipExpired) {
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
      <LandingPage onEnterCanvas={handleEnterCanvas} />
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
        onExportJson={handleExportJson}
        onExportMarkdown={handleExportMarkdown}
        onExportPng={handleExportPng}
        onShareLink={() => void handleShareLink()}
        onResetBoard={handleResetBoard}
        onGoToLanding={handleGoToLanding}
        onOpenSamples={() => setSampleViewerOpen(true)}
        onOpenLibrary={() => setLibraryOpen(true)}
        theme={theme}
        syncState={syncState}
        onToggleTheme={toggleTheme}
        nodeCount={nodeCount}
        showSuggestions={showSuggestions}
        onToggleSuggestions={toggleSuggestions}
      />

      {/* Main Infinite Canvas Viewport */}
      <main className="flex-1 w-full h-full pt-14 relative bg-slate-50/50 dark:bg-[#070b14] transition-colors duration-200">
        <ReactFlowProvider>
          <DeepDiveCanvas
            key={currentBoardId}
            initialNodes={initialNodes}
            initialEdges={initialEdges}
            onCanvasChange={handleCanvasChange}
            triggerAutoLayoutRef={triggerAutoLayoutRef}
            triggerFitViewRef={triggerFitViewRef}
            triggerAddRootRef={triggerAddRootRef}
            triggerAddNoteRef={triggerAddNoteRef}
            theme={theme}
            canvasId={currentBoardId}
            boardNeedsAutoName={isDefaultBoardName(boardName)}
            triggerExportPngRef={triggerExportPngRef}
            showSuggestions={showSuggestions}
          />
        </ReactFlowProvider>
        {/* Spec K5（D1）：空态新手 4 步 checklist（全完成/手动关闭后不再显示） */}
        <StarterChecklist hasBoards={boards.length > 0} />
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
      {toastMessage && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-slate-900/90 text-white px-4 py-2 rounded-full text-xs font-medium shadow-2xl backdrop-blur-md border border-slate-700/80 animate-in fade-in slide-in-from-bottom-2 duration-200">
          {toastMessage}
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <MainApp />
      <AuthModal />
      <UserProfileModal />
      <MySharesModal />
      <FeedbackModal />
      <RechargeModal />
      <AdminDashboardModal />
    </AuthProvider>
  );
}
