/**
 * Spec R1 — AI 练习面板（画布外独立功能，挂在画板库弹窗的「练习」tab 内）。
 *
 * 形态理由（Spec §4.5）：出题→点选→判卷是**线性快速流程**，画布的祖先上下文注入、
 * 子树切分、拓扑布局对这四件事一件都帮不上，硬压进画布是滥用。
 *
 * ⚠️ 面向用户文案纪律（CODEBUDDY.md 品牌与文案）：不出现「多 Agent」「审核」「难度标签」
 * 「自审」等内部术语；统计一律说「掌握情况」不说「正确率」（把产品从深度探索拉向刷题 App）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Brain, Loader2, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import * as quizStore from '../../lib/quiz-store';
import { scopeKeyFor } from '../../lib/board-scope';
import type { QuizAttemptView, QuizDifficulty, QuizGradeResult, QuizSubmission } from '../../lib/quiz-store';

const DIFFICULTY_LABELS: Record<QuizDifficulty, string> = {
  beginner: '入门',
  intermediate: '进阶',
  advanced: '困难',
};

/** 困难档题量默认 3（难度与题量**不强制绑定**，选择器始终可改） */
const DEFAULT_COUNT: Record<QuizDifficulty, number> = {
  beginner: 5,
  intermediate: 5,
  advanced: 3,
};

interface QuizPanelProps {
  userId: string | null;
}

type Phase =
  | { kind: 'form' }
  | { kind: 'loading' }
  | { kind: 'answering'; attempt: QuizAttemptView; startedAt: number }
  | { kind: 'graded'; attempt: QuizAttemptView; results: QuizGradeResult[]; summary: { correct: number; total: number } }
  | { kind: 'error'; message: string };

