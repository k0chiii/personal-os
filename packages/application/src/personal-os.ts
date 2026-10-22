import { Temporal } from "temporal-polyfill";

import {
  approveProposal,
  AssertionId,
  changeAssertionStatus,
  ContentHash,
  createAssertion,
  createEvidence,
  createDecision,
  createProposal,
  DecisionId,
  eventId,
  EvidenceId,
  ProposalId,
  PRIVACY_CLASSES,
  purgeEvidenceSnapshot,
  recordDecisionOutcome,
  rejectProposal,
  type AssertionSnapshot,
  type AssertionKind,
  type CanonicalEvent,
  type DecisionCriterionSnapshot,
  type DecisionOptionSnapshot,
  type DecisionSnapshot,
  type EpistemicOrigin,
  type EvidenceSnapshot,
  type EvidenceSourceType,
  type PrivacyClass,
  type ProposalSnapshot,
} from "@personal-os/domain";
import {
  AssertionNotFound,
  type BackupCipherPort,
  type AssertionRetrieverPort,
  DecisionNotFound,
  EvidenceIntegrityViolation,
  EvidenceNotFound,
  ProposalNotFound,
  type ClockPort,
  type ContentHasherPort,
  type EventStorePort,
  type IdGeneratorPort,
  type ProjectionPort,
  type RawEvidenceStorePort,
  type StoredEvent,
} from "@personal-os/ports";

export interface PersonalOsDependencies {
  readonly clock: ClockPort;
  readonly idGenerator: IdGeneratorPort;
  readonly contentHasher: ContentHasherPort;
  readonly rawEvidenceStore: RawEvidenceStorePort;
  readonly eventStore: EventStorePort;
  readonly projection: ProjectionPort;
  readonly assertionRetriever?: AssertionRetrieverPort;
}

export interface ImportEvidenceInput {
  readonly content: Uint8Array;
  readonly sourceType: EvidenceSourceType;
  readonly sourceUri?: string | null;
  readonly occurredAt?: Temporal.Instant | null;
  readonly author?: string | null;
  readonly privacy: PrivacyClass;
  readonly mediaType: string;
  readonly actor: string;
  readonly reason: string;
}

export interface ImportEvidenceResult {
  readonly evidence: EvidenceSnapshot;
  readonly deduplicated: boolean;
}

export interface ProposePreferenceInput {
  readonly subjectId: string;
  readonly object: string;
  readonly evidenceIds: readonly string[];
  readonly epistemicOrigin: EpistemicOrigin;
  readonly confidence?: number | null;
  readonly validFrom: Temporal.Instant;
  readonly validUntil?: Temporal.Instant | null;
  readonly privacy: PrivacyClass;
  readonly createdBy: "agent" | "user";
  readonly actor: string;
  readonly reason: string;
}

export interface ProposeAssertionInput extends ProposePreferenceInput {
  readonly kind: AssertionKind;
  readonly predicate?: string;
}

export interface ReviewProposalInput {
  readonly proposalId: string;
  readonly actor: string;
  readonly reason: string;
  readonly editedObject?: string;
}

export interface SupersedeAssertionInput {
  readonly assertionId: string;
  readonly object: string;
  readonly evidenceIds: readonly string[];
  readonly validFrom: Temporal.Instant;
  readonly epistemicOrigin?: EpistemicOrigin;
  readonly confidence?: number | null;
  readonly privacy?: PrivacyClass;
  readonly actor: string;
  readonly reason: string;
}

export interface ChangeAssertionStatusInput {
  readonly assertionId: string;
  readonly actor: string;
  readonly reason: string;
}

export interface AssertionExplanation {
  readonly assertion: AssertionSnapshot;
  readonly evidence: readonly EvidenceSnapshot[];
}

export interface IntegrityReport {
  readonly evidenceChecked: number;
  readonly eventCount: number;
}

export interface RetentionResult {
  readonly considered: number;
  readonly purged: readonly string[];
}

export interface CanonicalBackupRawObject {
  readonly contentHash: string;
  readonly rawObjectRef: string;
  readonly bytes: readonly number[];
}

export interface CanonicalBackup {
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly events: readonly StoredEvent[];
  readonly rawObjects: readonly CanonicalBackupRawObject[];
}

export interface RecordDecisionInput {
  readonly subjectId: string;
  readonly problem: string;
  readonly options: readonly DecisionOptionSnapshot[];
  readonly chosenOptionId: string;
  readonly criteria: readonly DecisionCriterionSnapshot[];
  readonly rationale: string;
  readonly constraints?: readonly string[];
  readonly stateSnapshot: string;
  readonly evidenceIds: readonly string[];
  readonly decidedAt: Temporal.Instant;
  readonly privacy: PrivacyClass;
  readonly actor: string;
  readonly reason: string;
}

export interface ContextEvidence {
  readonly evidence: EvidenceSnapshot;
  readonly content: string;
}

export interface ContextPack {
  readonly task: string;
  readonly temporalScope: string;
  readonly currentState: {
    readonly preferences: readonly AssertionSnapshot[];
    readonly intents: Readonly<
      Record<Exclude<AssertionKind, "preference">, readonly AssertionSnapshot[]>
    >;
  };
  readonly relevantAssertions: readonly AssertionSnapshot[];
  readonly relevantDecisions: readonly DecisionSnapshot[];
  readonly rawEvidence: readonly ContextEvidence[];
  readonly counterEvidence: readonly EvidenceSnapshot[];
  readonly contradictions: readonly string[];
  readonly uncertainties: readonly string[];
  readonly privacyPolicy: readonly PrivacyClass[];
  readonly tokenBudget: number;
  readonly estimatedTokens: number;
}

