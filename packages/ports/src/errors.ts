export class OptimisticConcurrencyConflict extends Error {
  readonly streamId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(streamId: string, expectedVersion: number, actualVersion: number) {
    super(
      `Optimistic concurrency conflict for ${streamId}: expected ${expectedVersion}, actual ${actualVersion}.`,
    );
    this.name = "OptimisticConcurrencyConflict";
    this.streamId = streamId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export class EvidenceNotFound extends Error {
  constructor(id: string) {
    super(`Evidence not found: ${id}.`);
    this.name = "EvidenceNotFound";
  }
}

export class ProposalNotFound extends Error {
  constructor(id: string) {
    super(`Proposal not found: ${id}.`);
    this.name = "ProposalNotFound";
  }
}

export class AssertionNotFound extends Error {
  constructor(id: string) {
    super(`Assertion not found: ${id}.`);
    this.name = "AssertionNotFound";
  }
}

export class DecisionNotFound extends Error {
  constructor(id: string) {
    super(`Decision not found: ${id}.`);
    this.name = "DecisionNotFound";
  }
}

export class EvidenceIntegrityViolation extends Error {
  readonly evidenceId: string;

  constructor(evidenceId: string) {
    super(`Raw Evidence content hash does not match for ${evidenceId}.`);
    this.name = "EvidenceIntegrityViolation";
    this.evidenceId = evidenceId;
  }
}

export class LlmUnavailable extends Error {
  readonly retryable = true;

  constructor(provider: string, cause?: string) {
    super(`LLM provider is unavailable: ${provider}${cause === undefined ? "" : ` (${cause})`}.`);
    this.name = "LlmUnavailable";
  }
}

export class LlmRateLimited extends Error {
  readonly retryable = true;

  constructor(provider: string) {
    super(`LLM provider rate limited the request: ${provider}.`);
    this.name = "LlmRateLimited";
  }
}

export class StructuredOutputInvalid extends Error {
  readonly retryable = false;

  constructor(provider: string) {
    super(`LLM provider returned invalid structured output: ${provider}.`);
    this.name = "StructuredOutputInvalid";
  }
}

export class PrivacyViolation extends Error {
  readonly retryable = false;

  constructor() {
    super("No eligible local provider is available for P3 data.");
    this.name = "PrivacyViolation";
  }
}
