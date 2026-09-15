/**
 * 产品文案与 SEO 元数据的唯一事实源。
 *
 * 为什么放在顶层 `shared/`（而不是 `src/lib/` 或 `server/lib/`）：
 * 这份内容同时被前端落地页（`src/components/landing/LandingPage.tsx`）与服务端
 * SEO 注入层（`server/lib/seo.ts`）消费，而 `.dependency-cruiser.cjs` 明令禁止
 * `server/ → src/` 与 `src/ → server/` 双向 import。放在两边都不是的顶层目录，
 * 才能让「页面可见文案」与「结构化数据 / 无 JS 静态回退块」出自同一份字符串——
 * 一旦三者漂移，同一个 URL 对会执行 JS 的爬虫与不执行 JS 的爬虫就会呈现不同内容，
 * 那是搜索引擎定义下的 cloaking。
 *
 * 纪律：
 * - 本文件是纯数据，**不 import 任何模块**（尤其是 lucide-react 这类前端依赖，
 *   否则服务端 bundle 会被拖进 React 生态）。图标只以字符串键出现，映射留在前端。
 * - 只放**文字**，不放 Tailwind 类名——类名一旦离开 JSX，Tailwind v4 的扫描与
 *   裁剪行为就不再直观，容易出现「本地好看、构建后缺样式」。
 */

export const BRAND = {
  name: '枝想',
  latin: 'Arborize',
  /** 对外一句话定位（页脚 / 结构化数据共用） */
  tagline: '无限画布式 AI 深度思考与分支探索工作台',
} as const;

/** H1 拆成两段：lead 承载主关键词，accent 保留视觉上的渐变色行 */
export const LANDING_H1 = {
  lead: 'AI 深度思考，不该被困在单线对话里',
  accent: '在无限画布上，推演你的多维认知星图',
} as const;

/**
 * snippet 优化的一段式定义：首句即给答案（「是什么」），不铺垫。
 * 同时用于落地页副标题与服务端静态回退块。
 */
export const LANDING_LEAD =
  '枝想（Arborize）是一款无限画布式的 AI 深度思考工具。它把传统的单线对话改成可自由分叉的思维拓扑：每个提问与解答都是画布上的一个节点，你可以同时推演多条平行思路，划词追问、递归深挖，并一键导出结构化研报。';

export interface LandingHighlight {
  label: string;
  sub: string;
}

/** 核心能力条：落地页 bento 条与 JSON-LD 的 featureList 共用 */
export const LANDING_HIGHLIGHTS: readonly LandingHighlight[] = [
  { label: '2D 无限画布', sub: '自由平移与空间记忆' },
  { label: '数学公式排版', sub: 'LaTeX 行内与块级推导' },
  { label: '划词递归裂变', sub: '任意词句瞬时衍生' },
  { label: '前沿大模型', sub: '极速推理与深度推演' },
  { label: '实时联网检索', sub: '权威来源引证溯源' },
  { label: '深夜护眼模式', sub: '沉浸式专注研究' },
];

/** 图标以字符串键表示，前端映射为具体图标组件 */
export type ScenarioIconKey = 'book' | 'code' | 'trend' | 'workflow';

export interface LandingScenario {
  icon: ScenarioIconKey;
  title: string;
  desc: string;
  tags: readonly string[];
  sampleTopic: string;
}

export const LANDING_SCENARIOS: readonly LandingScenario[] = [
  {
    icon: 'book',
    title: '学术科研与深度理论推演',
    desc: '拆解复杂前沿论文，对抽象定理、数学公式逐步下钻，在同一张画布上构建完整知识体系。',
    tags: ['arXiv论文精读', '论文公式推导', '多理论交叉对比'],
    sampleTopic: '什么是无穷？——希尔伯特旅馆与康托尔的集合论',
  },
  {
    icon: 'code',
    title: '系统架构设计与技术权衡',
    desc: '推演微服务拆解、分布式事务一致性与高并发容灾方案，在不同分支上权衡架构优劣。',
    tags: ['分布式容灾', '高并发架构', '性能与一致性权衡'],
    sampleTopic: '什么是 AI Agent？——从聊天机器人到自主智能体',
  },
  {
    icon: 'trend',
    title: '商业战略分析与投资尽调',
    desc: '围绕行业大盘、竞争壁垒、供应链与财务模型多线并发深挖，生成结构严密的尽调大纲。',
    tags: ['产业链拆解', '商业壁垒推演', '研报大纲导出'],
    sampleTopic: '钻石为什么这么贵？——稀缺、垄断与营销的经济学',
  },
  {
    icon: 'workflow',
    title: '高阶复杂学习与心智模型',
    desc: '告别碎片化问答，通过“提问 - 批判 - 验证 - 衍生”的螺旋闭环，建立属于你的认知星图。',
    tags: ['心智模型', '非线性思维', '双轨便签记录'],
    sampleTopic: '费曼学习法为什么有效？——教是最好的学',
  },
];

export interface LandingFaq {
  q: string;
  a: string;
}

