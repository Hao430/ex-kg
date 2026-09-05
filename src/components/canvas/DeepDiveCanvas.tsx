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
import { NodeActionsContext, NodeActionsContextValue } from '../../context/NodeActionsContext';

const nodeTypes = {
  chat: ChatCardNode,
  note: NoteCardNode,
};

// Initial state: One root answered node + 2 auto-derived suggested exploration nodes
const INITIAL_RAW_NODES: Node[] = [
  {
    id: 'root-1',
    type: 'chat',
    position: { x: 80, y: 160 },
    draggable: false,
    data: {
      title: '量子计算核心概念',
      depth: 0,
      question: '什么是量子叠加态（Quantum Superposition）？它与经典比特有什么本质区别？',
      answer: `**量子叠加态 (Quantum Superposition)** 是量子信息与量子物理的基石原理：

1. **经典比特 vs 量子比特 (Qubit)**：
   - **经典比特**：状态非 $0$ 即 $1$；
   - **量子比特**：可以处于状态 $|0\\rangle$ 与 $|1\\rangle$ 的任意线性叠加：
     $$|\\psi\\rangle = \\alpha|0\\rangle + \\beta|1\\rangle \\quad (\\text{满足 } |\\alpha|^2 + |\\beta|^2 = 1)$$

2. **指数级计算威力**：
   - $N$ 个经典比特任意时刻只能表达 $2^N$ 种可能中的**一种**状态；
   - $N$ 个量子比特的相干叠加系统能同时涵盖全部 $2^N$ 种基态，为算法提供指数级的状态空间探索潜能。

💡 *提示：你可以选择右侧的「探索建议」一键展开探讨，或在下方输入框继续追问衍生新分支！*`,
      status: 'idle',
      model: 'gemini-3.8-flash',
      enableWebSearch: true,
      grounding: {
        queries: ['量子叠加态 经典比特 本质区别 量子计算原理'],
        sources: [
          {
            index: 1,
            title: 'Quantum superposition - Wikipedia',
            uri: 'https://en.wikipedia.org/wiki/Quantum_superposition',
            domain: 'en.wikipedia.org',
          },
          {
            index: 2,
            title: 'What is Quantum Superposition? - IBM Quantum Computing',
            uri: 'https://www.ibm.com/topics/quantum-computing',
            domain: 'ibm.com',
          },
          {
            index: 3,
            title: 'Quantum Information and Computation - Stanford Encyclopedia of Philosophy',
            uri: 'https://plato.stanford.edu/entries/qt-quantcomp/',
            domain: 'plato.stanford.edu',
          },
        ],
      },
      suggestionsSpawned: true,
    },
  },
  {
    id: 'sug-init-1',
    type: 'chat',
    position: { x: 620, y: 60 },
    draggable: true,
    data: {
      title: 'Shor 算法加速机理',
      depth: 1,
      question: 'Shor 算法是如何巧妙利用量子叠加与相位干涉实现对 RSA 大数分解的指数级加速的？',
      answer: '',
      status: 'suggested',
      parentId: 'root-1',
      model: 'gemini-3.1-flash-lite',
    },
  },
  {
    id: 'note-demo-1',
    type: 'note',
    position: { x: 620, y: 320 },
    draggable: true,
    data: {
      title: '硬件瓶颈假设与研究沉淀',
      content: '量子并行计算威力源于态空间指数爆炸；但要达到容错计算，必须攻克微观系统与外界热噪声的耦合（退相干）。若无法维持相干态，叠加态将坍缩回经典态。',
    },
  },
  {
    id: 'sug-init-2',
    type: 'chat',
    position: { x: 1040, y: 320 },
    draggable: true,
    data: {
      title: '量子退相干核心瓶颈',
      depth: 1,
      question: '基于前述硬件假设，环境噪声导致的量子退相干（Decoherence）为何是建造物理量子计算机的最大工程挑战？',
      answer: '',
      status: 'suggested',
      parentId: 'note-demo-1',
      model: 'gemini-3.1-flash-lite',
    },
  },
];

