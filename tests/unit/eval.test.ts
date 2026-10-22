import { describe, expect, it } from "vite-plus/test";

import {
  V0_1_GOLD_CASES,
  V1_GOLD_CASES,
  runEval,
  runRetrievalEval,
} from "../../packages/eval/src/index.ts";

describe("v0.1 Eval framework", () => {
  it("contains the required 100-case category distribution", () => {
    const count = (category: string): number =>
      V0_1_GOLD_CASES.filter((testCase) => testCase.category === category).length;

    expect(V0_1_GOLD_CASES).toHaveLength(100);
    expect(count("fact")).toBe(30);
    expect(count("temporal")).toBe(20);
    expect(count("preference")).toBe(20);
    expect(count("decision")).toBe(20);
    expect(count("abstention")).toBe(10);
  });

  it("scores answer, Evidence grounding, and abstention independently", async () => {
    const report = await runEval(V0_1_GOLD_CASES, async (testCase) => ({
      answer: testCase.expectedAnswerTerms.join(" "),
      evidenceIds: testCase.expectedEvidenceIds,
      abstained: testCase.shouldAbstain,
    }));

    expect(report.total).toBe(100);
    expect(report.passed).toBe(100);
    expect(report.accuracy).toBe(1);
    expect(report.byCategory.abstention).toEqual({ total: 10, passed: 10 });
  });
});

describe("v1 Eval framework", () => {
  it("adds ten cases for each deferred v1 release-gate category", () => {
    expect(V1_GOLD_CASES).toHaveLength(160);
    for (const category of [
      "intent",
      "contradiction",
      "historical_comparison",
      "retrieval_ranking",
      "provider_regression",
      "cloud_parity",
    ]) {
      expect(V1_GOLD_CASES.filter((testCase) => testCase.category === category)).toHaveLength(10);
    }
  });

  it("reports MRR and recall at k for ranked retrieval", async () => {
    const report = await runRetrievalEval(
      [
        { id: "one", query: "alpha", relevantIds: ["a"] },
        { id: "two", query: "beta", relevantIds: ["b", "c"] },
      ],
      async (testCase) => (testCase.id === "one" ? ["x", "a"] : ["b", "x", "c"]),
      2,
    );
    expect(report).toEqual({ total: 2, meanReciprocalRank: 0.75, recallAtK: 2 / 3, k: 2 });
  });
});
