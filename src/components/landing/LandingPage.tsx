/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 官网落地页（2026-10 改版）：从「单产品画布」升级为「思维画布 + AI 练习」双产品叙事。
 * - 文案/FAQ/能力条全部取自 shared/product-content.ts（与服务端 SEO 回退块同源）
 * - AI 练习部分使用静态截图式卡片，不依赖图片素材与真实接口
 */
import React, { useEffect, useState } from 'react';
import {
  Compass,
  Sparkles,
  ArrowRight,
  GitBranch,
  MousePointerClick,
  Layers,
  FileText,
  Workflow,
  Zap,
  CheckCircle2,
  XCircle,
  BookOpen,
  Code2,
  TrendingUp,
  Maximize2,
  ExternalLink,
  ChevronRight,
  HelpCircle,
  Globe,
  SlidersHorizontal,
  Crown,
  LogIn,
  Brain,
  Target,
  History,
  Eye,
  Clock,
  BarChart3,
  ListChecks,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useModal } from '../../context/ModalContext';
import { trackEvent } from '../../lib/analytics';
import { SCENARIO_SAMPLE_INDEX, SAMPLE_BOARDS } from '../../lib/sample-boards';
import {
  LANDING_FAQS,
  LANDING_H1,
  LANDING_HIGHLIGHTS,
  LANDING_LEAD,
  LANDING_SCENARIOS,
  LANDING_TOPICS,
  type ScenarioIconKey,
} from '../../../shared/product-content';
import { SampleBoardViewer } from '../sample/SampleBoardViewer';

interface LandingPageProps {
  onEnterCanvas: (presetTopic?: string) => void;
  onEnterPractice?: (presetTopic?: string) => void;
}

const SCENARIO_ICONS: Record<ScenarioIconKey, React.ComponentType<{ className?: string }>> = {
  book: BookOpen,
  code: Code2,
  trend: TrendingUp,
  workflow: Workflow,
};

const FEATURE_ICONS = [Maximize2, MousePointerClick, Brain, BarChart3, Globe, FileText];
const FEATURE_DESCS = [
  '所有提问、解答与便签都留在同一张空间里，平移缩放即可回看整条推理链，不再翻页遗忘。',
  '划选任意词句或公式，自动继承上下文衍生子议题；一条主线可以同时长出多条平行思路。',
  '输入主题、选择难度与题量，AI 现场出单选题与判断题；答案在交卷前不下发，练的是真掌握。',
  '交卷即得掌握情况、逐题解析与知识点；历史记录可回看选项全文、只看错题，也能继续未完成的练习。',
  '推理时实时联网检索，权威来源以角标与来源卡片呈现，观点可追溯，不把幻觉当结论。',
  '行内与块级公式正确排版，画布可导出 Markdown 研报与 JSON 备份，练习记录也能随时回看。',
];

const SectionLabel: React.FC<{ icon: React.ReactNode; children: React.ReactNode; tone?: 'blue' | 'emerald' }> = ({
  icon,
  children,
  tone = 'blue',
}) => (
  <div
    className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-medium mb-3 ${
      tone === 'emerald'
        ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20'
        : 'bg-blue-500/10 text-blue-300 border-blue-500/20'
    }`}
  >
    {icon}
    <span>{children}</span>
  </div>
);

/** 静态截图式练习卡：题目 + 选项 + 掌握情况 */
const PracticeMock: React.FC = () => (
  <div className="rounded-2xl border border-white/[0.1] bg-[#0a1020] p-4 shadow-2xl shadow-black/30">
    <div className="flex items-center justify-between gap-2 pb-3 border-b border-white/[0.07]">
      <div className="flex items-center gap-2 min-w-0">
        <span className="w-7 h-7 rounded-lg bg-purple-500/20 text-purple-300 flex items-center justify-center shrink-0">
          <Brain className="w-4 h-4" />
        </span>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-white truncate">注意力机制</p>
          <p className="text-xxs text-slate-500">进阶 · 5 题 · AI 出题</p>
        </div>
      </div>
      <span className="text-xxs px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/25 shrink-0">
        掌握 4/5
      </span>
    </div>

    <div className="pt-3">
      <div className="flex items-center justify-between text-xxs text-slate-500">
        <span>第 2 题 · 单选</span>
        <span>3 / 5</span>
      </div>
      <p className="mt-2 text-xs font-semibold text-slate-100 leading-relaxed">
        多头注意力里，为什么要对 QKᵀ 除以 √d_k？
      </p>
      <div className="mt-2.5 space-y-1.5">
        {[
          { label: 'A', text: '让注意力分数落在 0~1 之间', state: 'wrong' },
          { label: 'B', text: '抵消点积随维度增长带来的方差', state: 'correct' },
          { label: 'C', text: '减少注意力头的数量', state: 'idle' },
          { label: 'D', text: '保证每个头看到相同的输入', state: 'idle' },
        ].map((o) => (
          <div
            key={o.label}
            className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xxs ${
              o.state === 'correct'
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                : o.state === 'wrong'
                  ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
                  : 'border-white/[0.07] bg-white/[0.02] text-slate-400'
            }`}
          >
            <span className="font-bold w-3">{o.label}</span>
            <span className="flex-1">{o.text}</span>
            {o.state === 'correct' && <CheckCircle2 className="w-3 h-3 shrink-0" />}
            {o.state === 'wrong' && <XCircle className="w-3 h-3 shrink-0" />}
          </div>
        ))}
      </div>
    </div>

    <div className="mt-3 pt-3 border-t border-white/[0.07] flex items-center justify-between">
      <div className="flex items-center gap-1.5 text-xxs text-slate-500">
        <SlidersHorizontal className="w-3 h-3 text-purple-400" />
        全部 5 · 只看错题 1
      </div>
      <span className="text-xxs text-emerald-300 flex items-center gap-1">
        <ListChecks className="w-3 h-3" /> 交卷后显示解析
      </span>
    </div>
  </div>
);

