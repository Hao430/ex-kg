import { useState, useRef, useEffect, useCallback } from 'react';
import type { Node, Edge } from '@xyflow/react';
import type { ChatNodeData, GroundingMetadata } from '../../../types';
import { buildAncestorContext } from '../../../lib/context';
import { extractSuggestions, getFallbackSuggestions } from '../../../lib/suggestions';
import { trackOnce } from '../../../lib/analytics';
import { markChecklistStep } from '../../../lib/checklist';

const STREAM_FLUSH_INTERVAL_MS = 2000;

export function sanitizeErrorMessage(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : (raw as any)?.message || String(raw);
  if (/429|quota|rate\s*limit|resource_exhausted/i.test(text)) {
    return '当前 AI 推理并发较高（429 限流保护中），系统正在为您自动调度备用链路，请稍候 2 秒后点击「重试」即可恢复。';
  }
  if (/503|high\s*demand|unavailable|overloaded/i.test(text)) {
    return 'AI 核心服务访问激增暂时受阻（503），已自动触发容灾平滑重试，请稍候片刻重试。';
  }
  return text.slice(0, 180);
}

export function estimateCardHeight(answer: string, question: string): number {
  const lineCount = (answer.match(/\n/g) || []).length + 1;
  const charLines = Math.ceil(answer.length / 26);
  const totalLines = Math.max(lineCount, charLines) + (question.length > 50 ? 2 : 1);
  return Math.max(380, 180 + totalLines * 24);
}

