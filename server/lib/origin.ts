import { AppError } from './errors.js';

/**
 * 站点来源（origin）的**可信推导**（安全审查 M3）。
 *
 * 背景：`Host` 请求头是**请求方可控的**。多处直接用
 * `${req.protocol}://${req.get('host')}` 拼链接，于是「伪造 Host」就能把服务端发出的
 * 邮件链接、分享链接指向攻击者域名——典型后果是重置密码投毒：攻击者用受害者邮箱调
 * forgot-password 并伪造 Host，受害者收到一封链接指向攻击者服务器的重置邮件，一点击
 * 令牌就落到对方手里（令牌是明文入库的一次性凭据，可直接换号）。
 *
 * 规则（顺序固定）：
 *   1. `APP_URL` 优先，并用 `new URL()` 校验（合法绝对地址才采用）——**配了它就完全不看 Host**；
 *   2. 未配置（或值是非法的占位符）时按请求推导，但 Host 必须先过 `sanitizeHostHeader`
 *      的字符白名单（主机名/点分或方括号 IPv6 + 可选端口），杜绝把引号、尖括号、空白
 *      之类的东西带进链接与邮件 HTML；
 *   3. 两者都拿不到可信值时**抛错**，而不是回落 `localhost`。回落到一个明知错误的地址，
 *      等于把「部署配置错了」伪装成一封看起来正常的邮件。
 *
 * 与 `server/lib/seo.ts` 的 `resolveOrigin()` 的分工：那个用于 canonical/og:url，
 * 契约是**永不抛错**（爬虫请求不该 500）；本函数用于会发出去的用户可见链接，宁可响亮失败。
 */
export interface OriginSource {
  protocol: string;
  get(name: string): string | undefined;
}

/**
 * Host 头字符白名单。允许：`example.com`、`sub.example.com:3000`、`[::1]:3000`。
 * 拒绝一切含引号/尖括号/空白/斜杠/反斜杠/`@`/`%` 的取值（它们不是合法 Host，
 * 却足以把邮件 HTML 撕开或在链接里塞进凭据段）。
 */
const HOST_HEADER_RE =
  /^(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::\d{1,5})?$/i;

/** 校验并归一化 Host 头；不合法返回 null（调用方决定是抛错还是另寻来源） */
export function sanitizeHostHeader(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const host = raw.trim();
  // 253 = DNS 主机名上限；端口段由正则的 \d{1,5} 限长
  if (host.length === 0 || host.length > 253) return null;
  if (!HOST_HEADER_RE.test(host)) return null;
  return host.toLowerCase();
}

/** 推导本次请求的可信 origin；无可信来源时抛 500（响亮失败，绝不回落错误地址） */
export function resolveRequestOrigin(req: OriginSource): string {
  const configured = process.env.APP_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
    } catch {
      // 非法/占位符（如本地 .env 的 APP_URL="MY_APP_URL"）→ 落到按请求推导
    }
  }

  const host = sanitizeHostHeader(req.get('host'));
  if (!host) {
    throw new AppError(500, 'ORIGIN_UNRESOLVED', '无法确定本站地址，请检查 APP_URL 配置');
  }
  return `${req.protocol}://${host}`;
}