/** 静态截图式画布卡：两张节点 + 连线 */
const CanvasMock: React.FC = () => (
  <div className="relative rounded-2xl border border-white/[0.1] bg-[#090f1c] p-3 overflow-hidden min-h-[260px]">
    <div
      className="absolute inset-0 opacity-[0.08]"
      style={{ backgroundImage: 'radial-gradient(#60a5fa 1px, transparent 1px)', backgroundSize: '22px 22px' }}
    />
    <div className="relative flex items-center justify-between text-xxs text-slate-500 pb-2 border-b border-white/[0.06]">
      <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-400" /> 联网溯源</span>
      <span className="font-mono">思维画布</span>
    </div>
    <div className="relative mt-3 space-y-2">
      <div className="w-[88%] rounded-xl border border-blue-500/35 bg-slate-900/95 p-3 shadow-lg">
        <p className="text-xxs text-blue-300 mb-1">主线 · 深度 0</p>
        <p className="text-xs font-semibold text-white leading-snug">为什么缩放点积注意力能稳定训练？</p>
        <div className="mt-2 h-1.5 w-4/5 rounded bg-white/[0.06]" />
        <div className="mt-1.5 h-1.5 w-3/5 rounded bg-white/[0.06]" />
      </div>
      <div className="w-[82%] ml-auto rounded-xl border border-indigo-500/35 bg-slate-900/95 p-3 shadow-lg">
        <p className="text-xxs text-indigo-300 mb-1 flex items-center gap-1"><GitBranch className="w-3 h-3" /> 子分支 · 深度 1</p>
        <p className="text-xs font-semibold text-white leading-snug">方差、softmax 饱和与梯度消失</p>
        <div className="mt-2 flex gap-1">
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300">[1] 来源</span>
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-white/[0.06] text-slate-400">划词衍生</span>
        </div>
      </div>
      <svg className="absolute left-[42%] top-[86px] w-12 h-10 text-blue-400/50" viewBox="0 0 48 40" fill="none">
        <path d="M2 2 C 30 2, 18 38, 46 38" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 4" />
      </svg>
    </div>
  </div>
);

const HeroPreview: React.FC<{ onEnterPractice?: () => void }> = ({ onEnterPractice }) => (
  <div className="relative">
    <div className="absolute -inset-6 bg-gradient-to-tr from-blue-600/20 via-indigo-600/10 to-emerald-500/15 blur-3xl rounded-full" />
    <div className="relative rounded-[28px] border border-white/[0.12] bg-[#080d19]/95 p-3 shadow-2xl shadow-blue-950/40 backdrop-blur-xl">
      <div className="flex items-center gap-1.5 px-1 pb-3">
        <span className="w-2.5 h-2.5 rounded-full bg-rose-500/70" />
        <span className="w-2.5 h-2.5 rounded-full bg-amber-500/70" />
        <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/70" />
        <span className="ml-2 text-[10px] font-mono text-slate-500">枝想工作台 · 画布 / 练习</span>
      </div>
      <div className="grid gap-3">
        <CanvasMock />
        <div className="relative -mt-8 ml-6 mr-0 sm:ml-12">
          <PracticeMock />
          <button
            type="button"
            onClick={onEnterPractice}
            className="absolute -bottom-3 right-3 px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xxs font-semibold shadow-lg transition cursor-pointer"
          >
            去练一组 →
          </button>
        </div>
      </div>
    </div>
  </div>
);

