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
import { SelectionPopup } from './SelectionPopup';
import { ChatNodeData, TextSelectionPayload, GroundingMetadata } from '../../types';
import { getLayoutedElements } from '../../lib/layout';
import { buildAncestorContext } from '../../lib/context';
import { onSyncState } from '../../lib/sync-queue';
import { saveBoard, loadBoardList, StoredBoard, deduplicateNodes, deduplicateEdges } from '../../lib/storage';
import { NodeActionsContext, NodeActionsContextValue } from '../../context/NodeActionsContext';
import { useAuth } from '../../context/AuthContext';
import { useRenderMonitor } from '../../hooks/useRenderMonitor';
import { trackEvent, trackOnce } from '../../lib/analytics';
import { markChecklistStep } from '../../lib/checklist';
import { AlertCircle, Sparkles, X, FolderPlus, AlertTriangle, Trash2 } from 'lucide-react';

let globalIdCounter = 0;
export const generateUniqueId = (prefix: string = 'node'): string => {
  globalIdCounter += 1;
  const time = Date.now();
  const rand = Math.random().toString(36).substring(2, 8);
  // 前缀截断：调用方会把父级 id 拼进前缀（如 node-${sourceNodeId}），层级越深 id 越长，
  // 会超过 PostgreSQL varchar(64) 上限（报 22001 value too long）导致画布保存失败。
  // 截断前缀只损失语义、不影响唯一性（time+counter+rand 保证唯一）。
  const safePrefix = prefix.length > 24 ? prefix.slice(0, 24) : prefix;
  return `${safePrefix}-${time}-${globalIdCounter}-${rand}`;
};

const nodeTypes = {
  chat: ChatCardNode,
  note: NoteCardNode,
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

  // Spec J2：服务端余量单一事实源（GET /api/quota，口径含 suggested 与后端拦截完全一致）。
  // null = 余量未知（VIP/Admin 不受限、查询失败或未同步）——此时前端不做本地拦截，由服务端 chat 403 兜底。
  const [serverNodeRemaining, setServerNodeRemaining] = useState<number | null>(null);
  const refreshServerQuota = useCallback(async () => {
    if (!canvasId || isVip) {
      setServerNodeRemaining(null);
      return;
    }
    try {
      const res = await fetch(`/api/quota?canvasId=${encodeURIComponent(canvasId)}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        setServerNodeRemaining(null);
        return;
      }
      const body = await res.json();
      setServerNodeRemaining(body?.node ? body.node.remaining : null);
    } catch {
      setServerNodeRemaining(null);
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
    if (serverNodeRemaining !== null) {
      if (serverNodeRemaining <= 0) {
        // K4 事件 10：配额墙触达（免费版转化漏斗核心指标；remaining 为计数非 PII）
        trackEvent('quota_wall', { remaining: serverNodeRemaining });
        // Spec K7：传入画板上下文，升级弹窗可展示当前画板真实节点余量
        openRechargeModal('当前画板的 AI 推理节点额度已用完。升级 Pro 畅享无限节点深度探索与推演！', canvasId ?? undefined);
        return false;
      }
      return true;
    }
    return true;
  }, [isVip, openRechargeModal, serverNodeRemaining]);

  // Auto-save sync back to parent
  useEffect(() => {
    onCanvasChange?.(nodes, edges);
  }, [nodes, edges, onCanvasChange]);

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

  // Helper to generate domain fallback suggestions if model didn't provide any
  const getFallbackSuggestions = (topic: string): string[] => {
    const clean = topic.replace(/^[请问如何么什]+/, '').trim() || '当前主题';
    return [
      `围绕「${clean}」的核心底层机理与数学/物理本质是什么？`,
      `在实际工程应用与软硬件实现中，「${clean}」面临哪些关键瓶颈与权衡？`,
    ];
  };

  // Automatically spawn suggested question nodes connected to parent
  const spawnSuggestedNodes = useCallback(
    (parentNodeId: string, suggestions: string[], parentDepth: number, currentBaseNodes?: Node[]) => {
      if (!suggestions || suggestions.length === 0) return;

      const newNodes: Node[] = [];
      const newEdges: Edge[] = [];

      suggestions.slice(0, 3).forEach((questionText, idx) => {
        const sugId = generateUniqueId(`sug-${parentNodeId}`);
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
          id: generateUniqueId(`e-${parentNodeId}-${sugId}`),
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
                  const parts = rawAccumulatedText.split('---SUGGESTIONS---');
                  const currentAnswer = parts[0].trimEnd();

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
        const parts = rawAccumulatedText.split('---SUGGESTIONS---');
        const finalAnswer = parts[0].trim();
        const suggestionsPart = parts[1] || '';

        let parsedSuggestions = suggestionsPart
          .split('\n')
          .map((s) => s.replace(/^[\d\.\-\*•\s]+/, '').trim())
          .filter((s) => s.length > 3 && !s.includes('SUGGESTIONS'));

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
    [defaultModel, defaultEnableWebSearch, setNodes, spawnSuggestedNodes]
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

      const newId = generateUniqueId(`node-${sourceNodeId}`);
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
        id: generateUniqueId(`e-${sourceNodeId}-${newId}`),
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

  // Internal execution of deleting specific node IDs
  const executeDeleteNodeIds = useCallback(
    (targetIds: string[]) => {
      const targetSet = new Set(targetIds);
      setNodes((nds) => nds.filter((n) => !targetSet.has(n.id)));
      setEdges((eds) => eds.filter((e) => !targetSet.has(e.source) && !targetSet.has(e.target)));
      setTimeout(() => {
        applyLayout();
      }, 50);
    },
    [applyLayout, setNodes, setEdges]
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
            data: { ...n.data, title },
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
    const newId = generateUniqueId('root');
    
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
      const newId = generateUniqueId(`branch-note-${sourceNoteId}`);
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
        id: generateUniqueId(`e-${sourceNoteId}-${newId}`),
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

      if (!isVip) {
        const existingBoards = loadBoardList();
        if (existingBoards.length >= 3) {
          openRechargeModal('免费版用户最多创建 3 个独立画板。升级 Pro 解锁无限画板与子分支导出！');
          return;
        }
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
      const newBoardId = generateUniqueId('board');
      const newBoardName = `分支导出: ${title}`;

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
    const newId = generateUniqueId('note');
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
      const newId = generateUniqueId(`note-${sourceNoteId}`);
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
        id: generateUniqueId(`e-${sourceNoteId}-${newId}`),
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
  useEffect(() => {
    if (triggerAutoLayoutRef) triggerAutoLayoutRef.current = () => applyLayout();
    if (triggerFitViewRef)
      triggerFitViewRef.current = () =>
        reactFlowInstance.fitView({ padding: 0.2, duration: 500 });
    if (triggerAddRootRef) triggerAddRootRef.current = handleAddRootNode;
    if (triggerAddNoteRef) triggerAddNoteRef.current = handleAddNoteNode;
  }, [
    applyLayout,
    reactFlowInstance,
    handleAddRootNode,
    handleAddNoteNode,
    triggerAutoLayoutRef,
    triggerFitViewRef,
    triggerAddRootRef,
    triggerAddNoteRef,
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
              id: generateUniqueId(`e-${params.source}-${params.target}`),
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
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          onlyRenderVisibleElements
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

