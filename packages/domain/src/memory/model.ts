import { Temporal } from "temporal-polyfill";

import { ContentHash } from "../shared/content-hash.ts";
import { AssertionId, EntityId, EvidenceId, EventId, ProposalId } from "../shared/id.ts";
import { TemporalValidity } from "../shared/temporal-validity.ts";

export const PRIVACY_CLASSES = ["P0", "P1", "P2", "P3"] as const;
export type PrivacyClass = (typeof PRIVACY_CLASSES)[number];

export const EPISTEMIC_ORIGINS = [
  "self_stated",
  "observed_behavior",
  "external_fact",
  "agent_inference",
] as const;
export type EpistemicOrigin = (typeof EPISTEMIC_ORIGINS)[number];

export const EVIDENCE_SOURCE_TYPES = ["markdown", "json", "plain_text"] as const;
export type EvidenceSourceType = (typeof EVIDENCE_SOURCE_TYPES)[number];

export const PROPOSAL_STATUSES = ["pending", "approved", "rejected"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const ASSERTION_STATUSES = ["active", "superseded", "disputed", "retracted"] as const;
export type AssertionStatus = (typeof ASSERTION_STATUSES)[number];

export const ASSERTION_KINDS = [
  "preference",
  "goal",
  "project",
  "artifact",
  "research_topic",
  "value",
  "belief",
  "constraint",
] as const;
export type AssertionKind = (typeof ASSERTION_KINDS)[number];

export const DEFAULT_ASSERTION_PREDICATES = {
  preference: "prefers",
  goal: "pursues",
  project: "works_on",
  artifact: "created",
  research_topic: "studies",
  value: "values",
  belief: "believes",
  constraint: "constrained_by",
} as const satisfies Readonly<Record<AssertionKind, string>>;

export class DomainInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainInvariantError";
  }
}

export interface EvidenceSnapshot {
  readonly id: string;
  readonly sourceType: EvidenceSourceType;
  readonly sourceUri: string | null;
  readonly contentHash: string;
  readonly occurredAt: string | null;
  readonly importedAt: string;
  readonly author: string | null;
  readonly privacy: PrivacyClass;
  readonly rawObjectRef: string;
  readonly mediaType: string;
  readonly purgedAt: string | null;
}

export interface AssertionSnapshot {
  readonly id: string;
  readonly subjectId: string;
  readonly kind: AssertionKind;
  readonly predicate: string;
  readonly object: string;
  readonly evidenceIds: readonly string[];
  readonly epistemicOrigin: EpistemicOrigin;
  readonly confidence: number | null;
  readonly validFrom: string;
  readonly validUntil: string | null;
  readonly recordedAt: string;
  readonly privacy: PrivacyClass;
  readonly status: AssertionStatus;
}

export interface ProposalSnapshot {
  readonly id: string;
  readonly assertion: AssertionSnapshot;
  readonly status: ProposalStatus;
  readonly createdAt: string;
  readonly createdBy: "agent" | "user";
  readonly reviewedAt: string | null;
  readonly reviewedBy: string | null;
  readonly reviewReason: string | null;
}

export interface AuditMetadata {
  readonly actor: string;
  readonly reason: string;
}

export interface EvidenceImportedEvent {
  readonly type: "evidence.imported";
  readonly eventId: string;
  readonly occurredAt: string;
  readonly evidence: EvidenceSnapshot;
}

export interface EvidencePurgedEvent {
  readonly type: "evidence.purged";
  readonly eventId: string;
  readonly occurredAt: string;
  readonly evidence: EvidenceSnapshot;
  readonly audit: AuditMetadata;
}

export interface ProposalCreatedEvent {
  readonly type: "proposal.created";
  readonly eventId: string;
  readonly occurredAt: string;
  readonly proposal: ProposalSnapshot;
}

export interface ProposalApprovedEvent {
  readonly type: "proposal.approved";
  readonly eventId: string;
  readonly occurredAt: string;
  readonly proposalId: string;
  readonly assertionId: string;
  readonly audit: AuditMetadata;
}

export interface ProposalRejectedEvent {
  readonly type: "proposal.rejected";
  readonly eventId: string;
  readonly occurredAt: string;
  readonly proposalId: string;
  readonly audit: AuditMetadata;
}

export interface AssertionCreatedEvent {
  readonly type: "assertion.created";
  readonly eventId: string;
  readonly occurredAt: string;
  readonly assertion: AssertionSnapshot;
  readonly proposalId: string;
  readonly audit: AuditMetadata;
}

export type MemoryCanonicalEvent =
  | EvidenceImportedEvent
  | EvidencePurgedEvent
  | ProposalCreatedEvent
  | ProposalApprovedEvent
  | ProposalRejectedEvent
  | AssertionCreatedEvent;

function canonicalInstant(value: Temporal.Instant): string {
  return value.toString();
}

function requireNonBlank(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new DomainInvariantError(`${field} must not be blank.`);
  }
  return normalized;
}

function requireConfidence(value: number | null): number | null {
  if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1)) {
    throw new DomainInvariantError("confidence must be null or a number from 0 to 1.");
  }
  return value;
}

