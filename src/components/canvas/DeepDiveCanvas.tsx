/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  ReactFlow,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  Edge,
  Node,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  useReactFlow,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { ChatCardNode } from '../nodes/ChatCardNode';
import { NoteCardNode } from '../nodes/NoteCardNode';
import { withErrorBoundary, ErrorBoundary } from '../ErrorBoundary';
import { SelectionPopup } from './SelectionPopup';
import { ChatNodeData, TextSelectionPayload, GroundingMetadata } from '../../types';
import { getLayoutedElements } from '../../lib/layout';
import { exportCanvasAsPng } from '../../lib/canvas-image-export';
import { buildAncestorContext } from '../../lib/context';
import { onSyncState } from '../../lib/sync-queue';
import { saveBoard, StoredBoard, deduplicateNodes, deduplicateEdges } from '../../lib/storage';
import { canCreate, markPendingCreate } from '../../lib/quota-store';
import { extractSuggestions, getFallbackSuggestions } from '../../lib/suggestions';
import { NodeActionsContext, NodeActionsContextValue } from '../../context/NodeActionsContext';
import { useAuth } from '../../context/AuthContext';
import { useRenderMonitor } from '../../hooks/useRenderMonitor';
import { trackEvent, trackOnce } from '../../lib/analytics';
import { markChecklistStep } from '../../lib/checklist';
import { uuidv7 } from '../../lib/uuid.js';
import { AlertCircle, Sparkles, X, FolderPlus, AlertTriangle, Trash2 } from 'lucide-react';

// id 生成统一 UUIDv7（路线 A，2026-09-10）：恒 36 字符、不可枚举、时间前缀 B-tree 友好；
// ADR-0013 的「前缀截断防 varchar(64) 22001」防御随之消亡（不再有前缀拼接，见 src/lib/uuid.ts）
export const generateUniqueId = (): string => uuidv7();

// 技术债 #0032：节点级错误边界——单个节点渲染抛错降级为占位卡片，不再拖垮整画布
const nodeTypes = {
  chat: withErrorBoundary(ChatCardNode),
  note: withErrorBoundary(NoteCardNode),
};

// ---- Edge style constants: unified definitions to avoid repeating inline style objects in multiple places ----
const AI_EDGE_COLOR = '#6366f1';
const NOTE_EDGE_COLOR = '#d97706';
const AI_EDGE_STYLE: React.CSSProperties = { stroke: AI_EDGE_COLOR, strokeWidth: 2 };
const AI_SUGGEST_EDGE_STYLE: React.CSSProperties = {
  stroke: AI_EDGE_COLOR,
  strokeWidth: 1.8,
  strokeDasharray: '4,4',
};
const NOTE_EDGE_STYLE: React.CSSProperties = { stroke: NOTE_EDGE_COLOR, strokeWidth: 2 };
const NOTE_ANIMATED_EDGE_STYLE: React.CSSProperties = {
  stroke: NOTE_EDGE_COLOR,
  strokeWidth: 2,
  strokeDasharray: '4,3',
};
const AI_EDGE_MARKER: Edge['markerEnd'] = { type: MarkerType.ArrowClosed, color: AI_EDGE_COLOR };
const NOTE_EDGE_MARKER: Edge['markerEnd'] = { type: MarkerType.ArrowClosed, color: NOTE_EDGE_COLOR };


interface DeepDiveCanvasProps {
  initialNodes?: Node[];
  initialEdges?: Edge[];
  onCanvasChange?: (nodes: Node[], edges: Edge[]) => void;
  triggerAutoLayoutRef?: React.MutableRefObject<(() => void) | null>;
  triggerFitViewRef?: React.MutableRefObject<(() => void) | null>;
  triggerAddRootRef?: React.MutableRefObject<(() => void) | null>;
  triggerAddNoteRef?: React.MutableRefObject<(() => void) | null>;
  theme?: 'light' | 'dark';
  defaultModel?: string;
  defaultEnableWebSearch?: boolean;
  /** 当前画板 id：随 /api/chat 请求体上报，供审计归因与画布级节点配额校验 */
  canvasId?: string;
  /** 自动命名：画板名仍为默认名（未命名/探索课题 #N）时为 true，首节点完成后附带生成画板名 */
  boardNeedsAutoName?: boolean;
  /** PNG 导出触发器：App 侧调用，画布内部先关虚拟化全量渲染再捕获（修复导出图丢连线） */
  triggerExportPngRef?: React.MutableRefObject<
    ((title: string) => Promise<{ ok: boolean; error?: string }>) | null
  >;
  /** 探索灵感节点（status='suggested'）显示开关：仅视图级隐藏，数据层与配额口径不受影响 */
  showSuggestions?: boolean;
}

