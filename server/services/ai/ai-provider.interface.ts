import type { AiModelConfig } from '../../core/records.js';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'model';
  content: string;
}

export interface GroundingSource {
  index: number;
  title: string;
  uri: string;
  domain: string;
  snippet?: string;
}

export interface GroundingPayload {
  sources: GroundingSource[];
  queries: string[];
}

export interface ChatStreamCallbacks {
  onToken: (text: string) => Promise<void>;
  onGrounding: (grounding: GroundingPayload) => Promise<void>;
  onReset: () => Promise<void>;
}

export interface ProviderExecutionOptions {
  messages: ChatMessage[];
  effectiveSystemInstruction: string;
  systemModelConfig: AiModelConfig;
  requestedModel?: string;
  userId: string;
  canvasId?: string | null;
  nodeId?: string | null;
  startTime: number;
  isAborted?: () => boolean;
}

export interface ProviderExecutionResult {
  provider: string;
  modelUsed: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  groundingSources: GroundingSource[];
  groundingQueries: string[];
  rawSourcesCount: number;
  sourcesTruncated: boolean;
  webSearchCalls: number;
  ttftMs: number;
  resetCount: number;
  candidateFailures: number;
}

export interface AIProvider {
  readonly name: string;
  execute(
    options: ProviderExecutionOptions,
    callbacks: ChatStreamCallbacks
  ): Promise<ProviderExecutionResult>;
}