export const QuizPanel: React.FC<QuizPanelProps> = ({ userId }) => {
  const [topic, setTopic] = useState('');
  const [difficulty, setDifficulty] = useState<QuizDifficulty>('beginner');
  const [count, setCount] = useState(5);
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const [choices, setChoices] = useState<Record<string, string>>({});
  const historyView = useSyncExternalStore(quizStore.subscribe, quizStore.getHistoryView);
  const startRef = useRef<Record<string, number>>({});
  /** pickChoice 用 useCallback([]) 固化了引用，需 ref 读最新 phase 才能存对 attemptId */
  const phaseRef = useRef<Phase>(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // 切换账号即重置练习视图（避免跨账号看到他人记录）
  useEffect(() => {
    if (userId) {
      quizStore.bindScope(scopeKeyFor(userId));
    } else {
      quizStore.reset();
    }
    setPhase({ kind: 'form' });
    setChoices({});
  }, [userId]);

  useEffect(() => {
    if (phase.kind === 'form') void quizStore.refreshHistory();
  }, [phase.kind]);

  const handleGenerate = useCallback(async () => {
    if (!topic.trim()) return;
    setPhase({ kind: 'loading' });
    const outcome = await quizStore.generateQuiz({ topic: topic.trim(), difficulty, count });
    // ⚠️ 本仓 tsconfig 未开 strict，TS 不做判别式联合的收窄，故显式取字段而非依赖 `!outcome.ok` 后的类型收窄
    if (!outcome.ok) {
      setPhase({ kind: 'error', message: (outcome as { error?: string }).error || '出题失败，请稍后重试' });
      return;
    }
    const attempt = (outcome as { data: QuizAttemptView }).data;
    // 恢复未提交草稿（切面板/刷新不丢）；草稿存的是 {questionId: {choice, elapsedMs}}，此处只取 choice
    const draft = quizStore.loadDraft(attempt.attemptId);
    const restored: Record<string, string> = {};
    for (const [qid, sub] of Object.entries(draft)) {
      if (sub && typeof sub.choice === 'string') restored[qid] = sub.choice;
    }
    setChoices(restored);
    startRef.current = {};
    setPhase({ kind: 'answering', attempt, startedAt: Date.now() });
  }, [topic, difficulty, count]);

  const handleSubmit = useCallback(async () => {
    if (phase.kind !== 'answering') return;
    const { attempt } = phase;
    const now = Date.now();
    // 每题用时 = 本题首答时刻 −（上一题首答时刻；本题为第一题时用开卷时刻）。
    // ⚠️ 不能用「提交时刻 − 开卷时刻」再均分：那样每题都等于总时长，
    // 判断题的 low_confidence（3s）就永远判不出秒答，标记形同虚设。
    // 未作答的题（理论上不可能——提交按钮要求全部作答）按总时长兜底。
    const stamps = attempt.questions
      .map((q) => startRef.current[q.id])
      .filter((v): v is number => typeof v === 'number')
      .sort((a, b) => a - b);
    const byQuestion = new Map<string, number>();
    for (let i = 0; i < attempt.questions.length; i++) {
      const q = attempt.questions[i];
      const stamp = startRef.current[q.id];
      if (typeof stamp !== 'number') {
        byQuestion.set(q.id, now - phase.startedAt);
        continue;
      }
      // 找到该题之前最近的一次作答时刻
      let prev = phase.startedAt;
      for (const s of stamps) {
        if (s < stamp) prev = s;
      }
      byQuestion.set(q.id, stamp - prev);
    }
    const answers: QuizSubmission[] = attempt.questions.map((q) => ({
      questionId: q.id,
      choice: choices[q.id] ?? '',
      elapsedMs: Math.max(100, byQuestion.get(q.id) ?? 1000),
    }));
    const outcome = await quizStore.submitAnswers(attempt.attemptId, answers);
    if (!outcome.ok) {
      setPhase({ kind: 'error', message: (outcome as { error?: string }).error || '提交失败，请稍后重试' });
      return;
    }
    const graded = outcome as { results: QuizGradeResult[]; summary: { correct: number; total: number } };
    quizStore.clearDraft(attempt.attemptId);
    setPhase({
      kind: 'graded',
      attempt,
      results: graded.results,
      summary: { correct: graded.summary.correct, total: graded.summary.total },
    });
  }, [phase, choices]);

  const pickChoice = useCallback((questionId: string, choice: string) => {
    if (!startRef.current[questionId]) startRef.current[questionId] = Date.now();
    setChoices((prev) => {
      const next = { ...prev, [questionId]: choice };
      // 草稿即时落盘（切面板/刷新不丢，照 chat-draft 先例；提交成功后 clearDraft）
      if (phaseRef.current?.kind === 'answering') {
        quizStore.saveDraft(phaseRef.current.attempt.attemptId, {
          ...Object.fromEntries(Object.entries(next).map(([qid, c]) => [
            qid, { questionId: qid, choice: c, elapsedMs: 0 },
          ])),
        });
      }
      return next;
    });
  }, []);

  const answeredCount = useMemo(
    () => (phase.kind === 'answering' ? phase.attempt.questions.filter((q) => choices[q.id]).length : 0),
    [phase, choices],
  );

  return (
    <div className="flex flex-col gap-5 p-5" data-testid="quiz-panel">
      {phase.kind === 'form' && (
        <FormView
          topic={topic}
          difficulty={difficulty}
          count={count}
          onTopicChange={setTopic}
          onDifficultyChange={(d) => { setDifficulty(d); setCount(DEFAULT_COUNT[d]); }}
          onCountChange={setCount}
          onSubmit={handleGenerate}
          history={historyView}
        />
      )}

      {phase.kind === 'loading' && (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-stone-500">
          <Loader2 className="w-6 h-6 animate-spin" />
          <p className="text-sm">正在按你的主题出题，请稍候…</p>
          <p className="text-xs text-stone-400">生成并核对题目通常需要几秒钟</p>
        </div>
      )}

      {phase.kind === 'error' && (
        <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
          <AlertTriangle className="w-6 h-6 text-amber-500" />
          <p className="text-sm text-stone-700">{phase.message}</p>
          <button
            type="button"
            onClick={() => setPhase({ kind: 'form' })}
            className="mt-2 px-4 py-2 text-sm border border-stone-300 rounded-lg hover:bg-stone-50"
          >
            返回重新开始
          </button>
        </div>
      )}

      {phase.kind === 'answering' && (
        <AnsweringView
          attempt={phase.attempt}
          choices={choices}
          answeredCount={answeredCount}
          onPick={pickChoice}
          onSubmit={handleSubmit}
          onBack={() => setPhase({ kind: 'form' })}
        />
      )}

      {phase.kind === 'graded' && (
        <GradedView
          results={phase.results}
          correct={phase.summary.correct}
          total={phase.summary.total}
          onRestart={() => { setPhase({ kind: 'form' }); setTopic(''); setChoices({}); }}
        />
      )}
    </div>
  );
};

// ─────────────────────────── 子视图 ───────────────────────────

const FormView: React.FC<{
  topic: string;
  difficulty: QuizDifficulty;
  count: number;
  onTopicChange: (v: string) => void;
  onDifficultyChange: (d: QuizDifficulty) => void;
  onCountChange: (n: number) => void;
  onSubmit: () => void;
  history: quizStore.QuizHistoryView;
}> = ({ topic, difficulty, count, onTopicChange, onDifficultyChange, onCountChange, onSubmit, history }) => (
  <div className="flex flex-col gap-5">
    <div className="flex flex-col gap-2">
      <p className="text-sm text-stone-600">
        写下一个你想巩固的主题，我们会据此出几道题。
      </p>
      <input
        type="text"
        value={topic}
        maxLength={200}
        onChange={(e) => onTopicChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && topic.trim()) onSubmit(); }}
        placeholder="例如：注意力机制 / 高中生物光合作用"
        className="px-3 py-2.5 border border-stone-300 rounded-lg outline-none focus:border-stone-500"
        data-testid="quiz-topic-input"
      />
      <div className="flex flex-wrap items-center gap-2">
        {(Object.keys(DIFFICULTY_LABELS) as QuizDifficulty[]).map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => onDifficultyChange(d)}
            className={`px-3 py-1.5 text-sm rounded-lg border ${
              difficulty === d
                ? 'border-stone-900 bg-stone-900 text-white'
                : 'border-stone-300 text-stone-600 hover:bg-stone-50'
            }`}
          >
            {DIFFICULTY_LABELS[d]}
          </button>
        ))}
        <span className="text-stone-300">·</span>
        {[3, 5, 10].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onCountChange(n)}
            className={`px-2.5 py-1.5 text-sm rounded-lg border ${
              count === n ? 'border-stone-900 text-stone-900' : 'border-stone-300 text-stone-500 hover:bg-stone-50'
            }`}
          >
            {n} 题
          </button>
        ))}
      </div>
      <button
        type="button"
        disabled={!topic.trim()}
        onClick={onSubmit}
        className="mt-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-stone-900 text-white rounded-lg disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Brain className="w-4 h-4" />
        开始练习
      </button>
    </div>

    {history.items.length > 0 && (
      <div className="flex flex-col gap-2 pt-4 border-t border-stone-200">
        <p className="text-xs text-stone-500">往期练习</p>
        {history.items.slice(0, 8).map((h) => (
          <div key={h.attemptId} className="flex items-center justify-between text-sm">
            <span className="text-stone-700 truncate">{h.topic}</span>
            <span className="text-xs text-stone-500 shrink-0 ml-3">
              {DIFFICULTY_LABELS[h.difficulty]}
              {h.correctCount !== null && ` · 掌握 ${h.correctCount}/${h.total}`}
            </span>
          </div>
        ))}
      </div>
    )}
  </div>
);