export const LandingPage: React.FC<LandingPageProps> = ({ onEnterCanvas, onEnterPractice }) => {
  const { user, isVip } = useAuth();
  const { openAuthModal, openRechargeModal } = useModal();
  const [activeScenario, setActiveScenario] = useState<number>(0);
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  const [sampleViewerOpen, setSampleViewerOpen] = useState(false);
  const [sampleIndex, setSampleIndex] = useState(0);

  useEffect(() => {
    trackEvent('landing_view');
  }, []);

  return (
    <div className="min-h-screen bg-[#060912] text-slate-100 font-sans selection:bg-blue-500/30 selection:text-blue-200 overflow-x-hidden relative">
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
        <div className="absolute top-[-18%] left-1/2 -translate-x-1/2 w-[1100px] h-[700px] bg-gradient-to-b from-blue-600/20 via-indigo-600/10 to-transparent blur-[150px] rounded-full" />
        <div className="absolute top-[35%] left-[-12%] w-[620px] h-[520px] bg-cyan-600/10 blur-[150px] rounded-full" />
        <div className="absolute top-[62%] right-[-12%] w-[720px] h-[620px] bg-purple-600/10 blur-[170px] rounded-full" />
        <div
          className="absolute inset-0 opacity-[0.035]"
          style={{ backgroundImage: 'radial-gradient(#94a3b8 1px, transparent 1px)', backgroundSize: '30px 30px' }}
        />
      </div>

      {/* Header */}
      <header className="sticky top-0 z-50 backdrop-blur-xl bg-[#060912]/85 border-b border-white/[0.07]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 cursor-pointer select-none shrink-0" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-blue-600 via-indigo-600 to-cyan-400 flex items-center justify-center text-white shadow-lg shadow-blue-500/20 ring-1 ring-white/20">
              <Compass className="w-5 h-5" />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-base font-bold tracking-tight text-white">枝想<span className="text-blue-400 font-medium">Arborize</span></span>
              <span className="hidden sm:inline-block text-xxs font-bold tracking-wider px-2 py-0.5 rounded-full bg-white/[0.06] text-slate-300 border border-white/10">
                思考 × 练习
              </span>
            </div>
          </div>

          <nav className="hidden lg:flex items-center gap-1 px-2 py-1 rounded-full bg-white/[0.03] border border-white/[0.07] text-xs font-medium text-slate-300">
            <a href="#products" className="px-3 py-1.5 rounded-lg hover:text-white hover:bg-white/[0.07] transition-colors">双产品</a>
            <a href="#practice" className="px-3 py-1.5 rounded-lg hover:text-white hover:bg-white/[0.07] transition-colors">AI 练习</a>
            <a href="#features" className="px-3 py-1.5 rounded-lg hover:text-white hover:bg-white/[0.07] transition-colors">核心能力</a>
            <a href="#scenarios" className="px-3 py-1.5 rounded-lg hover:text-white hover:bg-white/[0.07] transition-colors">探索场景</a>
            <a href="#faq" className="px-3 py-1.5 rounded-lg hover:text-white hover:bg-white/[0.07] transition-colors">常见疑问</a>
          </nav>

          <div className="flex items-center gap-2 shrink-0">
            {user ? (
              <>
                <button
                  onClick={() => openRechargeModal()}
                  className={`hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-xs font-semibold transition-all cursor-pointer ${
                    isVip
                      ? 'bg-amber-500/15 border-amber-500/30 text-amber-300'
                      : 'bg-indigo-500/15 border-indigo-500/30 text-indigo-200'
                  }`}
                >
                  <Crown className="w-3.5 h-3.5 text-amber-400" />
                  {isVip ? 'VIP' : '升级 VIP'}
                </button>
                <div className="hidden md:flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-white/[0.05] border border-white/10 text-xs text-slate-300">
                  <span className="w-5 h-5 rounded-md bg-gradient-to-tr from-indigo-600 to-purple-600 text-white flex items-center justify-center font-bold text-xxs overflow-hidden">
                    {user.avatar && (user.avatar.startsWith('http') || user.avatar.startsWith('data:')) ? (
                      <img src={user.avatar} alt="avatar" className="w-full h-full object-cover" />
                    ) : (
                      <span>{(user.name || user.email)[0]?.toUpperCase()}</span>
                    )}
                  </span>
                  <span className="max-w-[90px] truncate">{user.name || user.email.split('@')[0]}</span>
                </div>
              </>
            ) : (
              <button
                onClick={() => openAuthModal('signin')}
                className="hidden sm:flex items-center gap-1 px-3 py-1.5 rounded-xl border border-white/15 bg-white/[0.05] hover:bg-white/[0.1] text-slate-200 text-xs font-medium transition-all cursor-pointer"
              >
                <LogIn className="w-3.5 h-3.5 text-blue-400" />
                登录 / 注册
              </button>
            )}
            <button
              onClick={() => onEnterCanvas()}
              className="group inline-flex items-center gap-1.5 px-3.5 sm:px-4 py-2 rounded-xl text-xs font-semibold text-white bg-white/[0.08] hover:bg-white/[0.14] border border-white/15 transition-all cursor-pointer"
            >
              进入工作台
              <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
            </button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative z-10 pt-14 md:pt-20 pb-16 px-4 sm:px-6 max-w-7xl mx-auto">
        <div className="grid lg:grid-cols-[1.02fr_0.98fr] gap-12 lg:gap-16 items-center">
          <div className="text-center lg:text-left">
            <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-white/[0.04] border border-white/10 text-xs font-medium text-slate-300 mb-6">
              <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
              思维画布 × AI 练习 · 一个工作台完成「学」与「练」
            </div>
            <h1 className="text-3xl sm:text-5xl lg:text-[3.35rem] font-extrabold tracking-tight text-white leading-[1.15]">
              {LANDING_H1.lead}
              <span className="block mt-2.5 bg-clip-text text-transparent bg-gradient-to-r from-blue-400 via-indigo-200 to-emerald-300">
                {LANDING_H1.accent}
              </span>
            </h1>
            <p className="mt-5 text-sm sm:text-base text-slate-300/90 leading-relaxed max-w-2xl mx-auto lg:mx-0">
              {LANDING_LEAD}
            </p>
            <div className="mt-7 flex flex-wrap items-center justify-center lg:justify-start gap-3">
              <button
                onClick={() => onEnterCanvas()}
                className="group flex items-center gap-2 px-6 py-3.5 rounded-2xl text-sm font-semibold text-white bg-gradient-to-r from-blue-600 via-indigo-600 to-blue-500 hover:from-blue-500 hover:to-indigo-500 shadow-xl shadow-blue-600/25 border border-blue-400/40 transition-all cursor-pointer"
              >
                <Compass className="w-4 h-4 text-cyan-200" />
                免费开始思考
                <ArrowRight className="w-4 h-4 text-blue-200 group-hover:translate-x-0.5 transition-transform" />
              </button>
              {onEnterPractice && (
                <button
                  onClick={() => onEnterPractice()}
                  className="group flex items-center gap-2 px-6 py-3.5 rounded-2xl text-sm font-semibold text-white bg-gradient-to-r from-purple-600 via-indigo-600 to-purple-500 hover:from-purple-500 hover:to-purple-600 shadow-xl shadow-purple-600/25 border border-purple-400/40 transition-all cursor-pointer"
                >
                  <Brain className="w-4 h-4 text-purple-200" />
                  去 AI 练习
                  <ArrowRight className="w-4 h-4 text-purple-200 group-hover:translate-x-0.5 transition-transform" />
                </button>
              )}
            </div>
            <div className="mt-7 flex flex-wrap items-center justify-center lg:justify-start gap-2 text-xs text-slate-400">
              <span className="text-slate-500">试试这些主题:</span>
              {LANDING_TOPICS.slice(0, 3).map((topic) => (
                <button
                  key={topic}
                  onClick={() => onEnterCanvas(topic)}
                  className="px-3 py-1.5 rounded-lg bg-white/[0.03] hover:bg-blue-500/10 border border-white/[0.07] text-slate-300 hover:text-blue-200 transition-all cursor-pointer"
                >
                  {topic}
                </button>
              ))}
            </div>
          </div>
          <HeroPreview onEnterPractice={onEnterPractice ? () => onEnterPractice() : undefined} />
        </div>

        <div className="mt-16 grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {[
            { icon: Maximize2, title: '无限画布', sub: '不翻页的空间记忆' },
            { icon: Target, title: '三档难度', sub: '入门 / 进阶 / 困难' },
            { icon: ListChecks, title: '选择题 + 判断题', sub: '交卷即判，解析可见' },
            { icon: History, title: '练习详情', sub: '错题回看 · 继续作答' },
          ].map(({ icon: Icon, title, sub }) => (
            <div key={title} className="p-4 rounded-2xl bg-white/[0.025] border border-white/[0.06]">
              <Icon className="w-4 h-4 text-blue-400 mb-2" />
              <p className="text-sm font-bold text-white">{title}</p>
              <p className="text-xxs text-slate-500 mt-0.5">{sub}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Two products */}
      <section id="products" className="relative z-10 py-20 px-6 max-w-7xl mx-auto">
        <div className="text-center mb-12">
          <SectionLabel icon={<Layers className="w-3.5 h-3.5" />}>双产品工作台</SectionLabel>
          <h2 className="text-3xl sm:text-5xl font-bold text-white tracking-tight">先想清楚，再练扎实</h2>
          <p className="mt-4 text-slate-400 text-sm sm:text-base max-w-2xl mx-auto">
            思维画布负责「展开与推演」，AI 练习负责「检验与巩固」。两者独立使用，也能共享同一个学习主题。
          </p>
        </div>

        <div className="grid lg:grid-cols-2 gap-6">
          <div className="rounded-3xl p-7 bg-gradient-to-b from-blue-500/[0.08] to-white/[0.02] border border-blue-500/20 hover:border-blue-400/40 transition-all">
            <div className="flex items-center gap-3 mb-4">
              <span className="w-11 h-11 rounded-2xl bg-blue-500/20 border border-blue-400/30 text-blue-300 flex items-center justify-center"><Compass className="w-5 h-5" /></span>
              <div>
                <p className="text-xxs text-blue-300 font-semibold tracking-wider">PRODUCT 01</p>
                <h3 className="text-xl font-bold text-white">思维画布</h3>
              </div>
            </div>
            <p className="text-sm text-slate-400 leading-relaxed">把问题摊开在同一张无限画布上，让 AI 回答成为可继续追问、可追溯来源的思维节点。</p>
            <ul className="mt-5 space-y-2.5 text-xs text-slate-300">
              {['一次推演多条平行思路，不丢上下文', '划词即可从任意句子上长出新分支', '来源角标 + 公式 + 便签，形成可导出研报'].map((t) => (
                <li key={t} className="flex items-start gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-blue-400 mt-0.5 shrink-0" />{t}</li>
              ))}
            </ul>
            <button onClick={() => onEnterCanvas()} className="mt-6 inline-flex items-center gap-1.5 text-xs font-semibold text-blue-300 hover:text-blue-200 transition cursor-pointer">
              进入思维画布 <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="rounded-3xl p-7 bg-gradient-to-b from-purple-500/[0.08] to-white/[0.02] border border-purple-500/20 hover:border-purple-400/40 transition-all">
            <div className="flex items-center gap-3 mb-4">
              <span className="w-11 h-11 rounded-2xl bg-purple-500/20 border border-purple-400/30 text-purple-300 flex items-center justify-center"><Brain className="w-5 h-5" /></span>
              <div>
                <p className="text-xxs text-purple-300 font-semibold tracking-wider">PRODUCT 02</p>
                <h3 className="text-xl font-bold text-white">AI 练习</h3>
              </div>
            </div>
            <p className="text-sm text-slate-400 leading-relaxed">把「看懂了」变成「做对了」。输入主题，AI 现场出题；交卷后给出掌握情况与逐题解析。</p>
            <ul className="mt-5 space-y-2.5 text-xs text-slate-300">
              {['主题 + 难度 + 题量，三步生成一套题', '交卷前不下发答案，避免边看边猜', '历史记录可回看选项全文、只看错题、继续作答'].map((t) => (
                <li key={t} className="flex items-start gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-purple-400 mt-0.5 shrink-0" />{t}</li>
              ))}
            </ul>
            {onEnterPractice && (
              <button onClick={() => onEnterPractice()} className="mt-6 inline-flex items-center gap-1.5 text-xs font-semibold text-purple-300 hover:text-purple-200 transition cursor-pointer">
                开始一次练习 <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Practice showcase */}
      <section id="practice" className="relative z-10 py-20 px-6 max-w-7xl mx-auto">
        <div className="grid lg:grid-cols-[0.9fr_1.1fr] gap-12 items-center">
          <div>
            <SectionLabel icon={<Brain className="w-3.5 h-3.5" />} tone="emerald">AI 练习 · 学完就练</SectionLabel>
            <h2 className="text-3xl sm:text-5xl font-bold text-white tracking-tight leading-tight">
              不用自己找题，<br className="hidden sm:block" />也能知道自己会不会
            </h2>
            <p className="mt-4 text-slate-400 text-sm leading-relaxed">
              从主题到掌握情况，一条完整的练习闭环。选择题与判断题混合出题，交卷后逐题复盘，错题可以直接回到画布继续深挖。
            </p>
            <div className="mt-8 space-y-4">
              {[
                { n: '01', title: '说出想练的主题', desc: '自然语言即可，入门 / 进阶 / 困难三档难度，题量 3/5/10 可选。' },
                { n: '02', title: '逐题作答，交卷判分', desc: '服务端判卷，交卷后才下发标准答案与解析；秒答会被单独标记。' },
                { n: '03', title: '看掌握情况，回看详情', desc: '掌握 X/Y、只看错题、知识点与总用时；历史详情可随时回看或继续未完成记录。' },
              ].map((s) => (
                <div key={s.n} className="flex gap-3">
                  <span className="text-xxs font-mono font-bold text-emerald-400 pt-0.5 shrink-0">{s.n}</span>
                  <div>
                    <p className="text-sm font-semibold text-white">{s.title}</p>
                    <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{s.desc}</p>
                  </div>
                </div>
              ))}
            </div>
            {onEnterPractice && (
              <button
                onClick={() => onEnterPractice()}
                className="mt-7 inline-flex items-center gap-2 px-5 py-3 rounded-xl text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 shadow-lg shadow-emerald-950/40 transition cursor-pointer"
              >
                免费练一组 <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div className="relative">
            <div className="absolute -inset-6 bg-gradient-to-tr from-emerald-500/10 via-purple-500/10 to-transparent blur-3xl rounded-full" />
            <div className="relative space-y-3">
              <PracticeMock />
              <div className="rounded-2xl border border-white/[0.1] bg-[#0a1020] p-4 shadow-2xl shadow-black/30">
                <div className="flex items-center justify-between pb-2.5 border-b border-white/[0.07]">
                  <div className="flex items-center gap-2 text-xs font-semibold text-white">
                    <History className="w-3.5 h-3.5 text-emerald-400" /> 练习记录
                  </div>
                  <span className="text-xxs text-slate-500">共 12 次</span>
                </div>
                <div className="mt-2 space-y-1.5">
                  {[
                    { topic: '注意力机制', meta: '进阶 · 掌握 4/5', time: '今天 14:20', ok: true },
                    { topic: 'TCP 三次握手', meta: '入门 · 掌握 5/5', time: '昨天 21:05', ok: true },
                    { topic: '光合作用光反应', meta: '困难 · 未完成', time: '10 月 24 日', ok: false },
                  ].map((r) => (
                    <div key={r.topic} className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-white/[0.02] border border-white/[0.05]">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${r.ok ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                      <div className="min-w-0 flex-1">
                        <p className="text-xxs font-medium text-slate-200 truncate">{r.topic}</p>
                        <p className="text-[10px] text-slate-500">{r.meta} · {r.time}</p>
                      </div>
                      <Eye className="w-3.5 h-3.5 text-slate-500" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Canvas showcase */}
      <section className="relative z-10 py-20 px-6 max-w-7xl mx-auto">
        <div className="rounded-3xl border border-white/[0.08] bg-white/[0.02] p-6 sm:p-10">
          <div className="grid lg:grid-cols-[0.85fr_1.15fr] gap-10 items-center">
            <div>
              <SectionLabel icon={<GitBranch className="w-3.5 h-3.5" />}>思维画布 · 展开推演</SectionLabel>
              <h2 className="text-3xl sm:text-4xl font-bold text-white tracking-tight">一张画布，装下所有平行思路</h2>
              <p className="mt-3 text-sm text-slate-400 leading-relaxed">
                每个提问与回答都是节点。你可以在同一个主题下同时推进多条分支，划词追问、联网溯源、插入便签，最后导出结构化研报。
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                {['划词衍生', '递归深挖', '来源角标', '自动排版', 'Markdown 导出'].map((t) => (
                  <span key={t} className="text-xxs px-2 py-1 rounded-lg bg-white/[0.04] border border-white/[0.07] text-slate-400">{t}</span>
                ))}
              </div>
              <button onClick={() => onEnterCanvas()} className="mt-6 inline-flex items-center gap-1.5 text-xs font-semibold text-blue-300 hover:text-blue-200 transition cursor-pointer">
                打开完整画布 <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2 rounded-2xl border border-blue-500/25 bg-[#0a1020] p-4">
                <p className="text-xxs text-blue-300 mb-1 flex items-center gap-1"><Globe className="w-3 h-3" /> 实时联网 · 来源可追溯</p>
                <p className="text-sm font-semibold text-white">缩放点积注意力为什么要除以 √d_k？</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.05] text-slate-400">[1] Attention Is All You Need</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.05] text-slate-400">[2] 官方文档</span>
                </div>
              </div>
              <div className="rounded-2xl border border-indigo-500/25 bg-[#0a1020] p-4">
                <p className="text-xxs text-indigo-300 mb-1">子分支 · 方差分析</p>
                <p className="text-xs font-semibold text-white">点积方差随维度线性增长 → softmax 饱和</p>
                <div className="mt-2 h-1.5 w-5/6 rounded bg-white/[0.06]" />
                <div className="mt-1.5 h-1.5 w-3/5 rounded bg-white/[0.06]" />
              </div>
              <div className="rounded-2xl border border-amber-500/25 bg-[#0a1020] p-4">
                <p className="text-xxs text-amber-300 mb-1">研究便签</p>
                <p className="text-xs text-slate-300 leading-relaxed">待验证：温度系数是否也会影响注意力分布的峰值？</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="relative z-10 py-20 px-6 max-w-7xl mx-auto">
        <div className="text-center mb-12">
          <SectionLabel icon={<Layers className="w-3.5 h-3.5" />}>核心能力</SectionLabel>
          <h2 className="text-3xl sm:text-5xl font-bold text-white tracking-tight">思考与练习，共用一套认知底座</h2>
          <p className="mt-4 text-slate-400 text-sm sm:text-base max-w-2xl mx-auto">不是把聊天框换个皮，而是围绕「展开 → 溯源 → 验证 → 巩固」重新设计学习路径。</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {LANDING_HIGHLIGHTS.map((item, idx) => {
            const Icon = FEATURE_ICONS[idx] ?? Layers;
            return (
              <div key={item.label} className="rounded-3xl p-6 bg-gradient-to-b from-white/[0.05] to-white/[0.015] border border-white/[0.08] hover:border-white/[0.18] transition-all group">
                <div className="w-11 h-11 rounded-2xl bg-white/[0.05] border border-white/[0.08] flex items-center justify-center text-blue-300 mb-4 group-hover:scale-105 transition-transform">
                  <Icon className="w-5 h-5" />
                </div>
                <h3 className="text-base font-bold text-white mb-1">{item.label}</h3>
                <p className="text-xxs text-blue-300/80 mb-2">{item.sub}</p>
                <p className="text-xs text-slate-400 leading-relaxed">{FEATURE_DESCS[idx]}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Comparison */}
      <section id="comparison" className="relative z-10 py-20 px-6 max-w-6xl mx-auto">
        <div className="text-center mb-12">
          <SectionLabel icon={<Workflow className="w-3.5 h-3.5" />}>学习路径对比</SectionLabel>
          <h2 className="text-3xl sm:text-5xl font-bold text-white tracking-tight">从「问过」到「会了」</h2>
        </div>
        <div className="overflow-hidden rounded-3xl border border-white/[0.08]">
          <div className="grid grid-cols-[1.1fr_1fr_1fr] bg-white/[0.04] text-xs font-semibold text-slate-300">
            <div className="p-4">学习环节</div>
            <div className="p-4 border-l border-white/[0.06]">单线对话</div>
            <div className="p-4 border-l border-white/[0.06] text-emerald-300">枝想工作台</div>
          </div>
          {[
            ['展开思路', '一条线往下聊，早期假设被顶出屏幕', '无限画布，多条分支并行推演'],
            ['深入某个概念', '复制一段话重新开一个会话', '划词直接长出新分支，继承上下文'],
            ['确认是否掌握', '只能靠自我感觉', 'AI 出题 → 交卷 → 掌握情况与错题解析'],
            ['回看与复盘', '翻聊天记录，答案难定位', '练习详情：选项全文、知识点、只看错题'],
          ].map(([label, oldWay, newWay]) => (
            <div key={label} className="grid grid-cols-[1.1fr_1fr_1fr] text-xs border-t border-white/[0.06]">
              <div className="p-4 text-slate-400 font-medium">{label}</div>
              <div className="p-4 border-l border-white/[0.06] text-slate-500 flex items-start gap-2"><XCircle className="w-3.5 h-3.5 text-rose-500/70 mt-0.5 shrink-0" />{oldWay}</div>
              <div className="p-4 border-l border-white/[0.06] text-slate-200 flex items-start gap-2 bg-emerald-500/[0.03]"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" />{newWay}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Scenarios */}
      <section id="scenarios" className="relative z-10 py-20 px-6 max-w-7xl mx-auto">
        <div className="text-center mb-12">
          <SectionLabel icon={<Compass className="w-3.5 h-3.5" />}>探索场景</SectionLabel>
          <h2 className="text-3xl sm:text-5xl font-bold text-white tracking-tight">从一个真问题开始</h2>
          <p className="mt-4 text-slate-400 text-sm sm:text-base max-w-2xl mx-auto">选择一个场景，先展开思路，再用练习检验自己是否真的掌握。</p>
        </div>
        <div className="grid lg:grid-cols-[0.9fr_1.1fr] gap-6">
          <div className="space-y-2.5">
            {LANDING_SCENARIOS.map((s, idx) => {
              const Icon = SCENARIO_ICONS[s.icon];
              const active = activeScenario === idx;
              return (
                <button
                  key={s.title}
                  onClick={() => setActiveScenario(idx)}
                  className={`w-full text-left p-4 rounded-2xl border transition-all cursor-pointer ${
                    active ? 'bg-white/[0.07] border-blue-500/35' : 'bg-white/[0.02] border-white/[0.06] hover:border-white/[0.13]'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <span className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${active ? 'bg-blue-500/20 text-blue-300' : 'bg-white/[0.04] text-slate-400'}`}>
                      <Icon className="w-4 h-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-white">{s.title}</p>
                      <p className="text-xs text-slate-500 mt-1 leading-relaxed line-clamp-2">{s.desc}</p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="rounded-3xl border border-white/[0.08] bg-white/[0.02] p-6 flex flex-col">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xxs px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-300 border border-blue-500/25">
                场景 {String(activeScenario + 1).padStart(2, '0')}
              </span>
              <span className="text-xs text-slate-500">推荐起点</span>
            </div>
            <h3 className="text-xl font-bold text-white">{LANDING_SCENARIOS[activeScenario].title}</h3>
            <p className="mt-3 text-sm text-slate-400 leading-relaxed flex-1">{LANDING_SCENARIOS[activeScenario].desc}</p>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {LANDING_SCENARIOS[activeScenario].tags.map((tag) => (
                <span key={tag} className="text-xxs px-2 py-1 rounded-lg bg-white/[0.04] border border-white/[0.06] text-slate-400">{tag}</span>
              ))}
            </div>
            <div className="mt-5 p-3 rounded-xl bg-[#080d19] border border-white/[0.06]">
              <p className="text-xxs text-slate-500 mb-1">可以这样开始</p>
              <p className="text-xs text-slate-200">{LANDING_SCENARIOS[activeScenario].sampleTopic}</p>
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              <button
                onClick={() => onEnterCanvas(LANDING_SCENARIOS[activeScenario].sampleTopic)}
                className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition cursor-pointer"
              >
                用这个主题开画布
              </button>
              <button
                onClick={() => {
                  setSampleIndex(SCENARIO_SAMPLE_INDEX[activeScenario] ?? 0);
                  setSampleViewerOpen(true);
                }}
                className="px-4 py-2 rounded-xl bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.1] text-slate-300 text-xs font-medium transition cursor-pointer"
              >
                查看示例画布
              </button>
              {onEnterPractice && (
                <button
                  onClick={() => onEnterPractice(LANDING_SCENARIOS[activeScenario].sampleTopic)}
                  className="px-4 py-2 rounded-xl bg-purple-600/90 hover:bg-purple-500 text-white text-xs font-semibold transition cursor-pointer"
                >
                  用这个主题练习
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="relative z-10 py-20 px-6 max-w-4xl mx-auto">
        <div className="text-center mb-10">
          <SectionLabel icon={<HelpCircle className="w-3.5 h-3.5" />}>常见疑问</SectionLabel>
          <h2 className="text-3xl sm:text-4xl font-bold text-white tracking-tight">开始之前，你可能想知道</h2>
        </div>
        <div className="space-y-2.5">
          {LANDING_FAQS.map((faq, idx) => {
            const open = openFaq === idx;
            return (
              <div key={faq.q} className="rounded-2xl border border-white/[0.07] bg-white/[0.02] overflow-hidden">
                <button
                  onClick={() => setOpenFaq(open ? null : idx)}
                  className="w-full flex items-center justify-between gap-4 p-4 text-left cursor-pointer"
                >
                  <span className="text-sm font-semibold text-slate-200">{faq.q}</span>
                  <ChevronRight className={`w-4 h-4 text-slate-500 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
                </button>
                {open && <p className="px-4 pb-4 text-xs text-slate-400 leading-relaxed">{faq.a}</p>}
              </div>
            );
          })}
        </div>
      </section>

      {/* CTA */}
      <section className="relative z-10 py-20 px-6 max-w-6xl mx-auto">
        <div className="relative overflow-hidden rounded-[32px] border border-white/[0.1] bg-gradient-to-br from-blue-600/15 via-indigo-600/10 to-emerald-500/10 p-8 sm:p-14 text-center">
          <div className="absolute -top-24 left-1/2 -translate-x-1/2 w-[500px] h-[260px] bg-blue-500/20 blur-[100px] rounded-full" />
          <div className="relative">
            <SectionLabel icon={<Sparkles className="w-3.5 h-3.5" />}>现在开始</SectionLabel>
            <h2 className="text-3xl sm:text-5xl font-extrabold text-white tracking-tight">把今天的思考，变成明天还会的</h2>
            <p className="mt-4 text-sm text-slate-300 max-w-xl mx-auto">免费注册即可使用思维画布与 AI 练习。先从一个问题开始，再用一套题确认自己真的会了。</p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <button onClick={() => onEnterCanvas()} className="px-6 py-3.5 rounded-2xl bg-white text-slate-900 font-bold text-sm hover:bg-slate-100 transition cursor-pointer flex items-center gap-2">
                <Compass className="w-4 h-4" /> 免费开始思考
              </button>
              {onEnterPractice && (
                <button onClick={() => onEnterPractice()} className="px-6 py-3.5 rounded-2xl bg-purple-600 hover:bg-purple-500 text-white font-bold text-sm transition cursor-pointer flex items-center gap-2">
                  <Brain className="w-4 h-4" /> 免费练一组
                </button>
              )}
            </div>
            <p className="mt-4 text-xxs text-slate-500">无需信用卡 · 邮箱注册即用</p>
          </div>
        </div>
      </section>

      <footer className="relative z-10 border-t border-white/[0.06] px-6 py-8">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3 text-xxs text-slate-500">
          <div className="flex items-center gap-2">
            <Compass className="w-4 h-4 text-blue-400" />
            <span>枝想 Arborize · 无限画布式 AI 深度思考与主动练习工作台</span>
          </div>
          <div className="flex items-center gap-4">
            <a href="#products" className="hover:text-slate-300 transition-colors">产品</a>
            <a href="#faq" className="hover:text-slate-300 transition-colors">常见疑问</a>
            <a href="/" className="hover:text-slate-300 transition-colors">© {new Date().getFullYear()} 枝想</a>
          </div>
        </div>
      </footer>

      {sampleViewerOpen && (
        <SampleBoardViewer initialIndex={sampleIndex} onClose={() => setSampleViewerOpen(false)} />
      )}
    </div>
  );
};
