/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  X,
  Cpu,
  Globe,
  Sparkles,
  Check,
  Search,
  ExternalLink,
  ShieldCheck,
  Zap,
  HelpCircle,
} from 'lucide-react';

export interface ModelOption {
  id: string;
  name: string;
  tag: string;
  tagColor: string;
  description: string;
  isPro?: boolean;
}

export const PRESET_MODELS: ModelOption[] = [
  {
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    tag: '推荐',
    tagColor: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300 border-blue-200 dark:border-blue-800',
    description: '平衡推理深度与流式响应速度，全面支持联网搜索与代码推演。',
  },
  {
    id: 'gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro Preview',
    tag: '高智能',
    tagColor: 'bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300 border-purple-200 dark:border-purple-800',
    description: '前沿复杂推演架构，适合高阶数学、数论、前沿科学难题推演。',
    isPro: true,
  },
  {
    id: 'gemini-3.1-flash-lite',
    name: 'Gemini 3.1 Flash Lite',
    tag: '极速',
    tagColor: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
    description: '极致轻量，极低延迟，适合高频快速发散与概念探索。',
  },
  {
    id: 'gemini-flash-latest',
    name: 'Gemini Flash Latest',
    tag: '最新',
    tagColor: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300 border-amber-200 dark:border-amber-800',
    description: 'Google 最新稳定 Flash 通用多模态模型版本。',
  },
];

interface ModelSearchSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentModel: string;
  onSelectModel: (modelId: string) => void;
  enableWebSearch: boolean;
  onToggleWebSearch: (enabled: boolean) => void;
}

