export type AgentRunStatus = "succeeded" | "failed" | "abstained";

export interface AgentToolCall {
  readonly name: string;
  readonly inputSummary: string;
  readonly outputSummary: string | null;
}

export interface AgentRunRecord {
  readonly runId: string;
  readonly timestamp: string;
  readonly status: AgentRunStatus;
  readonly provider: string | null;
  readonly model: string | null;
  readonly promptVersion: string;
  readonly contextIds: readonly string[];
  readonly toolCalls: readonly AgentToolCall[];
  readonly latencyMs: number;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly estimatedUsd: number | null;
  readonly output: string | null;
  readonly evalResult: string | null;
  readonly error: string | null;
}

export interface AgentRunRecorderPort {
  record(run: AgentRunRecord): Promise<void>;
}
