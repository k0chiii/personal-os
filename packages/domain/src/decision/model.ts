import { Temporal } from "temporal-polyfill";

import { DecisionId, EntityId, EvidenceId } from "../shared/id.ts";
import { DomainInvariantError, type PrivacyClass } from "../memory/model.ts";

export interface DecisionOptionSnapshot {
  readonly id: string;
  readonly label: string;
  readonly rejectedReason: string | null;
}

export interface DecisionCriterionSnapshot {
  readonly name: string;
  readonly description: string;
}

export interface DecisionOutcomeSnapshot {
  readonly summary: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
}

export interface DecisionSnapshot {
  readonly id: string;
  readonly subjectId: string;
  readonly problem: string;
  readonly options: readonly DecisionOptionSnapshot[];
  readonly chosenOptionId: string;
  readonly criteria: readonly DecisionCriterionSnapshot[];
  readonly rationale: string;
  readonly constraints: readonly string[];
  readonly stateSnapshot: string;
  readonly evidenceIds: readonly string[];
  readonly decidedAt: string;
  readonly recordedAt: string;
  readonly privacy: PrivacyClass;
  readonly outcome: DecisionOutcomeSnapshot | null;
  readonly retrospective: string | null;
}

function nonBlank(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new DomainInvariantError(`${field} must not be blank.`);
  }
  return normalized;
}

export function createDecision(input: {
  readonly id: string;
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
  readonly recordedAt: Temporal.Instant;
  readonly privacy: PrivacyClass;
}): DecisionSnapshot {
  if (input.options.length < 2) {
    throw new DomainInvariantError("A Decision must include at least two Options.");
  }
  const options = input.options.map((option) => ({
    id: nonBlank(option.id, "option id"),
    label: nonBlank(option.label, "option label"),
    rejectedReason: option.rejectedReason,
  }));
  if (new Set(options.map((option) => option.id)).size !== options.length) {
    throw new DomainInvariantError("Decision Option IDs must be unique.");
  }
  if (!options.some((option) => option.id === input.chosenOptionId)) {
    throw new DomainInvariantError("chosenOptionId must refer to one of the Decision Options.");
  }
  if (input.criteria.length === 0) {
    throw new DomainInvariantError("A Decision must include at least one Criterion.");
  }
  const evidenceIds = [...new Set(input.evidenceIds.map((id) => EvidenceId.parse(id)))];
  if (evidenceIds.length === 0) {
    throw new DomainInvariantError("A Decision must reference at least one Evidence item.");
  }

  return {
    id: DecisionId.parse(input.id),
    subjectId: EntityId.parse(input.subjectId),
    problem: nonBlank(input.problem, "problem"),
    options,
    chosenOptionId: input.chosenOptionId,
    criteria: input.criteria.map((criterion) => ({
      name: nonBlank(criterion.name, "criterion name"),
      description: nonBlank(criterion.description, "criterion description"),
    })),
    rationale: nonBlank(input.rationale, "rationale"),
    constraints: (input.constraints ?? []).map((constraint) => nonBlank(constraint, "constraint")),
    stateSnapshot: nonBlank(input.stateSnapshot, "stateSnapshot"),
    evidenceIds,
    decidedAt: input.decidedAt.toString(),
    recordedAt: input.recordedAt.toString(),
    privacy: input.privacy,
    outcome: null,
    retrospective: null,
  };
}

export function recordDecisionOutcome(input: {
  readonly decision: DecisionSnapshot;
  readonly summary: string;
  readonly occurredAt: Temporal.Instant;
  readonly recordedAt: Temporal.Instant;
  readonly retrospective?: string | null;
}): DecisionSnapshot {
  if (input.decision.outcome !== null) {
    throw new DomainInvariantError("A Decision Outcome has already been recorded.");
  }
  return {
    ...input.decision,
    outcome: {
      summary: nonBlank(input.summary, "outcome summary"),
      occurredAt: input.occurredAt.toString(),
      recordedAt: input.recordedAt.toString(),
    },
    retrospective:
      input.retrospective === null || input.retrospective === undefined
        ? null
        : nonBlank(input.retrospective, "retrospective"),
  };
}