export const ModelSearchSettingsModal: React.FC<ModelSearchSettingsModalProps> = ({
  isOpen,
  onClose,
  currentModel,
  onSelectModel,
  enableWebSearch,
  onToggleWebSearch,
}) => {
  const [customModelInput, setCustomModelInput] = useState('');
  const [activeTab, setActiveTab] = useState<'model' | 'search'>('model');

  if (!isOpen) return null;

  const isCustom = !PRESET_MODELS.some((m) => m.id === currentModel);

  const handleApplyCustomModel = (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = customModelInput.trim();
    if (!trimmed) return;
    onSelectModel(trimmed);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-blue-600/10 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 flex items-center justify-center">
              <Cpu className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">
                AI 模型与联网搜索配置
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                自定义推理模型引擎与实时联网知识库索引
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab navigation */}
        <div className="flex px-6 pt-3 border-b border-slate-100 dark:border-slate-800 gap-4 text-xs font-semibold">
          <button
            onClick={() => setActiveTab('model')}
            className={`pb-2.5 flex items-center gap-1.5 border-b-2 transition-colors ${
              activeTab === 'model'
                ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            <Cpu className="w-3.5 h-3.5" />
            <span>AI 推理模型 ({isCustom ? '自定义' : currentModel})</span>
          </button>
          <button
            onClick={() => setActiveTab('search')}
            className={`pb-2.5 flex items-center gap-1.5 border-b-2 transition-colors ${
              activeTab === 'search'
                ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            <Globe className="w-3.5 h-3.5" />
            <span>联网搜索与来源索引 ({enableWebSearch ? '已开启' : '已关闭'})</span>
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-6">
          {activeTab === 'model' && (
            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between mb-2.5">
                  <label className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-blue-500" />
                    <span>预设官方主流模型</span>
                  </label>
                  <span className="text-[11px] text-slate-400 dark:text-slate-500">
                    当前选用: <strong className="text-blue-600 dark:text-blue-400 font-mono">{currentModel}</strong>
                  </span>
                </div>

                {/* Model Cards */}
                <div className="grid grid-cols-1 gap-2.5">
                  {PRESET_MODELS.map((m) => {
                    const isSelected = currentModel === m.id;
                    return (
                      <div
                        key={m.id}
                        onClick={() => onSelectModel(m.id)}
                        className={`p-3.5 rounded-xl border transition-all cursor-pointer flex items-start justify-between gap-3 ${
                          isSelected
                            ? 'border-blue-600 dark:border-blue-500 bg-blue-50/50 dark:bg-blue-950/40 ring-2 ring-blue-500/20 shadow-sm'
                            : 'border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-800/50 hover:bg-slate-50 dark:hover:bg-slate-800'
                        }`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-semibold text-xs text-slate-900 dark:text-slate-100 font-mono">
                              {m.name}
                            </span>
                            <span
                              className={`px-2 py-0.5 text-[10px] font-semibold rounded-full border ${m.tagColor}`}
                            >
                              {m.tag}
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                            {m.description}
                          </p>
                        </div>
                        <div className="shrink-0 mt-0.5">
                          <div
                            className={`w-4 h-4 rounded-full border flex items-center justify-center transition-colors ${
                              isSelected
                                ? 'bg-blue-600 border-blue-600 text-white'
                                : 'border-slate-300 dark:border-slate-600'
                            }`}
                          >
                            {isSelected && <Check className="w-2.5 h-2.5 stroke-[3]" />}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Custom Model Input */}
              <div className="pt-3 border-t border-slate-100 dark:border-slate-800">
                <label className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5 mb-2">
                  <Cpu className="w-3.5 h-3.5 text-indigo-500" />
                  <span>自定义模型名称 (Custom Model ID)</span>
                </label>
                <form onSubmit={handleApplyCustomModel} className="flex gap-2">
                  <input
                    type="text"
                    value={customModelInput}
                    onChange={(e) => setCustomModelInput(e.target.value)}
                    placeholder={
                      isCustom
                        ? `当前自定义: ${currentModel}`
                        : '例如：gemini-2.5-flash, gemini-2.5-pro...'
                    }
                    className="flex-1 px-3 py-2 text-xs font-mono bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/10 text-slate-800 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500"
                  />
                  <button
                    type="submit"
                    disabled={!customModelInput.trim()}
                    className="px-3.5 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 dark:disabled:bg-slate-800 disabled:text-slate-400 text-white rounded-xl text-xs font-medium transition-colors shrink-0 shadow-xs"
                  >
                    应用模型
                  </button>
                </form>
                {isCustom && (
                  <div className="mt-2 text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                    <Zap className="w-3 h-3 shrink-0" />
                    <span>
                      当前正使用自定义模型：<strong>{currentModel}</strong>
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'search' && (
            <div className="space-y-4">
              {/* Web Search Grounding Master Toggle */}
              <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <Globe className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100">
                      Google 实时联网搜索 (Search Grounding)
                    </h3>
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                    在 AI 推演回答时接入实时 Google 搜索，获取最新的学术文献、技术文档与客观知识，避免知识时效性滞后。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onToggleWebSearch(!enableWebSearch)}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-offset-2 ${
                    enableWebSearch ? 'bg-blue-600' : 'bg-slate-300 dark:bg-slate-700'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      enableWebSearch ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* Source indexing explanation */}
              <div className="p-4 rounded-xl border border-blue-100 dark:border-blue-900/40 bg-blue-50/40 dark:bg-blue-950/20 space-y-2.5">
                <h4 className="text-xs font-bold text-blue-900 dark:text-blue-300 flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                  <span>智能来源索引机制 (Source Indexing)</span>
                </h4>
                <ul className="text-xs text-blue-800/80 dark:text-blue-300/80 space-y-1.5 leading-relaxed list-disc pl-4">
                  <li>
                    <strong>数字角标对齐</strong>：正文中凡涉及外部检索论据，自动以 <code className="px-1 py-0.5 rounded bg-blue-100 dark:bg-blue-900/60 font-mono">[1]</code>、<code className="px-1 py-0.5 rounded bg-blue-100 dark:bg-blue-900/60 font-mono">[2]</code> 连续方括号角标标注。
                  </li>
                  <li>
                    <strong>结构化卡片索引</strong>：推演卡片内置「📚 引用来源索引」面板，展示网页标题、原始域名、网页直达链接及真实检索关键词。
                  </li>
                  <li>
                    <strong>随卡片沉淀</strong>：导出的 Markdown / JSON 将完整保留来源 URL 和索引列表，方便学术与研究追溯。
                  </li>
                </ul>
              </div>

              <div className="flex items-center gap-2 p-3 bg-slate-100 dark:bg-slate-800/60 rounded-xl text-xs text-slate-500 dark:text-slate-400">
                <HelpCircle className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                <span>
                  提示：追问时在卡片底部的追问栏中也可随时单独点击 🌐 图标开启或关闭当前分支的搜索。
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3.5 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40">
          <span className="text-[11px] text-slate-400 dark:text-slate-500">
            设置将自动持久化至本地存储
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-medium transition-colors shadow-xs"
          >
            完成配置
          </button>
        </div>
      </div>
    </div>
  );
};