/** 与 FAQPage 结构化数据严格同源：改了这里，页面与 schema 同时改 */
export const LANDING_FAQS: readonly LandingFaq[] = [
  {
    q: '为什么需要无限画布，而不是传统的单聊对话框？',
    a: '传统的聊天机器人采用垂直流式单窗口，当探讨进入第 5 轮提问时，早期的核心假设已被长文顶出屏幕，容易发生上下文漂移或遗忘。枝想采用无限 2D 画布，每一个问题和解答都是可自由展开的思维节点。你可以同时探讨 5 个平行子分支，所有思考脉络一览无余。',
  },
  {
    q: '我的研究数据和画板内容安全吗？',
    a: '请放心。枝想将您的画布、节点、连线与便签完整保存在您的专属账号中，更换浏览器或设备登录后内容依然如初，数据严格隔离、仅您本人可见。您也可以随时一键导出标准 JSON 备份或 Markdown 研报大纲，成果永远由您带走。',
  },
  {
    q: '“划词追问”功能是如何工作的？',
    a: '在阅读任何卡片的 AI 解答时，只需用鼠标划选感兴趣的一段文字、专有名词或公式，系统会自动浮出探索胶囊。点击即可自动继承当前卡片的上下文背景，在旁边衍生出一个专属的子议题卡片继续深挖。',
  },
  {
    q: '支持哪些数学公式与代码格式？',
    a: '完美渲染学术级数学公式：行内公式（$E=mc^2$）与独立块级矩阵积分公式（$$...$$）均可正确排版；代码块支持整洁排版与一键复制，语法高亮能力正在加紧开发中，敬请期待。',
  },
];

/** 首屏「推荐探索课题」快捷入口 */
export const LANDING_TOPICS: readonly string[] = [
  '什么是 AI Agent？与聊天机器人有何不同',
  '特修斯之船：换了所有零件的船还是原船吗',
  '自由意志存在吗？——决定论与相容论',
  '缸中之脑：我们如何确知世界是真实的',
];

export type SeoRouteKey =
  | 'home'
  | 'reset-password'
  | 'verify-email'
  | 'share'
  | 'not-found';

export interface SeoRouteMeta {
  /** 标题控制在 30 个汉字内，主关键词前置 */
  title: string;
  /** 描述控制在 150-160 半角宽度（约 75-80 汉字） */
  description: string;
  robots: string;
}

/**
 * 路由级 meta 表。
 *
 * 收录策略：只有落地页 `/` 可被收录；工具页（重置密码/验证邮箱）与用户快照分享页
 * 一律 noindex——分享码虽然随机不可枚举，但快照里是用户的个人思考内容，
 * 进 SERP 的隐私风险大于长尾收益（`docs/产品问题跟踪清单.md` B1 的「SEO 长尾」设想
 * 因此暂缓，如需开启只需改这里的 robots 并补一条服务端读取快照标题的路径）。
 */
export const SEO_ROUTES: Record<SeoRouteKey, SeoRouteMeta> = {
  home: {
    title: '枝想 Arborize｜AI 深度思考画布，非线性对话与分支推演',
    description:
      '枝想 Arborize 是一款无限画布式 AI 深度思考工具：把单线对话变成可分叉的思维拓扑。支持划词追问、递归深挖、公式排版与联网来源溯源，一键导出 Markdown 研报。',
    robots: 'index, follow, max-image-preview:large',
  },
  'reset-password': {
    title: '重置密码 · 枝想 Arborize',
    description: '通过邮件链接重置枝想账号密码。',
    robots: 'noindex, nofollow',
  },
  'verify-email': {
    title: '邮箱验证 · 枝想 Arborize',
    description: '完成枝想账号的邮箱验证。',
    robots: 'noindex, nofollow',
  },
  share: {
    title: '画板分享 · 枝想 Arborize',
    description: '枝想公开分享的 AI 思维画板（只读快照）。',
    robots: 'noindex, follow',
  },
  'not-found': {
    title: '页面不存在 · 枝想 Arborize',
    description: '您访问的页面不存在。',
    robots: 'noindex, nofollow',
  },
};

/** 站点图标（favicon / apple-touch-icon；实测 512×520） */
export const SITE_ICON = {
  path: '/logo/logo.png',
  type: 'image/png',
  width: 512,
  height: 520,
} as const;

/**
 * 社交分享封面（og:image / twitter:image）。
 *
 * 由对象存储直出（oss.hao430.cn，2026-09-15 生成，1600×1600 WebP），因此这里写死的是
 * **绝对地址而非本域路径**——封面与站点产物解耦，换图不必重新部署。
 * 两点刻意的处理：
 * - 路径里的中文做**百分号编码**：原始非 ASCII 的 URL 在部分抓取器（微信/推特）里会解析失败。
 * - 宽度/高度**如实声明 1600×1600**：大图卡（1.91:1）会居中裁切，这张图是无文字的抽象画面，
 *   裁切只是构图变化，不会切掉任何信息；谎报成 1200×630 反而会被判为尺寸不符。
 * - ⚠️ 该桶须保持公开可读（不得开 referer 白名单），否则抓取器取不到图。
 */
export const OG_IMAGE = {
  url: 'https://oss.hao430.cn/ai-art/20260915/%E5%A2%A8%E5%BA%95%E6%98%9F%E5%9B%BE-c62005.webp',
  type: 'image/webp',
  width: 1600,
  height: 1600,
  alt: '墨色纸面上，一支红色笔触向右生长成由节点与连线构成的星图',
} as const;
