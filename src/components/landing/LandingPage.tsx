/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  Compass,
  Sparkles,
  ArrowRight,
  GitBranch,
  MousePointerClick,
  Layers,
  FileText,
  ShieldCheck,
  Cpu,
  Workflow,
  Zap,
  CheckCircle2,
  XCircle,
  BookOpen,
  Code2,
  TrendingUp,
  Maximize2,
  RefreshCw,
  ExternalLink,
  ChevronRight,
  HelpCircle,
  Sun,
  Moon,
  Globe,
  Search,
  SlidersHorizontal,
  Coins,
  LogIn,
  User,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

interface LandingPageProps {
  onEnterCanvas: (presetTopic?: string) => void;
  theme?: 'light' | 'dark';
  onToggleTheme?: () => void;
}

export const LandingPage: React.FC<LandingPageProps> = ({
  onEnterCanvas,
  theme = 'light',
  onToggleTheme,
}) => {
  const { user, openAuthModal, openRechargeModal } = useAuth();
  const isDark = theme === 'dark';
  const [activeScenario, setActiveScenario] = useState<number>(0);
  const [demoExpanded, setDemoExpanded] = useState<boolean>(false);
  const [demoStep, setDemoStep] = useState<number>(1);
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  const scenarios = [
    {
      icon: BookOpen,
      title: '学术科研与深度理论推演',
      desc: '拆解复杂前沿论文，对抽象定理、数学公式逐步下钻，在同一张画布上构建完整知识体系。',
      tags: ['arXiv论文精读', 'KaTeX公式推导', '多理论交叉对比'],
      sampleTopic: '超导量子计算与表面码纠错拓扑',
    },
    {
      icon: Code2,
      title: '系统架构设计与技术权衡',
      desc: '推演微服务拆解、分布式事务一致性与高并发容灾方案，在不同分支上权衡架构优劣。',
      tags: ['分布式容灾', '高并发架构', '性能与一致性权衡'],
      sampleTopic: '分布式数据库 Raft 共识与多副本强一致性',
    },
    {
      icon: TrendingUp,
      title: '商业战略分析与投资尽调',
      desc: '围绕行业大盘、竞争壁垒、供应链与财务模型多线并发深挖，生成结构严密的尽调大纲。',
      tags: ['产业链拆解', '商业壁垒推演', '研报大纲导出'],
      sampleTopic: '具身智能商业化落地路径与算力瓶颈',
    },
    {
      icon: Workflow,
      title: '高阶复杂学习与心智模型',
      desc: '告别碎片化问答，通过“提问 - 批判 - 验证 - 衍生”的螺旋闭环，建立属于你的认知星图。',
      tags: ['心智模型', '非线性思维', '双轨便签记录'],
      sampleTopic: '大语言模型注意力机制与Transformer进化史',
    },
  ];

  const faqs = [
    {
      q: '为什么需要无限画布，而不是传统的单聊对话框？',
      a: '传统的聊天机器人采用垂直流式单窗口，当探讨进入第 5 轮提问时，早期的核心假设已被长文顶出屏幕，容易发生上下文漂移或遗忘。DeepDive 采用无限 2D 画布，每一个问题和解答都是可自由展开的思维节点。你可以同时探讨 5 个平行子分支，所有思考脉络一览无余。',
    },
    {
      q: '我的研究数据和画板内容安全吗？',
      a: '绝对安全。DeepDive 默认将所有画布、节点、连线与便签完整保存在您浏览器的本地存储（Local Storage）中，支持一键导出标准 JSON 备份或 Markdown 研报大纲，数据完全归您所有。',
    },
    {
      q: '“划词追问”功能是如何工作的？',
      a: '在阅读任何卡片的 AI 解答时，只需用鼠标划选感兴趣的一段文字、专有名词或公式，系统会自动浮出探索胶囊。点击即可自动继承当前卡片的上下文背景，在旁边衍生出一个专属的子议题卡片继续深挖。',
    },
    {
      q: '支持哪些数学公式与代码格式？',
      a: '内嵌 KaTeX 数学排版引擎，完美解析学术级 LaTeX 行内公式（$E=mc^2$）与独立块级矩阵积分公式（$$...$$），同时支持主流编程语言代码高亮与一键复制代码块。',
    },
  ];

  return (
    <div className="min-h-screen bg-[#070a13] text-slate-100 font-sans selection:bg-blue-500/30 selection:text-blue-200 overflow-x-hidden relative">
      {/* Background Ambience & Aurora Glows */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
        <div className="absolute top-[-10%] left-1/2 -translate-x-1/2 w-[1000px] h-[600px] bg-gradient-to-b from-blue-600/20 via-indigo-600/10 to-transparent blur-[140px] rounded-full" />
        <div className="absolute top-[30%] left-[-10%] w-[600px] h-[500px] bg-cyan-600/10 blur-[150px] rounded-full" />
        <div className="absolute top-[60%] right-[-10%] w-[700px] h-[600px] bg-purple-600/10 blur-[160px] rounded-full" />
        {/* Subtle grid pattern */}
        <div
          className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage: `radial-gradient(#94a3b8 1px, transparent 1px)`,
            backgroundSize: '32px 32px',
          }}
        />
      </div>

      {/* Modern High-End Top Navigation */}
      <header className="sticky top-0 z-50 backdrop-blur-xl bg-[#070a13]/80 border-b border-white/[0.08] transition-all">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          {/* Brand */}
          <div className="flex items-center gap-3 cursor-pointer" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-blue-600 via-indigo-500 to-cyan-400 flex items-center justify-center text-white shadow-lg shadow-blue-500/25 ring-1 ring-white/20">
              <Compass className="w-5 h-5 text-white" />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-base font-bold tracking-tight text-white">DeepDive</span>
              <span className="text-xs px-1.5 py-0.5 rounded-full bg-blue-500/20 text-blue-300 font-medium border border-blue-500/30">
                v2.0
              </span>
            </div>
          </div>

          {/* Links */}
          <nav className="hidden md:flex items-center gap-8 text-xs font-medium text-slate-300">
            <a href="#features" className="hover:text-white transition-colors">核心特性</a>
            <a href="#interactive-demo" className="hover:text-white transition-colors">交互式演示</a>
            <a href="#scenarios" className="hover:text-white transition-colors">探索场景</a>
            <a href="#comparison" className="hover:text-white transition-colors">思维范式对比</a>
            <a href="#faq" className="hover:text-white transition-colors">常见疑问</a>
          </nav>

          {/* CTA Buttons */}
          <div className="flex items-center gap-2.5 sm:gap-3">
            {onToggleTheme && (
              <button
                onClick={onToggleTheme}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-xs font-medium text-slate-200 transition-all cursor-pointer"
                title={isDark ? '当前为深色模式（点击切换浅色）' : '切换为深色模式'}
              >
                {isDark ? (
                  <>
                    <Moon className="w-3.5 h-3.5 text-amber-300 fill-amber-300/20" />
                    <span className="hidden sm:inline text-amber-200">深色</span>
                  </>
                ) : (
                  <>
                    <Sun className="w-3.5 h-3.5 text-amber-400" />
                    <span className="hidden sm:inline text-slate-300">浅色</span>
                  </>
                )}
              </button>
            )}

            {user ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={openRechargeModal}
                  className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-300 text-xs font-semibold transition-all cursor-pointer"
                  title="充值 AI 算力点数"
                >
                  <Coins className="w-3.5 h-3.5 text-amber-400" />
                  <span>{user.credits_balance.toLocaleString()} 点</span>
                </button>
                <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-white/5 border border-white/10 text-xs text-slate-300">
                  <div className="w-5 h-5 rounded-md bg-indigo-600 text-white flex items-center justify-center font-bold text-[10px]">
                    {user.name ? user.name[0].toUpperCase() : user.email[0].toUpperCase()}
                  </div>
                  <span className="hidden md:inline max-w-[100px] truncate">{user.name || user.email.split('@')[0]}</span>
                </div>
              </div>
            ) : (
              <button
                onClick={() => openAuthModal('signin')}
                className="flex items-center gap-1 px-3 py-1.5 rounded-xl border border-white/15 bg-white/10 hover:bg-white/15 text-white text-xs font-medium transition-all cursor-pointer"
              >
                <LogIn className="w-3.5 h-3.5 text-blue-400" />
                <span>登录 / 注册</span>
              </button>
            )}

            <button
              onClick={() => onEnterCanvas()}
              className="group relative inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold text-white bg-gradient-to-r from-blue-600 via-indigo-600 to-blue-500 hover:from-blue-500 hover:to-indigo-500 shadow-md shadow-blue-500/20 border border-blue-400/30 transition-all duration-200 hover:scale-[1.02] active:scale-[0.98]"
            >
              <span>进入思维画布</span>
              <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
            </button>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative z-10 pt-16 md:pt-24 pb-20 px-6 max-w-7xl mx-auto text-center">
        {/* Eyebrow Pill */}
        <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-white/[0.05] border border-white/[0.1] text-xs font-medium text-blue-300 backdrop-blur-md mb-8 hover:bg-white/[0.08] transition-colors">
          <Sparkles className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
          <span>非线性无限画布 · 递归推理与多分支认知平台</span>
          <ChevronRight className="w-3.5 h-3.5 text-slate-500" />
        </div>

        {/* Display Title */}
        <h1 className="text-4xl sm:text-6xl lg:text-7xl font-extrabold tracking-tight text-white leading-[1.12] max-w-5xl mx-auto">
          告别单线程对话的遗忘与局限
          <span className="block mt-2 bg-clip-text text-transparent bg-gradient-to-r from-blue-400 via-indigo-200 to-cyan-300">
            在无限画布中，推演你的思维宇宙
          </span>
        </h1>

        {/* Subtitle */}
        <p className="mt-6 text-base sm:text-lg text-slate-400 max-w-3xl mx-auto leading-relaxed font-normal">
          人类的深度思考从不是单行道的自言自语。DeepDive 将传统垂直滚动的聊天窗口解构为具备拓扑关联的认知星图。
          支持<b>划词深挖、递归分支推演、学术级 LaTeX 公式、便签双轨论证与全自动拓扑排版</b>。
        </p>

        {/* Action Buttons */}
        <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
          <button
            onClick={() => onEnterCanvas()}
            className="flex items-center gap-2.5 px-7 py-3.5 rounded-2xl text-sm font-semibold text-white bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 shadow-xl shadow-blue-600/30 border border-blue-400/40 hover:scale-[1.02] active:scale-[0.98] transition-all"
          >
            <Compass className="w-4 h-4 text-cyan-200" />
            <span>立即开启探索 (进入画板)</span>
            <ArrowRight className="w-4 h-4 text-blue-200 ml-1" />
          </button>

          <a
            href="#interactive-demo"
            className="flex items-center gap-2 px-6 py-3.5 rounded-2xl text-sm font-medium text-slate-300 bg-white/[0.05] hover:bg-white/[0.09] border border-white/[0.1] hover:text-white backdrop-blur-md transition-all"
          >
            <span>体验交互演练</span>
          </a>
        </div>

        {/* Quick Sample Triggers */}
        <div className="mt-8 flex flex-wrap items-center justify-center gap-2 text-xs text-slate-400">
          <span className="text-slate-500">预置探索课题:</span>
          {[
            '超导量子比特退相干机制',
            'Transformer 注意力机制与数学形式',
            '具身智能世界模型演进',
          ].map((topic) => (
            <button
              key={topic}
              onClick={() => onEnterCanvas(topic)}
              className="px-3 py-1 rounded-lg bg-white/[0.04] hover:bg-blue-500/10 hover:border-blue-500/30 border border-white/[0.06] text-slate-300 hover:text-blue-300 transition-all"
            >
              {topic} →
            </button>
          ))}
        </div>

        {/* Core Specs Bar */}
        <div className="mt-16 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 max-w-5xl mx-auto pt-8 border-t border-white/[0.07]">
          <div className="flex flex-col items-center">
            <span className="text-xl sm:text-2xl font-bold text-white tracking-tight">2D 无限画布</span>
            <span className="text-[11px] text-slate-400 mt-1">自由平移与空间记忆</span>
          </div>
          <div className="flex flex-col items-center">
            <span className="text-xl sm:text-2xl font-bold text-cyan-400 tracking-tight">KaTeX 原生</span>
            <span className="text-[11px] text-slate-400 mt-1">学术级 LaTeX 公式推导</span>
          </div>
          <div className="flex flex-col items-center">
            <span className="text-xl sm:text-2xl font-bold text-blue-400 tracking-tight">划词递归裂变</span>
            <span className="text-[11px] text-slate-400 mt-1">任意点无缝开启子议题</span>
          </div>
          <div className="flex flex-col items-center">
            <span className="text-xl sm:text-2xl font-bold text-indigo-400 tracking-tight">模型自由切换</span>
            <span className="text-[11px] text-slate-400 mt-1">Gemini 3.8 / 3.1 / 2.5</span>
          </div>
          <div className="flex flex-col items-center">
            <span className="text-xl sm:text-2xl font-bold text-emerald-400 tracking-tight">实时联网检索</span>
            <span className="text-[11px] text-slate-400 mt-1">Google Grounding 来源引证</span>
          </div>
          <div className="flex flex-col items-center">
            <span className="text-xl sm:text-2xl font-bold text-amber-400 tracking-tight">深夜护眼模式</span>
            <span className="text-[11px] text-slate-400 mt-1">全时段沉浸深度思考</span>
          </div>
        </div>
      </section>

      {/* Interactive Canvas Simulator / Showcase */}
      <section id="interactive-demo" className="relative z-10 py-16 px-6 max-w-7xl mx-auto">
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-500/10 text-blue-300 border border-blue-500/20 text-xs font-medium mb-3">
            <Zap className="w-3.5 h-3.5 text-blue-400" />
            <span>实时交互式演练演示</span>
          </div>
          <h2 className="text-3xl sm:text-4xl font-bold text-white tracking-tight">
            体验非线性思维树的生长过程
          </h2>
          <p className="mt-3 text-slate-400 text-sm max-w-2xl mx-auto">
            在下方沙盘中点击交互控制，直观感受“主线探索 → 联网引证 → 划词高亮 → 分支裂变 → 拓扑重排”的认知体验。
          </p>
        </div>

        {/* Mock Canvas Container */}
        <div className="relative rounded-3xl border border-white/[0.12] bg-[#0c1222]/90 backdrop-blur-2xl shadow-2xl overflow-hidden p-4 sm:p-6">
          {/* Simulator Header */}
          <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-white/[0.08]">
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-rose-500/80" />
              <span className="w-3 h-3 rounded-full bg-amber-500/80" />
              <span className="w-3 h-3 rounded-full bg-emerald-500/80" />
              <span className="ml-3 text-xs font-mono text-slate-400">
                演示画板: 量子计算机退相干与表面码纠错.deepdive
              </span>
            </div>

            {/* Interactive Step Buttons */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setDemoStep((prev) => (prev === 1 ? 2 : prev === 2 ? 3 : 1))}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-600/30 hover:bg-blue-600/50 border border-blue-400/30 text-blue-200 text-xs font-medium transition-all"
              >
                <RefreshCw className="w-3.5 h-3.5 text-blue-400 animate-spin" style={{ animationDuration: '6s' }} />
                <span>
                  {demoStep === 1
                    ? '① 划词选中文本并追问'
                    : demoStep === 2
                    ? '② 自动生长新子分支'
                    : '③ 恢复初始视图'}
                </span>
              </button>

              <button
                onClick={() => onEnterCanvas('超导量子计算与表面码纠错拓扑')}
                className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-white/[0.08] hover:bg-white/[0.15] text-white text-xs font-medium transition-all"
              >
                <span>在完整画布中打开</span>
                <ExternalLink className="w-3 h-3 text-slate-400" />
              </button>
            </div>
          </div>

          {/* Simulated Canvas Stage */}
          <div className="relative min-h-[500px] w-full rounded-2xl bg-[#090e1b] overflow-hidden border border-white/[0.06] p-4 sm:p-6 flex flex-col md:flex-row gap-6 items-start justify-center">
            {/* Background Dots */}
            <div
              className="absolute inset-0 opacity-[0.06] pointer-events-none"
              style={{
                backgroundImage: `radial-gradient(#60a5fa 1.5px, transparent 1.5px)`,
                backgroundSize: '24px 24px',
              }}
            />

            {/* Root Node Card (Left) */}
            <div className="w-full md:w-[380px] bg-slate-900/95 border border-blue-500/40 rounded-2xl shadow-xl shadow-blue-950/50 p-4 relative z-10 transition-all hover:border-blue-400">
              <div className="flex items-center justify-between pb-2 mb-2 border-b border-white/[0.08]">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-blue-400 animate-ping" />
                  <span className="text-xs font-bold text-white">主线探索 #0</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 flex items-center gap-1">
                    <Globe className="w-2.5 h-2.5" />
                    已联网
                  </span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                    Gemini 3.8 Flash
                  </span>
                </div>
              </div>

              <h4 className="text-sm font-semibold text-white mb-2">
                超导量子比特的退相干机制与主要噪声源
              </h4>

              <div className="text-xs text-slate-300 leading-relaxed bg-slate-950/60 p-3 rounded-xl border border-white/[0.05]">
                <p className="mb-2">
                  超导量子系统的状态保持受到两类基本物理退相干过程限制：
                </p>
                <div className="p-2 my-1.5 rounded bg-blue-950/40 border border-blue-800/40 font-mono text-[11px] text-cyan-200">
                  {'$$T_1: \\text{能量弛豫时间} \\quad T_2^*: \\text{纯退相位时间}$$'}
                </div>
                <p className="text-slate-300">
                  主要由
                  <span
                    className={`px-1 py-0.5 mx-0.5 rounded transition-colors ${
                      demoStep >= 2
                        ? 'bg-blue-500/30 text-blue-200 border border-blue-400/40 font-medium'
                        : 'bg-white/[0.06] text-slate-200'
                    }`}
                  >
                    约瑟夫森结的电荷噪声
                  </span>
                  与介质材料双能级系统 (TLS) 损耗引起。
                </p>
              </div>

              {/* Source citations preview */}
              <div className="mt-2.5 p-2 rounded-xl bg-blue-950/30 border border-blue-500/20 text-[11px]">
                <div className="flex items-center justify-between font-semibold text-blue-300 mb-1">
                  <div className="flex items-center gap-1">
                    <Globe className="w-3 h-3 text-cyan-400" />
                    <span>权威检索来源 (3 篇)</span>
                  </div>
                  <span className="text-[9px] text-slate-400">Google Grounding</span>
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  <span className="px-1.5 py-0.5 rounded bg-white/[0.05] border border-white/[0.08] text-[9px] text-blue-200">
                    [1] Nature Quantum: Dephasing
                  </span>
                  <span className="px-1.5 py-0.5 rounded bg-white/[0.05] border border-white/[0.08] text-[9px] text-blue-200">
                    [2] arXiv: Surface Code
                  </span>
                  <span className="px-1.5 py-0.5 rounded bg-white/[0.05] border border-white/[0.08] text-[9px] text-blue-200">
                    [3] IBM Quantum Docs
                  </span>
                </div>
              </div>

              {/* Selection Capsule Simulation */}
              {demoStep === 2 && (
                <div className="mt-2.5 p-2 rounded-xl bg-gradient-to-r from-blue-600/90 to-indigo-600/90 text-white text-[11px] flex items-center justify-between shadow-lg animate-in fade-in zoom-in-95">
                  <div className="flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-cyan-300" />
                    <span>已划选「约瑟夫森结电荷噪声」深入推演</span>
                  </div>
                  <span className="text-[10px] bg-white/20 px-2 py-0.5 rounded-md font-semibold">
                    自动衍生中 →
                  </span>
                </div>
              )}

              {/* Bottom stats */}
              <div className="mt-3 flex items-center justify-between text-[10px] text-slate-400 pt-2 border-t border-white/[0.06]">
                <span className="flex items-center gap-1 text-slate-300">
                  <SlidersHorizontal className="w-3 h-3 text-indigo-400" />
                  <span>Gemini 3.8 Flash · 实时检索</span>
                </span>
                <span>已衍生 2 个子分支</span>
              </div>
            </div>

            {/* Connecting Edge SVG simulation */}
            <div className="hidden md:flex flex-col items-center justify-center self-center h-20 text-blue-400/60">
              <svg width="60" height="40" className="overflow-visible">
                <path
                  d="M 0 20 C 30 20, 30 20, 60 20"
                  fill="transparent"
                  stroke="#3b82f6"
                  strokeWidth="2"
                  strokeDasharray="4,4"
                />
                <circle cx="60" cy="20" r="3" fill="#60a5fa" />
              </svg>
            </div>

            {/* Child Branch Node Card (Right) */}
            <div
              className={`w-full md:w-[360px] bg-slate-900/90 border rounded-2xl shadow-xl p-4 relative z-10 transition-all duration-300 ${
                demoStep >= 2
                  ? 'border-indigo-500/50 shadow-indigo-950/50 opacity-100 translate-x-0'
                  : 'border-white/[0.08] opacity-80'
              }`}
            >
              <div className="flex items-center justify-between pb-2 mb-2 border-b border-white/[0.08]">
                <div className="flex items-center gap-2">
                  <GitBranch className="w-3.5 h-3.5 text-indigo-400" />
                  <span className="text-xs font-bold text-white">子分支 #1 (深度 1)</span>
                </div>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30">
                  {demoStep >= 2 ? '推演就绪' : '建议议题'}
                </span>
              </div>

              <h4 className="text-sm font-semibold text-white mb-2">
                约瑟夫森结非简谐性与 Transmon 能级设计
              </h4>

              <div className="text-xs text-slate-300 leading-relaxed bg-slate-950/60 p-3 rounded-xl border border-white/[0.05]">
                <p className="mb-2">
                  通过增大结电容降低约瑟夫森结对电荷噪声敏感度：
                </p>
                <div className="p-2 my-1.5 rounded bg-indigo-950/40 border border-indigo-800/40 font-mono text-[11px] text-indigo-200">
                  {'$$E_J / E_C \\gg 50 \\implies \\text{指数级压制电荷弥散}$$'}
                </div>
                <p className="text-slate-400 text-[11px]">
                  同时保留微弱的非简谐性以实现 $|0\rangle \to |1\rangle$ 单量子比特逻辑门受控翻转。
                </p>
              </div>

              {/* Sticky note connected */}
              <div className="mt-3 p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs">
                <div className="flex items-center gap-1 text-[11px] font-semibold text-amber-300 mb-1">
                  <span>💡 研究假设便签</span>
                </div>
                <p className="text-[11px] text-amber-100/90 leading-normal">
                  需要验证：结电容增加是否会导致谐振腔读取色散位移 $\chi$ 降低？
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 6 Core Pillars Showcase */}
      <section id="features" className="relative z-10 py-20 px-6 max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-500/10 text-blue-300 border border-blue-500/20 text-xs font-medium mb-3">
            <Layers className="w-3.5 h-3.5 text-blue-400" />
            <span>核心认知架构</span>
          </div>
          <h2 className="text-3xl sm:text-5xl font-bold text-white tracking-tight">
            专为复杂思考与学术严谨而生
          </h2>
          <p className="mt-4 text-slate-400 text-base max-w-2xl mx-auto">
            DeepDive 不是一个简单包装的对话工具，而是一个释放深层心智模型的空间计算工作台。
          </p>
        </div>

        {/* 6 Grid Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {/* Card 1 */}
          <div className="rounded-3xl p-7 bg-gradient-to-b from-white/[0.06] to-white/[0.02] border border-white/[0.1] hover:border-blue-500/40 transition-all duration-300 hover:shadow-2xl hover:shadow-blue-900/20 group">
            <div className="w-12 h-12 rounded-2xl bg-blue-500/20 border border-blue-400/30 flex items-center justify-center text-blue-400 mb-5 group-hover:scale-110 transition-transform">
              <Maximize2 className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-bold text-white mb-2.5 tracking-tight">
              无限画布与空间记忆
            </h3>
            <p className="text-xs sm:text-sm text-slate-400 leading-relaxed mb-4">
              彻底打破长篇文本流的“翻页遗忘”。所有探讨以 2D 卡片排布在无限画布上，支持平移缩放与 Dagre 自动排版，掌控全局思考骨架。
            </p>
            <div className="flex items-center gap-2 text-xs text-blue-400 font-medium">
              <span>零拖拽拓扑布局 (Dagre Layout)</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </div>
          </div>

          {/* Card 2 */}
          <div className="rounded-3xl p-7 bg-gradient-to-b from-white/[0.06] to-white/[0.02] border border-white/[0.1] hover:border-cyan-500/40 transition-all duration-300 hover:shadow-2xl hover:shadow-cyan-900/20 group">
            <div className="w-12 h-12 rounded-2xl bg-cyan-500/20 border border-cyan-400/30 flex items-center justify-center text-cyan-400 mb-5 group-hover:scale-110 transition-transform">
              <MousePointerClick className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-bold text-white mb-2.5 tracking-tight">
              划词裂变 · 任意点递归深入
            </h3>
            <p className="text-xs sm:text-sm text-slate-400 leading-relaxed mb-4">
              在阅读长篇解答时遇到关键公式或专有名词，鼠标划选即刻弹出悬浮探索胶囊，自动继承上下文衍生独立子议题分支。
            </p>
            <div className="flex items-center gap-2 text-xs text-cyan-400 font-medium">
              <span>语义继承与追问衍生</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </div>
          </div>

          {/* Card 3: Custom Models */}
          <div className="rounded-3xl p-7 bg-gradient-to-b from-white/[0.06] to-white/[0.02] border border-white/[0.1] hover:border-indigo-500/40 transition-all duration-300 hover:shadow-2xl hover:shadow-indigo-900/20 group">
            <div className="w-12 h-12 rounded-2xl bg-indigo-500/20 border border-indigo-400/30 flex items-center justify-center text-indigo-400 mb-5 group-hover:scale-110 transition-transform">
              <SlidersHorizontal className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-bold text-white mb-2.5 tracking-tight">
              多元前沿模型自由调配
            </h3>
            <p className="text-xs sm:text-sm text-slate-400 leading-relaxed mb-4">
              支持卡片级与全局模型自选。在极速推理的 Gemini 3.1 Flash-Lite、全能高效的 Gemini 3.8 Flash 与深度推演的 Gemini 2.5 Pro 间灵活切换。
            </p>
            <div className="flex items-center gap-2 text-xs text-indigo-400 font-medium">
              <span>按需调优计算性能与推理深度</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </div>
          </div>

          {/* Card 4: Real-time Web Search & Sources Grounding */}
          <div className="rounded-3xl p-7 bg-gradient-to-b from-white/[0.06] to-white/[0.02] border border-white/[0.1] hover:border-emerald-500/40 transition-all duration-300 hover:shadow-2xl hover:shadow-emerald-900/20 group">
            <div className="w-12 h-12 rounded-2xl bg-emerald-500/20 border border-emerald-400/30 flex items-center justify-center text-emerald-400 mb-5 group-hover:scale-110 transition-transform">
              <Globe className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-bold text-white mb-2.5 tracking-tight">
              实时联网搜索与来源索引
            </h3>
            <p className="text-xs sm:text-sm text-slate-400 leading-relaxed mb-4">
              支持 Google Search 真实联网检索增强。自动抽取权威论文、官方文档与行业报告来源，卡片内置可交互的引用角标与来源卡片，杜绝幻觉。
            </p>
            <div className="flex items-center gap-2 text-xs text-emerald-400 font-medium">
              <span>Google Grounding 溯源有据</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </div>
          </div>

          {/* Card 5: KaTeX */}
          <div className="rounded-3xl p-7 bg-gradient-to-b from-white/[0.06] to-white/[0.02] border border-white/[0.1] hover:border-amber-500/40 transition-all duration-300 hover:shadow-2xl hover:shadow-amber-900/20 group">
            <div className="w-12 h-12 rounded-2xl bg-amber-500/20 border border-amber-400/30 flex items-center justify-center text-amber-400 mb-5 group-hover:scale-110 transition-transform">
              <Cpu className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-bold text-white mb-2.5 tracking-tight">
              学术级 KaTeX 公式与代码推演
            </h3>
            <p className="text-xs sm:text-sm text-slate-400 leading-relaxed mb-4">
              专为科研与工程设计。完美解析 LaTeX 行内与行间公式、矩阵、偏微分与积分。支持代码语法高亮与思维链（Chain of Thought）折叠审视。
            </p>
            <div className="flex items-center gap-2 text-xs text-amber-400 font-medium">
              <span>实时流式渲染与数学推导</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </div>
          </div>

          {/* Card 6: Dual-track Notes & Night Mode */}
          <div className="rounded-3xl p-7 bg-gradient-to-b from-white/[0.06] to-white/[0.02] border border-white/[0.1] hover:border-purple-500/40 transition-all duration-300 hover:shadow-2xl hover:shadow-purple-900/20 group">
            <div className="w-12 h-12 rounded-2xl bg-purple-500/20 border border-purple-400/30 flex items-center justify-center text-purple-400 mb-5 group-hover:scale-110 transition-transform">
              <FileText className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-bold text-white mb-2.5 tracking-tight">
              双轨便签论证与深夜护眼画布
            </h3>
            <p className="text-xs sm:text-sm text-slate-400 leading-relaxed mb-4">
              支持插入个人研究假设便签，与 AI 解答共同构建论证图谱。全局适配深夜暗色模式，推演完毕一键导出结构化 Markdown 研报与 JSON 备份。
            </p>
            <div className="flex items-center gap-2 text-xs text-purple-400 font-medium">
              <span>沉浸式夜间模式与研报导出</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </div>
          </div>
        </div>
      </section>

      {/* Comparison Matrix: Linear Chat vs DeepDive Canvas */}
      <section id="comparison" className="relative z-10 py-20 px-6 max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 text-xs font-medium mb-3">
            <Workflow className="w-3.5 h-3.5 text-indigo-400" />
            <span>范式变革</span>
          </div>
          <h2 className="text-3xl sm:text-5xl font-bold text-white tracking-tight">
            传统 AI 对话 vs DeepDive 无限拓扑
          </h2>
          <p className="mt-4 text-slate-400 text-base max-w-2xl mx-auto">
            思考方式决定了认知的上限。看一看空间图谱如何彻底碾压传统线性垂直对话。
          </p>
        </div>

        {/* Comparison Table */}
        <div className="max-w-4xl mx-auto rounded-3xl border border-white/[0.1] bg-white/[0.02] backdrop-blur-xl overflow-hidden shadow-2xl">
          <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-white/[0.08]">
            {/* Left: Traditional Chat */}
            <div className="p-8 bg-rose-950/10">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-xl bg-rose-500/20 border border-rose-500/30 flex items-center justify-center text-rose-400">
                  <XCircle className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="text-base font-bold text-white">传统线性 Chatbot</h4>
                  <span className="text-xs text-rose-400">单行道 · 碎片化 · 易遗忘</span>
                </div>
              </div>

              <ul className="space-y-4 text-xs sm:text-sm text-slate-400">
                <li className="flex items-start gap-3">
                  <span className="text-rose-400 mt-0.5">✕</span>
                  <span><b>单向垂直滚动</b>：无法多路径同时推演平行假设，一旦追问就打乱原主线</span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="text-rose-400 mt-0.5">✕</span>
                  <span><b>上下文稀释与漂移</b>：多轮交流后，模型与用户双双遗忘初始的核心命题</span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="text-rose-400 mt-0.5">✕</span>
                  <span><b>缺乏结构化沉淀</b>：最终留下一大串难以回溯的纯文本碎渣</span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="text-rose-400 mt-0.5">✕</span>
                  <span><b>缺少个人思考注入</b>：无法在特定解答旁贴上批判性质疑与便签</span>
                </li>
              </ul>
            </div>

            {/* Right: DeepDive */}
            <div className="p-8 bg-blue-950/20">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-xl bg-blue-500/20 border border-blue-500/30 flex items-center justify-center text-blue-400">
                  <CheckCircle2 className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="text-base font-bold text-white">DeepDive 空间思维画板</h4>
                  <span className="text-xs text-blue-400">无限图谱 · 递归分支 · 全景可控</span>
                </div>
              </div>

              <ul className="space-y-4 text-xs sm:text-sm text-slate-300">
                <li className="flex items-start gap-3">
                  <span className="text-emerald-400 mt-0.5">✓</span>
                  <span><b>2D 无限画板</b>：主线与任意衍生分支清晰共存，任意节点随时平移缩放</span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="text-emerald-400 mt-0.5">✓</span>
                  <span><b>划词裂变深挖</b>：阅读中发现盲点立即开辟新分支，前置语义精确继承</span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="text-emerald-400 mt-0.5">✓</span>
                  <span><b>自动拓扑布局</b>：Dagre 树状算法一键规整排版，复杂知识井然有序</span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="text-emerald-400 mt-0.5">✓</span>
                  <span><b>双轨便签与大纲导出</b>：人机协同论证，一键导出严谨 Markdown 研报</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Target Scenarios Explorer */}
      <section id="scenarios" className="relative z-10 py-20 px-6 max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-cyan-500/10 text-cyan-300 border border-cyan-500/20 text-xs font-medium mb-3">
            <BookOpen className="w-3.5 h-3.5 text-cyan-400" />
            <span>深度探索场景</span>
          </div>
          <h2 className="text-3xl sm:text-5xl font-bold text-white tracking-tight">
            为追求极致认知的思考者打造
          </h2>
          <p className="mt-4 text-slate-400 text-base max-w-2xl mx-auto">
            无论是科研论文推演、系统架构设计，还是投资研报撰写，DeepDive 都是你的第二大脑。
          </p>
        </div>

        {/* Tab Selection */}
        <div className="flex flex-wrap items-center justify-center gap-3 mb-10">
          {scenarios.map((sc, idx) => {
            const Icon = sc.icon;
            const isActive = activeScenario === idx;
            return (
              <button
                key={sc.title}
                onClick={() => setActiveScenario(idx)}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-2xl text-xs font-semibold transition-all ${
                  isActive
                    ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/30 border border-blue-400/40'
                    : 'bg-white/[0.04] text-slate-400 hover:bg-white/[0.08] hover:text-white border border-white/[0.08]'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{sc.title}</span>
              </button>
            );
          })}
        </div>

        {/* Selected Scenario Showcase Card */}
        <div className="max-w-4xl mx-auto rounded-3xl border border-white/[0.1] bg-gradient-to-b from-[#0e1628] to-[#090e1b] p-8 md:p-12 shadow-2xl relative overflow-hidden">
          <div className="relative z-10 flex flex-col md:flex-row items-start md:items-center justify-between gap-8">
            <div className="max-w-xl">
              <span className="text-xs font-bold text-blue-400 tracking-wider uppercase">
                场景深度探索
              </span>
              <h3 className="text-2xl sm:text-3xl font-bold text-white mt-2 mb-4">
                {scenarios[activeScenario].title}
              </h3>
              <p className="text-slate-300 text-sm leading-relaxed mb-6">
                {scenarios[activeScenario].desc}
              </p>

              <div className="flex flex-wrap gap-2 mb-8">
                {scenarios[activeScenario].tags.map((tag) => (
                  <span
                    key={tag}
                    className="px-3 py-1 rounded-full bg-white/[0.06] text-slate-300 border border-white/[0.08] text-xs"
                  >
                    #{tag}
                  </span>
                ))}
              </div>

              <button
                onClick={() => onEnterCanvas(scenarios[activeScenario].sampleTopic)}
                className="flex items-center gap-2 px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-md shadow-blue-500/30 transition-all hover:scale-[1.02]"
              >
                <span>以此场景开启探索: 「{scenarios[activeScenario].sampleTopic}」</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="w-full md:w-64 p-6 rounded-2xl bg-white/[0.03] border border-white/[0.08] text-center shrink-0">
              <ShieldCheck className="w-10 h-10 text-cyan-400 mx-auto mb-3" />
              <div className="text-sm font-bold text-white mb-1">全流程本地持久化</div>
              <p className="text-xs text-slate-400 leading-normal">
                无需联网注册账号，随时随地开启，进度实时保存至您的浏览器。
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ Section */}
      <section id="faq" className="relative z-10 py-20 px-6 max-w-4xl mx-auto">
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-purple-500/10 text-purple-300 border border-purple-500/20 text-xs font-medium mb-3">
            <HelpCircle className="w-3.5 h-3.5 text-purple-400" />
            <span>常见疑问</span>
          </div>
          <h2 className="text-3xl sm:text-4xl font-bold text-white tracking-tight">
            关于 DeepDive 的一切
          </h2>
        </div>

        <div className="space-y-4">
          {faqs.map((faq, idx) => {
            const isOpen = openFaq === idx;
            return (
              <div
                key={faq.q}
                className="rounded-2xl border border-white/[0.08] bg-white/[0.03] backdrop-blur-md overflow-hidden transition-all"
              >
                <button
                  onClick={() => setOpenFaq(isOpen ? null : idx)}
                  className="w-full text-left px-6 py-5 flex items-center justify-between gap-4 font-semibold text-white text-sm hover:text-blue-300 transition-colors"
                >
                  <span>{faq.q}</span>
                  <ChevronRight
                    className={`w-4 h-4 text-slate-400 transition-transform duration-200 shrink-0 ${
                      isOpen ? 'rotate-90 text-blue-400' : ''
                    }`}
                  />
                </button>
                {isOpen && (
                  <div className="px-6 pb-5 text-xs sm:text-sm text-slate-300 leading-relaxed border-t border-white/[0.04] pt-4">
                    {faq.a}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Final Call to Action */}
      <section className="relative z-10 py-24 px-6 max-w-6xl mx-auto text-center">
        <div className="relative rounded-3xl p-10 sm:p-16 overflow-hidden border border-blue-500/30 bg-gradient-to-b from-blue-950/40 via-indigo-950/20 to-[#070a13] shadow-2xl">
          <div className="absolute -top-24 left-1/2 -translate-x-1/2 w-96 h-96 bg-blue-500/20 blur-[120px] rounded-full pointer-events-none" />

          <h2 className="text-3xl sm:text-5xl font-extrabold text-white tracking-tight">
            准备好重构你的思考范式了吗？
          </h2>
          <p className="mt-4 text-slate-300 text-sm sm:text-base max-w-2xl mx-auto leading-relaxed">
            告别被截断的思路与混乱的笔记。现在就进入 DeepDive，在无限二维画布上构建属于你的认知星图。
          </p>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <button
              onClick={() => onEnterCanvas()}
              className="flex items-center gap-2 px-8 py-4 rounded-2xl text-sm font-bold text-white bg-gradient-to-r from-blue-600 via-indigo-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 shadow-2xl shadow-blue-500/40 border border-white/20 transition-all hover:scale-105 active:scale-95"
            >
              <Compass className="w-4 h-4 text-white" />
              <span>立即进入思维画布 (无需注册)</span>
              <ArrowRight className="w-4 h-4 text-white" />
            </button>
          </div>

          <div className="mt-6 text-xs text-slate-400 flex items-center justify-center gap-4">
            <span>✓ 实时本地自动保存</span>
            <span>•</span>
            <span>✓ 一键导出 Markdown 研报</span>
            <span>•</span>
            <span>✓ 极速 Gemini 智能推理</span>
          </div>
        </div>
      </section>

      {/* Modern Footer */}
      <footer className="relative z-10 border-t border-white/[0.08] py-12 px-6 max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-6 text-xs text-slate-400">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center text-white">
            <Compass className="w-4 h-4" />
          </div>
          <span className="font-bold text-slate-200">DeepDive Cognitive Canvas</span>
          <span className="text-slate-600">|</span>
          <span>无限画布式 AI 深度思维与分支探索认知平台</span>
        </div>

        <div className="flex items-center gap-6">
          <button
            onClick={() => onEnterCanvas()}
            className="hover:text-white transition-colors"
          >
            直接进入画布
          </button>
          <a
            href="#features"
            className="hover:text-white transition-colors"
          >
            功能特性
          </a>
          <a
            href="#scenarios"
            className="hover:text-white transition-colors"
          >
            探索方案
          </a>
          <span className="text-slate-600">© 2026 DeepDive. All rights reserved.</span>
        </div>
      </footer>
    </div>
  );
};
