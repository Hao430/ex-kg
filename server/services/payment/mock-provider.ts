import type { PaymentProvider, PaymentStatus } from './payment-provider.js';
import type { OrderRecord } from '../../core/records.js';

type MockState = PaymentStatus | 'refunded';

/**
 * Mock 支付渠道（Spec E2）：内存 Map 模拟支付状态机 pending → paid | failed | refunded。
 * 仅用于开发/测试环境模拟支付回调全链路。
 */
class MockProvider implements PaymentProvider {
  readonly name = 'mock';

  private states = new Map<string, MockState>();

  async createPayment(order: OrderRecord): Promise<{ payUrl: string }> {
    this.states.set(order.order_no, 'pending');
    return { payUrl: `mock://pay/${order.order_no}` };
  }

  async queryPayment(orderNo: string): Promise<{ status: PaymentStatus }> {
    const status = this.states.get(orderNo);
    if (status === 'paid') return { status: 'paid' };
    if (status === 'failed') return { status: 'failed' };
    return { status: 'pending' };
  }

  async handleCallback(payload: { orderNo: string; success: boolean }): Promise<{ orderNo: string; success: boolean }> {
    this.states.set(payload.orderNo, payload.success ? 'paid' : 'failed');
    return { orderNo: payload.orderNo, success: payload.success };
  }

  async refund(order: OrderRecord): Promise<{ success: boolean }> {
    this.states.set(order.order_no, 'refunded');
    return { success: true };
  }
}

export const mockProvider = new MockProvider();
