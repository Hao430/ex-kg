/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import {
  Sparkles,
  Trash2,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  AlertCircle,
  RotateCw,
  HelpCircle,
  X,
  ArrowRight,
  GitFork,
  Globe,
  ExternalLink,
  Cpu,
  Search,
  FolderPlus,
} from 'lucide-react';
import { ChatNodeData } from '../../types';
import { useNodeActions } from '../../context/NodeActionsContext';
import { useModal } from '../../context/ModalContext';
import { Tooltip } from '../ui/Tooltip';
import { useRenderMonitor } from '../../hooks/useRenderMonitor';
import { useClickOutside } from '../../hooks/useClickOutside';
import { Spinner } from '../ui/base/Spinner';
import { getChatDraft, setChatDraft, clearChatDraft } from '../../lib/chat-draft.js';

// Preprocess LaTeX math syntax so remark-math and rehype-katex render it properly
function preprocessLaTeX(content: string): string {
  if (!content) return '';
  return content
    // Convert \[ ... \] block math to $$ ... $$
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, math) => `\n\n$$\n${math.trim()}\n$$\n\n`)
    // Convert \( ... \) inline math to $ ... $
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, math) => `$${math.trim()}$`);
}

/**
 * 角标链接化（#4b 来源索引）：把正文中指向真实来源的 [n] 角标替换为内部锚点链接
 * `[n](#src-n)`，由下方 markdownComponents 的 a 定制渲染为可点击上标徽章。
 * 规则：
 * - 仅纯数字 1~2 位角标（天然排除 [^1] 脚注），(?!\() 排除已是链接的 [1](url)；
 * - n 超过来源数（maxIndex）不替换，防止模型幻觉编号产生假跳转；
 * - 数学公式（$...$ / $$...$$）与代码块（```）段内跳过，避免污染语法。
 */