const INITIAL_RAW_EDGES: Edge[] = [
  {
    id: 'e-root-sug-1',
    source: 'root-1',
    target: 'sug-init-1',
    type: 'default',
    animated: true,
    style: { stroke: '#818cf8', strokeWidth: 1.8, strokeDasharray: '4,4' },
    markerEnd: { type: MarkerType.ArrowClosed, color: '#818cf8' },
  },
  {
    id: 'e-root-note-1',
    source: 'root-1',
    sourceHandle: 'out',
    target: 'note-demo-1',
    targetHandle: 'in',
    type: 'default',
    animated: false,
    style: { stroke: '#d97706', strokeWidth: 2 },
    markerEnd: { type: MarkerType.ArrowClosed, color: '#d97706' },
  },
  {
    id: 'e-note-sug-2',
    source: 'note-demo-1',
    sourceHandle: 'out',
    target: 'sug-init-2',
    targetHandle: 'in',
    type: 'default',
    animated: true,
    style: { stroke: '#d97706', strokeWidth: 2, strokeDasharray: '4,3' },
    markerEnd: { type: MarkerType.ArrowClosed, color: '#d97706' },
  },
];

// Pre-layout initial graph
const INITIAL_LAYOUTED = getLayoutedElements(INITIAL_RAW_NODES, INITIAL_RAW_EDGES, 'LR');

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
  defaultModel = 'gemini-3.8-flash',
  defaultEnableWebSearch = true,
}) => {
  const [nodes, setNodes, onNodesChange] = useNodesState(
    initialNodes || INITIAL_LAYOUTED.nodes
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState(
    initialEdges || INITIAL_LAYOUTED.edges
  );
  const [selectionPayload, setSelectionPayload] = useState<TextSelectionPayload | null>(null);
  const reactFlowInstance = useReactFlow();

  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  // Auto-save sync back to parent
  useEffect(() => {
    onCanvasChange?.(nodes, edges);
  }, [nodes, edges, onCanvasChange]);

  // Layout function (Zero-drag automatic tidy tree)
  const applyLayout = useCallback(
    (currentNodes = nodesRef.current, currentEdges = edgesRef.current) => {
      const layouted = getLayoutedElements(currentNodes, currentEdges, 'LR');
      setNodes([...layouted.nodes]);
      setEdges([...layouted.edges]);
      window.requestAnimationFrame(() => {
        reactFlowInstance.fitView({ padding: 0.25, duration: 400 });
      });
    },
    [reactFlowInstance, setNodes, setEdges]
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
        const sugId = `sug-${Date.now()}-${idx}-${Math.random().toString(36).substring(2, 6)}`;
        const title = questionText.slice(0, 16);

        const sugNode: Node = {
          id: sugId,
          type: 'chat',
          draggable: true,
          position: { x: 0, y: 0 }, // Layout will position correctly
          data: {
            title,
            depth: parentDepth + 1,
            question: questionText,
            answer: '',
            status: 'suggested',
            parentId: parentNodeId,
            model: defaultModel || 'gemini-3.8-flash',
            enableWebSearch: defaultEnableWebSearch,
          },
        };

        const sugEdge: Edge = {
          id: `e-${parentNodeId}-${sugId}`,
          source: parentNodeId,
          target: sugId,
          type: 'default',
          animated: true,
          style: { stroke: '#818cf8', strokeWidth: 1.8, strokeDasharray: '4,4' },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#818cf8' },
        };

        newNodes.push(sugNode);
        newEdges.push(sugEdge);
      });

      const baseList = currentBaseNodes || nodesRef.current;
      const updatedNodes = [...baseList, ...newNodes];
      const updatedEdges = [...edgesRef.current, ...newEdges];

      // Auto-layout to align cleanly
      const layouted = getLayoutedElements(updatedNodes, updatedEdges, 'LR');
      nodesRef.current = layouted.nodes;
      edgesRef.current = layouted.edges;
      setNodes(layouted.nodes);
      setEdges(layouted.edges);
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
      const targetNode = nodesRef.current.find((n) => n.id === nodeId);
      const existingData = targetNode?.data as unknown as ChatNodeData | undefined;

      const activeModel =
        options?.model || existingData?.model || defaultModel || 'gemini-3.8-flash';
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

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: ancestorContext,
            model: activeModel,
            enableWebSearch: activeWebSearch,
          }),
        });

        if (!response.ok || !response.body) {
          let errDetail = `请求失败: ${response.statusText || response.status}`;
          try {
            const bodyJson = await response.json();
            if (bodyJson?.error) errDetail = sanitizeErrorMessage(bodyJson.error);
          } catch {}
          throw new Error(errDetail);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

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
            },
          };
        });

        // Immediately sync nodesRef to avoid race conditions
        nodesRef.current = finalizedNodes;
        setNodes(finalizedNodes);

        // Auto-spawn suggested question nodes using the fresh finalizedNodes
        spawnSuggestedNodes(nodeId, parsedSuggestions, currentDepth, finalizedNodes);
      } catch (err: any) {
        console.error('Error generating AI response:', err);
        const friendlyMessage = sanitizeErrorMessage(err);
        setNodes((nds) =>
          nds.map((n) => {
            if (n.id !== nodeId) return n;
            const d = n.data as unknown as ChatNodeData;
            return {
              ...n,
              data: {
                ...d,
                status: 'error',
                errorMessage: friendlyMessage,
              },
            };
          })
        );
      }
    },
    [defaultModel, defaultEnableWebSearch, setNodes, spawnSuggestedNodes]
  );

  // Requirement 2: Follow-up inquiry creates a NEW child node for the next dialogue
  const handleFollowUpInquiry = useCallback(
    (
      sourceNodeId: string,
      questionText: string,
      options?: { model?: string; enableWebSearch?: boolean }
    ) => {
      const sourceNode = nodesRef.current.find((n) => n.id === sourceNodeId);
      const parentData = sourceNode?.data as unknown as ChatNodeData | undefined;
      const depth = (parentData?.depth ?? 0) + 1;

      const activeModel =
        options?.model || parentData?.model || defaultModel || 'gemini-3.8-flash';
      const activeWebSearch =
        options?.enableWebSearch !== undefined
          ? options.enableWebSearch
          : parentData?.enableWebSearch !== undefined
          ? parentData.enableWebSearch
          : defaultEnableWebSearch;

      const newId = `node-${Date.now()}`;
      const title = questionText.slice(0, 16);

      const newNode: Node = {
        id: newId,
        type: 'chat',
        position: {
          x: (sourceNode?.position.x || 0) + 520,
          y: sourceNode?.position.y || 0,
        },
        draggable: false,
        data: {
          title,
          depth,
          question: questionText,
          answer: '',
          status: 'generating',
          model: activeModel,
          enableWebSearch: activeWebSearch,
          parentId: sourceNodeId,
        },
      };

      const newEdge: Edge = {
        id: `e-${sourceNodeId}-${newId}`,
        source: sourceNodeId,
        target: newId,
        type: 'default',
        style: { stroke: '#3b82f6', strokeWidth: 2 },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: '#3b82f6',
        },
      };

      const nextNodes = [...nodesRef.current, newNode];
      const nextEdges = [...edgesRef.current, newEdge];

      // Auto-layout with smooth transition
      const layouted = getLayoutedElements(nextNodes, nextEdges, 'LR');
      setNodes(layouted.nodes);
      setEdges(layouted.edges);

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
        generateNodeAnswer(newId, questionText, {
          model: activeModel,
          enableWebSearch: activeWebSearch,
        });
      }, 100);
    },
    [defaultModel, defaultEnableWebSearch, generateNodeAnswer, reactFlowInstance, setNodes, setEdges]
  );

  // Requirement 3: User clicks on a suggested question node to generate answer
  const handleActivateSuggestion = useCallback(
    (nodeId: string) => {
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
              style: { stroke: '#3b82f6', strokeWidth: 2 },
              markerEnd: { type: MarkerType.ArrowClosed, color: '#3b82f6' },
            };
          }
          return e;
        })
      );

      // Start generating answer
      generateNodeAnswer(nodeId, question);
    },
    [generateNodeAnswer, setEdges]
  );

  // Branch from node / phrase (DeepDive text selection feature)
  const handleBranch = useCallback(
    (sourceNodeId: string, triggerPhrase?: string) => {
      const sourceNode = nodesRef.current.find((n) => n.id === sourceNodeId);
      const parentData = sourceNode?.data as unknown as ChatNodeData | undefined;
      const depth = (parentData?.depth ?? 0) + 1;

      const newId = `branch-${Date.now()}`;
      const questionText = triggerPhrase
        ? `请围绕「${triggerPhrase}」深入展开剖析其核心原理与关键影响。`
        : '请在此分支展开深度探索与推演。';
      const title = triggerPhrase
        ? `深入: ${triggerPhrase.slice(0, 15)}`
        : `深度 #${depth} 分支`;

      const newNode: Node = {
        id: newId,
        type: 'chat',
        position: {
          x: (sourceNode?.position.x || 0) + 520,
          y: sourceNode?.position.y || 0,
        },
        draggable: true,
        data: {
          title,
          depth,
          question: questionText,
          answer: '',
          status: 'generating',
          model: 'gemini-flash-latest',
          parentId: sourceNodeId,
          branchTriggerPhrase: triggerPhrase,
        },
      };

      const newEdge: Edge = {
        id: `e-${sourceNodeId}-${newId}`,
        source: sourceNodeId,
        target: newId,
        type: 'default',
        style: { stroke: '#3b82f6', strokeWidth: 2 },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: '#3b82f6',
        },
      };

      const nextNodes = [...nodesRef.current, newNode];
      const nextEdges = [...edgesRef.current, newEdge];

      const layouted = getLayoutedElements(nextNodes, nextEdges, 'LR');
      setNodes(layouted.nodes);
      setEdges(layouted.edges);

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

      setTimeout(() => {
        generateNodeAnswer(newId, questionText);
      }, 100);
    },
    [generateNodeAnswer, reactFlowInstance, setNodes, setEdges]
  );

  // Delete node and cascade connected edges
  const handleDeleteNode = useCallback(
    (nodeId: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== nodeId));
      setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
      setTimeout(() => {
        applyLayout();
      }, 50);
    },
    [applyLayout, setNodes, setEdges]
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
    const newId = `root-${Date.now()}`;
    
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
      draggable: true,
      data: {
        title: '新探索主题',
        depth: 0,
        question: '',
        answer: '',
        status: 'idle',
        model: defaultModel || 'gemini-3.8-flash',
        enableWebSearch: defaultEnableWebSearch,
        onSendMessage: (nId: string, q: string, opts?: any) =>
          generateNodeAnswer(nId, q, opts),
        onFollowUpInquiry: handleFollowUpInquiry,
        onActivateSuggestion: handleActivateSuggestion,
        onBranch: handleBranch,
        onDelete: handleDeleteNode,
        onToggleCollapse: handleToggleCollapse,
        onUpdateTitle: handleUpdateTitle,
      },
    };

    setNodes((nds) => [...nds, newNode]);

    // Smoothly pan camera to the new topic card
    setTimeout(() => {
      reactFlowInstance.setCenter(newX + 220, newY + 180, {
        zoom: 0.95,
        duration: 500,
      });
    }, 50);
  }, [
    generateNodeAnswer,
    handleFollowUpInquiry,
    handleActivateSuggestion,
    handleBranch,
    handleDeleteNode,
    handleToggleCollapse,
    handleUpdateTitle,
    reactFlowInstance,
    setNodes,
  ]);

  // Branch into an AI Chat inquiry directly from a Note premise
  const handleBranchFromNote = useCallback(
    (sourceNoteId: string, premiseText: string) => {
      const sourceNode = nodesRef.current.find((n) => n.id === sourceNoteId);
      const newId = `branch-note-${Date.now()}`;
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
        draggable: true,
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
        id: `e-${sourceNoteId}-${newId}`,
        source: sourceNoteId,
        sourceHandle: 'out',
        target: newId,
        targetHandle: 'in',
        type: 'default',
        animated: true,
        style: { stroke: '#d97706', strokeWidth: 2, strokeDasharray: '4,3' },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: '#d97706',
        },
      };

      setNodes((nds) => [...nds, newNode]);
      setEdges((eds) => [...eds, newEdge]);

      setTimeout(() => {
        generateNodeAnswer(newId, prompt);
      }, 100);
    },
    [generateNodeAnswer, setNodes, setEdges]
  );

  // Add note node placed near viewport center
  const handleAddNoteNode = useCallback(() => {
    const newId = `note-${Date.now()}`;
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
    setNodes((nds) => [...nds, newNode]);
  }, [reactFlowInstance, setNodes]);

  // Re-bind callbacks into node data
  useEffect(() => {
    setNodes((nds) =>
      nds.map((node) => {
        if (node.type === 'chat') {
          return {
            ...node,
            data: {
              ...node.data,
              onSendMessage: (nId: string, q: string, opts?: any) =>
                generateNodeAnswer(nId, q, opts),
              onFollowUpInquiry: handleFollowUpInquiry,
              onActivateSuggestion: handleActivateSuggestion,
              onBranch: handleBranch,
              onDelete: handleDeleteNode,
              onToggleCollapse: handleToggleCollapse,
              onUpdateTitle: handleUpdateTitle,
              onRetry: (nId: string, opts?: any) => {
                const chatData = node.data as unknown as ChatNodeData;
                const q = chatData.question || chatData.title;
                if (q) {
                  generateNodeAnswer(nId, q, opts);
                }
              },
            },
          };
        } else if (node.type === 'note') {
          return {
            ...node,
            data: {
              ...node.data,
              onUpdate: handleUpdateNote,
              onDelete: handleDeleteNode,
              onBranchFromNote: handleBranchFromNote,
            },
          };
        }
        return node;
      })
    );
  }, [
    generateNodeAnswer,
    handleFollowUpInquiry,
    handleActivateSuggestion,
    handleBranch,
    handleBranchFromNote,
    handleDeleteNode,
    handleToggleCollapse,
    handleUpdateTitle,
    handleUpdateNote,
    setNodes,
  ]);

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
      const strokeColor = isNoteInvolved ? '#d97706' : '#3b82f6';

      setEdges((eds) =>
        addEdge(
          {
            ...params,
            type: 'default',
            animated: isNoteInvolved,
            style: {
              stroke: strokeColor,
              strokeWidth: 2,
              strokeDasharray: isNoteInvolved ? '4,3' : undefined,
            },
            markerEnd: { type: MarkerType.ArrowClosed, color: strokeColor },
          },
          eds
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
    ]
  );

  return (
    <div className="w-full h-full relative">
      <NodeActionsContext.Provider value={actionsValue}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          nodesDraggable={true}
          nodesConnectable={true}
          elementsSelectable={true}
          minZoom={0.2}
          maxZoom={2.0}
          fitView
          fitViewOptions={{ padding: 0.25 }}
          className="bg-slate-50/50 dark:bg-[#070b14] transition-colors duration-200"
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1.5}
            color={theme === 'dark' ? '#334155' : '#cbd5e1'}
          />
          <Controls
            position="bottom-left"
            showInteractive={false}
            className="!bg-white dark:!bg-slate-900 !border !border-slate-200 dark:!border-slate-800 !shadow-lg !rounded-xl overflow-hidden"
          />
          <MiniMap
            position="bottom-right"
            zoomable
            pannable
            nodeColor={(n) => {
              if (n.type === 'note') return theme === 'dark' ? '#b45309' : '#fde68a';
              if ((n.data as any)?.status === 'suggested') return theme === 'dark' ? '#4f46e5' : '#c7d2fe';
              return theme === 'dark' ? '#2563eb' : '#93c5fd';
            }}
            maskColor={theme === 'dark' ? 'rgba(7, 11, 20, 0.75)' : 'rgba(240, 242, 245, 0.7)'}
            className="!bg-white/90 dark:!bg-slate-900/90 !border !border-slate-200 dark:!border-slate-800 !shadow-lg !rounded-2xl !backdrop-blur-sm"
          />
        </ReactFlow>
      </NodeActionsContext.Provider>

      {/* Floating Capsule for DeepDive branching upon selecting text */}
      <SelectionPopup
        payload={selectionPayload}
        onBranch={handleBranch}
        onClose={() => setSelectionPayload(null)}
      />
    </div>
  );
};

