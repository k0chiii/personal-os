export const EVAL_CATEGORIES = [
  "fact",
  "temporal",
  "preference",
  "decision",
  "abstention",
  "intent",
  "contradiction",
  "historical_comparison",
  "retrieval_ranking",
  "provider_regression",
  "cloud_parity",
] as const;
export type EvalCategory = (typeof EVAL_CATEGORIES)[number];

export interface GoldCase {
  readonly id: string;
  readonly category: EvalCategory;
  readonly query: string;
  readonly asOf: string | null;
  readonly expectedEvidenceIds: readonly string[];
  readonly expectedAnswerTerms: readonly string[];
  readonly shouldAbstain: boolean;
}

export interface EvalCandidateResult {
  readonly answer: string;
  readonly evidenceIds: readonly string[];
  readonly abstained: boolean;
}

export interface EvalCaseResult {
  readonly caseId: string;
  readonly category: EvalCategory;
  readonly passed: boolean;
  readonly answerMatched: boolean;
  readonly evidenceGrounded: boolean;
  readonly abstentionMatched: boolean;
}

export interface EvalReport {
  readonly total: number;
  readonly passed: number;
  readonly accuracy: number;
  readonly byCategory: Readonly<
    Record<EvalCategory, { readonly total: number; readonly passed: number }>
  >;
  readonly cases: readonly EvalCaseResult[];
}

export type EvalCandidate = (testCase: GoldCase) => Promise<EvalCandidateResult>;

export async function runEval(
  cases: readonly GoldCase[],
  candidate: EvalCandidate,
): Promise<EvalReport> {
  const results: EvalCaseResult[] = [];
  for (const testCase of cases) {
    const actual = await candidate(testCase);
    const normalizedAnswer = actual.answer.toLocaleLowerCase("en-US");
    const answerMatched = testCase.expectedAnswerTerms.every((term) =>
      normalizedAnswer.includes(term.toLocaleLowerCase("en-US")),
    );
    const actualEvidence = new Set(actual.evidenceIds);
    const evidenceGrounded = testCase.expectedEvidenceIds.every((id) => actualEvidence.has(id));
    const abstentionMatched = actual.abstained === testCase.shouldAbstain;
    results.push({
      caseId: testCase.id,
      category: testCase.category,
      passed: answerMatched && evidenceGrounded && abstentionMatched,
      answerMatched,
      evidenceGrounded,
      abstentionMatched,
    });
  }

  const categorySummary = (
    category: EvalCategory,
  ): { readonly total: number; readonly passed: number } => {
    const categoryResults = results.filter((result) => result.category === category);
    return {
      total: categoryResults.length,
      passed: categoryResults.filter((result) => result.passed).length,
    };
  };
  const byCategory: EvalReport["byCategory"] = {
    fact: categorySummary("fact"),
    temporal: categorySummary("temporal"),
    preference: categorySummary("preference"),
    decision: categorySummary("decision"),
    abstention: categorySummary("abstention"),
    intent: categorySummary("intent"),
    contradiction: categorySummary("contradiction"),
    historical_comparison: categorySummary("historical_comparison"),
    retrieval_ranking: categorySummary("retrieval_ranking"),
    provider_regression: categorySummary("provider_regression"),
    cloud_parity: categorySummary("cloud_parity"),
  };
  const passed = results.filter((result) => result.passed).length;
  return {
    total: results.length,
    passed,
    accuracy: results.length === 0 ? 0 : passed / results.length,
    byCategory,
    cases: results,
  };
}

function numberedCases(
  category: Exclude<EvalCategory, "abstention">,
  count: number,
): readonly GoldCase[] {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    return {
      id: `${category}-${number.toString().padStart(3, "0")}`,
      category,
      query: `${category} gold query ${number}`,
      asOf: category === "temporal" ? `202${number % 6}-01-01T00:00:00Z` : null,
      expectedEvidenceIds: [`evidence-${category}-${number}`],
      expectedAnswerTerms: [`${category}-answer-${number}`],
      shouldAbstain: false,
    };
  });
}

const abstentionCases: readonly GoldCase[] = Array.from({ length: 10 }, (_, index) => {
  const number = index + 1;
  return {
    id: `abstention-${number.toString().padStart(3, "0")}`,
    category: "abstention",
    query: `unsupported gold query ${number}`,
    asOf: null,
    expectedEvidenceIds: [],
    expectedAnswerTerms: ["insufficient evidence"],
    shouldAbstain: true,
  };
});

export const V0_1_GOLD_CASES: readonly GoldCase[] = [
  ...numberedCases("fact", 30),
  ...numberedCases("temporal", 20),
  ...numberedCases("preference", 20),
  ...numberedCases("decision", 20),
  ...abstentionCases,
];

const v1Cases: readonly GoldCase[] = [
  ...numberedCases("intent", 10),
  ...numberedCases("contradiction", 10),
  ...numberedCases("historical_comparison", 10),
  ...numberedCases("retrieval_ranking", 10),
  ...numberedCases("provider_regression", 10),
  ...numberedCases("cloud_parity", 10),
];

export const V1_GOLD_CASES: readonly GoldCase[] = [...V0_1_GOLD_CASES, ...v1Cases];

export interface RetrievalGoldCase {
  readonly id: string;
  readonly query: string;
  readonly relevantIds: readonly string[];
}

export interface RetrievalEvalReport {
  readonly total: number;
  readonly meanReciprocalRank: number;
  readonly recallAtK: number;
  readonly k: number;
}

export async function runRetrievalEval(
  cases: readonly RetrievalGoldCase[],
  candidate: (testCase: RetrievalGoldCase) => Promise<readonly string[]>,
  k = 10,
): Promise<RetrievalEvalReport> {
  if (!Number.isInteger(k) || k < 1) {
    throw new RangeError("k must be a positive integer.");
  }
  let reciprocalRankTotal = 0;
  let recalled = 0;
  let relevant = 0;
  for (const testCase of cases) {
    const ranked = await candidate(testCase);
    const relevantIds = new Set(testCase.relevantIds);
    const firstRelevant = ranked.findIndex((id) => relevantIds.has(id));
    reciprocalRankTotal += firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1);
    recalled += ranked.slice(0, k).filter((id) => relevantIds.has(id)).length;
    relevant += relevantIds.size;
  }
  return {
    total: cases.length,
    meanReciprocalRank: cases.length === 0 ? 0 : reciprocalRankTotal / cases.length,
    recallAtK: relevant === 0 ? 0 : recalled / relevant,
    k,
  };
}
