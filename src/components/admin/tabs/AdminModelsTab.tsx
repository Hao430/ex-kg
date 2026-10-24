/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Cpu,
  Check,
  CheckCircle2,
  XCircle,
  Eye,
  EyeOff,
  Zap,
  Activity,
  RefreshCw,
} from 'lucide-react';
import { AiModelConfig } from '../../../types';
import { ModelTestResult, ModelPreset } from '../types';
import { ModelWarningBanner } from '../shared/ModelWarningBanner';

export interface AdminModelsTabProps {
  modelConfigured: boolean | null;
  onModelConfiguredChange: (configured: boolean) => void;
  onProviderChange?: (provider: 'gemini' | 'openai') => void;
  onFeedback: (message: string) => void;
}

const PRESETS: ModelPreset[] = [
  { name: 'DeepSeek 官方 (deepseek-chat)', provider: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { name: 'SiliconFlow 硅基流动', provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  { name: 'OpenAI 官方 (gpt-4o)', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { name: 'Moonshot Kimi', provider: 'openai', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { name: '阿里通义千问 (Qwen-Plus)', provider: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: '本地 Ollama (DeepSeek-R1)', provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'deepseek-r1' },
];

export const AdminModelsTab: React.FC<AdminModelsTabProps> = ({
  modelConfigured,
  onModelConfiguredChange,
  onProviderChange,
  onFeedback,
}) => {
  const [modelConfig, setModelConfig] = useState<AiModelConfig>({
    provider: 'gemini',
    openai_base_url: 'https://api.openai.com/v1',
    openai_api_key: '',
    openai_model: 'deepseek-chat',
    gemini_model: '',
    temperature: 0.7,
    max_tokens: 4096,
    custom_system_prompt: '',
    force_web_search: true,
  });
  const [rawApiKeyInput, setRawApiKeyInput] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [savingModelConfig, setSavingModelConfig] = useState(false);
  const [testingModelConnection, setTestingModelConnection] = useState(false);
  const [testResult, setTestResult] = useState<ModelTestResult | null>(null);

  const fetchModelConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/model-config', { credentials: 'include' });
      if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
        const data = await res.json();
        if (data.config) {
          setModelConfig(data.config);
          setRawApiKeyInput(data.config.openai_api_key || '');
          onProviderChange?.(data.config.provider);
        }
      }
    } catch (e) {
      console.error('Fetch model-config error:', e);
    }
  }, [onProviderChange]);

  useEffect(() => {
    fetchModelConfig();
  }, [fetchModelConfig]);

  const applyPreset = (preset: ModelPreset) => {
    setModelConfig((prev) => ({
      ...prev,
      provider: preset.provider,
      openai_base_url: preset.baseUrl,
      openai_model: preset.model,
    }));
    onProviderChange?.(preset.provider);
    onFeedback(`已载入预设: ${preset.name}（请填入对应的 API Key）`);
  };

  const handleSaveModelConfig = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setSavingModelConfig(true);
    try {
      const res = await fetch('/api/admin/model-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          provider: modelConfig.provider,
          openai_base_url: modelConfig.openai_base_url,
          openai_api_key: rawApiKeyInput,
          openai_model: modelConfig.openai_model,
          gemini_model: modelConfig.gemini_model,
          temperature: modelConfig.temperature,
          max_tokens: modelConfig.max_tokens,
          custom_system_prompt: modelConfig.custom_system_prompt,
          force_web_search: modelConfig.force_web_search !== false,
        }),
      });
      const d = await res.json();
      if (res.ok && d.success) {
        onFeedback('AI 模型与接口配置已成功保存并立即生效！');
        onModelConfiguredChange(true);
        if (d.config) {
          setModelConfig(d.config);
          setRawApiKeyInput(d.config.openai_api_key || '');
          onProviderChange?.(d.config.provider);
        }
      } else {
        onFeedback(d.error || '保存失败');
      }
    } catch (e: any) {
      onFeedback(e?.message || '网络异常，保存失败');
    } finally {
      setSavingModelConfig(false);
    }
  };

  const handleTestModelConnection = async () => {
    setTestingModelConnection(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/admin/model-config/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          provider: modelConfig.provider,
          openai_base_url: modelConfig.openai_base_url,
          openai_api_key: rawApiKeyInput,
          openai_model: modelConfig.openai_model,
          gemini_model: modelConfig.gemini_model,
        }),
      });
      const d = await res.json();
      if (res.ok && d.success) {
        setTestResult({
          success: true,
          message: d.message || '连接测试成功',
          reply: d.reply,
          latencyMs: d.latencyMs,
          modelUsed: d.modelUsed,
          endpoint: d.endpoint,
        });
      } else {
        setTestResult({
          success: false,
          message: '接口连接失败',
          error: d.error || '未知错误',
          latencyMs: d.latencyMs,
          endpoint: d.endpoint,
        });
      }
    } catch (e: any) {
      setTestResult({
        success: false,
        message: '网络异常，无法连接接口',
        error: e?.message || '连接超时',
      });
    } finally {
      setTestingModelConnection(false);
    }
  };

  return (
    <div className="space-y-6">
      <ModelWarningBanner modelConfigured={modelConfigured} />

      <form onSubmit={handleSaveModelConfig} className="space-y-6">
        {/* Provider Selector */}
        <div className="p-5 rounded-2xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200/80 dark:border-slate-700/80">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                <Cpu className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                AI 核心调用引擎与接口协议
              </h4>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                自由切换原生 Google Gemini 或通用 OpenAI 兼容格式接口（如 DeepSeek、SiliconFlow、Moonshot、Qwen 等）
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div
              onClick={() => {
                setModelConfig((prev) => ({ ...prev, provider: 'gemini' }));
                onProviderChange?.('gemini');
              }}
              className={`cursor-pointer p-4 rounded-xl border-2 transition-all flex items-start gap-3.5 ${
                modelConfig.provider === 'gemini'
                  ? 'border-indigo-600 dark:border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/40 shadow-xs'
                  : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/80 hover:border-slate-300 dark:hover:border-slate-600'
              }`}
            >
              <div
                className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5 ${
                  modelConfig.provider === 'gemini'
                    ? 'border-indigo-600 dark:border-indigo-500 bg-indigo-600 dark:bg-indigo-500 text-white'
                    : 'border-slate-300 dark:border-slate-600'
                }`}
              >
                {modelConfig.provider === 'gemini' && <Check className="w-3 h-3 stroke-[3]" />}
              </div>
              <div>
                <div className="text-xs font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                  Google Gemini 原生引擎
                  <span className="px-1.5 py-0.2 rounded text-xxs bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                    内嵌 Google 搜索
                  </span>
                </div>
                <p className="text-xxs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                  采用官方 GoogleGenAI SDK，深度支持多模态及原生 Google Search Grounding 实时检索。
                </p>
              </div>
            </div>

            <div
              onClick={() => {
                setModelConfig((prev) => ({ ...prev, provider: 'openai' }));
                onProviderChange?.('openai');
              }}
              className={`cursor-pointer p-4 rounded-xl border-2 transition-all flex items-start gap-3.5 ${
                modelConfig.provider === 'openai'
                  ? 'border-indigo-600 dark:border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/40 shadow-xs'
                  : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/80 hover:border-slate-300 dark:hover:border-slate-600'
              }`}
            >
              <div
                className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5 ${
                  modelConfig.provider === 'openai'
                    ? 'border-indigo-600 dark:border-indigo-500 bg-indigo-600 dark:bg-indigo-500 text-white'
                    : 'border-slate-300 dark:border-slate-600'
                }`}
              >
                {modelConfig.provider === 'openai' && <Check className="w-3 h-3 stroke-[3]" />}
              </div>
              <div>
                <div className="text-xs font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                  OpenAI 格式兼容协议
                  <span className="px-1.5 py-0.2 rounded text-xxs bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                    DeepSeek / GPT-4o 等
                  </span>
                </div>
                <p className="text-xxs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                  兼容标准 <code className="font-mono text-indigo-600 dark:text-indigo-400">/v1/chat/completions</code> 流式协议，支持主流大模型提供商及私有化部署。
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Quick Presets */}
        {modelConfig.provider === 'openai' && (
          <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200/80 dark:border-slate-700/80">
            <div className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-2 flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-amber-500" />
              一键载入主流服务商预设:
            </div>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((preset) => (
                <button
                  key={preset.name}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  className="px-2.5 py-1 text-xs rounded-lg bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 transition-colors cursor-pointer"
                >
                  {preset.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Main Config Form */}
        <div className="p-5 rounded-2xl bg-white dark:bg-slate-800/80 border border-slate-200/80 dark:border-slate-700/80 space-y-4">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            接口连接与模型参数配置
          </h4>

          {modelConfig.provider === 'openai' ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  API 接口地址 (Base URL) <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={modelConfig.openai_base_url}
                  onChange={(e) =>
                    setModelConfig((prev) => ({ ...prev, openai_base_url: e.target.value }))
                  }
                  placeholder="例如: https://api.deepseek.com 或 https://api.openai.com/v1"
                  className="w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
                />
                <p className="text-xxs text-slate-400 dark:text-slate-500">无需手动拼接 /chat/completions，系统将自动路由</p>
              </div>

              <div className="space-y-1">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  调用模型名称 (Model ID) <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={modelConfig.openai_model}
                  onChange={(e) =>
                    setModelConfig((prev) => ({ ...prev, openai_model: e.target.value }))
                  }
                  placeholder="例如: deepseek-chat, gpt-4o, qwen-max"
                  className="w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
                />
              </div>

              <div className="space-y-1 md:col-span-2">
                <div className="flex items-center justify-between">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    API 密钥 (API Key / Token) <span className="text-rose-500">*</span>
                  </label>
                  {modelConfig.has_openai_key && (
                    <span className="text-xxs text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" /> 当前已配置密钥
                    </span>
                  )}
                </div>
                <div className="relative">
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    value={rawApiKeyInput}
                    onChange={(e) => setRawApiKeyInput(e.target.value)}
                    placeholder={modelConfig.has_openai_key ? '已配置 (留空或保持掩码表示不更改)' : 'sk-xxxxxxxx...'}
                    className="w-full px-3 py-2 pr-10 text-xs bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey(!showApiKey)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                  >
                    {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1 md:col-span-2">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Gemini 默认调用模型
                </label>
                <select
                  value={modelConfig.gemini_model || ''}
                  onChange={(e) =>
                    setModelConfig((prev) => ({ ...prev, gemini_model: e.target.value }))
                  }
                  className="w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="">请选择模型（必选，保存后生效）</option>
                  <option value="gemini-3.8-flash">gemini-3.8-flash (极速推理)</option>
                  <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite (轻量高并发)</option>
                  <option value="gemini-flash-latest">gemini-flash-latest (持续最新版本)</option>
                </select>
              </div>
            </div>
          )}

          {/* Hyperparameters */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-slate-100 dark:border-slate-800">
            <div className="space-y-1">
              <div className="flex justify-between text-xs font-medium text-slate-700 dark:text-slate-300">
                <span>生成发散度 (Temperature):</span>
                <span className="font-mono text-indigo-600 dark:text-indigo-400">{modelConfig.temperature}</span>
              </div>
              <input
                type="range"
                min="0"
                max="1.5"
                step="0.05"
                value={modelConfig.temperature}
                onChange={(e) =>
                  setModelConfig((prev) => ({ ...prev, temperature: parseFloat(e.target.value) }))
                }
                className="w-full accent-indigo-600 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg cursor-pointer"
              />
              <div className="flex justify-between text-xxs text-slate-400 dark:text-slate-500">
                <span>精确收敛 (0.0)</span>
                <span>标准平衡 (0.7)</span>
                <span>高度创意 (1.5)</span>
              </div>
            </div>

            <div className="space-y-1">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                单次生成最大 Token (Max Tokens)
              </label>
              <input
                type="number"
                min="512"
                max="32768"
                step="512"
                value={modelConfig.max_tokens}
                onChange={(e) =>
                  setModelConfig((prev) => ({ ...prev, max_tokens: parseInt(e.target.value, 10) || 4096 }))
                }
                className="w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
              />
            </div>
          </div>

          {/* Force Web Search switch */}
          <div className="flex items-center justify-between gap-4 pt-2 border-t border-slate-100 dark:border-slate-800">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                强制实时联网检索 (Force Web Search)
              </label>
              <p className="text-xxs text-slate-400 dark:text-slate-500 mt-0.5">
                开启后每次回答都会先联网检索并附来源索引（推荐，保障「溯源有据」）；关闭则由模型自主决定是否检索
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={modelConfig.force_web_search !== false}
              onClick={() =>
                setModelConfig((prev) => ({ ...prev, force_web_search: !(prev.force_web_search !== false) }))
              }
              className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors cursor-pointer ${
                modelConfig.force_web_search !== false ? 'bg-indigo-600' : 'bg-slate-300 dark:bg-slate-700'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                  modelConfig.force_web_search !== false ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* System Prompt */}
          <div className="space-y-1 pt-2 border-t border-slate-100 dark:border-slate-800">
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              全局导师角色系统提示词 (System Prompt 自定义覆盖)
            </label>
            <textarea
              rows={3}
              value={modelConfig.custom_system_prompt || ''}
              onChange={(e) =>
                setModelConfig((prev) => ({ ...prev, custom_system_prompt: e.target.value }))
              }
              placeholder="留空则使用内置苏格拉底式启发导师提示词…"
              className="w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 leading-relaxed"
            />
          </div>
        </div>

        {/* Test Result Preview */}
        {testResult && (
          <div
            className={`p-4 rounded-xl border text-xs animate-in fade-in ${
              testResult.success
                ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
                : 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-200'
            }`}
          >
            <div className="flex items-center justify-between font-semibold mb-1">
              <div className="flex items-center gap-2">
                {testResult.success ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <XCircle className="w-4 h-4 text-rose-600 dark:text-rose-400" />
                )}
                <span>{testResult.message}</span>
              </div>
              {testResult.latencyMs !== undefined && (
                <span className="font-mono text-xxs px-2 py-0.5 rounded bg-black/5 dark:bg-white/10">
                  耗时: {testResult.latencyMs}ms
                </span>
              )}
            </div>
            {testResult.reply && (
              <div className="mt-2 p-2.5 rounded-lg bg-white/80 dark:bg-slate-900/80 border border-emerald-200/60 dark:border-emerald-800/60 font-mono text-xxs text-slate-700 dark:text-slate-300">
                <strong>返回内容：</strong> {testResult.reply}
              </div>
            )}
            {testResult.error && (
              <div className="mt-2 p-2.5 rounded-lg bg-white/80 dark:bg-slate-900/80 border border-rose-200/60 dark:border-rose-800/60 font-mono text-xxs text-rose-600 dark:text-rose-400">
                <strong>错误详情：</strong> {testResult.error}
              </div>
            )}
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            onClick={handleTestModelConnection}
            disabled={testingModelConnection}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700/80 text-xs font-medium text-slate-700 dark:text-slate-200 transition-colors shadow-xs cursor-pointer disabled:opacity-50"
          >
            {testingModelConnection ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin text-indigo-600" />
                <span>正在进行接口联调测试…</span>
              </>
            ) : (
              <>
                <Activity className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                <span>测试接口连通性 (Ping)</span>
              </>
            )}
          </button>

          <button
            type="submit"
            disabled={savingModelConfig}
            className="flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-600 text-white text-xs font-semibold transition-colors shadow-sm cursor-pointer disabled:opacity-50"
          >
            {savingModelConfig ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>正在保存…</span>
              </>
            ) : (
              <>
                <Check className="w-3.5 h-3.5" />
                <span>保存并立即生效</span>
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
};
