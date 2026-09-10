import { AlipaySdk } from 'alipay-sdk';
import type { PaymentProvider, PaymentStatus } from './payment-provider.js';
import type { OrderRecord } from '../../core/records.js';

/**
 * 支付宝电脑网站支付渠道（alipay.trade.page.pay，ADR-0014）。
 *
 * 官方 alipay-sdk v4：RSA2 签名/验签在 SDK 内完成；本类只做业务映射。
 * 配置三要素（.env）：ALIPAY_APP_ID / ALIPAY_PRIVATE_KEY（PKCS8 应用私钥）/
 * ALIPAY_ALIPAY_PUBLIC_KEY（支付宝公钥——注意是开放平台「支付宝公钥」，
 * 不是商户应用公钥；沙箱与生产公钥不可混用，否则 notify 验签必失败）。
 * ALIPAY_GATEWAY 可选：沙箱填 https://openapi-sandbox.dl.alipaydev.com。
 */
const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');

/** 支付宝配置是否齐备（getPaymentProvider 据此选择渠道；测试环境不配则走 mock） */
export function isAlipayConfigured(): boolean {
  return Boolean(
    process.env.ALIPAY_APP_ID &&
    process.env.ALIPAY_PRIVATE_KEY &&
    process.env.ALIPAY_ALIPAY_PUBLIC_KEY
  );
}

/** .env 单行 base64 密钥 → PEM（SDK 期望 PEM 格式，密钥工具单行产出需补头尾与换行） */
function toPem(key: string, type: 'PRIVATE KEY' | 'PUBLIC KEY'): string {
  const trimmed = key.trim().replace(/\\n/g, '');
  if (trimmed.includes('-----BEGIN')) return trimmed;
  const body = trimmed.replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g)?.join('\n') ?? body;
  return `-----BEGIN ${type}-----\n${lines}\n-----END ${type}-----`;
}

class AlipayProvider implements PaymentProvider {
  readonly name = 'alipay';

  private sdk: AlipaySdk;

  private constructor(sdk: AlipaySdk) {
    this.sdk = sdk;
  }

  static create(): AlipayProvider {
    // 网关基址统一处理：兼容带不带 /gateway.do 的写法，v3 curl 用去尾巴的 endpoint
    const base = (process.env.ALIPAY_GATEWAY || 'https://openapi.alipay.com')
      .replace(/\/+$/, '')
      .replace(/\/gateway\.do$/, '');
    const sdk = new AlipaySdk({
      appId: process.env.ALIPAY_APP_ID!,
      privateKey: toPem(process.env.ALIPAY_PRIVATE_KEY!, 'PRIVATE KEY'),
      alipayPublicKey: toPem(process.env.ALIPAY_ALIPAY_PUBLIC_KEY!, 'PUBLIC KEY'),
      keyType: 'PKCS8',
      gateway: `${base}/gateway.do`,
      endpoint: base,
    });
    return new AlipayProvider(sdk);
  }

  /** 生成收银台跳转 URL（电脑网站支付；手机浏览器同样会拉起支付宝收银台 H5） */
  async createPayment(order: OrderRecord): Promise<{ payUrl: string }> {
    const payUrl = this.sdk.pageExecute('alipay.trade.page.pay', 'GET', {
      bizContent: {
        out_trade_no: order.order_no,
        product_code: 'FAST_INSTANT_TRADE_PAY',
        total_amount: (order.amount_cents / 100).toFixed(2),
        subject: order.plan_name || 'Pro 会员订阅',
      },
      notify_url: `${APP_URL}/api/subscriptions/notify`,
      return_url: `${APP_URL}/?payment=return`,
    });
    return { payUrl };
  }

  /** 官方查单（v3 alipay.trade.query）→ 本地状态机映射；网络异常向上抛由调用方降级 */
  async queryPayment(orderNo: string): Promise<{ status: PaymentStatus }> {
    try {
      const res = await this.sdk.curl<{ trade_status?: string }>('POST', '/v3/alipay/trade/query', {
        body: { out_trade_no: orderNo },
      });
      const tradeStatus = res?.data?.trade_status;
      if (tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED') return { status: 'paid' };
      if (tradeStatus === 'TRADE_CLOSED') return { status: 'failed' };
      return { status: 'pending' }; // WAIT_BUYER_PAY 等
    } catch (e: any) {
      // 订单未在收银台提交过（用户打开链接但未支付）→ 视为仍在等待
      const code = e?.code || e?.data?.code;
      if (code === 'ACQ.TRADE_NOT_EXIST') return { status: 'pending' };
      throw e;
    }
  }

  /** 异步通知验签：checkNotifySign 失败时以不 decode 的 V2 兜底（urlencoded 原串问题） */
  verifyNotifySignature(form: Record<string, unknown>): boolean {
    try {
      if (this.sdk.checkNotifySign(form)) return true;
      return this.sdk.checkNotifySignV2(form);
    } catch {
      return false;
    }
  }

  /**
   * 接口兼容保留：真实到账结算走 billing.service 的 settleOrderPaid（幂等激活），
   * 本方法不做本地状态写入，仅透传结果（与 mock 渠道行为对齐的空实现）。
   */
  async handleCallback(payload: { orderNo: string; success: boolean }): Promise<{ orderNo: string; success: boolean }> {
    return payload;
  }

  /** 支付宝 appId（notify 请求方校验用） */
  get appId(): string {
    return process.env.ALIPAY_APP_ID || '';
  }

  /** 退款（v3 alipay.trade.refund）：一期仅实现接口，不暴露业务端点 */
  async refund(order: OrderRecord): Promise<{ success: boolean }> {
    try {
      await this.sdk.curl('POST', '/v3/alipay/trade/refund', {
        body: {
          out_trade_no: order.order_no,
          refund_amount: (order.amount_cents / 100).toFixed(2),
        },
      });
      return { success: true };
    } catch (e) {
      console.error('Alipay refund failed:', e);
      return { success: false };
    }
  }
}

let cached: AlipayProvider | null = null;

/** 懒初始化单例：env 在进程启动后、首次调用前就位即可（测试进程 set env 后再触发） */
export function getAlipayProvider(): AlipayProvider {
  if (!cached) cached = AlipayProvider.create();
  return cached;
}

/** 测试辅助：重置缓存的 SDK 实例（重设 env 后生效） */
export function resetAlipayProviderForTest(): void {
  cached = null;
}
