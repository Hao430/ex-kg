import { AppError } from './errors.js';

/**
 * 出站请求目标守卫（ADR-0024 / 安全审查 H2）。
 *
 * 背景：`ai_model_config.openai_base_url` 由管理员在运营台填写，服务端会
 * `${baseUrl}/responses` 直接 `fetch`——此前**没有任何校验**。三个后果：
 *   1. **平台 AI 密钥外送**：`/model-config/test` 在请求体未带 Key 时会回落到已保存的
 *      真实密钥，于是「填一个新地址 + 不填 Key」就能让服务端把 Bearer 密钥送到任意主机；
 *   2. **SSRF**：地址可以是内网/回环/云元数据（`169.254.169.254`、阿里云 `100.100.100.200`），
 *      服务端成为内网探针；
 *   3. 非法协议（`file:`/`gopher:` 等）与明文 `http` 也被放行，后者会让 API Key 走明文链路。
 *
 * 规则（命中即抛 400，绝不静默改成别的地址）：
 *   - 必须是绝对 URL，且协议只允许 `https:`（`http:` 需显式开关，见下）；
 *   - URL 内不得内嵌 `user:pass@`（既是凭据泄漏也是解析歧义）；
 *   - 云元数据地址**恒定拒绝**——没有任何正当理由让业务去访问元数据服务；
 *   - 回环/私网/链路本地/保留段默认拒绝，需 `OUTBOUND_ALLOW_PRIVATE_HOSTS=true` 显式放开
 *     （供本地或内网自托管模型；与本仓 SAVE_DEFAULT_BOARD_MODE 等开关同风格：默认关，翻开要明说）。
 *
 * ⚠️ **已知残留**：本守卫只看字面主机名，不做 DNS 解析后再校验（DNS rebinding：
 * 一个公网域名解析到 127.0.0.1 仍可绕过）。要彻底堵住需解析后按 IP 复核或固定连接目标，
 * 属独立工作项；此处**明说而不是假装已覆盖**。
 */
export interface OutboundUrlOptions {
  /** 用途，出现在错误信息里（如「模型配置联调」「推理调用」），便于运维定位配置项 */
  purpose: string;
}

/**
 * 恒定拒绝的目标：云元数据服务（主机名字面量 + IP 字面量）。
 * 与私网开关无关——内网自托管模型没有理由去读实例元数据。
 */
const ALWAYS_BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
]);
const ALWAYS_BLOCKED_IPS = new Set([
  '169.254.169.254', // AWS / GCP / Azure / 阿里云 通用 IMDS
  '100.100.100.200', // 阿里云 ECS 元数据
]);

/** 出站是否允许内网/明文（默认关；关时只允许公网 https） */
function allowPrivateHosts(): boolean {
  return process.env.OUTBOUND_ALLOW_PRIVATE_HOSTS === 'true';
}

/** 回环 / 私网 / 链路本地 / 保留段（IPv4） */
function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false; // 不是 IPv4 字面量
  }
  const [a, b, c] = parts;
  if (a === 0) return true; // 0.0.0.0/8 「本网络」
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // 回环
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true; // 链路本地
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 基准测试段
  if (a >= 224) return true; // 组播 224/4 + 保留 240/4 + 广播
  return false;
}

/** 回环 / 唯一本地 / 链路本地 / 组播（IPv6），并把 IPv4 映射地址交回 v4 判定 */
function isPrivateIpv6(ipWithBrackets: string): boolean {
  const ip = ipWithBrackets.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (ip === '::' || ip === '::1') return true;
  if (/^fe[89ab]/.test(ip)) return true; // fe80::/10 链路本地
  if (/^f[cd]/.test(ip)) return true; // fc00::/7 唯一本地
  if (/^ff/.test(ip)) return true; // ff00::/8 组播
  const mapped = ip.match(/(\d{1,3}(?:\.\d{1,3}){3})$/); // ::ffff:127.0.0.1 之类
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

/**
 * 校验一个出站基址；返回解析后的 URL（调用方可取 `origin` 做主机比对）。
 * 不合法一律抛 400 `OUTBOUND_URL_REJECTED`——**不要**catch 后回落到默认地址，
 * 那会把「配置写错」伪装成「一切正常」。
 */
export function assertSafeOutboundUrl(raw: string, opts: OutboundUrlOptions): URL {
  const value = (raw || '').trim();
  if (!value) {
    throw new AppError(400, 'OUTBOUND_URL_REJECTED', `${opts.purpose}：服务地址不能为空`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(400, 'OUTBOUND_URL_REJECTED', `${opts.purpose}：服务地址不是合法的绝对 URL`);
  }

  if (url.username || url.password) {
    throw new AppError(
      400,
      'OUTBOUND_URL_REJECTED',
      `${opts.purpose}：服务地址不得内嵌用户名或口令`
    );
  }

  const isHttps = url.protocol === 'https:';
  const isHttp = url.protocol === 'http:';
  if (!isHttps && !isHttp) {
    throw new AppError(
      400,
      'OUTBOUND_URL_REJECTED',
      `${opts.purpose}：不支持的协议 ${url.protocol}（只允许 https）`
    );
  }

  const hostname = url.hostname.toLowerCase();
  const bareHost = hostname.replace(/^\[/, '').replace(/\]$/, '');

  if (ALWAYS_BLOCKED_HOSTNAMES.has(hostname) || ALWAYS_BLOCKED_IPS.has(bareHost)) {
    throw new AppError(
      400,
      'OUTBOUND_URL_REJECTED',
      `${opts.purpose}：不允许访问云元数据地址`
    );
  }

  if (!allowPrivateHosts()) {
    const isIpv6Literal = hostname.startsWith('[');
    const isPrivate =
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      isPrivateIpv4(bareHost) ||
      (isIpv6Literal && isPrivateIpv6(hostname));
    if (isPrivate) {
      throw new AppError(
        400,
        'OUTBOUND_URL_REJECTED',
        `${opts.purpose}：不允许访问回环/内网地址（确需内网自托管模型请设 OUTBOUND_ALLOW_PRIVATE_HOSTS=true）`
      );
    }
    if (isHttp) {
      throw new AppError(
        400,
        'OUTBOUND_URL_REJECTED',
        `${opts.purpose}：必须使用 https（明文 http 会让 API Key 暴露在链路上）`
      );
    }
  }

  return url;
}
