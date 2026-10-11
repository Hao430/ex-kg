/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { AdminOverview, AuthUser, AiModelConfig } from '../../types';

export type AdminTabType = 'overview' | 'users' | 'orders' | 'models' | 'tickets';

export interface AdminDatabaseStatus {
  connected: boolean;
  type: 'postgresql' | 'memory' | string;
  message: string;
  canvasCount: number;
  nodeCount: number;
}

export interface AdminOrder {
  id: string;
  order_no: string;
  user_id: string;
  user_email?: string;
  plan_name: string;
  amount_cents: number;
  status: 'pending' | 'paid' | 'failed' | 'refunded';
  duration_days: number;
  created_at: string;
}

export interface AdminTicket {
  id: string;
  user_id?: string;
  user_email?: string;
  contact_info?: string;
  type: 'suggestion' | 'bug' | 'ux' | 'other';
  rating: number;
  content: string;
  status: 'pending' | 'processing' | 'resolved' | 'rejected';
  admin_reply?: string;
  created_at: string;
  resolved_at?: string;
}

export interface ModelTestResult {
  success: boolean;
  message: string;
  reply?: string;
  latencyMs?: number;
  modelUsed?: string;
  endpoint?: string;
  error?: string;
}

export interface ModelPreset {
  name: string;
  provider: 'openai' | 'gemini';
  baseUrl: string;
  model: string;
}
