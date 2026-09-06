import type { OrderRecord } from '../../core/records.js';

export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'refunded';

/**
 * 支付渠道抽象（Spec E1）：统一下单 / 查单 / 回调 / 退款能力，
 * 便于后续接入真实支付渠道时替换实现。
 */
export interface PaymentProvider {
  readonly name: string;
  createPayment(order: OrderRecord): Promise<{ payUrl: string }>;
  queryPayment(orderNo: string): Promise<{ status: PaymentStatus }>;
  handleCallback(payload: { orderNo: string; success: boolean }): Promise<{ orderNo: string; success: boolean }>;
  refund(order: OrderRecord): Promise<{ success: boolean }>;
}