export function linkifyCitations(content: string, maxIndex: number): string {
  if (!content || maxIndex < 1) return content;
  const replaceIn = (segment: string) =>
    segment.replace(/\[(\d{1,2})\](?!\()/g, (match, num: string) => {
      const n = Number(num);
      return n >= 1 && n <= maxIndex ? `[${n}](#src-${n})` : match;
    });
  // 按 数学公式 / 代码块 分段，仅对普通文本段执行替换
  return content
    .split(/(\$\$[\s\S]*?\$\$|\$[^$\n]*?\$|```[\s\S]*?```|`[^`\n]*?`)/g)
    .map((seg, i) => (i % 2 === 1 ? seg : replaceIn(seg)))
    .join('');
}

/** 来源链接协议白名单（#8）：仅 http(s) 可作为跳转 href，其余渲染为纯文本 */
export function isSafeSourceUri(uri: string | undefined | null): boolean {
  return typeof uri === 'string' && /^https?:\/\//i.test(uri);
}

// ---------------------------------------------------------------------------
// Markdown 渲染配置（性能：模块级常量，避免每次渲染重建引用导致
// ReactMarkdown 无法复用解析结果；components 映射与插件数组均稳定）
// ---------------------------------------------------------------------------
const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS = [rehypeKatex];
const MARKDOWN_COMPONENTS = {
  p: ({ children }: any) => (
    <p className="mb-2.5 last:mb-0 leading-relaxed text-slate-700 dark:text-slate-300 break-words">{children}</p>
  ),
  h1: ({ children }: any) => (
    <h1 className="text-base font-bold text-slate-900 dark:text-slate-100 mt-3 mb-2">{children}</h1>
  ),
  h2: ({ children }: any) => (
    <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100 mt-2.5 mb-1.5">{children}</h2>
  ),
  h3: ({ children }: any) => (
    <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 mt-2 mb-1">{children}</h3>
  ),
  ul: ({ children }: any) => (
    <ul className="list-disc pl-4 mb-2.5 space-y-1 text-slate-700 dark:text-slate-300">{children}</ul>
  ),
  ol: ({ children }: any) => (
    <ol className="list-decimal pl-4 mb-2.5 space-y-1 text-slate-700 dark:text-slate-300">{children}</ol>
  ),
  li: ({ children }: any) => <li className="leading-relaxed">{children}</li>,
  blockquote: ({ children }: any) => (
    <blockquote className="border-l-3 border-indigo-500 dark:border-indigo-400 pl-3.5 py-1.5 my-2 bg-indigo-50/40 dark:bg-indigo-950/25 rounded-r-lg text-slate-700 dark:text-slate-300 text-xs italic">
      {children}
    </blockquote>
  ),
  code: ({ className, children, ...props }: any) => {
    const isInline = !className && typeof children === 'string' && !children.includes('\n');
    if (isInline) {
      return (
        <code
          className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-indigo-700 dark:text-indigo-300 font-mono text-[11px] font-medium border border-slate-200/60 dark:border-slate-700"
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <div className="my-2.5 rounded-xl bg-[#090e1a] dark:bg-[#060a12] p-3 text-slate-100 font-mono text-xs overflow-x-auto shadow-xs border border-slate-800/80">
        <code {...props}>{children}</code>
      </div>
    );
  },
  table: ({ children }: any) => (
    <div className="overflow-x-auto my-2.5 border border-slate-200 dark:border-slate-700 rounded-lg">
      <table className="min-w-full text-xs text-left border-collapse">{children}</table>
    </div>
  ),
  th: ({ children }: any) => (
    <th className="px-3 py-2 bg-slate-100 dark:bg-slate-800 font-semibold text-slate-800 dark:text-slate-200 border-b border-slate-200 dark:border-slate-700">
      {children}
    </th>
  ),
  td: ({ children }: any) => (
    <td className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 text-slate-700 dark:text-slate-300">{children}</td>
  ),
  strong: ({ children }: any) => <strong className="font-semibold text-slate-900 dark:text-white">{children}</strong>,
  a: ({ href, children }: any) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-indigo-600 dark:text-indigo-400 underline hover:text-indigo-800 dark:hover:text-indigo-300"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-3 border-slate-200 dark:border-slate-800" />,
} as const;

/** 流式渲染节流间隔：generating 期间 Markdown 重解析频率上限（毫秒） */
const STREAM_RENDER_INTERVAL_MS = 150;

export const ChatCardNode: React.FC<NodeProps> = React.memo(({ id, data, selected }) => {
  const nodeData = data as unknown as ChatNodeData;
  // 只读模式（分享页/示例画布）：隐藏交互控件，仅保留展示；动作经 readOnlyNodeActions 桩兜底
  const readOnly = Boolean(nodeData.readOnly);
  const nodeActions = useNodeActions();
  const { openAuthModal, openRechargeModal } = useModal();

  // 输入的初值取自未提交草稿（sessionStorage，按节点 + 输入框种类）：
  // 提问框在提交前只是组件 state，切走画板/重挂载就没了——用户体感是「我打的字消失了」。
  const [followUpInput, setFollowUpInput] = useState(() => getChatDraft(id, 'followup'));
  const [initialInput, setInitialInput] = useState(() => getChatDraft(id, 'initial'));
  const [copied, setCopied] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState(nodeData.title || '思维节点');
  const [showSources, setShowSources] = useState(true);
  /** #4b：点击正文角标后短暂高亮的来源编号（1.5s 自动清除） */
  const [highlightSource, setHighlightSource] = useState<number | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const sourcesContainerRef = useRef<HTMLDivElement>(null);
  const renderWarning = useRenderMonitor(`ChatNode_${id}`);

  // #点击空白地方自动收起：当参考来源展开时，点击卡片外部/正文空白/画布空白自动收起
  // 使用捕获阶段确保即使节点内部容器调用了 stopPropagation 也能可靠捕获
  useClickOutside({
    refs: [sourcesContainerRef],
    enabled: showSources,
    onOutside: () => setShowSources(false),
    // 正文引用角标 <sup> 与锚点链接交由 handleCitationClick 处理展开与高亮定位
    ignore: (target) =>
      target.closest('sup') !== null ||
      target.getAttribute('href')?.startsWith('#src-') === true,
  });

  // Auto scroll to latest answer text while generating
  useEffect(() => {
    if (nodeData.status === 'generating') {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [nodeData.answer, nodeData.status]);

  const currentAnswerText =
    nodeData.answer ??
    nodeData.messages?.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n\n') ??
    '';

  // 流式节流：generating 期间 answer 高频增长，全量重解析 Markdown+KaTeX 是最大渲染热点。
  // 限频到 ~150ms 一次；非 generating（含最终完成帧）总是渲染最新全文。
  const [throttledAnswer, setThrottledAnswer] = useState<string | null>(null);
  const lastFlushRef = useRef(0);
  useEffect(() => {
    if (nodeData.status !== 'generating') {
      setThrottledAnswer(null); // 完成态：直接渲染全文
      return;
    }
    const now = Date.now();
    if (now - lastFlushRef.current >= STREAM_RENDER_INTERVAL_MS) {
      lastFlushRef.current = now;
      setThrottledAnswer(currentAnswerText);
    } else {
      const t = setTimeout(() => {
        lastFlushRef.current = Date.now();
        setThrottledAnswer(currentAnswerText);
      }, STREAM_RENDER_INTERVAL_MS);
      return () => clearTimeout(t);
    }
  }, [currentAnswerText, nodeData.status]);
  const renderedAnswer = nodeData.status === 'generating' && throttledAnswer !== null ? throttledAnswer : currentAnswerText;

  const processedAnswer = useMemo(
    () => linkifyCitations(preprocessLaTeX(renderedAnswer), nodeData.grounding?.sources?.length || 0),
    [renderedAnswer, nodeData.grounding?.sources?.length]
  );

  // #4b：点击正文上标角标 → 展开来源面板并滚动高亮对应项
  const handleCitationClick = (n: number) => {
    setShowSources(true);
    setHighlightSource(n);
    requestAnimationFrame(() => {
      document.getElementById(`chat-src-${id}-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    setTimeout(() => setHighlightSource(null), 1500);
  };

  // #4b/#8：markdown a 组件定制——#src- 内部锚点渲染为上标徽章；
  // 非 http(s) 协议渲染为纯文本（防 javascript: 等伪协议）；其余保持外链样式。
  // useMemo 稳定引用，避免破坏 ReactMarkdown 解析缓存（见 MARKDOWN_COMPONENTS 注释）。
  const markdownComponents = useMemo(
    () => ({
      ...MARKDOWN_COMPONENTS,
      a: ({ href, children }: any) => {
        if (typeof href === 'string' && href.startsWith('#src-')) {
          const n = Number(href.slice(5));
          if (Number.isInteger(n)) {
            return (
              <sup
                onClick={(e) => {
                  e.preventDefault();
                  handleCitationClick(n);
                }}
                title={`查看来源 [${n}]`}
                className="cursor-pointer select-none mx-0.5 px-1 rounded text-[9px] font-bold leading-none align-super bg-indigo-100 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-600 hover:text-white transition-colors"
              >
                {n}
              </sup>
            );
          }
        }
        if (typeof href === 'string' && !/^https?:\/\//i.test(href)) {
          return <span className="text-slate-700 dark:text-slate-300">{children}</span>;
        }
        return MARKDOWN_COMPONENTS.a({ href, children });
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id]
  );

  const handleCopy = () => {
    const qText = nodeData.question ? `[提问]\n${nodeData.question}\n\n` : '';
    const aText = nodeData.answer
      ? `[回答]\n${nodeData.answer}`
      : (nodeData.messages || [])
          .map((m) => `[${m.role === 'user' ? '用户' : 'AI'}]\n${m.content}`)
          .join('\n\n');
    const sourcesText =
      nodeData.grounding?.sources && nodeData.grounding.sources.length > 0
        ? `\n\n[参考来源]\n` +
          nodeData.grounding.sources.map((s) => `[${s.index}] ${s.title}: ${s.uri}`).join('\n')
        : '';
    navigator.clipboard.writeText(`${qText}${aText}${sourcesText}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Follow-up inquiry: creates a NEW child node for the next dialogue
  const handleFollowUpSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const query = followUpInput.trim();
    if (!query || nodeData.status === 'generating') return;
    const options = {
      model: nodeData.model,
      enableWebSearch: true,
    };
    nodeActions?.followUpInquiry?.(id, query, options);
    setFollowUpInput('');
    clearChatDraft(id, 'followup'); // 已提交：清掉草稿，别让下次打开误以为是新输入
  };

  // Initial question submit if node is an empty root
  const handleInitialSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const query = initialInput.trim();
    if (!query) return;
    const options = {
      model: nodeData.model,
      enableWebSearch: true,
    };
    nodeActions?.sendMessage?.(id, query, options);
    setInitialInput('');
    clearChatDraft(id, 'initial');
  };

  const handleTitleSubmit = () => {
    setEditingTitle(false);
    const trimmed = titleValue.trim();
    if (trimmed) {
      nodeActions?.updateTitle?.(id, trimmed);
    } else {
      setTitleValue(nodeData.title);
    }
  };

  const handleDelete = () => {
    nodeActions?.deleteNode?.(id);
  };

  const handleToggleCollapse = () => {
    nodeActions?.toggleCollapse?.(id);
  };

  const handleActivateSuggestion = () => {
    nodeActions?.activateSuggestion?.(id);
  };

  const handleRetry = () => {
    const q = nodeData.question || nodeData.messages?.find((m) => m.role === 'user')?.content || '';
    if (q) {
      const options = {
        model: nodeData.model,
        enableWebSearch: true,
      };
      nodeActions?.sendMessage?.(id, q, options);
    }
  };  // --------------------------------------------------------------------------
  // MODE A: Exploration Suggestion Node (Specialized Branch Trigger Pill Card)
  // --------------------------------------------------------------------------
  if (nodeData.status === 'suggested') {
    const questionFull = nodeData.question || nodeData.title;
    return (
      <div
        className={`group relative w-[290px] rounded-2xl border bg-white/90 dark:bg-[#0c1222]/90 backdrop-blur-xl shadow-[0_8px_30px_rgba(99,102,241,0.08)] dark:shadow-[0_12px_32px_rgba(0,0,0,0.5)] transition-all duration-200 hover:border-indigo-400 dark:hover:border-indigo-500/80 hover:shadow-[0_12px_36px_rgba(99,102,241,0.16)] ${
          selected
            ? 'border-indigo-500 ring-4 ring-indigo-500/20 shadow-[0_12px_36px_rgba(99,102,241,0.2)]'
            : 'border-indigo-200/80 dark:border-indigo-900/50'
        }`}
      >
        {renderWarning && (
          <div className="absolute -top-10 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-500 text-xs font-medium shadow-md backdrop-blur-md whitespace-nowrap z-50 animate-in fade-in slide-in-from-bottom-2">
            {renderWarning}
          </div>
        )}

        {/* Incoming Handle */}
        <Handle
          type="target"
          position={Position.Left}
          id="in"
          className="!w-3.5 !h-3.5 !bg-white dark:!bg-slate-900 !border-2 !border-indigo-500 dark:!border-indigo-400 !-left-[7px] transition-transform hover:!scale-125 shadow-xs"
        />

        {/* Header Bar */}
        <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-indigo-100/80 dark:border-indigo-900/40 bg-indigo-50/50 dark:bg-indigo-950/40 rounded-t-2xl">
          <div className="flex items-center gap-1.5">
            <span className="flex items-center justify-center w-5 h-5 rounded-md bg-indigo-500/15 text-indigo-600 dark:text-indigo-400">
              <Sparkles className="w-3 h-3 animate-pulse" />
            </span>
            <span className="text-[11px] font-semibold text-indigo-900 dark:text-indigo-200 tracking-wide">
              探索灵感
            </span>
          </div>

          {!readOnly && (
            <Tooltip content="关闭该探索建议" side="top">
              <button
                onClick={handleDelete}
                className="p-1 text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/50 rounded-md transition-colors opacity-80 hover:opacity-100 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </Tooltip>
          )}
        </div>

        {/* Suggestion Question Body */}
        <div className="p-3.5">
          <div className="flex items-start gap-2.5 mb-3.5">
            <HelpCircle className="w-4 h-4 text-indigo-500 dark:text-indigo-400 group-hover:text-indigo-600 dark:group-hover:text-indigo-300 shrink-0 mt-0.5 transition-colors" />
            <Tooltip content={questionFull} side="top">
              <p className="text-xs font-semibold text-slate-700 dark:text-slate-200 group-hover:text-slate-900 dark:group-hover:text-white leading-relaxed line-clamp-3 transition-colors cursor-help">
                {questionFull}
              </p>
            </Tooltip>
          </div>

          {!readOnly && (
            <Tooltip content="点击以此问题创建独立的思维分支" side="bottom">
              <button
                onClick={handleActivateSuggestion}
                className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-xl bg-gradient-to-r from-indigo-600 via-indigo-500 to-blue-600 hover:from-indigo-500 hover:to-blue-500 text-white text-xs font-semibold shadow-sm shadow-indigo-500/25 hover:shadow-md hover:shadow-indigo-500/35 transition-all active:scale-[0.98] cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>展开深度探讨</span>
                <ArrowRight className="w-3.5 h-3.5 ml-0.5" />
              </button>
            </Tooltip>
          )}
        </div>

        {/* Outgoing Handle */}
        <Handle
          type="source"
          position={Position.Right}
          id="out"
          className="!w-3.5 !h-3.5 !bg-white dark:!bg-slate-900 !border-2 !border-indigo-500 dark:!border-indigo-400 !-right-[7px] transition-transform hover:!scale-125 shadow-xs"
        />
      </div>
    );
  }

  // --------------------------------------------------------------------------
  // MODE B: Active / Answered Single Q&A Node
  // --------------------------------------------------------------------------
  const hasQuestion = Boolean(nodeData.question || (nodeData.messages && nodeData.messages.length > 0));
  const currentQuestionText =
    nodeData.question ||
    nodeData.messages?.find((m) => m.role === 'user')?.content ||
    nodeData.title;

  return (
    <div
      className={`relative w-[460px] rounded-2xl border bg-white/95 dark:bg-[#0c1222]/95 backdrop-blur-xl shadow-[0_10px_35px_rgba(0,0,0,0.05),0_1px_3px_rgba(0,0,0,0.03)] dark:shadow-[0_16px_45px_rgba(0,0,0,0.6),0_0_0_1px_rgba(255,255,255,0.05)] transition-all duration-200 ${
        selected
          ? 'border-indigo-500 ring-4 ring-indigo-500/20 dark:ring-indigo-500/30 shadow-[0_16px_40px_rgba(99,102,241,0.18)]'
          : 'border-slate-200/90 dark:border-white/[0.08] hover:border-slate-300 dark:hover:border-white/20'
      }`}
    >
      {renderWarning && (
        <div className="absolute -top-10 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-500 text-xs font-medium shadow-md backdrop-blur-md whitespace-nowrap z-50 animate-in fade-in slide-in-from-bottom-2">
          {renderWarning}
        </div>
      )}
      
      {/* Input / Incoming Handle (Left) */}
      <Handle
        type="target"
        position={Position.Left}
        id="in"
        className="!w-3.5 !h-3.5 !bg-white dark:!bg-slate-900 !border-2 !border-indigo-500 dark:!border-indigo-400 !-left-[7px] transition-transform hover:!scale-125 shadow-xs"
      />

      {/* Node Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 dark:border-slate-800/80 bg-slate-50/80 dark:bg-slate-900/70 rounded-t-2xl">
        <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
          <span className="flex items-center justify-center w-6 h-6 rounded-lg bg-indigo-50 dark:bg-indigo-950/70 text-indigo-600 dark:text-indigo-400 border border-indigo-100/80 dark:border-indigo-900/50 shrink-0">
            <Sparkles className="w-3.5 h-3.5" />
          </span>

          {editingTitle ? (
            <input
              type="text"
              value={titleValue}
              onChange={(e) => setTitleValue(e.target.value)}
              onBlur={handleTitleSubmit}
              onKeyDown={(e) => e.key === 'Enter' && handleTitleSubmit()}
              // 双击（选中文本等）不冒泡到 React Flow 视口，避免编辑时意外缩放
              onDoubleClick={(e) => e.stopPropagation()}
              autoFocus
              className="px-2 py-0.5 text-xs font-semibold text-slate-800 dark:text-slate-100 bg-white dark:bg-slate-800 border border-indigo-500 dark:border-indigo-400 rounded-lg outline-none w-full"
            />
          ) : (
            <Tooltip content={readOnly ? nodeData.title : '双击可重命名此节点标题'} side="top">
              <span
                // stopPropagation：阻断冒泡到 React Flow 的 d3-zoom（zoomOnDoubleClick 默认开），
                // 否则双击重命名会先触发视口放大，重命名被缩放淹没
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  if (readOnly) return;
                  setEditingTitle(true);
                }}
                className={`text-xs font-semibold text-slate-800 dark:text-slate-100 truncate transition-colors ${
                  readOnly ? '' : 'cursor-pointer hover:text-indigo-600 dark:hover:text-indigo-400'
                }`}
              >
                {nodeData.title}
              </span>
            </Tooltip>
          )}

          {nodeData.status === 'generating' && (
            <span className="shrink-0 flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-semibold rounded-full bg-indigo-500/10 text-indigo-600 dark:text-indigo-300 border border-indigo-500/25">
              <Spinner size="xs" />
              <span>推演中</span>
            </span>
          )}

          {nodeData.status === 'idle' && currentAnswerText && (
            <span className="shrink-0 flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20">
              <Check className="w-2.5 h-2.5 text-emerald-600 dark:text-emerald-400" />
              <span>就绪</span>
            </span>
          )}
        </div>

        {/* Header Action Buttons（只读模式仅保留复制：其余动作在分享页/示例画布无意义） */}
        <div className="flex items-center gap-1 shrink-0">
          {!readOnly && (
            <Tooltip content="将以此节点为起点的子分支导出为独立画板" side="top">
              <button
                onClick={() => nodeActions?.exportSubBranch?.(id)}
                className="p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/50 rounded-lg transition-colors cursor-pointer"
              >
                <FolderPlus className="w-3.5 h-3.5" />
              </button>
            </Tooltip>
          )}

          <Tooltip content={copied ? '已复制到剪贴板' : '复制节点完整问答内容'} side="top">
            <button
              onClick={handleCopy}
              className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-800/60 rounded-lg transition-colors cursor-pointer"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          </Tooltip>

          {!readOnly && (
            <>
              <Tooltip content={nodeData.isCollapsed ? '展开节点内容' : '折叠收起节点'} side="top">
                <button
                  onClick={handleToggleCollapse}
                  className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-800/60 rounded-lg transition-colors cursor-pointer"
                >
                  {nodeData.isCollapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
                </button>
              </Tooltip>

              <Tooltip content="删除此节点" side="top">
                <button
                  onClick={handleDelete}
                  className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/50 rounded-lg transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </Tooltip>
            </>
          )}
        </div>
      </div>

      {/* Sub-branch trigger pill if applicable */}
      {nodeData.branchTriggerPhrase && (
        <Tooltip content={`聚焦议题: ${nodeData.branchTriggerPhrase}`} side="top">
          <div className="px-4 py-1.5 bg-indigo-50/60 dark:bg-indigo-950/40 border-b border-indigo-100 dark:border-indigo-900/50 text-[11px] text-indigo-700 dark:text-indigo-300 flex items-center gap-1.5 font-medium cursor-help">
            <span className="shrink-0">🐰 聚焦议题:</span>
            <span className="truncate italic">"{nodeData.branchTriggerPhrase}"</span>
          </div>
        </Tooltip>
      )}

      {/* Question Header (Single Q&A format) */}
      {hasQuestion && !nodeData.isCollapsed && (
        <div className="px-4 py-2.5 bg-slate-50/70 dark:bg-slate-900/50 border-b border-slate-100 dark:border-slate-800/80 flex items-start gap-2.5">
          <span className="shrink-0 w-5 h-5 rounded-md bg-gradient-to-tr from-indigo-600 to-blue-600 text-white flex items-center justify-center text-[10px] font-bold mt-0.5 shadow-xs">
            问
          </span>
          <Tooltip content={currentQuestionText} side="top">
            <p className="text-xs font-semibold text-slate-800 dark:text-slate-100 leading-relaxed select-text break-words">
              {currentQuestionText}
            </p>
          </Tooltip>
        </div>
      )}

      {/* Node Body (Collapsible, with isolated scrollable container) */}
      {!nodeData.isCollapsed && (
        <div className="flex flex-col">
          {/* Scrollable Content Container with nowheel/nopan to prevent ReactFlow zoom */}
          <div
            ref={contentRef}
            onWheel={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            className="nodrag nowheel nopan p-4 max-h-[380px] overflow-y-auto overscroll-contain flex flex-col gap-3 text-sm text-slate-700 dark:text-slate-200 select-text cursor-text"
          >
            {/* If node is an empty root node without a question yet */}
            {!hasQuestion && !readOnly && (
              <div className="py-2">
                <p className="text-xs text-slate-600 dark:text-slate-400 font-medium mb-2.5">
                  输入你想探索的科学、哲学或工程议题：
                </p>
                <form onSubmit={handleInitialSubmit} className="flex gap-2 mb-3">
                  <input
                    type="text"
                    value={initialInput}
                    onChange={(e) => {
                      setInitialInput(e.target.value);
                      setChatDraft(id, 'initial', e.target.value);
                    }}
                    placeholder="例如：量子纠错码（Surface Code）核心架构是什么？"
                    className="nodrag flex-1 px-3 py-2 text-xs border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/10 text-slate-800 dark:text-slate-100 bg-white dark:bg-slate-800/80 placeholder:text-slate-400 dark:placeholder:text-slate-500"
                    autoFocus
                  />
                  <button
                    type="submit"
                    disabled={!initialInput.trim() || nodeData.status === 'generating'}
                    className="nodrag px-3.5 py-2 text-xs font-medium text-white bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-500 hover:to-blue-500 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-xs flex items-center gap-1 shrink-0 cursor-pointer"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>开始探索</span>
                  </button>
                </form>

                {/* Quick topic inspiration pills */}
                <div className="flex flex-col gap-1.5 pt-2 border-t border-slate-100 dark:border-slate-800">
                  <span className="text-[10px] text-slate-400 dark:text-slate-500 font-medium">✨ 或快速选择推荐议题探索：</span>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      '什么是 AI Agent？与聊天机器人有何不同',
                      '特修斯之船：换了所有零件的船还是原船吗',
                      '自由意志存在吗？——决定论与相容论',
                    ].map((preset) => (
                      <Tooltip key={preset} content={`点击快速探索议题: ${preset}`} side="bottom">
                        <button
                          type="button"
                          onClick={() => {
                            setInitialInput(preset);
                            nodeActions?.sendMessage?.(id, preset);
                          }}
                          className="nodrag text-[11px] px-2.5 py-1 rounded-lg bg-indigo-50 dark:bg-indigo-950/40 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 font-normal transition-colors text-left border border-indigo-100 dark:border-indigo-900/50 cursor-pointer"
                        >
                          {preset}
                        </button>
                      </Tooltip>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {!hasQuestion && readOnly && (
              <p className="text-xs text-slate-400 dark:text-slate-500">（暂无内容）</p>
            )}

            {/* Answer Content with Full Markdown and LaTeX Math Support */}
            {currentAnswerText ? (
              <div className="text-[13px] leading-relaxed text-slate-800 dark:text-slate-200 select-text">
                <ReactMarkdown
                  remarkPlugins={REMARK_PLUGINS}
                  rehypePlugins={REHYPE_PLUGINS}
                  components={markdownComponents}
                >
                  {processedAnswer}
                </ReactMarkdown>

                {/* Grounding Sources / Reference Citations Section */}
                {nodeData.grounding?.sources && nodeData.grounding.sources.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-slate-200/80 dark:border-slate-800">
                    <div
                      ref={sourcesContainerRef}
                      className="border border-indigo-100 dark:border-indigo-900/50 bg-indigo-50/25 dark:bg-slate-900/60 rounded-xl overflow-hidden shadow-xs transition-all duration-200"
                    >
                      {/* Source Accordion Header */}
                      <button
                        type="button"
                        onClick={() => setShowSources(!showSources)}
                        className="nodrag w-full px-3 py-2 flex items-center justify-between text-xs font-semibold text-indigo-950 dark:text-indigo-300 hover:bg-indigo-100/40 dark:hover:bg-slate-800/90 transition-colors cursor-pointer"
                      >
                        <div className="flex items-center gap-1.5 truncate mr-2">
                          <Globe className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400 shrink-0" />
                          <span>参考来源与事实索引 ({nodeData.grounding.sources.length})</span>
                          {nodeData.grounding.queries && nodeData.grounding.queries.length > 0 && (
                            <span className="hidden sm:inline text-[10px] text-slate-500 dark:text-slate-400 font-normal truncate max-w-[200px]">
                              · 检索词: "{nodeData.grounding.queries[0]}"
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0 text-slate-400">
                          <span className="text-[10px] font-normal">{showSources ? '收起' : '展开'}</span>
                          {showSources ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                        </div>
                      </button>

                      {/* Source Items Grid */}
                      {showSources && (
                        <div className="nodrag p-2.5 pt-1 grid grid-cols-1 gap-1.5 border-t border-indigo-100/80 dark:border-slate-700/60 max-h-56 overflow-y-auto overscroll-contain">
                          {nodeData.grounding.sources.map((src) => {
                            // #8 协议白名单：仅 http(s) 渲染为跳转链接，其余为纯文本展示
                            const isHttpLink = isSafeSourceUri(src.uri);
                            const Wrapper: any = isHttpLink ? 'a' : 'div';
                            const linkProps = isHttpLink
                              ? { href: src.uri, target: '_blank', rel: 'noopener noreferrer' }
                              : {};
                            return (
                              <Tooltip
                                key={`${src.uri}-${src.index}`}
                                content={isHttpLink ? `点击直达权威来源: ${src.uri}` : `来源: ${src.title}`}
                                side="top"
                              >
                                <Wrapper
                                  {...linkProps}
                                  id={`chat-src-${id}-${src.index}`}
                                  className={`flex items-start gap-2 p-2 rounded-lg bg-white dark:bg-slate-900/90 border transition-all group ${
                                    isHttpLink ? 'cursor-pointer ' : ''
                                  }${
                                    highlightSource === src.index
                                      ? 'border-indigo-500 ring-2 ring-indigo-400/60 shadow-sm'
                                      : 'border-slate-200/70 dark:border-slate-700/70 hover:border-indigo-400 dark:hover:border-indigo-500 hover:shadow-xs'
                                  }`}
                                >
                                  <span className="shrink-0 w-4 h-4 rounded-md bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 font-mono text-[10px] font-bold flex items-center justify-center mt-0.5 group-hover:bg-indigo-600 group-hover:text-white transition-colors">
                                    {src.index}
                                  </span>
                                  <div className="flex-1 min-w-0">
                                    <p className="text-[11px] font-medium text-slate-800 dark:text-slate-200 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 truncate leading-snug">
                                      {src.title}
                                    </p>
                                    {src.snippet && (
                                      <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400 line-clamp-2 leading-snug">
                                        {src.snippet}
                                      </p>
                                    )}
                                    <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">
                                      <span className="truncate">{src.domain}</span>
                                      {isHttpLink && (
                                        <>
                                          <span>•</span>
                                          <span className="inline-flex items-center gap-0.5 text-indigo-600 dark:text-indigo-400 group-hover:underline">
                                            直达出处 <ExternalLink className="w-2.5 h-2.5" />
                                          </span>
                                        </>
                                      )}
                                    </div>
                                  </div>
                                </Wrapper>
                              </Tooltip>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : null}

            {/* Generating indicator */}
            {nodeData.status === 'generating' && (
              <div className="flex flex-col gap-1.5 py-1.5 px-2.5 bg-indigo-50/70 dark:bg-indigo-950/50 rounded-lg w-fit border border-transparent dark:border-indigo-900/40">
                <div className="flex items-center gap-2 text-xs text-indigo-600 dark:text-indigo-400 font-medium">
                  <Spinner size="sm" />
                  <span>深度思考与推演中...</span>
                </div>
                {nodeData.enableWebSearch && (
                  <div className="flex items-center gap-1 text-[10px] text-indigo-500/90 dark:text-indigo-400/90">
                    <Globe className="w-3 h-3" />
                    <span>实时联网搜索中，正在索引权威知识源...</span>
                  </div>
                )}
              </div>
            )}

            {/* Error display with retry and quick CTA */}
            {nodeData.status === 'error' && (
              <div className="flex flex-col gap-2 p-3 bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-900/70 rounded-xl text-xs text-rose-800 dark:text-rose-200 shadow-sm">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
                  <span className="leading-snug flex-1 font-medium">{nodeData.errorMessage || '生成失败，请重试'}</span>
                </div>
                <div className="flex items-center justify-end gap-2 pt-1 border-t border-rose-200/60 dark:border-rose-900/50">
                  {!readOnly && (
                    <>
                      {nodeData.errorMessage?.includes('登录') && (
                        <button
                          onClick={() => openAuthModal('signin')}
                          className="nodrag flex items-center gap-1 px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-medium transition-colors cursor-pointer shadow-sm text-[11px]"
                        >
                          <span>登录 / 注册</span>
                          <ArrowRight className="w-3 h-3" />
                        </button>
                      )}
                      {(nodeData.errorMessage?.includes('会员') || nodeData.errorMessage?.includes('充值') || nodeData.errorMessage?.includes('升级')) && (
                        <button
                          onClick={() => openRechargeModal()}
                          className="nodrag flex items-center gap-1 px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded-lg font-medium transition-colors cursor-pointer shadow-sm text-[11px]"
                        >
                          <span>升级/续费会员</span>
                        </button>
                      )}
                      <Tooltip content="重新推演该问题" side="top">
                        <button
                          onClick={handleRetry}
                          className="nodrag flex items-center gap-1 px-2.5 py-1 bg-slate-700 hover:bg-slate-800 dark:bg-slate-800 dark:hover:bg-slate-700 text-white rounded-lg font-medium transition-colors cursor-pointer text-[11px]"
                        >
                          <RotateCw className="w-3 h-3" />
                          <span>重试</span>
                        </button>
                      </Tooltip>
                    </>
                  )}
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Node Footer / Follow-up Input: Always spawns a NEW child node */}
          {hasQuestion && !readOnly && (
            <div className="p-2.5 border-t border-slate-100 dark:border-slate-800/80 bg-slate-50/60 dark:bg-slate-900/40 rounded-b-2xl">
              <form onSubmit={handleFollowUpSubmit} className="relative flex items-center">
                <input
                  type="text"
                  value={followUpInput}
                  onChange={(e) => {
                    setFollowUpInput(e.target.value);
                    setChatDraft(id, 'followup', e.target.value);
                  }}
                  placeholder={
                    nodeData.status === 'generating'
                      ? 'AI 正在深度思考与推演中，请稍候...'
                      : '针对此解答继续追问（回车将衍生新分支节点）...'
                  }
                  disabled={nodeData.status === 'generating'}
                  className="nodrag w-full pl-3 pr-10 py-2 text-xs bg-white dark:bg-slate-800/90 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/10 placeholder:text-slate-400 dark:placeholder:text-slate-500 text-slate-800 dark:text-slate-100 disabled:bg-slate-100 dark:disabled:bg-slate-900 transition-all"
                />

                <Tooltip content="衍生追问（创建新的思维分支节点）" side="top">
                  <button
                    type="submit"
                    disabled={!followUpInput.trim() || nodeData.status === 'generating'}
                    className="nodrag absolute right-1.5 flex items-center justify-center p-1.5 text-white bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-500 hover:to-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-xs rounded-lg cursor-pointer active:scale-95"
                    aria-label="衍生追问"
                  >
                    <GitFork className="w-3.5 h-3.5" />
                  </button>
                </Tooltip>
              </form>
            </div>
          )}
        </div>
      )}

      {/* Output / Outgoing Handle (Right) */}
      <Handle
        type="source"
        position={Position.Right}
        id="out"
        className="!w-3.5 !h-3.5 !bg-white dark:!bg-slate-900 !border-2 !border-indigo-500 dark:!border-indigo-400 !-right-[7px] transition-transform hover:!scale-125 shadow-xs"
      />
    </div>
  );
});
ChatCardNode.displayName = 'ChatCardNode';
