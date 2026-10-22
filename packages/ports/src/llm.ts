import type { PrivacyClass } from "@personal-os/domain";

export interface LlmCapabilities {
  readonly structuredOutput: boolean;
  readonly toolCalling: boolean;
  readonly streaming: boolean;
  readonly vision: boolean;
  readonly embeddings: boolean;
  readonly local: boolean;
}

export interface GenerateRequest {
  readonly system?: string;
  readonly prompt: string;
  readonly privacy: readonly PrivacyClass[];
  readonly maxOutputTokens?: number;
}

export interface GenerateResult {
  readonly text: string;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly estimatedUsd: number | null;
}

export interface StructuredRequest<T> extends GenerateRequest {
  readonly schemaName: string;
  readonly parse: (value: unknown) => T;
}

export interface LlmPort {
  readonly providerId: string;
  readonly model: string;
  readonly remote: boolean;
  readonly capabilities: LlmCapabilities;
  generate(request: GenerateRequest): Promise<GenerateResult>;
  structured<T>(request: StructuredRequest<T>): Promise<T>;
}
