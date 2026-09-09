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
  deleteBoard,
  exportBoardToJson,
  exportBoardToMarkdown,
  fetchBoardFromServer,
  fetchBoardListFromServer,
  StoredBoard,
} from './lib/storage';
import { exportCanvasAsPng } from './lib/canvas-image-export';
import { DeepDiveBoardMeta, ChatNodeData } from './types';
import { onSyncState } from './lib/sync-queue';
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
import { SampleBoardViewer } from './components/sample/SampleBoardViewer';
import { ShareLinkModal } from './components/ui/ShareLinkModal';
import { StarterChecklist } from './components/canvas/StarterChecklist';
import { AuthModal } from './components/auth/AuthModal';
import { RechargeModal } from './components/ui/RechargeModal';
import { AdminDashboardModal } from './components/admin/AdminDashboardModal';
import { UserProfileModal } from './components/ui/UserProfileModal';
import { MySharesModal } from './components/ui/MySharesModal';
import { FeedbackModal } from './components/ui/FeedbackModal';

/**
 * 新画布引导（H2）：注入一个待填写的主题根节点，避免新用户/新建画板面对纯空白画布。
 * 节点 question 为空 → ChatCardNode 渲染首个提问表单（「输入你想探索的议题」+ 推荐议题 pills），
 * 与 Topbar「添加主题节点」（DeepDiveCanvas.handleAddRootNode）的空根卡形态一致。
 */
function createStarterRootNode(): Node[] {
  return [
    {
      id: `root-${Date.now()}`,
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

  const [boards, setBoards] = useState<DeepDiveBoardMeta[]>([]);
  const [currentBoardId, setCurrentBoardId] = useState<string>('default-board');
  const [boardName, setBoardName] = useState<string>('量子计算深度探索');
  const [initialNodes, setInitialNodes] = useState<Node[] | undefined>(undefined);
  const [initialEdges, setInitialEdges] = useState<Edge[] | undefined>(undefined);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [nodeCount, setNodeCount] = useState<number>(1);

  const { isVip, openRechargeModal, user, resendVerification } = useAuth();

  // Spec K5（D1）：示例画布只读查看器开关（Topbar「示例画布」入口）
  const [sampleViewerOpen, setSampleViewerOpen] = useState(false);

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
        // Spec B: 新账号/无任何画布时初始为「新画布 + 待填写主题」引导节点（不再注入量子演示画布）
        const defaultMeta: DeepDiveBoardMeta = {
          id: 'default-board',
          name: '未命名思维画布',
          updatedAt: Date.now(),
          nodeCount: 1,
        };
        setBoards([defaultMeta]);
        setInitialNodes(createStarterRootNode());
        setInitialEdges([]);
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

    const result = await deleteBoard(targetId);
    if (!result.ok) {
      setBoardReady(true); // 删除失败：停留在原画布，恢复编辑能力
      showToast('删除失败，请稍后重试');
      return;
    }
    const remaining = boards.filter((b) => b.id !== targetId);
    setBoards(remaining);
    showToast(`已删除画板「${target.name}」`);

    if (targetId !== currentBoardId) {
      setBoardReady(true); // 删除的是非当前画板：当前画布不受影响
      return;
    }
    if (remaining.length > 0) {
      const nextId = remaining[0].id;
      const seq = ++loadSeqRef.current;
      let loaded: StoredBoard | null = null;
      if (user) loaded = await fetchBoardFromServer(nextId);
      if (seq !== loadSeqRef.current) return; // 期间用户已手动切换画板，丢弃本次结果
      if (!loaded) loaded = loadBoard(nextId);
      if (loaded) {
        // setCurrentBoardId 与 setInitialNodes 同批提交（applyLoadedBoard）：
        // key remount 拿到的就是新内容——先切 id 后加载数据会让画布显示被删内容
        applyLoadedBoard(loaded);
      } else {
        // 服务端与本地均无内容：给引导节点，绝不复用被删画布的内容
        setCurrentBoardId(nextId);
        setBoardName(remaining[0].name);
        const starter = createStarterRootNode();
        setInitialNodes(starter);
        setInitialEdges([]);
        currentNodesRef.current = starter;
        currentEdgesRef.current = [];
        setNodeCount(1);
        setBoardReady(true);
      }
    } else {
      // 全部删除：初始化「新画布 + 待填写主题」引导节点（对齐新账号语义）
      setCurrentBoardId('default-board');
      setBoardName('未命名思维画布');
      const starter = createStarterRootNode();
      setInitialNodes(starter);
      setInitialEdges([]);
      currentNodesRef.current = starter;
      currentEdgesRef.current = [];
      setNodeCount(1);
      setBoardReady(true);
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
    setBoards(loadBoardList());
    showToast(`画板已重命名为「${newName}」`);
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
      setBoards(loadBoardList());
      showToast(`画板已自动命名为「${safe}」`);
    };
    window.addEventListener('deepdive:board-autotitle', handler);
    return () => window.removeEventListener('deepdive:board-autotitle', handler);
  }, [currentBoardId, boardName]);

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
    const starterNodes = createStarterRootNode();
    const emptyBoard: StoredBoard = {
      id: newId,
      name: newName,
      updatedAt: Date.now(),
      nodes: starterNodes,
      edges: [],
    };
    saveBoard(emptyBoard);
    const updatedList = loadBoardList();
    setBoards(updatedList);
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
        trackEvent('board_create'); // K4 事件 5：画板创建（不携带画板名，避免 PII）
        markChecklistStep('board'); // K5/D1：checklist 第 1 步
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
    if (!isVip && loadBoardList().length >= 3) {
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

    const boardId = `board-${Date.now()}`;
    const boardName = String(body.title || '克隆的分享画板').slice(0, 60);
    saveBoard({ id: boardId, name: boardName, updatedAt: Date.now(), nodes, edges });
    markShareCloned(intent.code);
    takeCloneIntent(); // 克隆成功：焚毁意图

    const updatedList = loadBoardList();
    setBoards(updatedList);
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
            canvasId={currentBoardId}
            boardNeedsAutoName={isDefaultBoardName(boardName)}
            triggerExportPngRef={triggerExportPngRef}
          />
        </ReactFlowProvider>
        {/* Spec K5（D1）：空态新手 4 步 checklist（全完成/手动关闭后不再显示） */}
        <StarterChecklist hasBoards={boards.length > 0} />
      </main>

      {/* Spec K5（D1）：示例画布只读查看器（纯前端静态内容，不占用户配额） */}
      {sampleViewerOpen && (
        <SampleBoardViewer onClose={() => setSampleViewerOpen(false)} />
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