const AnsweringView: React.FC<{
  attempt: QuizAttemptView;
  choices: Record<string, string>;
  answeredCount: number;
  onPick: (qid: string, choice: string) => void;
  onSubmit: () => void;
  onBack: () => void;
}> = ({ attempt, choices, answeredCount, onPick, onSubmit, onBack }) => (
  <div className="flex flex-col gap-5">
    <div className="flex items-center justify-between">
      <p className="text-sm text-stone-600">已作答 {answeredCount}/{attempt.questions.length}</p>
      <button type="button" onClick={onBack} className="text-xs text-stone-500 hover:text-stone-700">放弃本次</button>
    </div>

    {attempt.questions.map((q, i) => (
      <div key={q.id} className="flex flex-col gap-2">
        <p className="text-sm text-stone-800">
          <span className="text-stone-400 mr-1.5">{i + 1}.</span>
          {q.stem}
        </p>
        {q.type === 'single' && q.options ? (
          <div className="flex flex-col gap-1.5">
            {q.options.map((o) => (
              <button
                key={o.label}
                type="button"
                onClick={() => onPick(q.id, o.label)}
                className={`flex items-start gap-2 px-3 py-2 text-left text-sm rounded-lg border ${
                  choices[q.id] === o.label
                    ? 'border-stone-900 bg-stone-900 text-white'
                    : 'border-stone-200 text-stone-700 hover:bg-stone-50'
                }`}
              >
                <span className="font-medium shrink-0">{o.label}</span>
                <span>{o.text}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="flex gap-2">
            {[['true', '正确'], ['false', '错误']].map(([val, label]) => (
              <button
                key={val}
                type="button"
                onClick={() => onPick(q.id, val)}
                className={`px-4 py-2 text-sm rounded-lg border ${
                  choices[q.id] === val
                    ? 'border-stone-900 bg-stone-900 text-white'
                    : 'border-stone-200 text-stone-700 hover:bg-stone-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
    ))}

    <button
      type="button"
      disabled={answeredCount < attempt.questions.length}
      onClick={onSubmit}
      className="px-4 py-2.5 bg-stone-900 text-white rounded-lg disabled:opacity-40 disabled:cursor-not-allowed"
    >
      提交作答
    </button>
  </div>
);

const GradedView: React.FC<{
  results: QuizGradeResult[];
  correct: number;
  total: number;
  onRestart: () => void;
}> = ({ results, correct, total, onRestart }) => {
  // 低置信单列：判断题秒答不混入「已掌握」（Spec §6.1）
  const lowConfidenceCount = results.filter((r) => r.lowConfidence).length;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <p className="text-2xl font-light">掌握 {correct}/{total}</p>
        {lowConfidenceCount > 0 && (
          <p className="text-xs text-stone-500">
            其中 {lowConfidenceCount} 题作答很快，可能只是猜的，先不计入掌握
          </p>
        )}
      </div>

      <div className="flex flex-col gap-4">
        {results.map((r, i) => (
          <div key={r.questionId} className="flex flex-col gap-1.5">
            <p className="text-sm text-stone-800">
              <span className="text-stone-400 mr-1.5">{i + 1}.</span>
              {r.stem}
            </p>
            <div className="flex items-center gap-2 text-sm">
              {r.isCorrect
                ? <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                : <XCircle className="w-4 h-4 text-rose-500 shrink-0" />}
              <span className={r.isCorrect ? 'text-emerald-700' : 'text-rose-600'}>
                你的作答{r.type === 'single' ? ` ${r.answer === 'true' || r.answer === 'false' ? '' : r.answer}` : ''}
              </span>
              {!r.isCorrect && (
                <span className="text-stone-600">正确答案 {r.type === 'single' ? r.answer : r.answer === 'true' ? '正确' : '错误'}</span>
              )}
            </div>
            <p className="text-xs text-stone-500 pl-6">{r.explanation}</p>
            {r.lowConfidence && (
              <p className="text-xs text-amber-600 pl-6">这题答得很快，可能是猜的</p>
            )}
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={onRestart}
        className="px-4 py-2.5 border border-stone-300 rounded-lg hover:bg-stone-50"
      >
        再来一组
      </button>
    </div>
  );
};