export interface TimelineEntry {
  readonly globalPosition: number;
  readonly eventId: string;
  readonly operation: CanonicalEvent["type"];
  readonly occurredAt: string;
  readonly actor: string;
  readonly reason: string;
  readonly entityType: "evidence" | "proposal" | "assertion" | "decision";
  readonly entityId: string;
  readonly privacy: PrivacyClass;
}

const INTENT_KINDS = [
  "goal",
  "project",
  "artifact",
  "research_topic",
  "value",
  "belief",
  "constraint",
] as const satisfies readonly Exclude<AssertionKind, "preference">[];

function groupIntents(
  assertions: readonly AssertionSnapshot[],
): Readonly<Record<Exclude<AssertionKind, "preference">, readonly AssertionSnapshot[]>> {
  const byKind = (kind: Exclude<AssertionKind, "preference">): readonly AssertionSnapshot[] =>
    assertions.filter((assertion) => assertion.kind === kind);
  return {
    goal: byKind("goal"),
    project: byKind("project"),
    artifact: byKind("artifact"),
    research_topic: byKind("research_topic"),
    value: byKind("value"),
    belief: byKind("belief"),
    constraint: byKind("constraint"),
  };
}

function unreachableEvent(event: never): never {
  throw new Error(`Unsupported event: ${JSON.stringify(event)}`);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class PersonalOsApplication {
  readonly #dependencies: PersonalOsDependencies;

  constructor(dependencies: PersonalOsDependencies) {
    this.#dependencies = dependencies;
  }

  async importEvidence(input: ImportEvidenceInput): Promise<ImportEvidenceResult> {
    const hash = await this.#dependencies.contentHasher.sha256(input.content);
    const existing = await this.#dependencies.projection.findEvidenceByHash(hash);
    if (existing !== null) {
      return { evidence: existing, deduplicated: true };
    }

    const id = EvidenceId.parse(this.#dependencies.idGenerator.generate());
    const importedAt = this.#dependencies.clock.now();
    const rawObjectRef = await this.#dependencies.rawEvidenceStore.put(hash, input.content);
    const evidence = createEvidence({
      id,
      sourceType: input.sourceType,
      sourceUri: input.sourceUri ?? null,
      contentHash: hash.toString(),
      occurredAt: input.occurredAt ?? null,
      importedAt,
      author: input.author ?? null,
      privacy: input.privacy,
      rawObjectRef,
      mediaType: input.mediaType,
    });

    const imported: CanonicalEvent = {
      type: "evidence.imported",
      eventId: eventId(this.#dependencies.idGenerator.generate()),
      occurredAt: importedAt.toString(),
      evidence,
    };
    const stored = await this.#dependencies.eventStore.append({
      streamId: `evidence:${id}`,
      expectedVersion: 0,
      events: [imported],
      actor: input.actor,
      reason: input.reason,
      idempotencyKey: `evidence:${hash.toString()}`,
    });
    await this.#dependencies.projection.apply(stored);

    return { evidence, deduplicated: false };
  }

  async importTextEvidence(
    input: Omit<ImportEvidenceInput, "content"> & { readonly content: string },
  ): Promise<ImportEvidenceResult> {
    return this.importEvidence({ ...input, content: encoder.encode(input.content) });
  }

  async purgeEvidence(input: {
    readonly evidenceId: string;
    readonly actor: string;
    readonly reason: string;
  }): Promise<EvidenceSnapshot> {
    const evidence = await this.#dependencies.projection.getEvidence(
      EvidenceId.parse(input.evidenceId),
    );
    if (evidence === null) {
      throw new EvidenceNotFound(input.evidenceId);
    }
    const purgedAt = this.#dependencies.clock.now();
    const purged = purgeEvidenceSnapshot(evidence, purgedAt);
    const raw = await this.#dependencies.rawEvidenceStore.get(evidence.rawObjectRef);
    await this.#dependencies.rawEvidenceStore.delete(evidence.rawObjectRef);
    const streamId = `evidence:${evidence.id}`;
    try {
      const stored = await this.#dependencies.eventStore.append({
        streamId,
        expectedVersion: await this.#dependencies.eventStore.getStreamVersion(streamId),
        events: [
          {
            type: "evidence.purged",
            eventId: eventId(this.#dependencies.idGenerator.generate()),
            occurredAt: purgedAt.toString(),
            evidence: purged,
            audit: { actor: input.actor, reason: input.reason },
          },
        ],
        actor: input.actor,
        reason: input.reason,
      });
      await this.#dependencies.projection.apply(stored);
      return purged;
    } catch (error: unknown) {
      await this.#dependencies.rawEvidenceStore.put(ContentHash.parse(evidence.contentHash), raw);
      throw error;
    }
  }

  async executeRetention(input: {
    readonly importedBefore: Temporal.Instant;
    readonly privacy: readonly PrivacyClass[];
    readonly actor: string;
    readonly reason: string;
  }): Promise<RetentionResult> {
    const allowed = new Set(input.privacy);
    const evidence = await this.#dependencies.projection.listEvidence();
    const candidates = evidence.filter(
      (item) =>
        item.purgedAt === null &&
        allowed.has(item.privacy) &&
        Temporal.Instant.compare(Temporal.Instant.from(item.importedAt), input.importedBefore) < 0,
    );
    const purged: string[] = [];
    for (const item of candidates) {
      await this.purgeEvidence({
        evidenceId: item.id,
        actor: input.actor,
        reason: input.reason,
      });
      purged.push(item.id);
    }
    return { considered: evidence.length, purged };
  }

  async proposePreference(input: ProposePreferenceInput): Promise<ProposalSnapshot> {
    return this.proposeAssertion({ ...input, kind: "preference" });
  }

  async proposeAssertion(input: ProposeAssertionInput): Promise<ProposalSnapshot> {
    for (const evidenceIdValue of input.evidenceIds) {
      const evidence = await this.#dependencies.projection.getEvidence(
        EvidenceId.parse(evidenceIdValue),
      );
      if (evidence === null) {
        throw new EvidenceNotFound(evidenceIdValue);
      }
    }

    const createdAt = this.#dependencies.clock.now();
    const assertion = createAssertion({
      id: AssertionId.parse(this.#dependencies.idGenerator.generate()),
      subjectId: input.subjectId,
      kind: input.kind,
      ...(input.predicate === undefined ? {} : { predicate: input.predicate }),
      object: input.object,
      evidenceIds: input.evidenceIds,
      epistemicOrigin: input.epistemicOrigin,
      confidence: input.confidence ?? null,
      validFrom: input.validFrom,
      validUntil: input.validUntil ?? null,
      recordedAt: createdAt,
      privacy: input.privacy,
    });
    const proposal = createProposal({
      id: ProposalId.parse(this.#dependencies.idGenerator.generate()),
      assertion,
      createdAt,
      createdBy: input.createdBy,
    });
    const created: CanonicalEvent = {
      type: "proposal.created",
      eventId: eventId(this.#dependencies.idGenerator.generate()),
      occurredAt: createdAt.toString(),
      proposal,
    };
    const stored = await this.#dependencies.eventStore.append({
      streamId: `proposal:${proposal.id}`,
      expectedVersion: 0,
      events: [created],
      actor: input.actor,
      reason: input.reason,
    });
    await this.#dependencies.projection.apply(stored);
    return proposal;
  }

  async approveProposal(input: ReviewProposalInput): Promise<AssertionSnapshot> {
    const proposal = await this.#getPendingProposal(input.proposalId);
    const reviewedAt = this.#dependencies.clock.now();
    const approved = approveProposal({
      proposal,
      reviewedAt,
      actor: input.actor,
      reason: input.reason,
      ...(input.editedObject === undefined ? {} : { editedObject: input.editedObject }),
    });
    const audit = { actor: approved.reviewedBy!, reason: approved.reviewReason! };
    const events: readonly CanonicalEvent[] = [
      {
        type: "proposal.approved",
        eventId: eventId(this.#dependencies.idGenerator.generate()),
        occurredAt: reviewedAt.toString(),
        proposalId: approved.id,
        assertionId: approved.assertion.id,
        audit,
      },
      {
        type: "assertion.created",
        eventId: eventId(this.#dependencies.idGenerator.generate()),
        occurredAt: reviewedAt.toString(),
        assertion: approved.assertion,
        proposalId: approved.id,
        audit,
      },
    ];
    const streamId = `proposal:${approved.id}`;
    const expectedVersion = await this.#dependencies.eventStore.getStreamVersion(streamId);
    const stored = await this.#dependencies.eventStore.append({
      streamId,
      expectedVersion,
      events,
      actor: input.actor,
      reason: input.reason,
    });
    await this.#dependencies.projection.apply(stored);
    return approved.assertion;
  }

  async rejectProposal(input: ReviewProposalInput): Promise<ProposalSnapshot> {
    const proposal = await this.#getPendingProposal(input.proposalId);
    const reviewedAt = this.#dependencies.clock.now();
    const rejected = rejectProposal({
      proposal,
      reviewedAt,
      actor: input.actor,
      reason: input.reason,
    });
    const rejectedEvent: CanonicalEvent = {
      type: "proposal.rejected",
      eventId: eventId(this.#dependencies.idGenerator.generate()),
      occurredAt: reviewedAt.toString(),
      proposalId: rejected.id,
      audit: { actor: rejected.reviewedBy!, reason: rejected.reviewReason! },
    };
    const streamId = `proposal:${rejected.id}`;
    const expectedVersion = await this.#dependencies.eventStore.getStreamVersion(streamId);
    const stored = await this.#dependencies.eventStore.append({
      streamId,
      expectedVersion,
      events: [rejectedEvent],
      actor: input.actor,
      reason: input.reason,
    });
    await this.#dependencies.projection.apply(stored);
    return rejected;
  }

  async supersedeAssertion(input: SupersedeAssertionInput): Promise<AssertionSnapshot> {
    const current = await this.#getAssertion(input.assertionId);
    for (const evidenceIdValue of input.evidenceIds) {
      const evidence = await this.#dependencies.projection.getEvidence(
        EvidenceId.parse(evidenceIdValue),
      );
      if (evidence === null) {
        throw new EvidenceNotFound(evidenceIdValue);
      }
    }

    const recordedAt = this.#dependencies.clock.now();
    const previous = changeAssertionStatus(current, "superseded", input.validFrom);
    const successor = createAssertion({
      id: AssertionId.parse(this.#dependencies.idGenerator.generate()),
      subjectId: current.subjectId,
      kind: current.kind,
      predicate: current.predicate,
      object: input.object,
      evidenceIds: input.evidenceIds,
      epistemicOrigin: input.epistemicOrigin ?? current.epistemicOrigin,
      confidence: input.confidence === undefined ? current.confidence : input.confidence,
      validFrom: input.validFrom,
      recordedAt,
      privacy: input.privacy ?? current.privacy,
    });
    const superseded: CanonicalEvent = {
      type: "assertion.superseded",
      eventId: eventId(this.#dependencies.idGenerator.generate()),
      occurredAt: recordedAt.toString(),
      previous,
      successor,
      audit: { actor: input.actor, reason: input.reason },
    };
    await this.#appendAssertionEvent(current.id, superseded, input.actor, input.reason);
    return successor;
  }

  async disputeAssertion(input: ChangeAssertionStatusInput): Promise<AssertionSnapshot> {
    const current = await this.#getAssertion(input.assertionId);
    const changedAt = this.#dependencies.clock.now();
    const assertion = changeAssertionStatus(current, "disputed");
    const disputed: CanonicalEvent = {
      type: "assertion.disputed",
      eventId: eventId(this.#dependencies.idGenerator.generate()),
      occurredAt: changedAt.toString(),
      assertion,
      audit: { actor: input.actor, reason: input.reason },
    };
    await this.#appendAssertionEvent(current.id, disputed, input.actor, input.reason);
    return assertion;
  }

  async retractAssertion(input: ChangeAssertionStatusInput): Promise<AssertionSnapshot> {
    const current = await this.#getAssertion(input.assertionId);
    const retractedAt = this.#dependencies.clock.now();
    const assertion = changeAssertionStatus(current, "retracted", retractedAt);
    const retracted: CanonicalEvent = {
      type: "assertion.retracted",
      eventId: eventId(this.#dependencies.idGenerator.generate()),
      occurredAt: retractedAt.toString(),
      assertion,
      audit: { actor: input.actor, reason: input.reason },
    };
    await this.#appendAssertionEvent(current.id, retracted, input.actor, input.reason);
    return assertion;
  }

  async searchAssertions(input: {
    readonly query: string;
    readonly asOf?: Temporal.Instant;
    readonly privacy?: readonly PrivacyClass[];
    readonly limit?: number;
  }): Promise<readonly AssertionSnapshot[]> {
    if (this.#dependencies.assertionRetriever !== undefined) {
      const ranked = await this.#dependencies.assertionRetriever.search({
        query: input.query,
        asOf: input.asOf ?? this.#dependencies.clock.now(),
        privacy: input.privacy ?? PRIVACY_CLASSES,
        queryPrivacy: input.privacy ?? PRIVACY_CLASSES,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      return ranked.map((result) => result.assertion);
    }
    return this.#dependencies.projection.searchAssertions({
      query: input.query,
      asOf: input.asOf ?? this.#dependencies.clock.now(),
      ...(input.privacy === undefined ? {} : { privacy: input.privacy }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
  }

  async explainAssertion(id: string): Promise<AssertionExplanation> {
    const assertion = await this.#dependencies.projection.getAssertion(AssertionId.parse(id));
    if (assertion === null) {
      throw new AssertionNotFound(id);
    }
    const evidence: EvidenceSnapshot[] = [];
    for (const evidenceIdValue of assertion.evidenceIds) {
      const item = await this.#dependencies.projection.getEvidence(evidenceIdValue);
      if (item === null) {
        throw new EvidenceNotFound(evidenceIdValue);
      }
      evidence.push(item);
    }
    return { assertion, evidence };
  }

  async listProposals(status?: ProposalSnapshot["status"]): Promise<readonly ProposalSnapshot[]> {
    const events = await this.#dependencies.eventStore.readAll();
    const ids = [
      ...new Set(
        events
          .filter((stored) => stored.event.type === "proposal.created")
          .map((stored) =>
            stored.event.type === "proposal.created" ? stored.event.proposal.id : "",
          ),
      ),
    ];
    const proposals = await Promise.all(
      ids.map((id) => this.#dependencies.projection.getProposal(id)),
    );
    return proposals
      .filter((proposal): proposal is ProposalSnapshot => proposal !== null)
      .filter((proposal) => status === undefined || proposal.status === status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getTimeline(input: {
    readonly privacy: readonly PrivacyClass[];
    readonly limit?: number;
  }): Promise<readonly TimelineEntry[]> {
    const allowed = new Set(input.privacy);
    const events = await this.#dependencies.eventStore.readAll();
    const entries: TimelineEntry[] = [];
    for (const stored of events) {
      const identity = await this.#timelineIdentity(stored.event);
      if (identity === null || !allowed.has(identity.privacy)) {
        continue;
      }
      entries.push({
        globalPosition: stored.globalPosition,
        eventId: stored.event.eventId,
        operation: stored.event.type,
        occurredAt: stored.event.occurredAt,
        actor: stored.actor,
        reason: stored.reason,
        ...identity,
      });
    }
    return entries
      .sort((left, right) => right.globalPosition - left.globalPosition)
      .slice(0, Math.max(1, Math.min(input.limit ?? 100, 500)));
  }

  async recordDecision(input: RecordDecisionInput): Promise<DecisionSnapshot> {
    for (const evidenceIdValue of input.evidenceIds) {
      const evidence = await this.#dependencies.projection.getEvidence(
        EvidenceId.parse(evidenceIdValue),
      );
      if (evidence === null) {
        throw new EvidenceNotFound(evidenceIdValue);
      }
    }
    const recordedAt = this.#dependencies.clock.now();
    const decision = createDecision({
      id: DecisionId.parse(this.#dependencies.idGenerator.generate()),
      subjectId: input.subjectId,
      problem: input.problem,
      options: input.options,
      chosenOptionId: input.chosenOptionId,
      criteria: input.criteria,
      rationale: input.rationale,
      constraints: input.constraints ?? [],
      stateSnapshot: input.stateSnapshot,
      evidenceIds: input.evidenceIds,
      decidedAt: input.decidedAt,
      recordedAt,
      privacy: input.privacy,
    });
    const recorded: CanonicalEvent = {
      type: "decision.recorded",
      eventId: eventId(this.#dependencies.idGenerator.generate()),
      occurredAt: recordedAt.toString(),
      decision,
      audit: { actor: input.actor, reason: input.reason },
    };
    const stored = await this.#dependencies.eventStore.append({
      streamId: `decision:${decision.id}`,
      expectedVersion: 0,
      events: [recorded],
      actor: input.actor,
      reason: input.reason,
    });
    await this.#dependencies.projection.apply(stored);
    return decision;
  }

  async recordDecisionOutcome(input: {
    readonly decisionId: string;
    readonly summary: string;
    readonly occurredAt: Temporal.Instant;
    readonly retrospective?: string | null;
    readonly actor: string;
    readonly reason: string;
  }): Promise<DecisionSnapshot> {
    const id = DecisionId.parse(input.decisionId);
    const decision = await this.#dependencies.projection.getDecision(id);
    if (decision === null) {
      throw new DecisionNotFound(input.decisionId);
    }
    const recordedAt = this.#dependencies.clock.now();
    const updated = recordDecisionOutcome({
      decision,
      summary: input.summary,
      occurredAt: input.occurredAt,
      recordedAt,
      retrospective: input.retrospective ?? null,
    });
    const event: CanonicalEvent = {
      type: "decision.outcome_recorded",
      eventId: eventId(this.#dependencies.idGenerator.generate()),
      occurredAt: recordedAt.toString(),
      decision: updated,
      audit: { actor: input.actor, reason: input.reason },
    };
    const streamId = `decision:${decision.id}`;
    const stored = await this.#dependencies.eventStore.append({
      streamId,
      expectedVersion: await this.#dependencies.eventStore.getStreamVersion(streamId),
      events: [event],
      actor: input.actor,
      reason: input.reason,
    });
    await this.#dependencies.projection.apply(stored);
    return updated;
  }

  async searchDecisions(input: {
    readonly query: string;
    readonly asOf?: Temporal.Instant;
    readonly privacy?: readonly PrivacyClass[];
    readonly limit?: number;
  }): Promise<readonly DecisionSnapshot[]> {
    return this.#dependencies.projection.searchDecisions({
      query: input.query,
      asOf: input.asOf ?? this.#dependencies.clock.now(),
      ...(input.privacy === undefined ? {} : { privacy: input.privacy }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
  }

  async getCurrentState(
    input: {
      readonly privacy?: readonly PrivacyClass[];
      readonly asOf?: Temporal.Instant;
    } = {},
  ): Promise<{
    readonly asOf: string;
    readonly preferences: readonly AssertionSnapshot[];
    readonly intents: Readonly<
      Record<Exclude<AssertionKind, "preference">, readonly AssertionSnapshot[]>
    >;
    readonly recentDecisions: readonly DecisionSnapshot[];
  }> {
    const asOf = input.asOf ?? this.#dependencies.clock.now();
    const [preferences, recentDecisions] = await Promise.all([
      this.searchAssertions({
        query: "",
        asOf,
        ...(input.privacy === undefined ? {} : { privacy: input.privacy }),
        limit: 100,
      }),
      this.searchDecisions({
        query: "",
        asOf,
        ...(input.privacy === undefined ? {} : { privacy: input.privacy }),
        limit: 20,
      }),
    ]);
    return {
      asOf: asOf.toString(),
      preferences: preferences.filter((assertion) => assertion.kind === "preference"),
      intents: groupIntents(preferences),
      recentDecisions,
    };
  }

  async generateMasterDocument(
    input: {
      readonly privacy?: readonly PrivacyClass[];
      readonly asOf?: Temporal.Instant;
    } = {},
  ): Promise<string> {
    const state = await this.getCurrentState(input);
    const preferences = state.preferences.length
      ? state.preferences
          .map(
            (assertion) =>
              `- ${assertion.object} (${assertion.epistemicOrigin}; Evidence: ${assertion.evidenceIds.join(", ")})`,
          )
          .join("\n")
      : "- No approved preferences.";
    const decisions = state.recentDecisions.length
      ? state.recentDecisions
          .map((decision) => `- ${decision.problem}: ${decision.chosenOptionId}`)
          .join("\n")
      : "- No recorded decisions.";
    const intents = INTENT_KINDS.map((kind) => {
      const values = state.intents[kind];
      return `### ${kind}\n\n${values.length === 0 ? "- None." : values.map((assertion) => `- ${assertion.object}`).join("\n")}`;
    }).join("\n\n");
    return `# Personal Master Document\n\nGenerated as of ${state.asOf}.\n\n## Preferences\n\n${preferences}\n\n## Intents\n\n${intents}\n\n## Recent Decisions\n\n${decisions}\n`;
  }

  async buildContext(input: {
    readonly task: string;
    readonly query: string;
    readonly asOf?: Temporal.Instant;
    readonly allowedPrivacy: readonly PrivacyClass[];
    readonly tokenBudget: number;
  }): Promise<ContextPack> {
    if (!Number.isInteger(input.tokenBudget) || input.tokenBudget < 1) {
      throw new Error("tokenBudget must be a positive integer.");
    }
    const asOf = input.asOf ?? this.#dependencies.clock.now();
    const [assertions, decisions, currentAssertions] = await Promise.all([
      this.searchAssertions({
        query: input.query,
        asOf,
        privacy: input.allowedPrivacy,
        limit: 50,
      }),
      this.searchDecisions({
        query: input.query,
        asOf,
        privacy: input.allowedPrivacy,
        limit: 50,
      }),
      this.searchAssertions({
        query: "",
        asOf,
        privacy: input.allowedPrivacy,
        limit: 100,
      }),
    ]);
    const relevantAssertions: AssertionSnapshot[] = [];
    const relevantDecisions: DecisionSnapshot[] = [];
    const rawEvidence: ContextEvidence[] = [];
    const counterEvidence: EvidenceSnapshot[] = [];
    const contradictions: string[] = [];
    const seenEvidence = new Set<string>();
    let estimatedTokens = estimateTokens(input.task);

    for (const assertion of assertions) {
      const cost = estimateTokens(JSON.stringify(assertion));
      if (estimatedTokens + cost > input.tokenBudget) {
        break;
      }
      relevantAssertions.push(assertion);
      estimatedTokens += cost;
    }
    for (const decision of decisions) {
      const cost = estimateTokens(JSON.stringify(decision));
      if (estimatedTokens + cost > input.tokenBudget) {
        break;
      }
      relevantDecisions.push(decision);
      estimatedTokens += cost;
    }

    const evidenceIds = [
      ...relevantAssertions.flatMap((assertion) => assertion.evidenceIds),
      ...relevantDecisions.flatMap((decision) => decision.evidenceIds),
    ];
    for (const evidenceIdValue of evidenceIds) {
      if (seenEvidence.has(evidenceIdValue)) {
        continue;
      }
      seenEvidence.add(evidenceIdValue);
      const evidence = await this.#dependencies.projection.getEvidence(evidenceIdValue);
      if (
        evidence === null ||
        evidence.purgedAt !== null ||
        !input.allowedPrivacy.includes(evidence.privacy)
      ) {
        continue;
      }
      const content = decoder.decode(
        await this.#dependencies.rawEvidenceStore.get(evidence.rawObjectRef),
      );
      const cost = estimateTokens(content) + estimateTokens(JSON.stringify(evidence));
      if (estimatedTokens + cost > input.tokenBudget) {
        continue;
      }
      rawEvidence.push({ evidence, content });
      estimatedTokens += cost;
    }

    const conflictingAssertions = currentAssertions.filter((candidate) =>
      relevantAssertions.some(
        (relevant) =>
          candidate.id !== relevant.id &&
          candidate.subjectId === relevant.subjectId &&
          candidate.predicate === relevant.predicate &&
          candidate.object.toLocaleLowerCase() !== relevant.object.toLocaleLowerCase(),
      ),
    );
    for (const conflicting of conflictingAssertions) {
      const relevant = relevantAssertions.find(
        (candidate) =>
          candidate.subjectId === conflicting.subjectId &&
          candidate.predicate === conflicting.predicate &&
          candidate.object.toLocaleLowerCase() !== conflicting.object.toLocaleLowerCase(),
      );
      if (relevant === undefined) {
        continue;
      }
      const description = `${relevant.id} (${relevant.object}) conflicts with ${conflicting.id} (${conflicting.object})`;
      const descriptionCost = estimateTokens(description);
      if (estimatedTokens + descriptionCost <= input.tokenBudget) {
        contradictions.push(description);
        estimatedTokens += descriptionCost;
      }
      for (const evidenceIdValue of conflicting.evidenceIds) {
        if (counterEvidence.some((evidence) => evidence.id === evidenceIdValue)) {
          continue;
        }
        const evidence = await this.#dependencies.projection.getEvidence(evidenceIdValue);
        if (evidence === null || !input.allowedPrivacy.includes(evidence.privacy)) {
          continue;
        }
        const cost = estimateTokens(JSON.stringify(evidence));
        if (estimatedTokens + cost <= input.tokenBudget) {
          counterEvidence.push(evidence);
          estimatedTokens += cost;
        }
      }
    }

    return {
      task: input.task,
      temporalScope: asOf.toString(),
      currentState: {
        preferences: relevantAssertions.filter((assertion) => assertion.kind === "preference"),
        intents: groupIntents(relevantAssertions),
      },
      relevantAssertions,
      relevantDecisions,
      rawEvidence,
      counterEvidence,
      contradictions,
      uncertainties:
        relevantAssertions.length === 0 && relevantDecisions.length === 0
          ? ["insufficient evidence"]
          : contradictions.length > 0
            ? ["conflicting active assertions require human review"]
            : [],
      privacyPolicy: input.allowedPrivacy,
      tokenBudget: input.tokenBudget,
      estimatedTokens,
    };
  }

  async rebuild(): Promise<number> {
    const events = await this.#dependencies.eventStore.readAll();
    await this.#dependencies.projection.reset();
    await this.#dependencies.projection.apply(events);
    return events.length;
  }

  async createBackup(): Promise<CanonicalBackup> {
    const evidence = await this.#dependencies.projection.listEvidence();
    const rawObjects: CanonicalBackupRawObject[] = [];
    for (const item of evidence) {
      if (item.purgedAt !== null) {
        continue;
      }
      const content = await this.#dependencies.rawEvidenceStore.get(item.rawObjectRef);
      rawObjects.push({
        contentHash: item.contentHash,
        rawObjectRef: item.rawObjectRef,
        bytes: [...content],
      });
    }
    return {
      schemaVersion: 1,
      createdAt: this.#dependencies.clock.now().toString(),
      events: await this.#dependencies.eventStore.readAll(),
      rawObjects,
    };
  }

  async createEncryptedBackup(cipher: BackupCipherPort): Promise<Uint8Array> {
    return cipher.encrypt(encoder.encode(JSON.stringify(await this.createBackup())));
  }

  async restoreEncryptedBackup(
    encryptedBackup: Uint8Array,
    cipher: BackupCipherPort,
  ): Promise<IntegrityReport> {
    const plaintext = await cipher.decrypt(encryptedBackup);
    return this.restoreBackup(parseCanonicalBackup(JSON.parse(decoder.decode(plaintext))));
  }

  async restoreBackup(backup: CanonicalBackup): Promise<IntegrityReport> {
    if (backup.schemaVersion !== 1) {
      throw new Error(`Unsupported backup schema version: ${String(backup.schemaVersion)}.`);
    }
    if ((await this.#dependencies.eventStore.readAll()).length !== 0) {
      throw new Error("A backup can only be restored into an empty Event Store.");
    }
    for (const rawObject of backup.rawObjects) {
      const content = Uint8Array.from(rawObject.bytes);
      const actualHash = await this.#dependencies.contentHasher.sha256(content);
      if (actualHash.toString() !== rawObject.contentHash) {
        throw new EvidenceIntegrityViolation(rawObject.rawObjectRef);
      }
      const restoredReference = await this.#dependencies.rawEvidenceStore.put(actualHash, content);
      if (restoredReference !== rawObject.rawObjectRef) {
        throw new Error(
          `Raw Evidence reference changed during restore: ${rawObject.rawObjectRef} -> ${restoredReference}.`,
        );
      }
    }
    const restoredIdempotencyKeys = new Set<string>();
    for (let index = 0; index < backup.events.length;) {
      const first = backup.events[index]!;
      const batch = [first];
      if (first.idempotencyKey !== null) {
        if (restoredIdempotencyKeys.has(first.idempotencyKey)) {
          throw new Error(
            `Backup idempotency key ${first.idempotencyKey} is not stored as one contiguous append.`,
          );
        }
        for (let nextIndex = index + 1; nextIndex < backup.events.length; nextIndex += 1) {
          const next = backup.events[nextIndex]!;
          const previous = batch.at(-1)!;
          if (
            next.idempotencyKey !== first.idempotencyKey ||
            next.streamId !== first.streamId ||
            next.actor !== first.actor ||
            next.reason !== first.reason ||
            next.streamVersion !== previous.streamVersion + 1 ||
            next.globalPosition !== previous.globalPosition + 1
          ) {
            break;
          }
          batch.push(next);
        }
        restoredIdempotencyKeys.add(first.idempotencyKey);
      }

      const expectedVersion = await this.#dependencies.eventStore.getStreamVersion(first.streamId);
      if (
        batch.some(
          (stored, offset) =>
            stored.streamId !== first.streamId ||
            stored.streamVersion !== expectedVersion + offset + 1,
        )
      ) {
        throw new Error(`Backup stream ${first.streamId} is not in canonical version order.`);
      }
      await this.#dependencies.eventStore.append({
        streamId: first.streamId,
        expectedVersion,
        events: batch.map((stored) => stored.event),
        actor: first.actor,
        reason: first.reason,
        ...(first.idempotencyKey === null ? {} : { idempotencyKey: first.idempotencyKey }),
      });
      index += batch.length;
    }
    await this.rebuild();
    return this.verify();
  }

  async verify(): Promise<IntegrityReport> {
    const evidence = await this.#dependencies.projection.listEvidence();
    for (const item of evidence) {
      if (item.purgedAt !== null) {
        continue;
      }
      const raw = await this.#dependencies.rawEvidenceStore.get(item.rawObjectRef);
      const actual = await this.#dependencies.contentHasher.sha256(raw);
      if (actual.toString() !== item.contentHash) {
        throw new EvidenceIntegrityViolation(item.id);
      }
    }
    const events = await this.#dependencies.eventStore.readAll();
    return { evidenceChecked: evidence.length, eventCount: events.length };
  }

  async #getPendingProposal(id: string): Promise<ProposalSnapshot> {
    const proposal = await this.#dependencies.projection.getProposal(ProposalId.parse(id));
    if (proposal === null) {
      throw new ProposalNotFound(id);
    }
    return proposal;
  }

  async #timelineIdentity(event: CanonicalEvent): Promise<{
    readonly entityType: TimelineEntry["entityType"];
    readonly entityId: string;
    readonly privacy: PrivacyClass;
  } | null> {
    switch (event.type) {
      case "evidence.imported":
      case "evidence.purged":
        return {
          entityType: "evidence",
          entityId: event.evidence.id,
          privacy: event.evidence.privacy,
        };
      case "proposal.created":
        return {
          entityType: "proposal",
          entityId: event.proposal.id,
          privacy: event.proposal.assertion.privacy,
        };
      case "proposal.approved":
      case "proposal.rejected": {
        const proposal = await this.#dependencies.projection.getProposal(event.proposalId);
        return proposal === null
          ? null
          : { entityType: "proposal", entityId: proposal.id, privacy: proposal.assertion.privacy };
      }
      case "assertion.created":
        return {
          entityType: "assertion",
          entityId: event.assertion.id,
          privacy: event.assertion.privacy,
        };
      case "assertion.superseded":
        return {
          entityType: "assertion",
          entityId: event.successor.id,
          privacy: event.successor.privacy,
        };
      case "assertion.disputed":
      case "assertion.retracted":
        return {
          entityType: "assertion",
          entityId: event.assertion.id,
          privacy: event.assertion.privacy,
        };
      case "decision.recorded":
      case "decision.outcome_recorded":
        return {
          entityType: "decision",
          entityId: event.decision.id,
          privacy: event.decision.privacy,
        };
    }
    return unreachableEvent(event);
  }

  async #getAssertion(id: string): Promise<AssertionSnapshot> {
    const assertion = await this.#dependencies.projection.getAssertion(AssertionId.parse(id));
    if (assertion === null) {
      throw new AssertionNotFound(id);
    }
    return assertion;
  }

  async #appendAssertionEvent(
    assertionId: string,
    event: CanonicalEvent,
    actor: string,
    reason: string,
  ): Promise<void> {
    const streamId = `assertion:${assertionId}`;
    const stored = await this.#dependencies.eventStore.append({
      streamId,
      expectedVersion: await this.#dependencies.eventStore.getStreamVersion(streamId),
      events: [event],
      actor,
      reason,
    });
    await this.#dependencies.projection.apply(stored);
  }
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

