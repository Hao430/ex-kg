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
  loadBoardList,
  loadBoard,
  saveBoard,
  exportBoardToJson,
  exportBoardToMarkdown,
  fetchBoardFromServer,
  fetchBoardListFromServer,
  StoredBoard,
} from './lib/storage';
import { DeepDiveBoardMeta } from './types';
import { onSyncState } from './lib/sync-queue';
import { AuthProvider, useAuth } from './context/AuthContext';
import { AuthModal } from './components/auth/AuthModal';
import { RechargeModal } from './components/ui/RechargeModal';
import { AdminDashboardModal } from './components/admin/AdminDashboardModal';
import { UserProfileModal } from './components/ui/UserProfileModal';
import { FeedbackModal } from './components/ui/FeedbackModal';

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

  const [boards, setBoards] = useState<DeepDiveBoardMeta[]>([]);
  const [currentBoardId, setCurrentBoardId] = useState<string>('default-board');
  const [boardName, setBoardName] = useState<string>('量子计算深度探索');
  const [initialNodes, setInitialNodes] = useState<Node[] | undefined>(undefined);
  const [initialEdges, setInitialEdges] = useState<Edge[] | undefined>(undefined);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [nodeCount, setNodeCount] = useState<number>(1);

  const { isVip, openRechargeModal, user } = useAuth();

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

  const currentNodesRef = useRef<Node[]>([]);
  const currentEdgesRef = useRef<Edge[]>([]);
  const saveTimeoutRef = useRef<number | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 2500);
  };

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
      const detail = (e as CustomEvent).detail as { message?: string };
      showToast(detail?.message || '画板已在其他窗口被修改，请刷新后重试');
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
    return () => {
      window.removeEventListener('deepdive:canvas-save-conflict', onConflict);
      offSync();
      if (syncIdleTimerRef.current !== null) clearTimeout(syncIdleTimerRef.current);
    };
  }, []);

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

  // Load boards on startup（Spec A2：已登录时服务端为真源，失败回退本地）
  const loadSeqRef = useRef(0);
  useEffect(() => {
    let cancelled = false;
    const seq = ++loadSeqRef.current;
    const boot = async () => {
      const localList = loadBoardList();
      let activeId: string | undefined;
      let activeList: DeepDiveBoardMeta[] = localList;

      if (user) {
        const serverList = await fetchBoardListFromServer();
        if (cancelled || seq !== loadSeqRef.current) return;
        if (serverList) {
          // 服务端为主，本地独有画板（未同步草稿）保留在尾部
          const merged = [...serverList];
          for (const b of localList) {
            if (!merged.some((m) => m.id === b.id)) merged.push(b);
          }
          activeList = merged;
        }
      }

      if (activeList.length > 0) {
        setBoards(activeList);
        activeId = activeList[0].id;
      } else {
        const defaultMeta: DeepDiveBoardMeta = {
          id: 'default-board',
          name: '量子计算深度探索',
          updatedAt: Date.now(),
          nodeCount: 1,
        };
        setBoards([defaultMeta]);
        setNodeCount(1);
        setBoardReady(true);
        return;
      }

      if (!activeId) return;
      let loaded: StoredBoard | null = null;
      if (user) loaded = await fetchBoardFromServer(activeId);
      if (cancelled || seq !== loadSeqRef.current) return;
      if (!loaded) loaded = loadBoard(activeId);
      if (loaded) applyLoadedBoard(loaded);
      else setBoardReady(true);
    };
    void boot();
    return () => {
      cancelled = true;
    };
  }, [user?.id, applyLoadedBoard]);

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
        saveBoard(boardToSave);
        setBoards(loadBoardList());
      }, 600);
    },
    [currentBoardId, boardName, boardReady]
  );

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
    setBoards(loadBoardList());
    showToast(`画板已重命名为「${newName}」`);
  };

  const handleSwitchBoard = async (targetId: string) => {
    if (targetId === currentBoardId) return;
    const seq = ++loadSeqRef.current; // 过期的加载结果直接丢弃（Spec A2 审计修复）
    let loaded: StoredBoard | null = null;
    if (user) loaded = await fetchBoardFromServer(targetId); // Spec A2：服务端优先
    if (seq !== loadSeqRef.current) return; // 期间用户又切换了画板
    if (!loaded) loaded = loadBoard(targetId); // 回退本地草稿
    if (loaded) {
      applyLoadedBoard(loaded); // 加载完成后再整体切换，避免旧数据污染新画板
      showToast(`已载入画板「${loaded.name}」`);
    } else {
      showToast('画板加载失败，请稍后重试');
    }
  };

  const handleNewBoard = () => {
    if (!isVip && boards.length >= 3) {
      openRechargeModal('免费版用户最多支持创建 3 个独立画板。升级 Pro 会员解锁无限画板与无限节点！');
      return;
    }
    const newId = `board-${Date.now()}`;
    const newName = `探索课题 #${boards.length + 1}`;
    const emptyBoard: StoredBoard = {
      id: newId,
      name: newName,
      updatedAt: Date.now(),
      nodes: [],
      edges: [],
    };
    saveBoard(emptyBoard);
    const updatedList = loadBoardList();
    setBoards(updatedList);
    setCurrentBoardId(newId);
    setBoardName(newName);
    setInitialNodes([]);
    setInitialEdges([]);
    currentNodesRef.current = [];
    currentEdgesRef.current = [];
    setNodeCount(0);
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
        if (!isVip && boards.length >= 3) {
          openRechargeModal('免费版用户最多支持创建 3 个独立画板。升级 Pro 会员解锁无限画板！');
          return;
        }
        const newId = `board-${Date.now()}`;
        const newBoard: StoredBoard = {
          id: newId,
          name: presetTopic,
          updatedAt: Date.now(),
          nodes: [
            {
              id: `root-${Date.now()}`,
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
        saveBoard(newBoard);
        const updatedList = loadBoardList();
        setBoards(updatedList);
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

  const handleExportJson = () => {
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

  const handleResetBoard = () => {
    if (window.confirm('确定要清空当前画板的所有节点吗？此操作无法撤销。')) {
      localStorage.removeItem(`deepdive_board_${currentBoardId}`);
      localStorage.removeItem(`rabbithole_board_${currentBoardId}`);
      window.location.reload();
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
      <LandingPage
        onEnterCanvas={handleEnterCanvas}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
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
      {/* VIP 到期提醒横幅（Spec B3/B4） */}
      {vipBanner && !vipBannerDismissed && (
        <div
          data-testid="vip-banner"
          className={`absolute top-14 left-0 right-0 z-30 flex items-center justify-center gap-3 px-4 py-2 text-sm ${
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
      {/* Top Bar Navigation */}
      <Topbar
        boardName={boardName}
        onRenameBoard={handleRenameBoard}
        boards={boards}
        currentBoardId={currentBoardId}
        onSwitchBoard={(id) => void handleSwitchBoard(id)}
        onNewBoard={handleNewBoard}
        onAddRootNode={() => triggerAddRootRef.current?.()}
        onAddNoteNode={() => triggerAddNoteRef.current?.()}
        onAutoLayout={() => {
          triggerAutoLayoutRef.current?.();
          showToast('已自动按思维树重新规整排版');
        }}
        onFitView={() => triggerFitViewRef.current?.()}
        onExportJson={handleExportJson}
        onExportMarkdown={handleExportMarkdown}
        onResetBoard={handleResetBoard}
        onGoToLanding={handleGoToLanding}
        theme={theme}
        syncState={syncState}
        onToggleTheme={toggleTheme}
        nodeCount={nodeCount}
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
          />
        </ReactFlowProvider>
      </main>

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
      <FeedbackModal />
      <RechargeModal />
      <AdminDashboardModal />
    </AuthProvider>
  );
}