export function getCardRealHeight(nodeId: string, answer: string, question: string): number {
  if (typeof document !== 'undefined') {
    const el = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`) as HTMLElement | null;
    if (el && el.offsetHeight > 100) {
      return el.offsetHeight;
    }
  }
  return estimateCardHeight(answer, question);
}

export interface UseCanvasChatStreamOptions {
  nodesRef: React.MutableRefObject<Node[]>;
  edgesRef: React.MutableRefObject<Edge[]>;
  setNodes: (payload: Node[] | ((prev: Node[]) => Node[])) => void;
  canvasId?: string;
  boardNeedsAutoName?: boolean;
  defaultModel?: string;
  defaultEnableWebSearch?: boolean;
  checkAiQuota: () => boolean;
  requestImmediateSave: () => void;
  openAuthModal: (mode: 'signin' | 'signup') => void;
  spawnSuggestedNodes: (
    sourceNodeId: string,
    suggestions: string[],
    parentDepth: number,
    baseNodes?: Node[]
  ) => void;
}

/**
 * 画布 AI 问答 SSE 流式生成、自动命名与节流落盘 Hook
 */
export function useCanvasChatStream(options: UseCanvasChatStreamOptions) {
  const {
    nodesRef,
    edgesRef,
    setNodes,
    canvasId,
    boardNeedsAutoName,
    defaultModel,
    defaultEnableWebSearch,
    checkAiQuota,
    requestImmediateSave,
    openAuthModal,
    spawnSuggestedNodes,
  } = options;

  const [apiWarning, setApiWarning] = useState<string | null>(null);
  const activeStreamAbortRef = useRef<AbortController | null>(null);
  const lastStreamFlushRef = useRef(0);

  useEffect(
    () => () => {
      activeStreamAbortRef.current?.abort();
      activeStreamAbortRef.current = null;
    },
    []
  );

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
        if (!res.ok) return;
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
        // 网络失败不阻塞
      }
    },
    [canvasId, boardNeedsAutoName, nodesRef, setNodes]
  );

  const generateNodeAnswer = useCallback(
    async (
      nodeId: string,
      questionText: string,
      generateOpts?: { model?: string; enableWebSearch?: boolean }
    ) => {
      if (!checkAiQuota()) return;
      if (canvasId) trackOnce(`ai_first_${canvasId}`, 'ai_generate_first');
      markChecklistStep('generate');

      const targetNode = nodesRef.current.find((n) => n.id === nodeId);
      const existingData = targetNode?.data as unknown as ChatNodeData | undefined;

      const activeModel =
        generateOpts?.model || existingData?.model || defaultModel || '';
      const activeWebSearch =
        generateOpts?.enableWebSearch !== undefined
          ? generateOpts.enableWebSearch
          : existingData?.enableWebSearch !== undefined
          ? existingData.enableWebSearch
          : defaultEnableWebSearch;

      requestImmediateSave();
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

      const ancestorContext = buildAncestorContext(nodeId, nodesRef.current, edgesRef.current);
      let effectiveQuestion = questionText;
      if (
        existingData?.branchTriggerPhrase &&
        !questionText.includes(existingData.branchTriggerPhrase)
      ) {
        effectiveQuestion = `[深入探讨分支重点: "${existingData.branchTriggerPhrase}"]\n${questionText}`;
      }
      const lastContext = ancestorContext[ancestorContext.length - 1];
      if (!lastContext || lastContext.content !== effectiveQuestion) {
        ancestorContext.push({ role: 'user', content: effectiveQuestion });
      }

      let rawAccumulatedText = '';
      let receivedGrounding: GroundingMetadata | undefined = undefined;

      const abortController = new AbortController();
      activeStreamAbortRef.current = abortController;
      lastStreamFlushRef.current = Date.now();
      let lastMeasuredHeight = getCardRealHeight(nodeId, '', questionText);
      let isCompleted = false;

      const timeoutId = setTimeout(() => {
        if (!isCompleted) {
          setApiWarning('AI 模型响应较慢，由于云端推理排队或并发较高，请您耐心等待…');
          setTimeout(() => setApiWarning(null), 5000);
        }
      }, 10000);

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
          signal: abortController.signal,
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
            if (buffer.trim()) {
              const trailingLines = buffer.split('\n');
              for (const line of trailingLines) {
                if (line.startsWith('data: ')) {
                  try {
                    const parsed = JSON.parse(line.slice(6));
                    if (parsed.grounding) receivedGrounding = parsed.grounding;
                    if (parsed.text) rawAccumulatedText += parsed.text;
                  } catch {}
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
                  receivedGrounding = undefined;
                  lastMeasuredHeight = getCardRealHeight(nodeId, '', questionText);
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
                  const currentAnswer = extractSuggestions(rawAccumulatedText).answer.trimEnd();

                  if (Date.now() - lastStreamFlushRef.current >= STREAM_FLUSH_INTERVAL_MS) {
                    lastStreamFlushRef.current = Date.now();
                    requestImmediateSave();
                  }

                  const currentHeight = getCardRealHeight(nodeId, currentAnswer, questionText);
                  const deltaH = currentHeight - lastMeasuredHeight;

                  // 当流式文字增高量达到阈值（≥35px，约1.5行文字高度）时，执行纵向避让推挤（零视口抖动）
                  if (deltaH >= 35) {
                    lastMeasuredHeight = currentHeight;
                    const currentStreamingNode = nodesRef.current.find((n) => n.id === nodeId);
                    const currentY = currentStreamingNode?.position.y ?? 0;
                    const currentX = currentStreamingNode?.position.x ?? 0;

                    // 寻找所有纵向位于当前节点下方且处于列重叠范围内的分支根节点
                    const collisionRoots: string[] = [];
                    nodesRef.current.forEach((n) => {
                      if (n.id === nodeId) return;
                      if (n.position.y > currentY && Math.abs(n.position.x - currentX) < 480) {
                        collisionRoots.push(n.id);
                      }
                    });

                    if (collisionRoots.length > 0) {
                      // 递归收集碰撞根节点及其全部下游子孙，联动向下平滑推移 deltaH
                      const nodesToShift = new Set<string>();
                      const queue = [...collisionRoots];
                      collisionRoots.forEach((id) => nodesToShift.add(id));

                      while (queue.length > 0) {
                        const curr = queue.shift()!;
                        edgesRef.current
                          .filter((e) => e.source === curr)
                          .forEach((e) => {
                            if (!nodesToShift.has(e.target) && e.target !== nodeId) {
                              nodesToShift.add(e.target);
                              queue.push(e.target);
                            }
                          });
                      }

                      setNodes((nds) => {
                        const next = nds.map((n) => {
                          if (n.id === nodeId) {
                            const d = n.data as unknown as ChatNodeData;
                            return { ...n, data: { ...d, answer: currentAnswer } };
                          }
                          if (nodesToShift.has(n.id)) {
                            return {
                              ...n,
                              position: {
                                x: n.position.x,
                                y: n.position.y + deltaH,
                              },
                            };
                          }
                          return n;
                        });
                        nodesRef.current = next;
                        return next;
                      });
                      continue;
                    }
                  }

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

        const { answer: finalAnswer, suggestions: modelSuggestions } =
          extractSuggestions(rawAccumulatedText);
        let parsedSuggestions = modelSuggestions;

        if (parsedSuggestions.length === 0) {
          parsedSuggestions = getFallbackSuggestions(questionText);
        }

        const currentNode = nodesRef.current.find((n) => n.id === nodeId);
        const currentDepth = (currentNode?.data as unknown as ChatNodeData)?.depth ?? 0;

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

        requestImmediateSave();
        nodesRef.current = finalizedNodes;
        setNodes(finalizedNodes);

        spawnSuggestedNodes(nodeId, parsedSuggestions, currentDepth, finalizedNodes);
        void autoTitleNode(nodeId, questionText, finalAnswer);
      } catch (err: any) {
        console.error('Error generating AI response:', err);
        const friendlyMessage = sanitizeErrorMessage(err);
        requestImmediateSave();
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
      } finally {
        if (activeStreamAbortRef.current === abortController) {
          activeStreamAbortRef.current = null;
        }
      }
    },
    [
      checkAiQuota,
      canvasId,
      nodesRef,
      defaultModel,
      defaultEnableWebSearch,
      requestImmediateSave,
      setNodes,
      edgesRef,
      openAuthModal,
      spawnSuggestedNodes,
      autoTitleNode,
    ]
  );

  return {
    generateNodeAnswer,
    activeStreamAbortRef,
    apiWarning,
    setApiWarning,
  };
}