export function parseCanonicalBackup(value: unknown): CanonicalBackup {
  if (!isRecord(value)) {
    throw new TypeError("Backup must be a JSON object.");
  }
  const record = value;
  if (record.schemaVersion !== 1 || typeof record.createdAt !== "string") {
    throw new TypeError("Backup schemaVersion or createdAt is invalid.");
  }
  if (!Array.isArray(record.events) || !Array.isArray(record.rawObjects)) {
    throw new TypeError("Backup events and rawObjects must be arrays.");
  }
  const events = record.events.map((item) => parseBackupEvent(item));
  const rawObjects = record.rawObjects.map((item) => parseBackupRawObject(item));
  return { schemaVersion: 1, createdAt: record.createdAt, events, rawObjects };
}

function parseBackupEvent(value: unknown): StoredEvent {
  if (!isRecord(value)) {
    throw new TypeError("A backup event must be an object.");
  }
  const record = value;
  const event = record.event;
  if (!isCanonicalEvent(event)) {
    throw new TypeError("A backup event payload has invalid canonical metadata.");
  }
  const globalPosition = record.globalPosition;
  const streamVersion = record.streamVersion;
  if (
    typeof globalPosition !== "number" ||
    !Number.isSafeInteger(globalPosition) ||
    typeof streamVersion !== "number" ||
    !Number.isSafeInteger(streamVersion) ||
    typeof record.streamId !== "string" ||
    typeof record.actor !== "string" ||
    typeof record.reason !== "string" ||
    (record.idempotencyKey !== null && typeof record.idempotencyKey !== "string")
  ) {
    throw new TypeError("A backup event has invalid storage metadata.");
  }
  return {
    globalPosition,
    streamId: record.streamId,
    streamVersion,
    event,
    actor: record.actor,
    reason: record.reason,
    idempotencyKey: record.idempotencyKey,
  };
}