export const DeepDiveCanvas: React.FC<DeepDiveCanvasProps> = ({
  initialNodes,
  initialEdges,
  onCanvasChange,
  triggerAutoLayoutRef,
  triggerFitViewRef,
  triggerAddRootRef,
  triggerAddNoteRef,
  theme = 'light',
  defaultModel = '',
  defaultEnableWebSearch = true,
  canvasId,
  boardNeedsAutoName = false,
  triggerExportPngRef,
  showSuggestions = true,
}) => {
  const [nodes, setNodes, onNodesChange] = useNodesState(
    initialNodes || []
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState(
    initialEdges || []
  );
  const [selectionPayload, setSelectionPayload] = useState<TextSelectionPayload | null>(null);
  const [apiWarning, setApiWarning] = useState<string | null>(null);
  const [dismissLargeCanvasBanner, setDismissLargeCanvasBanner] = useState(false);
  const [deleteConfirmTarget, setDeleteConfirmTarget] = useState<{
    nodeId: string;
    nodeTitle: string;
    descendantCount: number;
    allTargetIds: string[];
  } | null>(null);
  const renderWarning = useRenderMonitor('DeepDiveCanvas');
  const reactFlowInstance = useReactFlow();
  const { isVip, openAuthModal, openRechargeModal } = useAuth();

  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  // Spec J2：服务端配额单一事实源（GET /api/quota，口径含 suggested 与后端拦截完全一致）。
  // null = 余量未知（VIP/Admin 不受限、查询失败或未同步）——此时前端不做本地拦截，由服务端 chat 403 兜底。
  const [serverNodeQuota, setServerNodeQuota] = useState<{ limit: number; remaining: number } | null>(null);
  const refreshServerQuota = useCallback(async () => {
    if (!canvasId || isVip) {
      setServerNodeQuota(null);
      return;
    }
    try {
      const res = await fetch(`/api/quota?canvasId=${encodeURIComponent(canvasId)}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        setServerNodeQuota(null);
        return;
      }
      const body = await res.json();
      const node = body?.node;
      setServerNodeQuota(
        node && typeof node.limit === 'number' && typeof node.remaining === 'number'
          ? { limit: node.limit, remaining: node.remaining }
          : null
      );
    } catch {
      setServerNodeQuota(null);
    }
  }, [canvasId, isVip]);

  useEffect(() => {
    refreshServerQuota();
    // 自动保存成功（服务端节点计数已更新）后刷新余量，保证展示与后端判定同源
    const off = onSyncState((state, boardId) => {
      if (state === 'saved' && boardId === canvasId) refreshServerQuota();
    });
    return off;
  }, [refreshServerQuota, canvasId]);

  // Free Tier AI Node Limit Check（余量来源：服务端 /api/quota，J2 起不再本地计数）
  const checkAiQuota = useCallback((): boolean => {
    if (isVip) return true;
    if (serverNodeQuota !== null) {
      // 乐观余量：用本地实时 chat 节点数（含 suggested，与后端同口径）对齐 limit，
      // 消除「编辑后到防抖保存完成前」的滞后窗口——删除节点余量立即可见，新增也即时计入
      const localUsed = nodesRef.current.filter((n) => (n.type || 'chat') === 'chat').length;
      const effectiveRemaining = Math.max(0, serverNodeQuota.limit - localUsed);
      if (effectiveRemaining <= 0) {
        // K4 事件 10：配额墙触达（免费版转化漏斗核心指标；remaining 为计数非 PII）
        trackEvent('quota_wall', { remaining: effectiveRemaining });
        // Spec K7：传入画板上下文，升级弹窗可展示当前画板真实节点余量
        openRechargeModal('当前画板的 AI 推理节点额度已用完。升级 Pro 畅享无限节点深度探索与推演！', canvasId ?? undefined);
        return false;
      }
      return true;
    }
    return true;
  }, [isVip, openRechargeModal, serverNodeQuota, canvasId]);

  // Auto-save sync back to parent（拖动期间跳过逐帧上报，dragstop 一次性上报终态，避免每帧重排防抖定时器）
  const isDraggingRef = useRef(false);
  useEffect(() => {
    if (isDraggingRef.current) return;
    onCanvasChange?.(nodes, edges);
  }, [nodes, edges, onCanvasChange]);
  const handleNodeDragStart = useCallback(() => {
    isDraggingRef.current = true;
  }, []);
  const handleNodeDragStop = useCallback(() => {
    isDraggingRef.current = false;
    onCanvasChange?.(nodesRef.current, edgesRef.current);
  }, [onCanvasChange]);
  const handleSelectionDragStart = useCallback(() => {
    isDraggingRef.current = true;
  }, []);
  const handleSelectionDragStop = useCallback(() => {
    isDraggingRef.current = false;
    onCanvasChange?.(nodesRef.current, edgesRef.current);
  }, [onCanvasChange]);

  // Layout function (Zero-drag automatic tidy tree)
  const applyLayout = useCallback(
    (currentNodes = nodesRef.current, currentEdges = edgesRef.current) => {
      const layouted = getLayoutedElements(currentNodes, currentEdges, 'LR');
      // 布局无变化（缓存命中且位置未动）时跳过 setNodes，避免无谓的全画布重渲染
      if (layouted.nodes !== currentNodes) setNodes(layouted.nodes);
      if (layouted.edges !== currentEdges) setEdges(layouted.edges);
      window.requestAnimationFrame(() => {
        reactFlowInstance.fitView({ padding: 0.25, duration: 400 });
      });
    },
    [reactFlowInstance, setNodes, setEdges]
  );

  // MiniMap 节点配色（useCallback 按 theme 记忆化，避免内联函数使 MiniMap memo 失效）
  const minimapNodeColor = useCallback(
    (n: Node) => {
      if (n.type === 'note') return theme === 'dark' ? '#d97706' : '#f59e0b';
      if ((n.data as any)?.status === 'suggested') return theme === 'dark' ? '#6366f1' : '#a5b4fc';
      return theme === 'dark' ? '#4f46e5' : '#6366f1';
    },
    [theme]
  );

  // Helper to extract clean user-friendly error message
  const sanitizeErrorMessage = (raw: unknown): string => {
    if (!raw) return '生成出错，请重试';
    let str = (raw as any)?.message || String(raw);
    try {
      if (typeof str === 'string' && (str.startsWith('{') || str.includes('{\n'))) {
        const start = str.indexOf('{');
        const parsed = JSON.parse(str.slice(start));
        if (parsed?.error?.message) {
          try {
            const nested = JSON.parse(parsed.error.message);
            if (nested?.error?.message) return nested.error.message;
          } catch {}
          return parsed.error.message;
        }
      }
    } catch {}
    if (str.includes('503') || str.includes('high demand') || str.includes('UNAVAILABLE')) {
      return '模型并发访问量较高，请点击重试。';
    }
    if (str.includes('429') || str.includes('RESOURCE_EXHAUSTED')) {
      return '请求频次较高，请稍候再试。';
    }
    return str;
  };

  // Automatically spawn suggested question nodes connected to parent
  const spawnSuggestedNodes = useCallback(
    (parentNodeId: string, suggestions: string[], parentDepth: number, currentBaseNodes?: Node[]) => {
      if (!suggestions || suggestions.length === 0) return;

      const newNodes: Node[] = [];
      const newEdges: Edge[] = [];

      suggestions.slice(0, 3).forEach((questionText, idx) => {
        const sugId = generateUniqueId();
        const title = questionText.slice(0, 16);

        const sugNode: Node = {
          id: sugId,
          type: 'chat',
          draggable: false,
          position: { x: 0, y: 0 }, // Layout will position correctly
          data: {
            title,
            depth: parentDepth + 1,
            question: questionText,
            answer: '',
            status: 'suggested',
            parentId: parentNodeId,
            model: defaultModel || '',
            enableWebSearch: defaultEnableWebSearch,
          },
        };

        const sugEdge: Edge = {
          id: generateUniqueId(),
          source: parentNodeId,
          target: sugId,
          type: 'default',
          animated: true,
          style: AI_SUGGEST_EDGE_STYLE,
          markerEnd: AI_EDGE_MARKER,
        };

        newNodes.push(sugNode);
        newEdges.push(sugEdge);
      });

      const baseList = currentBaseNodes || nodesRef.current;
      const updatedNodes = deduplicateNodes([...baseList, ...newNodes]);
      const updatedEdges = deduplicateEdges([...edgesRef.current, ...newEdges]);

      // Auto-layout to align cleanly
      const layouted = getLayoutedElements(updatedNodes, updatedEdges, 'LR');
      nodesRef.current = layouted.nodes;
      edgesRef.current = layouted.edges;
      setNodes(nodesRef.current);
      setEdges(edgesRef.current);
    },
    [defaultModel, defaultEnableWebSearch, setNodes, setEdges]
  );

  // 自动命名（只命名一次）：节点生成成功后独立调用 LLM 命名端点。
  // 手动改过标题（titleManual）或已消耗命名机会（autoTitled）的节点跳过；
  // 画板名仅在 App 侧仍为默认名时由 boardNeedsAutoName 触发附带生成，经事件回传 App 采纳。
  const autoTitleNode = useCallback(
    async (nodeId: string, question: string, answer: string) => {
      const target = nodesRef.current.find((n) => n.id === nodeId);
      const d = target?.data as unknown as ChatNodeData | undefined;
      if (!d || d.titleManual || d.autoTitled) return;
      try {
        const res = await fetch(
          `/api/canvases/${encodeURIComponent(canvasId || 'local')}/auto-title`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              nodeId,
              question: question.slice(0, 2000),
              answer: answer.slice(0, 3000),
              includeBoard: Boolean(canvasId && boardNeedsAutoName),
            }),
          }
        );
        if (!res.ok) return; // 失败不置标志：下次生成可重试命名
        const body = await res.json();
        const nodeTitle = typeof body?.nodeTitle === 'string' ? body.nodeTitle.trim() : '';
        setNodes((nds) =>
          nds.map((n) => {
            if (n.id !== nodeId) return n;
            const nd = n.data as unknown as ChatNodeData;
            return {
              ...n,
              data: { ...nd, autoTitled: true, ...(nodeTitle ? { title: nodeTitle } : {}) },
            };
          })
        );
        const boardTitle = typeof body?.boardTitle === 'string' ? body.boardTitle.trim() : '';
        if (boardTitle && canvasId && boardNeedsAutoName) {
          window.dispatchEvent(
            new CustomEvent('deepdive:board-autotitle', {
              detail: { boardId: canvasId, title: boardTitle },
            })
          );
        }
      } catch {
        // 网络失败：保留截断标题，标志不置位，下次生成可重试
      }
    },
    [canvasId, boardNeedsAutoName, setNodes]
  );

  // Core generator for answering a question in a single node
  const generateNodeAnswer = useCallback(
    async (
      nodeId: string,
      questionText: string,
      options?: { model?: string; enableWebSearch?: boolean }
    ) => {
      if (!checkAiQuota()) return;
      // K4 事件 6：每画板首次发起 AI 生成（终身一次去重，衡量激活深度）
      if (canvasId) trackOnce(`ai_first_${canvasId}`, 'ai_generate_first');
      // K5/D1：checklist 第 3 步（发起过一次 AI 生成）
      markChecklistStep('generate');

      const targetNode = nodesRef.current.find((n) => n.id === nodeId);
      const existingData = targetNode?.data as unknown as ChatNodeData | undefined;

      const activeModel =
        options?.model || existingData?.model || defaultModel || '';
      const activeWebSearch =
        options?.enableWebSearch !== undefined
          ? options.enableWebSearch
          : existingData?.enableWebSearch !== undefined
          ? existingData.enableWebSearch
          : defaultEnableWebSearch;

      // Set generating status
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== nodeId) return n;
          const d = n.data as unknown as ChatNodeData;
          return {
            ...n,
            data: {
              ...d,
              title: !d.title || d.title === '新探索主题' ? questionText.slice(0, 16) : d.title,
              question: questionText,
              status: 'generating',
              model: activeModel,
              enableWebSearch: activeWebSearch,
              errorMessage: undefined,
            },
          };
        })
      );

      // Assemble full ancestor lineage context
      const ancestorContext = buildAncestorContext(nodeId, nodesRef.current, edgesRef.current);
      // Ensure current question is the last user message
      const lastContext = ancestorContext[ancestorContext.length - 1];
      if (!lastContext || lastContext.content !== questionText) {
        ancestorContext.push({ role: 'user', content: questionText });
      }

      let rawAccumulatedText = '';
      let receivedGrounding: GroundingMetadata | undefined = undefined;

      const abortController = new AbortController();
      let isCompleted = false;
      
      const timeoutId = setTimeout(() => {
        if (!isCompleted) {
          setApiWarning('AI 模型响应较慢，由于云端推理排队或并发较高，请您耐心等待...');
          setTimeout(() => setApiWarning(null), 5000);
        }
      }, 10000); // 10 seconds gentle prompt

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            messages: ancestorContext,
            model: activeModel,
            enableWebSearch: activeWebSearch,
            canvasId: canvasId ?? null,
            nodeId,
          }),
          signal: abortController.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok || !response.body) {
          let errDetail = `请求失败: ${response.statusText || response.status}`;
          try {
            const bodyJson = await response.json();
            if (bodyJson?.error) errDetail = sanitizeErrorMessage(bodyJson.error);
          } catch {}

          if (response.status === 401) {
            openAuthModal('signin');
            errDetail = '请先登录后再提问，欢迎加入枝想开启深度探索';
          }

          throw new Error(errDetail);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // Process any trailing data left in buffer
            if (buffer.trim()) {
              const trailingLines = buffer.split('\n');
              for (const line of trailingLines) {
                if (line.startsWith('data: ')) {
                  try {
                    const parsed = JSON.parse(line.slice(6));
                    if (parsed.grounding) receivedGrounding = parsed.grounding;
                    if (parsed.text) rawAccumulatedText += parsed.text;
                  } catch {
                    // Ignore parse error on partial chunks
                  }
                }
              }
            }
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n\n');
          buffer = lines.pop() || '';

          let streamCompleted = false;
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const parsed = JSON.parse(line.slice(6));
                if (parsed.error) {
                  throw new Error(parsed.error);
                }
                if (parsed.grounding) {
                  receivedGrounding = parsed.grounding;
                }
                if (parsed.done) {
                  if (parsed.grounding) {
                    receivedGrounding = parsed.grounding;
                  }
                  streamCompleted = true;
                  break;
                }
                if (parsed.reset) {
                  rawAccumulatedText = '';
                  // 模型容灾换流：旧流来源一并作废，避免「文本无来源、列表留旧来源」错位
                  receivedGrounding = undefined;
                  setNodes((nds) =>
                    nds.map((n) => {
                      if (n.id !== nodeId) return n;
                      const d = n.data as unknown as ChatNodeData;
                      return {
                        ...n,
                        data: {
                          ...d,
                          answer: '',
                        },
                      };
                    })
                  );
                  continue;
                }
                if (parsed.text) {
                  rawAccumulatedText += parsed.text;

                  // Separate answer from suggestions in real-time
                  const currentAnswer = extractSuggestions(rawAccumulatedText).answer.trimEnd();

                  // Stream answer update into card
                  setNodes((nds) =>
                    nds.map((n) => {
                      if (n.id !== nodeId) return n;
                      const d = n.data as unknown as ChatNodeData;
                      return {
                        ...n,
                        data: {
                          ...d,
                          answer: currentAnswer,
                        },
                      };
                    })
                  );
                }
              } catch (e: any) {
                if (e.message && !e.message.includes('JSON')) {
                  throw e;
                }
              }
            }
          }
          if (streamCompleted) break;
        }

        // Stream finished: finalize answer and parse suggestions
        const { answer: finalAnswer, suggestions: modelSuggestions } = extractSuggestions(rawAccumulatedText);
        let parsedSuggestions = modelSuggestions;

        if (parsedSuggestions.length === 0) {
          parsedSuggestions = getFallbackSuggestions(questionText);
        }

        // Get parent depth
        const currentNode = nodesRef.current.find((n) => n.id === nodeId);
        const currentDepth = (currentNode?.data as unknown as ChatNodeData)?.depth ?? 0;

        // Atomically prepare finalized nodes with completed idle status
        const finalizedNodes = nodesRef.current.map((n) => {
          if (n.id !== nodeId) return n;
          const d = n.data as unknown as ChatNodeData;
          return {
            ...n,
            data: {
              ...d,
              answer: finalAnswer,
              status: 'idle' as const,
              suggestionsSpawned: true,
              model: activeModel,
              enableWebSearch: activeWebSearch,
              grounding: receivedGrounding || d.grounding,
              errorMessage: undefined,
            },
          };
        });

        // Immediately sync nodesRef and React state to avoid race conditions
        nodesRef.current = finalizedNodes;
        setNodes(finalizedNodes);

        // Auto-spawn suggested question nodes using the fresh finalizedNodes
        spawnSuggestedNodes(nodeId, parsedSuggestions, currentDepth, finalizedNodes);

        // 自动命名（fire-and-forget，不阻塞卡片就绪；只命名一次）
        void autoTitleNode(nodeId, questionText, finalAnswer);
      } catch (err: any) {
        console.error('Error generating AI response:', err);
        const friendlyMessage = sanitizeErrorMessage(err);
        setNodes((nds) => {
          const updated = nds.map((n) => {
            if (n.id !== nodeId) return n;
            const d = n.data as unknown as ChatNodeData;
            return {
              ...n,
              data: {
                ...d,
                status: 'error' as const,
                errorMessage: friendlyMessage,
              },
            };
          });
          nodesRef.current = updated;
          return updated;
        });
      }
    },
    [defaultModel, defaultEnableWebSearch, setNodes, spawnSuggestedNodes, autoTitleNode]
  );

  // Shared helper: create a child chat node + edge under a source node, auto-layout, pan camera to the new node, start generation
  const createChildChatNode = useCallback(
    (params: {
      sourceNodeId: string;
      question: string;
      title: string | ((depth: number) => string);
      options?: { model?: string; enableWebSearch?: boolean };
      branchTriggerPhrase?: string;
    }) => {
      const { sourceNodeId, question, branchTriggerPhrase } = params;
      const sourceNode = nodesRef.current.find((n) => n.id === sourceNodeId);
      const parentData = sourceNode?.data as unknown as ChatNodeData | undefined;
      const depth = (parentData?.depth ?? 0) + 1;

      const activeModel =
        params.options?.model || parentData?.model || defaultModel || '';
      const activeWebSearch =
        params.options?.enableWebSearch !== undefined
          ? params.options.enableWebSearch
          : parentData?.enableWebSearch !== undefined
          ? parentData.enableWebSearch
          : defaultEnableWebSearch;

      const newId = generateUniqueId();
      const title =
        typeof params.title === 'function' ? params.title(depth) : params.title;

      const newNode: Node = {
        id: newId,
        type: 'chat',
        position: { x: 0, y: 0 }, // Layout will position correctly
        draggable: false,
        data: {
          title,
          depth,
          question,
          answer: '',
          status: 'generating',
          model: activeModel,
          enableWebSearch: activeWebSearch,
          parentId: sourceNodeId,
          ...(branchTriggerPhrase ? { branchTriggerPhrase } : {}),
        },
      };

      const newEdge: Edge = {
        id: generateUniqueId(),
        source: sourceNodeId,
        target: newId,
        type: 'default',
        style: AI_EDGE_STYLE,
        markerEnd: AI_EDGE_MARKER,
      };

      // Auto-layout with smooth transition (输入已去重，layout 产物无需再次去重)
      const layouted = getLayoutedElements(
        deduplicateNodes([...nodesRef.current, newNode]),
        deduplicateEdges([...edgesRef.current, newEdge]),
        'LR'
      );
      nodesRef.current = layouted.nodes;
      edgesRef.current = layouted.edges;
      setNodes(nodesRef.current);
      setEdges(edgesRef.current);

      // Smooth camera pan to the newly branched child node
      setTimeout(() => {
        const targetNode = layouted.nodes.find((n) => n.id === newId);
        if (targetNode) {
          reactFlowInstance.setCenter(
            targetNode.position.x + 220,
            targetNode.position.y + 180,
            { zoom: 0.9, duration: 600 }
          );
        }
      }, 50);

      // Start generation in the new node
      setTimeout(() => {
        generateNodeAnswer(newId, question, {
          model: activeModel,
          enableWebSearch: activeWebSearch,
        });
      }, 100);
    },
    [defaultModel, defaultEnableWebSearch, generateNodeAnswer, reactFlowInstance, setNodes, setEdges]
  );

  // Requirement 2: Follow-up inquiry creates a NEW child node for the next dialogue
  const handleFollowUpInquiry = useCallback(
    (
      sourceNodeId: string,
      questionText: string,
      options?: { model?: string; enableWebSearch?: boolean }
    ) => {
      if (!checkAiQuota()) return;
      createChildChatNode({
        sourceNodeId,
        question: questionText,
        title: questionText.slice(0, 16),
        options,
      });
    },
    [checkAiQuota, createChildChatNode]
  );

  // Requirement 3: User clicks on a suggested question node to generate answer
  const handleActivateSuggestion = useCallback(
    (nodeId: string) => {
      if (!checkAiQuota()) return;
      const targetNode = nodesRef.current.find((n) => n.id === nodeId);
      if (!targetNode) return;
      const nodeData = targetNode.data as unknown as ChatNodeData;
      const question: string = nodeData.question || (targetNode.data as any)?.title || '请展开探讨此主题';

      // Transform edge to solid active line
      setEdges((eds) =>
        eds.map((e) => {
          if (e.target === nodeId) {
            return {
              ...e,
              animated: false,
              style: AI_EDGE_STYLE,
              markerEnd: AI_EDGE_MARKER,
            };
          }
          return e;
        })
      );

      // Start generating answer
      generateNodeAnswer(nodeId, question);
    },
    [checkAiQuota, generateNodeAnswer, setEdges]
  );

  // Branch from node / phrase (DeepDive text selection feature)
  const handleBranch = useCallback(
    (sourceNodeId: string, triggerPhrase?: string) => {
      if (!checkAiQuota()) return;
      // K5/D1：checklist 第 2 步（划词/节点分支）
      markChecklistStep('branch');
      createChildChatNode({
        sourceNodeId,
        question: triggerPhrase
          ? `请围绕「${triggerPhrase}」深入展开剖析其核心原理与关键影响。`
          : '请在此分支展开深度探索与推演。',
        title: (depth) =>
          triggerPhrase ? `深入: ${triggerPhrase.slice(0, 15)}` : `深度 #${depth} 分支`,
        options: { model: 'gemini-flash-latest' },
        branchTriggerPhrase: triggerPhrase,
      });
    },
    [checkAiQuota, createChildChatNode]
  );

  // Helper to recursively collect all descendant node IDs downstream
  const getDescendantNodeIds = useCallback((rootId: string, currentEdges = edgesRef.current): Set<string> => {
    const descendants = new Set<string>();
    const queue = [rootId];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      const outgoing = currentEdges.filter((e) => e.source === curr);
      outgoing.forEach((e) => {
        if (!descendants.has(e.target)) {
          descendants.add(e.target);
          queue.push(e.target);
        }
      });
    }
    return descendants;
  }, []);

  // 手动连线校验（isValidConnection）：同一条推导链上的节点禁止互连——
  // 祖先方向（会成环，服务端 NODE_PARENT_CYCLE 兜底）与后代方向（同链捷径）都拦；
  // 同时拦截自连与重复连线。跨分支连线不受限。
  const isValidConnection = useCallback(
    (connection: Connection): boolean => {
      const { source, target } = connection;
      if (!source || !target || source === target) return false;

      // target 是 source 的祖先（沿入边上溯；含 source===target 已被上方拦截）
      let cur: string | undefined = target;
      const visited = new Set<string>();
      while (cur && !visited.has(cur)) {
        if (cur === source) return false;
        visited.add(cur);
        cur = edgesRef.current.find((e) => e.target === cur)?.source;
      }

      // target 是 source 的后代（下溯）
      if (getDescendantNodeIds(source).has(target)) return false;

      // 已存在同向连线
      return !edgesRef.current.some((e) => e.source === source && e.target === target);
    },
    [getDescendantNodeIds]
  );

  // 拆除连接线：双击边直接移除（键盘 Delete/Backspace 删除选中边经 onBeforeDelete 放行）
  const handleEdgeDoubleClick = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      setEdges((eds) => eds.filter((e) => e.id !== edge.id));
    },
    [setEdges]
  );

  // 键盘删除守卫：只放行边的移除；节点删除必须走卡片删除按钮（级联确认弹窗），
  // 防止选中节点按 Delete 绕过确认造成孤儿子节点（上下文链断裂）
  const handleBeforeDelete = useCallback(async ({ edges: pendingEdges }: { nodes: Node[]; edges: Edge[] }) => {
    return { nodes: [], edges: pendingEdges };
  }, []);

  // Internal execution of deleting specific node IDs
  // 删除后不重排版/不 fitView（工单反馈：删除触发全局缩放观感差）——画布布局交由用户自行安排
  const executeDeleteNodeIds = useCallback(
    (targetIds: string[]) => {
      const targetSet = new Set(targetIds);
      setNodes((nds) => nds.filter((n) => !targetSet.has(n.id)));
      setEdges((eds) => eds.filter((e) => !targetSet.has(e.source) && !targetSet.has(e.target)));
    },
    [setNodes, setEdges]
  );

  // Delete node trigger: if it has child nodes, prompt with modal; otherwise delete immediately
  const handleDeleteNode = useCallback(
    (nodeId: string) => {
      const descendants = getDescendantNodeIds(nodeId);
      const targetNode = nodesRef.current.find((n) => n.id === nodeId);
      const title =
        (targetNode?.data as any)?.title ||
        (targetNode?.data as any)?.question?.slice(0, 16) ||
        '当前节点';

      if (descendants.size > 0) {
        // Has children: open confirmation dialog
        setDeleteConfirmTarget({
          nodeId,
          nodeTitle: title,
          descendantCount: descendants.size,
          allTargetIds: [nodeId, ...Array.from(descendants)],
        });
      } else {
        // Single leaf node: delete directly
        executeDeleteNodeIds([nodeId]);
      }
    },
    [getDescendantNodeIds, executeDeleteNodeIds]
  );

  // Collapse / Expand node
  const handleToggleCollapse = useCallback(
    (nodeId: string) => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== nodeId) return n;
          const d = n.data as unknown as ChatNodeData;
          return {
            ...n,
            data: { ...d, isCollapsed: !d.isCollapsed },
          };
        })
      );
      setTimeout(() => applyLayout(), 50);
    },
    [applyLayout, setNodes]
  );

  const handleUpdateTitle = useCallback(
    (nodeId: string, title: string) => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== nodeId) return n;
          return {
            ...n,
            // 手动改名置 titleManual：自动命名永不覆盖用户手起的标题
            data: { ...n.data, title, titleManual: true },
          };
        })
      );
    },
    [setNodes]
  );

  const handleUpdateNote = useCallback(
    (nodeId: string, content: string, title?: string) => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== nodeId) return n;
          return {
            ...n,
            data: { ...n.data, content, ...(title ? { title } : {}) },
          };
        })
      );
    },
    [setNodes]
  );

  // Add new standalone Root topic node
  const handleAddRootNode = useCallback(() => {
    if (!checkAiQuota()) return;
    const newId = generateUniqueId();
    
    // Find bottom-most root or leftmost node to place cleanly underneath
    const rootNodes = nodesRef.current.filter((n) => {
      const isRoot = (n.data as any)?.depth === 0 || !edgesRef.current.some((e) => e.target === n.id);
      return isRoot;
    });

    let newX = 80;
    let newY = 160;

    if (rootNodes.length > 0) {
      const maxY = Math.max(...rootNodes.map((n) => n.position.y));
      newY = maxY + 460;
      newX = rootNodes[0].position.x || 80;
    } else if (nodesRef.current.length > 0) {
      const maxY = Math.max(...nodesRef.current.map((n) => n.position.y));
      newY = maxY + 420;
    }

    const newNode: Node = {
      id: newId,
      type: 'chat',
      position: { x: newX, y: newY },
      draggable: false,
      data: {
        title: '新探索主题',
        depth: 0,
        question: '',
        answer: '',
        status: 'idle',
        model: defaultModel || '',
        enableWebSearch: defaultEnableWebSearch,
      },
    };

    setNodes((nds) => deduplicateNodes([...nds, newNode]));

    // Smoothly pan camera to the new topic card
    setTimeout(() => {
      reactFlowInstance.setCenter(newX + 220, newY + 180, {
        zoom: 0.95,
        duration: 500,
      });
    }, 50);
  }, [
    checkAiQuota,
    defaultModel,
    defaultEnableWebSearch,
    reactFlowInstance,
    setNodes,
  ]);

  // Branch into an AI Chat inquiry directly from a Note premise
  const handleBranchFromNote = useCallback(
    (sourceNoteId: string, premiseText: string) => {
      if (!checkAiQuota()) return;
      const sourceNode = nodesRef.current.find((n) => n.id === sourceNoteId);
      const newId = generateUniqueId();
      const noteTitle = (sourceNode?.data as any)?.title || '便签前置假设';
      const prompt = premiseText.trim()
        ? `基于前置假设与思考沉淀「${premiseText.trim()}」，请深入推演其逻辑可行性、潜在工程挑战与下一步突破方向。`
        : `基于「${noteTitle}」作为前置课题假设，展开深入推演与探索。`;

      const sourcePos = sourceNode?.position || { x: 400, y: 300 };

      const newNode: Node = {
        id: newId,
        type: 'chat',
        position: {
          x: sourcePos.x + 380,
          y: sourcePos.y - 20,
        },
        draggable: false,
        data: {
          title: `推演: ${noteTitle.slice(0, 14)}`,
          depth: 1,
          question: prompt,
          answer: '',
          status: 'generating',
          parentId: sourceNoteId,
          model: 'gemini-3.1-flash-lite',
          branchTriggerPhrase: noteTitle,
        },
      };

      const newEdge: Edge = {
        id: generateUniqueId(),
        source: sourceNoteId,
        sourceHandle: 'out',
        target: newId,
        targetHandle: 'in',
        type: 'default',
        animated: true,
        style: NOTE_ANIMATED_EDGE_STYLE,
        markerEnd: NOTE_EDGE_MARKER,
      };

      setNodes((nds) => deduplicateNodes([...nds, newNode]));
      setEdges((eds) => deduplicateEdges([...eds, newEdge]));

      setTimeout(() => {
        generateNodeAnswer(newId, prompt);
      }, 100);
    },
    [checkAiQuota, generateNodeAnswer, setNodes, setEdges]
  );

  // Export a sub-branch starting from a node into an independent board
  const handleExportSubBranch = useCallback(
    (rootNodeId: string) => {
      const rootNode = nodesRef.current.find((n) => n.id === rootNodeId);
      if (!rootNode) return;

      if (canCreate(isVip) === 'block') {
        openRechargeModal('免费版用户最多创建 3 个独立画板。升级 Pro 解锁无限画板与子分支导出！');
        return;
      }

      // Breadth-First-Search down the directed tree to collect all descendants
      const descendants = getDescendantNodeIds(rootNodeId);
      const visitedNodeIds = new Set<string>([rootNodeId, ...descendants]);

      const subNodes = nodesRef.current.filter((n) => visitedNodeIds.has(n.id));
      const subEdges = edgesRef.current.filter(
        (e) => visitedNodeIds.has(e.source) && visitedNodeIds.has(e.target)
      );

      const title =
        (rootNode.data as any)?.title ||
        (rootNode.data as any)?.question?.slice(0, 15) ||
        '子思维分支';
      const newBoardId = generateUniqueId();
      const newBoardName = `分支导出: ${title}`;
      markPendingCreate(newBoardId);

      const minX = Math.min(...subNodes.map((n) => n.position.x));
      const minY = Math.min(...subNodes.map((n) => n.position.y));
      const normalizedNodes = subNodes.map((n) => ({
        ...n,
        position: {
          x: n.position.x - minX + 80,
          y: n.position.y - minY + 160,
        },
      }));

      const newBoard: StoredBoard = {
        id: newBoardId,
        name: newBoardName,
        updatedAt: Date.now(),
        nodes: deduplicateNodes(normalizedNodes),
        edges: deduplicateEdges(subEdges),
      };

      saveBoard(newBoard);

      // Remove exported branch nodes and associated edges from current canvas to boost performance
      setNodes((nds) => nds.filter((n) => !visitedNodeIds.has(n.id)));
      setEdges((eds) =>
        eds.filter((e) => !visitedNodeIds.has(e.source) && !visitedNodeIds.has(e.target))
      );

      setTimeout(() => {
        applyLayout();
      }, 50);

      setApiWarning(
        `已成功将分支「${title}」及 ${subNodes.length} 个节点导出为独立画板《${newBoardName}》，并已从当前画布移除以显著提升性能！`
      );
      setTimeout(() => setApiWarning(null), 6000);
    },
    [applyLayout, getDescendantNodeIds, isVip, openRechargeModal, setEdges, setNodes]
  );

  // Add note node placed near viewport center
  const handleAddNoteNode = useCallback(() => {
    const newId = generateUniqueId();
    let targetX = 300;
    let targetY = 200;
    try {
      const center = reactFlowInstance.screenToFlowPosition({
        x: window.innerWidth / 2 + (Math.random() * 80 - 40),
        y: window.innerHeight / 2 + (Math.random() * 80 - 40),
      });
      if (center && !isNaN(center.x)) {
        targetX = center.x;
        targetY = center.y;
      }
    } catch {
      targetX = 250 + Math.random() * 100;
      targetY = 200 + Math.random() * 100;
    }

    const newNode: Node = {
      id: newId,
      type: 'note',
      position: { x: targetX, y: targetY },
      draggable: true,
      data: {
        title: '思考备忘与假设',
        content: '',
      },
    };
    setNodes((nds) => deduplicateNodes([...nds, newNode]));
  }, [reactFlowInstance, setNodes]);

  // Create and connect a subsequent Note node (e.g. on pressing Tab or clicking +)
  const handleBranchNewNote = useCallback(
    (sourceNoteId: string) => {
      const sourceNode = nodesRef.current.find((n) => n.id === sourceNoteId);
      const newId = generateUniqueId();
      const sourceX = sourceNode ? sourceNode.position.x : 300;
      const sourceY = sourceNode ? sourceNode.position.y : 200;

      const newPosition = {
        x: sourceX + 380,
        y: sourceY + (Math.random() * 20 - 10),
      };

      const newNode: Node = {
        id: newId,
        type: 'note',
        position: newPosition,
        draggable: true,
        data: {
          title: '延伸思考与假设',
          content: '',
        },
      };

      const newEdge: Edge = {
        id: generateUniqueId(),
        source: sourceNoteId,
        target: newId,
        type: 'default',
        animated: true,
        style: NOTE_ANIMATED_EDGE_STYLE,
        markerEnd: NOTE_EDGE_MARKER,
      };

      setNodes((nds) => deduplicateNodes([...nds, newNode]));
      setEdges((eds) => deduplicateEdges([...eds, newEdge]));

      setTimeout(() => {
        reactFlowInstance.setCenter(newPosition.x + 160, newPosition.y + 120, {
          zoom: Math.max(reactFlowInstance.getZoom(), 0.85),
          duration: 400,
        });
      }, 50);
    },
    [reactFlowInstance, setNodes, setEdges]
  );

  // Expose trigger refs to parent
  // Spec K1 修复：导出前临时关闭 onlyRenderVisibleElements 全量渲染（虚拟化会让
  // 视口外的节点/边不在 DOM，捕获出的图片丢连线），捕获完成恢复
  const [exportFullRender, setExportFullRender] = useState(false);
  useEffect(() => {
    if (triggerAutoLayoutRef) triggerAutoLayoutRef.current = () => applyLayout();
    if (triggerFitViewRef)
      triggerFitViewRef.current = () =>
        reactFlowInstance.fitView({ padding: 0.2, duration: 500 });
    if (triggerAddRootRef) triggerAddRootRef.current = handleAddRootNode;
    if (triggerAddNoteRef) triggerAddNoteRef.current = handleAddNoteNode;
    if (triggerExportPngRef) {
      triggerExportPngRef.current = async (title: string) => {
        setExportFullRender(true);
        try {
          // 等两帧 + 余量，确保 React 完成全量 DOM 挂载后再捕获
          await new Promise<void>((r) =>
            requestAnimationFrame(() => requestAnimationFrame(() => r()))
          );
          await new Promise<void>((r) => setTimeout(r, 80));
          return await exportCanvasAsPng(nodesRef.current, title);
        } finally {
          setExportFullRender(false);
        }
      };
    }
  }, [
    applyLayout,
    reactFlowInstance,
    handleAddRootNode,
    handleAddNoteNode,
    triggerAutoLayoutRef,
    triggerFitViewRef,
    triggerAddRootRef,
    triggerAddNoteRef,
    triggerExportPngRef,
  ]);

  // Text selection handler: detect selection inside chat card to pop up "钻入兔子洞" capsule
  useEffect(() => {
    const handleMouseUp = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.toString().trim()) {
        setSelectionPayload(null);
        return;
      }

      const selectedText = selection.toString().trim();
      if (selectedText.length < 2) {
        setSelectionPayload(null);
        return;
      }

      // Check if selection is within a node
      let anchorElem: HTMLElement | null = selection.anchorNode as HTMLElement;
      if (anchorElem && anchorElem.nodeType === window.Node.TEXT_NODE) {
        anchorElem = anchorElem.parentElement;
      }

      const nodeContainer = anchorElem?.closest('.react-flow__node');
      if (!nodeContainer) {
        setSelectionPayload(null);
        return;
      }

      const nodeId = nodeContainer.getAttribute('data-id');
      if (!nodeId) return;

      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      setSelectionPayload({
        nodeId,
        text: selectedText,
        clientRect: {
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
        },
      });
    };

    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const onConnect = useCallback(
    (params: Connection) => {
      const sourceNode = nodesRef.current.find((n) => n.id === params.source);
      const targetNode = nodesRef.current.find((n) => n.id === params.target);
      const isNoteInvolved = sourceNode?.type === 'note' || targetNode?.type === 'note';

      setEdges((eds) =>
        deduplicateEdges(
          addEdge(
            {
              ...params,
              id: generateUniqueId(),
              type: 'default',
              animated: isNoteInvolved,
              style: isNoteInvolved ? NOTE_ANIMATED_EDGE_STYLE : AI_EDGE_STYLE,
              markerEnd: isNoteInvolved ? NOTE_EDGE_MARKER : AI_EDGE_MARKER,
            },
            eds
          )
        )
      );
    },
    [setEdges]
  );

  const actionsValue: NodeActionsContextValue = useMemo(
    () => ({
      sendMessage: (nId: string, q: string, opts?: any) =>
        generateNodeAnswer(nId, q, opts),
      followUpInquiry: handleFollowUpInquiry,
      activateSuggestion: handleActivateSuggestion,
      branch: handleBranch,
      branchFromNote: handleBranchFromNote,
      deleteNode: handleDeleteNode,
      toggleCollapse: handleToggleCollapse,
      updateTitle: handleUpdateTitle,
      updateNote: handleUpdateNote,
      exportSubBranch: handleExportSubBranch,
      branchNewNote: handleBranchNewNote,
      retry: (nId: string, opts?: any) => {
        const target = nodesRef.current.find((n) => n.id === nId);
        const chatData = target?.data as unknown as ChatNodeData;
        const q = chatData?.question || chatData?.title;
        if (q) {
          generateNodeAnswer(nId, q, opts);
        }
      },
    }),
    [
      generateNodeAnswer,
      handleFollowUpInquiry,
      handleActivateSuggestion,
      handleBranch,
      handleBranchFromNote,
      handleDeleteNode,
      handleToggleCollapse,
      handleUpdateTitle,
      handleUpdateNote,
      handleExportSubBranch,
      handleBranchNewNote,
    ]
  );

  const isLargeCanvas = nodes.length >= 150;

  // 探索灵感节点视图级隐藏：对 suggested 节点及其连线注入 ReactFlow hidden 字段，
  // 仅影响渲染（含 MiniMap），nodes/edges state 保持数据真源不被污染——
  // 保存、配额计数（含 suggested，与后端同口径）与再次开启后的位置均不受影响
  const hiddenSuggestedIds = useMemo(() => {
    if (showSuggestions) return null;
    return new Set(
      nodes
        .filter((n) => (n.data as unknown as ChatNodeData)?.status === 'suggested')
        .map((n) => n.id)
    );
  }, [nodes, showSuggestions]);

  const displayNodes = useMemo(() => {
    if (!hiddenSuggestedIds) return nodes;
    return nodes.map((n) =>
      hiddenSuggestedIds.has(n.id) ? { ...n, hidden: true } : n
    );
  }, [nodes, hiddenSuggestedIds]);

  const displayEdges = useMemo(() => {
    if (!hiddenSuggestedIds) return edges;
    return edges.map((e) =>
      hiddenSuggestedIds.has(e.source) || hiddenSuggestedIds.has(e.target)
        ? { ...e, hidden: true }
        : e
    );
  }, [edges, hiddenSuggestedIds]);

  const handlePaneClick = useCallback(() => {
    setSelectionPayload(null);
  }, []);

  return (
    <div className="w-full h-full relative">
      {/* Large Canvas Mind Branch Performance Optimization Banner */}
      {isLargeCanvas && !dismissLargeCanvasBanner && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 max-w-xl w-[92%] px-4 py-3 rounded-2xl bg-amber-50 dark:bg-amber-950/80 border border-amber-300 dark:border-amber-700/60 shadow-xl backdrop-blur-md animate-in fade-in slide-in-from-top-4 flex items-center justify-between gap-3 text-amber-900 dark:text-amber-200">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-amber-100 dark:bg-amber-900/60 flex items-center justify-center shrink-0 text-amber-600 dark:text-amber-400">
              <FolderPlus className="w-4 h-4" />
            </div>
            <div className="text-xs sm:text-sm">
              <span className="font-semibold">当前画板思维分支较为庞大（{nodes.length} 个节点）：</span>
              <span className="text-amber-800 dark:text-amber-300 ml-1">
                为保持极致流畅度与低延迟渲染，建议点击卡片右上角的
                <span className="inline-flex items-center px-1.5 py-0.5 mx-1 rounded bg-amber-200/60 dark:bg-amber-800/60 text-amber-900 dark:text-amber-100 font-mono text-xs">
                  <FolderPlus className="w-3 h-3 mr-0.5 inline" /> 导出分支
                </span>
                将子分支导出为独立画板。
              </span>
            </div>
          </div>
          <button
            onClick={() => setDismissLargeCanvasBanner(true)}
            className="p-1 rounded-lg hover:bg-amber-200/50 dark:hover:bg-amber-800/50 text-amber-600 dark:text-amber-400 transition-colors shrink-0"
            title="关闭提示"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Performance & API Warnings */}
      {(apiWarning || renderWarning) && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 pointer-events-none">
          {apiWarning && (
            <div className="flex items-center gap-2 px-4 py-2.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-500 text-sm font-medium shadow-lg backdrop-blur-md animate-in fade-in slide-in-from-top-4">
              <AlertCircle className="w-4 h-4" />
              {apiWarning}
            </div>
          )}
          {renderWarning && (
            <div className="flex items-center gap-2 px-4 py-2.5 rounded-full bg-blue-500/10 border border-blue-500/30 text-blue-500 text-sm font-medium shadow-lg backdrop-blur-md animate-in fade-in slide-in-from-top-4">
              <AlertCircle className="w-4 h-4" />
              {renderWarning}
            </div>
          )}
        </div>
      )}

      <NodeActionsContext.Provider value={actionsValue}>
        {/* 技术债 #0032：画布级错误边界——渲染链路异常时整块画布降级为可恢复面板，
            应用其余部分（顶栏/列表）不受影响 */}
        <ErrorBoundary variant="canvas">
          <ReactFlow
          nodes={displayNodes}
          edges={displayEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onEdgeDoubleClick={handleEdgeDoubleClick}
          onBeforeDelete={handleBeforeDelete}
          deleteKeyCode={['Backspace', 'Delete']}
          onPaneClick={handlePaneClick}
          onNodeDragStart={handleNodeDragStart}
          onNodeDragStop={handleNodeDragStop}
          onSelectionDragStart={handleSelectionDragStart}
          onSelectionDragStop={handleSelectionDragStop}
          nodeTypes={nodeTypes}
          onlyRenderVisibleElements={!exportFullRender}
          nodesDraggable={true}
          nodesConnectable={true}
          elementsSelectable={true}
          minZoom={0.2}
          maxZoom={2.0}
          fitView
          fitViewOptions={{ padding: 0.25 }}
          className="bg-[#f8fafc] dark:bg-[#070c18] transition-colors duration-200"
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={22}
            size={1.25}
            color={theme === 'dark' ? '#1e293b' : '#cbd5e1'}
          />
          <Controls
            position="bottom-left"
            showInteractive={false}
            className="!bg-white/95 dark:!bg-[#0c1322]/95 !border !border-slate-200/90 dark:!border-white/10 !shadow-xl !rounded-2xl overflow-hidden backdrop-blur-md"
          />
          <MiniMap
            position="bottom-right"
            zoomable
            pannable
            nodeColor={minimapNodeColor}
            maskColor={theme === 'dark' ? 'rgba(7, 12, 24, 0.78)' : 'rgba(241, 245, 249, 0.75)'}
            className="!bg-white/95 dark:!bg-[#0c1322]/95 !border !border-slate-200/90 dark:!border-white/10 !shadow-2xl !rounded-2xl !backdrop-blur-md"
          />
          </ReactFlow>
        </ErrorBoundary>
      </NodeActionsContext.Provider>

      {/* Floating Capsule for DeepDive branching upon selecting text */}
      <SelectionPopup
        payload={selectionPayload}
        onBranch={handleBranch}
        onClose={() => setSelectionPayload(null)}
      />

      {/* Delete Parent Node & Cascade Children Confirmation Modal */}
      {deleteConfirmTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 p-5 space-y-4">
            <div className="flex items-start gap-3">
              <div className="p-2.5 rounded-xl bg-rose-500/10 text-rose-500 dark:bg-rose-500/20 shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  确认删除该分支及其全部子节点？
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                  您正在尝试删除「<span className="font-medium text-slate-800 dark:text-slate-200">{deleteConfirmTarget.nodeTitle}</span>」。
                  该节点包含 <span className="font-semibold text-rose-500">{deleteConfirmTarget.descendantCount}</span> 个衍生的下级子节点，
                  确认删除后，<strong className="text-slate-700 dark:text-slate-300">该父节点及其全部下游子节点将一并级联删除</strong>，该操作不可撤销。
                </p>
              </div>
            </div>

            <div className="bg-slate-50 dark:bg-slate-800/60 rounded-xl p-3 border border-slate-100 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-300 flex items-center justify-between">
              <span>受影响节点总数</span>
              <span className="font-mono font-semibold text-rose-600 dark:text-rose-400">
                {deleteConfirmTarget.allTargetIds.length} 个节点
              </span>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => setDeleteConfirmTarget(null)}
                className="px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  executeDeleteNodeIds(deleteConfirmTarget.allTargetIds);
                  setDeleteConfirmTarget(null);
                }}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 active:bg-rose-800 text-white text-xs font-semibold shadow-sm transition-colors flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>确认一并删除 ({deleteConfirmTarget.allTargetIds.length})</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

