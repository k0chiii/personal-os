import type { Temporal } from "temporal-polyfill";

import type {
  AssertionSnapshot,
  CanonicalEvent,
  DecisionSnapshot,
  EvidenceSnapshot,
  ProposalSnapshot,
} from "@personal-os/domain";
import type { ContentHash } from "@personal-os/domain";

export interface ClockPort {
  now(): Temporal.Instant;
}

export interface ContentHasherPort {
  sha256(content: Uint8Array): Promise<ContentHash>;
}

export interface RawEvidenceStorePort {
  put(hash: ContentHash, content: Uint8Array): Promise<string>;
  get(rawObjectRef: string): Promise<Uint8Array>;
  delete(rawObjectRef: string): Promise<void>;
}

export interface StoredEvent {
  readonly globalPosition: number;
  readonly streamId: string;
  readonly streamVersion: number;
  readonly event: CanonicalEvent;
  readonly actor: string;
  readonly reason: string;
  readonly idempotencyKey: string | null;
}

export interface AppendEventsInput {
  readonly streamId: string;
  readonly expectedVersion: number;
  readonly events: readonly CanonicalEvent[];
  readonly actor: string;
  readonly reason: string;
  readonly idempotencyKey?: string;
}

export interface EventStorePort {
  append(input: AppendEventsInput): Promise<readonly StoredEvent[]>;
  readStream(streamId: string): Promise<readonly StoredEvent[]>;
  readAll(afterPosition?: number): Promise<readonly StoredEvent[]>;
  getStreamVersion(streamId: string): Promise<number>;
}

export interface AssertionSearchInput {
  readonly query: string;
  readonly asOf: Temporal.Instant;
  readonly privacy?: readonly string[];
  readonly limit?: number;
}

export interface DecisionSearchInput {
  readonly query: string;
  readonly asOf: Temporal.Instant;
  readonly privacy?: readonly string[];
  readonly limit?: number;
}

export interface ProjectionPort {
  reset(): Promise<void>;
  apply(events: readonly StoredEvent[]): Promise<void>;
  findEvidenceByHash(hash: ContentHash): Promise<EvidenceSnapshot | null>;
  getEvidence(id: string): Promise<EvidenceSnapshot | null>;
  listEvidence(): Promise<readonly EvidenceSnapshot[]>;
  getProposal(id: string): Promise<ProposalSnapshot | null>;
  getAssertion(id: string): Promise<AssertionSnapshot | null>;
  listAssertions(): Promise<readonly AssertionSnapshot[]>;
  getDecision(id: string): Promise<DecisionSnapshot | null>;
  searchAssertions(input: AssertionSearchInput): Promise<readonly AssertionSnapshot[]>;
  searchDecisions(input: DecisionSearchInput): Promise<readonly DecisionSnapshot[]>;
}