function parseBackupRawObject(value: unknown): CanonicalBackupRawObject {
  if (!isRecord(value)) {
    throw new TypeError("A backup raw object must be an object.");
  }
  const record = value;
  if (
    typeof record.contentHash !== "string" ||
    typeof record.rawObjectRef !== "string" ||
    !Array.isArray(record.bytes) ||
    !record.bytes.every(
      (byte) => typeof byte === "number" && Number.isInteger(byte) && byte >= 0 && byte <= 255,
    )
  ) {
    throw new TypeError("A backup raw object has invalid metadata or bytes.");
  }
  ContentHash.parse(record.contentHash);
  return {
    contentHash: record.contentHash,
    rawObjectRef: record.rawObjectRef,
    bytes: record.bytes,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalEvent(value: unknown): value is CanonicalEvent {
  if (
    !isRecord(value) ||
    typeof value.type !== "string" ||
    typeof value.eventId !== "string" ||
    typeof value.occurredAt !== "string"
  ) {
    return false;
  }
  switch (value.type) {
    case "evidence.imported":
      return isRecord(value.evidence);
    case "evidence.purged":
      return isRecord(value.evidence) && isRecord(value.audit);
    case "proposal.created":
      return isRecord(value.proposal);
    case "proposal.approved":
      return (
        typeof value.proposalId === "string" &&
        typeof value.assertionId === "string" &&
        isRecord(value.audit)
      );
    case "proposal.rejected":
      return typeof value.proposalId === "string" && isRecord(value.audit);
    case "assertion.created":
      return (
        isRecord(value.assertion) && typeof value.proposalId === "string" && isRecord(value.audit)
      );
    case "assertion.superseded":
      return isRecord(value.previous) && isRecord(value.successor) && isRecord(value.audit);
    case "assertion.disputed":
    case "assertion.retracted":
      return isRecord(value.assertion) && isRecord(value.audit);
    case "decision.recorded":
    case "decision.outcome_recorded":
      return isRecord(value.decision) && isRecord(value.audit);
    default:
      return false;
  }
}