export function createEvidence(input: {
  readonly id: string;
  readonly sourceType: EvidenceSourceType;
  readonly sourceUri?: string | null;
  readonly contentHash: string;
  readonly occurredAt?: Temporal.Instant | null;
  readonly importedAt: Temporal.Instant;
  readonly author?: string | null;
  readonly privacy: PrivacyClass;
  readonly rawObjectRef: string;
  readonly mediaType: string;
}): EvidenceSnapshot {
  return {
    id: EvidenceId.parse(input.id),
    sourceType: input.sourceType,
    sourceUri: input.sourceUri ?? null,
    contentHash: ContentHash.parse(input.contentHash).toString(),
    occurredAt:
      input.occurredAt === null || input.occurredAt === undefined
        ? null
        : canonicalInstant(input.occurredAt),
    importedAt: canonicalInstant(input.importedAt),
    author: input.author ?? null,
    privacy: input.privacy,
    rawObjectRef: requireNonBlank(input.rawObjectRef, "rawObjectRef"),
    mediaType: requireNonBlank(input.mediaType, "mediaType"),
    purgedAt: null,
  };
}

export function purgeEvidenceSnapshot(
  evidence: EvidenceSnapshot,
  purgedAt: Temporal.Instant,
): EvidenceSnapshot {
  if (evidence.purgedAt !== null) {
    throw new DomainInvariantError("Evidence has already been purged.");
  }
  return { ...evidence, purgedAt: canonicalInstant(purgedAt) };
}

export function createAssertion(input: {
  readonly id: string;
  readonly subjectId: string;
  readonly kind: AssertionKind;
  readonly predicate?: string;
  readonly object: string;
  readonly evidenceIds: readonly string[];
  readonly epistemicOrigin: EpistemicOrigin;
  readonly confidence?: number | null;
  readonly validFrom: Temporal.Instant;
  readonly validUntil?: Temporal.Instant | null;
  readonly recordedAt: Temporal.Instant;
  readonly privacy: PrivacyClass;
}): AssertionSnapshot {
  const evidenceIds = [...new Set(input.evidenceIds.map((id) => EvidenceId.parse(id)))];
  if (evidenceIds.length === 0) {
    throw new DomainInvariantError("An assertion must reference at least one Evidence item.");
  }

  const validity = TemporalValidity.create(input.validFrom, input.validUntil ?? null);

  return {
    id: AssertionId.parse(input.id),
    subjectId: EntityId.parse(input.subjectId),
    kind: input.kind,
    predicate: requireNonBlank(
      input.predicate ?? DEFAULT_ASSERTION_PREDICATES[input.kind],
      "predicate",
    ),
    object: requireNonBlank(input.object, "assertion object"),
    evidenceIds,
    epistemicOrigin: input.epistemicOrigin,
    confidence: requireConfidence(input.confidence ?? null),
    validFrom: canonicalInstant(validity.validFrom),
    validUntil: validity.validUntil === null ? null : canonicalInstant(validity.validUntil),
    recordedAt: canonicalInstant(input.recordedAt),
    privacy: input.privacy,
    status: "active",
  };
}

export function createPreferenceAssertion(
  input: Omit<Parameters<typeof createAssertion>[0], "kind" | "predicate">,
): AssertionSnapshot {
  return createAssertion({ ...input, kind: "preference" });
}

export function createProposal(input: {
  readonly id: string;
  readonly assertion: AssertionSnapshot;
  readonly createdAt: Temporal.Instant;
  readonly createdBy: "agent" | "user";
}): ProposalSnapshot {
  return {
    id: ProposalId.parse(input.id),
    assertion: input.assertion,
    status: "pending",
    createdAt: canonicalInstant(input.createdAt),
    createdBy: input.createdBy,
    reviewedAt: null,
    reviewedBy: null,
    reviewReason: null,
  };
}

export function approveProposal(input: {
  readonly proposal: ProposalSnapshot;
  readonly reviewedAt: Temporal.Instant;
  readonly actor: string;
  readonly reason: string;
  readonly editedObject?: string;
}): ProposalSnapshot {
  if (input.proposal.status !== "pending") {
    throw new DomainInvariantError("Only a pending proposal can be approved.");
  }

  return {
    ...input.proposal,
    assertion: {
      ...input.proposal.assertion,
      object:
        input.editedObject === undefined
          ? input.proposal.assertion.object
          : requireNonBlank(input.editedObject, "edited assertion object"),
      recordedAt: canonicalInstant(input.reviewedAt),
    },
    status: "approved",
    reviewedAt: canonicalInstant(input.reviewedAt),
    reviewedBy: requireNonBlank(input.actor, "actor"),
    reviewReason: requireNonBlank(input.reason, "reason"),
  };
}

export function rejectProposal(input: {
  readonly proposal: ProposalSnapshot;
  readonly reviewedAt: Temporal.Instant;
  readonly actor: string;
  readonly reason: string;
}): ProposalSnapshot {
  if (input.proposal.status !== "pending") {
    throw new DomainInvariantError("Only a pending proposal can be rejected.");
  }

  return {
    ...input.proposal,
    status: "rejected",
    reviewedAt: canonicalInstant(input.reviewedAt),
    reviewedBy: requireNonBlank(input.actor, "actor"),
    reviewReason: requireNonBlank(input.reason, "reason"),
  };
}

export function eventId(value: string): string {
  return EventId.parse(value);
}

export function changeAssertionStatus(
  assertion: AssertionSnapshot,
  status: Exclude<AssertionStatus, "active">,
  validUntil?: Temporal.Instant,
): AssertionSnapshot {
  if (assertion.status !== "active") {
    throw new DomainInvariantError("Only an active Assertion can change status.");
  }
  if (
    validUntil !== undefined &&
    Temporal.Instant.compare(validUntil, Temporal.Instant.from(assertion.validFrom)) < 0
  ) {
    throw new DomainInvariantError("Assertion status change cannot end validity before validFrom.");
  }
  return {
    ...assertion,
    status,
    validUntil: validUntil?.toString() ?? assertion.validUntil,
  };
}
