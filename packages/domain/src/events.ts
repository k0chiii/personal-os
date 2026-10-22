import type { DecisionSnapshot } from "./decision/model.ts";
import type { AssertionSnapshot, AuditMetadata, MemoryCanonicalEvent } from "./memory/model.ts";

export interface DecisionRecordedEvent {
  readonly type: "decision.recorded";
  readonly eventId: string;
  readonly occurredAt: string;
  readonly decision: DecisionSnapshot;
  readonly audit: AuditMetadata;
}

export interface DecisionOutcomeRecordedEvent {
  readonly type: "decision.outcome_recorded";
  readonly eventId: string;
  readonly occurredAt: string;
  readonly decision: DecisionSnapshot;
  readonly audit: AuditMetadata;
}

export interface AssertionSupersededEvent {
  readonly type: "assertion.superseded";
  readonly eventId: string;
  readonly occurredAt: string;
  readonly previous: AssertionSnapshot;
  readonly successor: AssertionSnapshot;
  readonly audit: AuditMetadata;
}

export interface AssertionDisputedEvent {
  readonly type: "assertion.disputed";
  readonly eventId: string;
  readonly occurredAt: string;
  readonly assertion: AssertionSnapshot;
  readonly audit: AuditMetadata;
}

export interface AssertionRetractedEvent {
  readonly type: "assertion.retracted";
  readonly eventId: string;
  readonly occurredAt: string;
  readonly assertion: AssertionSnapshot;
  readonly audit: AuditMetadata;
}

export type CanonicalEvent =
  | MemoryCanonicalEvent
  | DecisionRecordedEvent
  | DecisionOutcomeRecordedEvent
  | AssertionSupersededEvent
  | AssertionDisputedEvent
  | AssertionRetractedEvent;
