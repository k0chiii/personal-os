import { describe, expect, it } from "vite-plus/test";

import {
  openQuestions,
  wordingOrTemplate,
  type QuestionAssertion,
} from "../../packages/application/src/index.ts";

function assertion(
  overrides: {
    readonly kind?: QuestionAssertion["kind"];
    readonly subjectId?: string;
    readonly predicate?: string;
    readonly object?: string;
    readonly privacy?: QuestionAssertion["privacy"];
    readonly evidenceIds?: readonly string[];
    readonly status?: QuestionAssertion["status"];
  } = {},
): QuestionAssertion {
  return {
    kind: overrides.kind ?? "preference",
    subjectId: overrides.subjectId ?? "subject-1",
    predicate: overrides.predicate ?? "prefers",
    object: overrides.object ?? "朝型",
    privacy: overrides.privacy ?? "P1",
    evidenceIds: overrides.evidenceIds ?? ["evidence-1"],
    status: overrides.status ?? "active",
  };
}

const preferenceTemplate = "いまの好みを一言で教えてください。";

describe("openQuestions", () => {
  it("returns nothing when no kind is selected", () => {
    expect(openQuestions({ kinds: [], assertions: [assertion()] })).toEqual([]);
  });

  it("skips a missing kind that already has a pending proposal", () => {
    expect(
      openQuestions({
        kinds: ["goal"],
        assertions: [],
        pendingKinds: ["goal"],
      }),
    ).toEqual([]);
  });

  it("asks only for the selected kind that has no assertions", () => {
    expect(
      openQuestions({
        kinds: ["goal"],
        assertions: [assertion({ kind: "preference", object: "朝型" })],
      }),
    ).toEqual([
      {
        kind: "goal",
        code: "missing",
        prompt: "いまの目標を一言で教えてください。",
      },
    ]);
  });

  it("reports one conflict when two visible assertions disagree on the object", () => {
    expect(
      openQuestions({
        kinds: ["preference"],
        assertions: [
          assertion({ subjectId: "same", predicate: "prefers", object: "朝型" }),
          assertion({
            subjectId: "same",
            predicate: "prefers",
            object: "夜型",
            evidenceIds: ["evidence-2"],
          }),
        ],
      }),
    ).toEqual([
      {
        kind: "preference",
        code: "conflict",
        prompt: "好みが食い違っています。どちらを残しますか。",
      },
    ]);
  });

  it("does not treat a different subject as a conflict", () => {
    expect(
      openQuestions({
        kinds: ["preference"],
        assertions: [
          assertion({ subjectId: "one", predicate: "prefers", object: "朝型" }),
          assertion({
            subjectId: "two",
            predicate: "prefers",
            object: "夜型",
            evidenceIds: ["evidence-2"],
          }),
        ],
      }),
    ).toEqual([]);
  });

  it("asks for evidence once when a visible assertion cites nothing", () => {
    const questions = openQuestions({
      kinds: ["belief"],
      assertions: [
        assertion({ kind: "belief", object: "秘密の信念", evidenceIds: [] }),
        assertion({
          kind: "belief",
          object: "もう一つの秘密",
          evidenceIds: [],
          subjectId: "subject-2",
        }),
      ],
    });

    expect(questions).toEqual([
      {
        kind: "belief",
        code: "uncited",
        prompt: "根拠のない信念があります。根拠を一言で教えてください。",
      },
    ]);
    expect(questions[0]?.prompt).not.toContain("秘密の信念");
  });

  it("ignores superseded assertions", () => {
    expect(
      openQuestions({
        kinds: ["preference"],
        assertions: [
          assertion({
            status: "superseded",
            subjectId: "same",
            predicate: "prefers",
            object: "古い好み",
            evidenceIds: [],
          }),
          assertion({
            status: "active",
            subjectId: "same",
            predicate: "prefers",
            object: "新しい好み",
            evidenceIds: ["evidence-1"],
          }),
        ],
      }),
    ).toEqual([]);
  });

  it("asks nothing when the only active assertion is P3", () => {
    expect(
      openQuestions({
        kinds: ["constraint"],
        assertions: [
          assertion({ kind: "constraint", privacy: "P3", object: "社外秘の制約", evidenceIds: [] }),
        ],
      }),
    ).toEqual([]);
  });

  it("keeps both conflicting objects out of the prompt", () => {
    const questions = openQuestions({
      kinds: ["value"],
      assertions: [
        assertion({ kind: "value", predicate: "values", object: "静けさ", subjectId: "same" }),
        assertion({
          kind: "value",
          predicate: "values",
          object: "速度",
          subjectId: "same",
          evidenceIds: ["evidence-2"],
        }),
      ],
    });

    expect(questions[0]?.prompt).not.toContain("静けさ");
    expect(questions[0]?.prompt).not.toContain("速度");
  });

  it("returns three questions, uncited before conflict before missing", () => {
    const questions = openQuestions({
      kinds: ["preference", "goal", "project"],
      assertions: [
        assertion({
          kind: "preference",
          subjectId: "same",
          predicate: "prefers",
          object: "朝型",
          evidenceIds: [],
        }),
        assertion({
          kind: "preference",
          subjectId: "same",
          predicate: "prefers",
          object: "夜型",
          evidenceIds: ["evidence-2"],
        }),
      ],
    });

    expect(questions.map((question) => question.code)).toEqual(["uncited", "conflict", "missing"]);
    expect(questions.map((question) => question.kind)).toEqual([
      "preference",
      "preference",
      "goal",
    ]);
    for (const question of questions) {
      expect(question.prompt).not.toContain("朝型");
      expect(question.prompt).not.toContain("夜型");
    }
  });
});

describe("wordingOrTemplate", () => {
  it("keeps a short rewrite that contains the kind label", () => {
    expect(wordingOrTemplate("preference", preferenceTemplate, "いまの好みは静かな朝です。")).toBe(
      "いまの好みは静かな朝です。",
    );
  });

  it("returns the template when the rewrite names a different kind label", () => {
    expect(wordingOrTemplate("preference", preferenceTemplate, "好みではなく目標です。")).toBe(
      preferenceTemplate,
    );
  });

  it("returns the template when the rewrite is empty", () => {
    expect(wordingOrTemplate("preference", preferenceTemplate, "")).toBe(preferenceTemplate);
    expect(wordingOrTemplate("preference", preferenceTemplate, "   ")).toBe(preferenceTemplate);
  });

  it("returns the template when the rewrite is longer than 120 characters", () => {
    const rewrite = `${"あ".repeat(119)}好み`;
    expect(rewrite).toHaveLength(121);
    expect(wordingOrTemplate("preference", preferenceTemplate, rewrite)).toBe(preferenceTemplate);
  });

  it("strips one pair of surrounding quotes and rejects a line break", () => {
    expect(
      wordingOrTemplate("preference", preferenceTemplate, '"いまの好みは静かな朝です。"'),
    ).toBe("いまの好みは静かな朝です。");
    expect(
      wordingOrTemplate("preference", preferenceTemplate, "いまの好みは\n静かな朝です。"),
    ).toBe(preferenceTemplate);
  });
});
