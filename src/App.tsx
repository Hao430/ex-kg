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
  StoredBoard,
} from './lib/storage';
import { DeepDiveBoardMeta } from './types';
import { AuthProvider } from './context/AuthContext';
import { AuthModal } from './components/auth/AuthModal';
import { RechargeModal } from './components/ui/RechargeModal';
import { AdminDashboardModal } from './components/admin/AdminDashboardModal';

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

  // Load boards on startup
  useEffect(() => {
    const list = loadBoardList();
    if (list.length > 0) {
      setBoards(list);
      const activeId = list[0].id;
      setCurrentBoardId(activeId);
      const loaded = loadBoard(activeId);
      if (loaded) {
        setBoardName(loaded.name);
        setInitialNodes(loaded.nodes);
        setInitialEdges(loaded.edges);
        currentNodesRef.current = loaded.nodes;
        currentEdgesRef.current = loaded.edges;
      }
    } else {
      const defaultMeta: DeepDiveBoardMeta = {
        id: 'default-board',
        name: '量子计算深度探索',
        updatedAt: Date.now(),
        nodeCount: 1,
      };
      setBoards([defaultMeta]);
    }
  }, []);

  // Debounced auto-save whenever nodes or edges change
  const handleCanvasChange = useCallback(
    (nodes: Node[], edges: Edge[]) => {
      currentNodesRef.current = nodes;
      currentEdgesRef.current = edges;

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
    [currentBoardId, boardName]
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

  const handleSwitchBoard = (targetId: string) => {
    if (targetId === currentBoardId) return;
    const loaded = loadBoard(targetId);
    if (loaded) {
      setCurrentBoardId(targetId);
      setBoardName(loaded.name);
      setInitialNodes(loaded.nodes);
      setInitialEdges(loaded.edges);
      currentNodesRef.current = loaded.nodes;
      currentEdgesRef.current = loaded.edges;
      showToast(`已载入画板「${loaded.name}」`);
    }
  };

  const handleNewBoard = () => {
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
              draggable: true,
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

  if (viewMode === 'landing') {
    return (
      <LandingPage
        onEnterCanvas={handleEnterCanvas}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
    );
  }

  return (
    <div className="w-screen h-screen overflow-hidden bg-slate-100 dark:bg-[#070b14] text-slate-900 dark:text-slate-100 flex flex-col font-sans select-none transition-colors duration-200">
      {/* Top Bar Navigation */}
      <Topbar
        boardName={boardName}
        onRenameBoard={handleRenameBoard}
        boards={boards}
        currentBoardId={currentBoardId}
        onSwitchBoard={handleSwitchBoard}
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
        onToggleTheme={toggleTheme}
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
      <RechargeModal />
      <AdminDashboardModal />
    </AuthProvider>
  );
}
