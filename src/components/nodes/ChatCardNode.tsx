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
  Loader2,
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
} from 'lucide-react';
import { ChatNodeData } from '../../types';
import { useNodeActions } from '../../context/NodeActionsContext';

// Preprocess LaTeX math syntax so remark-math and rehype-katex render it properly
function preprocessLaTeX(content: string): string {
  if (!content) return '';
  return content
    // Convert \[ ... \] block math to $$ ... $$
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, math) => `\n\n$$\n${math.trim()}\n$$\n\n`)
    // Convert \( ... \) inline math to $ ... $
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, math) => `$${math.trim()}$`);
}

export const ChatCardNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const nodeData = data as unknown as ChatNodeData;
  const nodeActions = useNodeActions();

  const [followUpInput, setFollowUpInput] = useState('');
  const [initialInput, setInitialInput] = useState('');
  const [copied, setCopied] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState(nodeData.title || '思维节点');
  const [showSources, setShowSources] = useState(true);
  const [nodeWebSearch, setNodeWebSearch] = useState(
    nodeData.enableWebSearch !== undefined ? nodeData.enableWebSearch : true
  );
  const contentRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Sync nodeWebSearch when nodeData.enableWebSearch changes
  useEffect(() => {
    if (nodeData.enableWebSearch !== undefined) {
      setNodeWebSearch(nodeData.enableWebSearch);
    }
  }, [nodeData.enableWebSearch]);

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

  const processedAnswer = useMemo(() => preprocessLaTeX(currentAnswerText), [currentAnswerText]);

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
      enableWebSearch: nodeWebSearch,
    };
    if (nodeActions?.followUpInquiry) {
      nodeActions.followUpInquiry(id, query, options);
    } else {
      nodeData.onFollowUpInquiry?.(id, query, options);
    }
    setFollowUpInput('');
  };

  // Initial question submit if node is an empty root
  const handleInitialSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const query = initialInput.trim();
    if (!query) return;
    const options = {
      model: nodeData.model,
      enableWebSearch: nodeWebSearch,
    };
    if (nodeActions?.sendMessage) {
      nodeActions.sendMessage(id, query, options);
    } else {
      nodeData.onSendMessage?.(id, query, options);
    }
    setInitialInput('');
  };

  const handleTitleSubmit = () => {
    setEditingTitle(false);
    const trimmed = titleValue.trim();
    if (trimmed) {
      if (nodeActions?.updateTitle) {
        nodeActions.updateTitle(id, trimmed);
      } else {
        nodeData.onUpdateTitle?.(id, trimmed);
      }
    } else {
      setTitleValue(nodeData.title);
    }
  };

  const handleDelete = () => {
    if (nodeActions?.deleteNode) {
      nodeActions.deleteNode(id);
    } else {
      nodeData.onDelete?.(id);
    }
  };

  const handleToggleCollapse = () => {
    if (nodeActions?.toggleCollapse) {
      nodeActions.toggleCollapse(id);
    } else {
      nodeData.onToggleCollapse?.(id);
    }
  };

  const handleActivateSuggestion = () => {
    if (nodeActions?.activateSuggestion) {
      nodeActions.activateSuggestion(id);
    } else {
      nodeData.onActivateSuggestion?.(id);
    }
  };

  const handleRetry = () => {
    const options = {
      model: nodeData.model,
      enableWebSearch: nodeData.enableWebSearch,
    };
    if (nodeActions?.retry) {
      nodeActions.retry(id, options);
    } else {
      nodeData.onRetry?.(id, options);
    }
  };

  // --------------------------------------------------------------------------
  // MODE A: Suggested Question Card (虚化待探索候选节点)
  // --------------------------------------------------------------------------
  if (nodeData.status === 'suggested') {
    return (
      <div
        className={`relative w-[360px] rounded-2xl border-2 transition-all duration-300 backdrop-blur-md group ${
          selected
            ? 'border-indigo-500 bg-white/95 dark:bg-slate-900/95 ring-4 ring-indigo-500/15 dark:ring-indigo-500/30 shadow-xl opacity-100'
            : 'border-dashed border-indigo-300/80 dark:border-indigo-500/50 bg-white/55 dark:bg-slate-900/70 hover:bg-white/95 dark:hover:bg-slate-900/95 hover:border-indigo-500/80 dark:hover:border-indigo-400 opacity-65 hover:opacity-100 shadow-sm hover:shadow-lg'
        }`}
      >
        {/* Incoming Handle */}
        <Handle
          type="target"
          position={Position.Left}
          id="in"
          className="!w-3 !h-3 !bg-indigo-400 !border-2 !border-white dark:!border-slate-900 !-left-[6px] transition-transform hover:!scale-125"
        />

        {/* Suggestion Card Header */}
        <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-dashed border-indigo-200/80 dark:border-indigo-900/60 bg-indigo-50/40 dark:bg-indigo-950/40 rounded-t-2xl">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="flex items-center justify-center w-5 h-5 rounded-md bg-indigo-100/70 dark:bg-indigo-900/60 text-indigo-500 dark:text-indigo-400 group-hover:text-indigo-600 dark:group-hover:text-indigo-300 transition-colors">
              <Sparkles className="w-3 h-3" />
            </span>
            <span className="text-[11px] font-semibold text-indigo-700/80 dark:text-indigo-300 group-hover:text-indigo-800 dark:group-hover:text-indigo-200 tracking-wide">
              待探索分支建议
            </span>
            <span className="px-1.5 py-0.2 text-[9px] font-medium rounded-full bg-indigo-100/60 dark:bg-indigo-900/60 text-indigo-600 dark:text-indigo-300">
              深度 #{nodeData.depth}
            </span>
          </div>

          <button
            onClick={handleDelete}
            className="p-1 text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/50 rounded-md transition-colors opacity-80 hover:opacity-100"
            title="关闭该探索建议"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Suggestion Question Body */}
        <div className="p-3.5">
          <div className="flex items-start gap-2 mb-3">
            <HelpCircle className="w-4 h-4 text-indigo-400 dark:text-indigo-400 group-hover:text-indigo-600 dark:group-hover:text-indigo-300 shrink-0 mt-0.5 transition-colors" />
            <p className="text-xs font-semibold text-slate-600 dark:text-slate-300 group-hover:text-slate-800 dark:group-hover:text-slate-100 leading-relaxed line-clamp-3 transition-colors">
              {nodeData.question || nodeData.title}
            </p>
          </div>

          <button
            onClick={handleActivateSuggestion}
            className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-xl bg-indigo-50/80 dark:bg-indigo-950/60 group-hover:bg-gradient-to-r group-hover:from-indigo-600 group-hover:to-blue-600 text-indigo-600 dark:text-indigo-300 group-hover:text-white border border-dashed border-indigo-200 dark:border-indigo-800/60 group-hover:border-transparent text-xs font-medium shadow-xs group-hover:shadow-md transition-all active:scale-[0.99]"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>展开深度探讨</span>
            <ArrowRight className="w-3.5 h-3.5 ml-0.5" />
          </button>
        </div>

        {/* Outgoing Handle */}
        <Handle
          type="source"
          position={Position.Right}
          id="out"
          className="!w-3 !h-3 !bg-indigo-400 !border-2 !border-white dark:!border-slate-900 !-right-[6px] transition-transform hover:!scale-125"
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
      className={`relative w-[450px] rounded-2xl border bg-white dark:bg-[#0f172a]/95 shadow-xl transition-all duration-200 ${
        selected
          ? 'border-blue-500 ring-4 ring-blue-500/10 dark:ring-blue-500/30 shadow-blue-500/10'
          : 'border-slate-200/80 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 shadow-slate-200/60 dark:shadow-black/50'
      }`}
    >
      {/* Input / Incoming Handle (Left) */}
      <Handle
        type="target"
        position={Position.Left}
        id="in"
        className="!w-3.5 !h-3.5 !bg-blue-500 !border-2 !border-white dark:!border-slate-900 !-left-[7px] transition-transform hover:!scale-125"
      />

      {/* Node Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 dark:border-slate-800/80 bg-slate-50/70 dark:bg-slate-800/60 rounded-t-2xl">
        <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
          <span className="flex items-center justify-center w-6 h-6 rounded-lg bg-blue-50 dark:bg-blue-950/80 text-blue-600 dark:text-blue-400 shrink-0">
            <Sparkles className="w-3.5 h-3.5" />
          </span>

          {editingTitle ? (
            <input
              type="text"
              value={titleValue}
              onChange={(e) => setTitleValue(e.target.value)}
              onBlur={handleTitleSubmit}
              onKeyDown={(e) => e.key === 'Enter' && handleTitleSubmit()}
              autoFocus
              className="px-1.5 py-0.5 text-xs font-semibold text-slate-800 dark:text-slate-100 bg-white dark:bg-slate-800 border border-blue-400 dark:border-blue-500 rounded outline-none w-full"
            />
          ) : (
            <span
              onDoubleClick={() => setEditingTitle(true)}
              className="text-xs font-semibold text-slate-800 dark:text-slate-100 truncate cursor-pointer hover:text-blue-600 dark:hover:text-blue-400"
              title="双击重命名标题"
            >
              {nodeData.title}
            </span>
          )}

          {nodeData.status === 'generating' && (
            <span className="shrink-0 flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded-full bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800/60 animate-pulse">
              <Loader2 className="w-2.5 h-2.5 animate-spin" />
              <span>推演中</span>
            </span>
          )}

          {nodeData.status === 'idle' && currentAnswerText && (
            <span className="shrink-0 flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded-full bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200/60 dark:border-emerald-800/60">
              <Check className="w-2.5 h-2.5 text-emerald-600 dark:text-emerald-400" />
              <span>推演就绪</span>
            </span>
          )}

          {/* Model badge */}
          {nodeData.model && (
            <span
              className="shrink-0 hidden sm:flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-mono font-medium rounded-md bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200/80 dark:border-slate-700/80"
              title={`执行模型: ${nodeData.model}`}
            >
              <Cpu className="w-2.5 h-2.5 text-blue-500" />
              <span className="truncate max-w-[85px]">{nodeData.model.replace('gemini-', '')}</span>
            </span>
          )}

          {/* Web Search badge */}
          {nodeData.enableWebSearch && (
            <span
              className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-medium rounded-md bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-300 border border-blue-200/70 dark:border-blue-800/70"
              title={
                nodeData.grounding?.sources?.length
                  ? `实时联网检索完成，已索引 ${nodeData.grounding.sources.length} 篇参考来源`
                  : '已启用实时联网检索'
              }
            >
              <Globe className="w-2.5 h-2.5 text-blue-500" />
              <span>联网{nodeData.grounding?.sources?.length ? `(${nodeData.grounding.sources.length})` : ''}</span>
            </span>
          )}

          <span className="shrink-0 px-2 py-0.5 text-[10px] font-medium tracking-wide rounded-full bg-slate-200/70 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
            {nodeData.depth === 0 ? '主线' : `深度 #${nodeData.depth}`}
          </span>
        </div>

        {/* Header Action Buttons */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={handleCopy}
            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-800/60 rounded transition-colors"
            title="复制节点问答内容"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>

          <button
            onClick={handleToggleCollapse}
            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-800/60 rounded transition-colors"
            title={nodeData.isCollapsed ? '展开节点' : '折叠节点'}
          >
            {nodeData.isCollapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
          </button>

          <button
            onClick={handleDelete}
            className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/50 rounded transition-colors"
            title="删除此节点"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Sub-branch trigger pill if applicable */}
      {nodeData.branchTriggerPhrase && (
        <div className="px-4 py-1.5 bg-blue-50/60 dark:bg-blue-950/40 border-b border-blue-100 dark:border-blue-900/50 text-[11px] text-blue-700 dark:text-blue-300 flex items-center gap-1.5 font-medium">
          <span className="shrink-0">🐰 聚焦议题:</span>
          <span className="truncate italic">"{nodeData.branchTriggerPhrase}"</span>
        </div>
      )}

      {/* Question Header (Single Q&A format) */}
      {hasQuestion && !nodeData.isCollapsed && (
        <div className="px-4 py-2.5 bg-slate-50/80 dark:bg-slate-800/40 border-b border-slate-100 dark:border-slate-800 flex items-start gap-2.5">
          <span className="shrink-0 w-5 h-5 rounded-md bg-blue-600 text-white flex items-center justify-center text-[10px] font-bold mt-0.5 shadow-xs">
            问
          </span>
          <p className="text-xs font-semibold text-slate-800 dark:text-slate-100 leading-relaxed select-text break-words">
            {currentQuestionText}
          </p>
        </div>
      )}

      {/* Node Body (Collapsible, with isolated scrollable container) */}
      {!nodeData.isCollapsed && (
        <div className="flex flex-col">
          {/* Scrollable Content Container with nowheel/nopan to prevent ReactFlow zoom */}
          <div
            ref={contentRef}
            onWheel={(e) => e.stopPropagation()}
            className="nowheel nopan p-4 max-h-[380px] overflow-y-auto overscroll-contain flex flex-col gap-3 text-sm text-slate-700 dark:text-slate-200 select-text"
          >
            {/* If node is an empty root node without a question yet */}
            {!hasQuestion && (
              <div className="py-2">
                <p className="text-xs text-slate-600 dark:text-slate-400 font-medium mb-2.5">
                  输入你想探索的科学、哲学或工程议题：
                </p>
                <form onSubmit={handleInitialSubmit} className="flex gap-2 mb-3">
                  <input
                    type="text"
                    value={initialInput}
                    onChange={(e) => setInitialInput(e.target.value)}
                    placeholder="例如：量子纠错码（Surface Code）核心架构是什么？"
                    className="nodrag flex-1 px-3 py-2 text-xs border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/10 text-slate-800 dark:text-slate-100 bg-white dark:bg-slate-800/80 placeholder:text-slate-400 dark:placeholder:text-slate-500"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => setNodeWebSearch(!nodeWebSearch)}
                    title={nodeWebSearch ? '已启用实时联网搜索（点击关闭）' : '已关闭联网搜索（点击开启）'}
                    className={`nodrag px-2.5 py-2 text-xs font-medium rounded-xl border flex items-center gap-1.5 transition-colors shrink-0 ${
                      nodeWebSearch
                        ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/70 border-blue-200 dark:border-blue-800'
                        : 'text-slate-400 bg-slate-50 dark:bg-slate-800/80 border-slate-200 dark:border-slate-700 hover:text-slate-600 dark:hover:text-slate-300'
                    }`}
                  >
                    <Globe className="w-3.5 h-3.5" />
                    <span className="text-[11px] hidden sm:inline">{nodeWebSearch ? '联网检索' : '离线推理'}</span>
                  </button>
                  <button
                    type="submit"
                    disabled={!initialInput.trim() || nodeData.status === 'generating'}
                    className="nodrag px-3.5 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-xl disabled:bg-slate-300 dark:disabled:bg-slate-800 disabled:cursor-not-allowed transition-all shadow-xs flex items-center gap-1 shrink-0"
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
                      '超导量子比特与退相干机制',
                      '量子纠错码 Surface Code 原理',
                      'Shor 算法破解 RSA 的数论本质',
                    ].map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => {
                          setInitialInput(preset);
                          if (nodeActions?.sendMessage) {
                            nodeActions.sendMessage(id, preset);
                          } else {
                            nodeData.onSendMessage?.(id, preset);
                          }
                        }}
                        className="nodrag text-[11px] px-2.5 py-1 rounded-lg bg-blue-50 dark:bg-blue-950/40 hover:bg-blue-100 dark:hover:bg-blue-900/50 text-blue-700 dark:text-blue-300 font-normal transition-colors text-left border border-blue-100 dark:border-blue-900/50"
                      >
                        {preset}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Answer Content with Full Markdown and LaTeX Math Support */}
            {currentAnswerText ? (
              <div className="text-[13px] leading-relaxed text-slate-800 dark:text-slate-200 select-text">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkMath]}
                  rehypePlugins={[rehypeKatex]}
                  components={{
                    p: ({ children }) => (
                      <p className="mb-2.5 last:mb-0 leading-relaxed text-slate-700 dark:text-slate-300 break-words">{children}</p>
                    ),
                    h1: ({ children }) => (
                      <h1 className="text-base font-bold text-slate-900 dark:text-slate-100 mt-3 mb-2">{children}</h1>
                    ),
                    h2: ({ children }) => (
                      <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100 mt-2.5 mb-1.5">{children}</h2>
                    ),
                    h3: ({ children }) => (
                      <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 mt-2 mb-1">{children}</h3>
                    ),
                    ul: ({ children }) => (
                      <ul className="list-disc pl-4 mb-2.5 space-y-1 text-slate-700 dark:text-slate-300">{children}</ul>
                    ),
                    ol: ({ children }) => (
                      <ol className="list-decimal pl-4 mb-2.5 space-y-1 text-slate-700 dark:text-slate-300">{children}</ol>
                    ),
                    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                    blockquote: ({ children }) => (
                      <blockquote className="border-l-3 border-blue-400 dark:border-blue-500 pl-3 py-1 my-2 bg-blue-50/50 dark:bg-blue-950/30 rounded-r-lg text-slate-600 dark:text-slate-300 text-xs italic">
                        {children}
                      </blockquote>
                    ),
                    code: ({ node, className, children, ...props }) => {
                      const isInline = !className && typeof children === 'string' && !children.includes('\n');
                      if (isInline) {
                        return (
                          <code
                            className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-blue-700 dark:text-blue-300 font-mono text-[11px] font-medium border border-slate-200/60 dark:border-slate-700"
                            {...props}
                          >
                            {children}
                          </code>
                        );
                      }
                      return (
                        <div className="my-2.5 rounded-xl bg-slate-900 dark:bg-black/90 p-3 text-slate-100 font-mono text-xs overflow-x-auto shadow-xs border border-transparent dark:border-slate-800">
                          <code {...props}>{children}</code>
                        </div>
                      );
                    },
                    table: ({ children }) => (
                      <div className="overflow-x-auto my-2.5 border border-slate-200 dark:border-slate-700 rounded-lg">
                        <table className="min-w-full text-xs text-left border-collapse">{children}</table>
                      </div>
                    ),
                    th: ({ children }) => (
                      <th className="px-3 py-2 bg-slate-100 dark:bg-slate-800 font-semibold text-slate-800 dark:text-slate-200 border-b border-slate-200 dark:border-slate-700">
                        {children}
                      </th>
                    ),
                    td: ({ children }) => (
                      <td className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 text-slate-700 dark:text-slate-300">{children}</td>
                    ),
                    strong: ({ children }) => <strong className="font-semibold text-slate-900 dark:text-white">{children}</strong>,
                    a: ({ href, children }) => (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 dark:text-blue-400 underline hover:text-blue-800 dark:hover:text-blue-300"
                      >
                        {children}
                      </a>
                    ),
                    hr: () => <hr className="my-3 border-slate-200 dark:border-slate-800" />,
                  }}
                >
                  {processedAnswer}
                </ReactMarkdown>

                {/* Grounding Sources / Reference Citations Section */}
                {nodeData.grounding?.sources && nodeData.grounding.sources.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-slate-200/80 dark:border-slate-800">
                    <div className="border border-blue-100 dark:border-blue-900/50 bg-blue-50/30 dark:bg-slate-800/60 rounded-xl overflow-hidden shadow-xs">
                      {/* Source Accordion Header */}
                      <button
                        type="button"
                        onClick={() => setShowSources(!showSources)}
                        className="nodrag w-full px-3 py-2 flex items-center justify-between text-xs font-semibold text-blue-900 dark:text-blue-300 hover:bg-blue-100/40 dark:hover:bg-slate-800/90 transition-colors"
                      >
                        <div className="flex items-center gap-1.5 truncate mr-2">
                          <Globe className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
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
                        <div className="nodrag p-2.5 pt-1 grid grid-cols-1 gap-1.5 border-t border-blue-100/80 dark:border-slate-700/60 max-h-56 overflow-y-auto overscroll-contain">
                          {nodeData.grounding.sources.map((src) => (
                            <a
                              key={`${src.uri}-${src.index}`}
                              href={src.uri}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-start gap-2 p-2 rounded-lg bg-white dark:bg-slate-900/90 border border-slate-200/70 dark:border-slate-700/70 hover:border-blue-400 dark:hover:border-blue-500 hover:shadow-xs transition-all group"
                              title={`点击直达来源网页: ${src.uri}`}
                            >
                              <span className="shrink-0 w-4 h-4 rounded-md bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300 font-mono text-[10px] font-bold flex items-center justify-center mt-0.5 group-hover:bg-blue-600 group-hover:text-white transition-colors">
                                {src.index}
                              </span>
                              <div className="flex-1 min-w-0">
                                <p className="text-[11px] font-medium text-slate-800 dark:text-slate-200 group-hover:text-blue-600 dark:group-hover:text-blue-400 truncate leading-snug">
                                  {src.title}
                                </p>
                                <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">
                                  <span className="truncate">{src.domain}</span>
                                  <span>•</span>
                                  <span className="inline-flex items-center gap-0.5 text-blue-500 dark:text-blue-400 group-hover:underline">
                                    直达出处 <ExternalLink className="w-2.5 h-2.5" />
                                  </span>
                                </div>
                              </div>
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : null}

            {/* Generating indicator */}
            {nodeData.status === 'generating' && (
              <div className="flex flex-col gap-1.5 py-1.5 px-2.5 bg-blue-50/70 dark:bg-blue-950/50 rounded-lg w-fit border border-transparent dark:border-blue-900/40">
                <div className="flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400 font-medium">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>深度思考与推演中...</span>
                </div>
                {nodeData.enableWebSearch && (
                  <div className="flex items-center gap-1 text-[10px] text-blue-500/90 dark:text-blue-400/90">
                    <Globe className="w-3 h-3" />
                    <span>Google 实时联网搜索中，正在索引权威知识源...</span>
                  </div>
                )}
              </div>
            )}

            {/* Error display with retry */}
            {nodeData.status === 'error' && (
              <div className="flex items-center justify-between p-2.5 bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-900/60 rounded-xl text-xs text-rose-700 dark:text-rose-300">
                <div className="flex items-center gap-1.5 flex-1 mr-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span className="leading-snug">{nodeData.errorMessage || '生成失败，请重试'}</span>
                </div>
                <button
                  onClick={handleRetry}
                  className="nodrag flex items-center gap-1 px-2 py-1 bg-rose-600 text-white rounded font-medium hover:bg-rose-700 transition-colors shrink-0"
                >
                  <RotateCw className="w-3 h-3" />
                  重试
                </button>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Node Footer / Follow-up Input: Always spawns a NEW child node */}
          {hasQuestion && (
            <div className="p-3 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 rounded-b-2xl">
              <form onSubmit={handleFollowUpSubmit} className="relative flex items-center">
                <input
                  type="text"
                  value={followUpInput}
                  onChange={(e) => setFollowUpInput(e.target.value)}
                  placeholder={
                    nodeData.status === 'generating'
                      ? 'AI 正在深度思考与推演中，请稍候...'
                      : '针对此解答继续追问（回车将衍生新分支节点）...'
                  }
                  disabled={nodeData.status === 'generating'}
                  className="nodrag w-full pl-3 pr-32 py-2 text-xs bg-white dark:bg-slate-800/90 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/10 placeholder:text-slate-400 dark:placeholder:text-slate-500 text-slate-800 dark:text-slate-100 disabled:bg-slate-100 dark:disabled:bg-slate-900"
                />

                {/* Quick Web Search Toggle for this Follow-up */}
                <button
                  type="button"
                  onClick={() => setNodeWebSearch(!nodeWebSearch)}
                  title={
                    nodeWebSearch
                      ? '本追问已启用联网检索（点击关闭）'
                      : '本追问已关闭联网检索（点击开启）'
                  }
                  className={`nodrag absolute right-24 p-1.5 rounded-lg text-xs flex items-center justify-center transition-colors ${
                    nodeWebSearch
                      ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/80 border border-blue-200 dark:border-blue-800/80'
                      : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  <Globe className="w-3.5 h-3.5" />
                </button>

                <button
                  type="submit"
                  disabled={!followUpInput.trim() || nodeData.status === 'generating'}
                  className="nodrag absolute right-1.5 flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:bg-slate-300 dark:disabled:bg-slate-700 disabled:cursor-not-allowed transition-colors shadow-xs"
                  title="以此问题创建新的思维分支节点"
                >
                  <GitFork className="w-3 h-3" />
                  <span>衍生追问</span>
                </button>
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
        className="!w-3.5 !h-3.5 !bg-blue-500 !border-2 !border-white dark:!border-slate-900 !-right-[7px] transition-transform hover:!scale-125"
      />
    </div>
  );
};
