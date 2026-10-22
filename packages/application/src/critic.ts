import type { ContextPack } from "./personal-os.ts";

export type CriticSeverity = "info" | "warning" | "error";

export interface CriticIssue {
  readonly code:
    | "conflicting_assertions"
    | "conflicting_decisions"
    | "disputed_or_retracted_assertion"
    | "uncited_prediction";
  readonly severity: CriticSeverity;
  readonly detail: string;
  readonly contextIds: readonly string[];
}

export interface CriticReport {
  readonly recommendation: "accept" | "revise" | "abstain";
  readonly issues: readonly CriticIssue[];
}

export class DecisionCritic {
  review(input: {
    readonly context: ContextPack;
    readonly prediction: string | null;
  }): CriticReport {
    const issues: CriticIssue[] = [];
    if (input.context.contradictions.length > 0) {
      issues.push({
        code: "conflicting_assertions",
        severity: "error",
        detail: input.context.contradictions.join("; "),
        contextIds: input.context.relevantAssertions.map((assertion) => assertion.id),
      });
    }

    const decisionsByProblem = new Map<string, typeof input.context.relevantDecisions>();
    for (const decision of input.context.relevantDecisions) {
      const key = `${decision.subjectId}:${decision.problem.trim().toLocaleLowerCase()}`;
      decisionsByProblem.set(key, [...(decisionsByProblem.get(key) ?? []), decision]);
    }
    for (const decisions of decisionsByProblem.values()) {
      if (new Set(decisions.map((decision) => decision.chosenOptionId)).size > 1) {
        issues.push({
          code: "conflicting_decisions",
          severity: "warning",
          detail: "Similar recorded Decisions selected different options.",
          contextIds: decisions.map((decision) => decision.id),
        });
      }
    }

    const challenged = input.context.relevantAssertions.filter(
      (assertion) => assertion.status === "disputed" || assertion.status === "retracted",
    );
    if (challenged.length > 0) {
      issues.push({
        code: "disputed_or_retracted_assertion",
        severity: "warning",
        detail: "The Context Pack contains disputed or retracted Assertions.",
        contextIds: challenged.map((assertion) => assertion.id),
      });
    }

    if (input.prediction !== null && input.context.rawEvidence.length > 0) {
      const knownIds = [
        ...input.context.relevantAssertions.map((assertion) => assertion.id),
        ...input.context.relevantDecisions.map((decision) => decision.id),
        ...input.context.rawEvidence.map((item) => item.evidence.id),
      ];
      if (!knownIds.some((id) => input.prediction?.includes(id))) {
        issues.push({
          code: "uncited_prediction",
          severity: "warning",
          detail: "The prediction does not cite a retrieved Assertion, Decision, or Evidence ID.",
          contextIds: knownIds,
        });
      }
    }

    return {
      recommendation: issues.some((issue) => issue.severity === "error")
        ? "abstain"
        : issues.length > 0
          ? "revise"
          : "accept",
      issues,
    };
  }
}
