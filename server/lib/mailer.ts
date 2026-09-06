import nodemailer, { type Transporter } from 'nodemailer';

/**
 * Spec D3：验证邮件发送器。
 * - SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS 齐备 → 真实 SMTP transport
 *   （开发环境可指向 Mailpit：SMTP_HOST=localhost, SMTP_PORT=1025）
 * - 否则 jsonTransport 干跑模式：邮件进内存 outbox 并 console.log 链接（开发/测试用）
 * - 生产环境 SMTP 配置不完整 → 启动即抛错（fail-fast，避免用户永久卡在未验证态）
 */
const OUTBOX_LIMIT = 50;
const outbox: Array<{ to: string; subject: string; text?: string; html?: string }> = [];

function isSmtpConfigured(): boolean {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  return Boolean(SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS);
}

if (process.env.NODE_ENV === 'production' && !isSmtpConfigured()) {
  throw new Error(
    '生产环境必须完整配置 SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS，否则用户将无法完成邮箱验证'
  );
}
if (process.env.NODE_ENV === 'production' && !process.env.APP_URL) {
  console.error('生产环境未配置 APP_URL，验证邮件中的链接将指向错误地址');
}

function buildTransport(): Transporter {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (isSmtpConfigured()) {
    const port = parseInt(SMTP_PORT!, 10);
    return nodemailer.createTransport({
      host: SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: SMTP_USER!, pass: SMTP_PASS! },
    });
  }
  return nodemailer.createTransport({ jsonTransport: true });
}

// 模块级复用同一 transporter
const transporter = buildTransport();
const isDryRun = (transporter.options as { jsonTransport?: boolean }).jsonTransport === true;

/**
 * 发送邮箱验证邮件。发信失败仅 console.warn，不向上抛（不阻塞注册/重发主流程）。
 */
export async function sendVerificationEmail(to: string, verifyUrl: string): Promise<void> {
  const subject = '枝想 邮箱验证';
  const text = `欢迎加入 枝想！请点击以下链接完成邮箱验证（24 小时内有效）：\n${verifyUrl}`;
  const html = `<p>欢迎加入 枝想！</p><p>请点击以下链接完成邮箱验证（24 小时内有效）：</p><p><a href="${verifyUrl}">${verifyUrl}</a></p>`;

  try {
    if (isDryRun) {
      // 干跑模式：内容进内存 outbox（有上限），供测试断言
      outbox.unshift({ to, subject, text, html });
      if (outbox.length > OUTBOX_LIMIT) outbox.pop();
      console.log(`[mailer:dry-run] 验证邮件（${to}）：${verifyUrl}`);
      return;
    }

    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to,
      subject,
      text,
      html,
    });
  } catch (e) {
    console.warn('验证邮件发送失败（不影响主流程）:', e);
  }
}

/**
 * Spec F1：发送找回密码邮件（链接 1h 有效）。干跑/发信失败处理同验证邮件。
 */
export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  const subject = '枝想 重置密码';
  const text = `您正在重置 枝想 账号密码。请点击以下链接设置新密码（1 小时内有效）：\n${resetUrl}\n\n如非本人操作，请忽略此邮件。`;
  const html = `<p>您正在重置 枝想 账号密码。</p><p>请点击以下链接设置新密码（1 小时内有效）：</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>如非本人操作，请忽略此邮件。</p>`;

  try {
    if (isDryRun) {
      outbox.unshift({ to, subject, text, html });
      if (outbox.length > OUTBOX_LIMIT) outbox.pop();
      console.log(`[mailer:dry-run] 重置密码邮件（${to}）：${resetUrl}`);
      return;
    }

    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to,
      subject,
      text,
      html,
    });
  } catch (e) {
    console.warn('重置密码邮件发送失败（不影响主流程）:', e);
  }
}

/** 测试辅助：读取干跑 outbox */
export function getOutboxForTest(): Array<{ to: string; subject: string; text?: string; html?: string }> {
  return outbox;
}

/** 测试辅助：清空 outbox */
export function clearOutboxForTest(): void {
  outbox.length = 0;
}
