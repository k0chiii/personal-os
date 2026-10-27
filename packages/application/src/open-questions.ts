import {
  ASSERTION_KINDS,
  type AssertionKind,
  type AssertionStatus,
  type PrivacyClass,
} from "@personal-os/domain";

export const QUESTION_CODES = ["missing", "conflict", "uncited"] as const;
export type QuestionCode = (typeof QUESTION_CODES)[number];

export interface QuestionAssertion {
  readonly kind: AssertionKind;
  readonly subjectId: string;
  readonly predicate: string;
  readonly object: string;
  readonly privacy: PrivacyClass;
  readonly evidenceIds: readonly string[];
  readonly status: AssertionStatus;
}

export interface OpenQuestion {
  readonly kind: AssertionKind;
  readonly code: QuestionCode;
  readonly prompt: string;
}

export interface QuestionWording {
  rewrite(prompt: string): Promise<string>;
}

const KIND_LABELS = {
  preference: "好み",
  goal: "目標",
  project: "プロジェクト",
  artifact: "成果物",
  research_topic: "研究テーマ",
  value: "価値観",
  belief: "信念",
  constraint: "制約",
} as const satisfies Record<AssertionKind, string>;

const PROMPT_TEMPLATES = {
  missing: (label: string) => `いまの${label}を一言で教えてください。`,
  conflict: (label: string) => `${label}が食い違っています。どちらを残しますか。`,
  uncited: (label: string) => `根拠のない${label}があります。根拠を一言で教えてください。`,
} as const satisfies Record<QuestionCode, (label: string) => string>;

const QUESTION_LIMIT = 3;

export function openQuestions(input: {
  readonly assertions: readonly QuestionAssertion[];
  readonly kinds: readonly AssertionKind[];
  readonly pendingKinds?: readonly AssertionKind[];
}): readonly OpenQuestion[] {
  if (input.kinds.length === 0) return [];
  const pending = new Set(input.pendingKinds ?? []);
  const questions: OpenQuestion[] = [];
  for (const kind of input.kinds) {
    for (const code of holeCodes(activeOfKind(input.assertions, kind), pending.has(kind))) {
      questions.push({ kind, code, prompt: PROMPT_TEMPLATES[code](KIND_LABELS[kind]) });
      if (questions.length === QUESTION_LIMIT) return questions;
    }
  }
  return questions;
}

export function wordingOrTemplate(
  kind: AssertionKind,
  template: string,
  modelText: string,
): string {
  if (hasLineBreak(modelText)) return template;
  const text = withoutSurroundingQuotes(modelText.trim()).trim();
  const label = KIND_LABELS[kind];
  if (hasLineBreak(text) || text.length < 1 || text.length > 120) return template;
  if (!text.includes(label) || namesAnotherKind(kind, text)) return template;
  return text;
}

function activeOfKind(
  assertions: readonly QuestionAssertion[],
  kind: AssertionKind,
): readonly QuestionAssertion[] {
  return assertions.filter((assertion) => assertion.kind === kind && assertion.status === "active");
}

function holeCodes(
  active: readonly QuestionAssertion[],
  pending: boolean,
): readonly QuestionCode[] {
  if (active.length === 0) return pending ? [] : ["missing"];
  const visible = active.filter((assertion) => isVisible(assertion.privacy));
  if (visible.length === 0) return [];
  const codes: QuestionCode[] = [];
  if (visible.some((assertion) => assertion.evidenceIds.length === 0)) codes.push("uncited");
  if (hasConflict(visible)) codes.push("conflict");
  return codes;
}

function isVisible(privacy: PrivacyClass): boolean {
  return privacy === "P0" || privacy === "P1" || privacy === "P2";
}

function hasConflict(visible: readonly QuestionAssertion[]): boolean {
  const seen = new Map<string, Map<string, string>>();
  for (const assertion of visible) {
    let predicates = seen.get(assertion.subjectId);
    if (predicates === undefined) {
      predicates = new Map<string, string>();
      seen.set(assertion.subjectId, predicates);
    }
    const object = assertion.object.toLocaleLowerCase();
    const previous = predicates.get(assertion.predicate);
    if (previous !== undefined && previous !== object) return true;
    predicates.set(assertion.predicate, object);
  }
  return false;
}

function namesAnotherKind(kind: AssertionKind, text: string): boolean {
  return ASSERTION_KINDS.some((other) => other !== kind && text.includes(KIND_LABELS[other]));
}

function hasLineBreak(text: string): boolean {
  return text.includes("\n") || text.includes("\r");
}

function withoutSurroundingQuotes(text: string): string {
  const pairs: readonly (readonly [string, string])[] = [
    ['"', '"'],
    ["'", "'"],
    ["「", "」"],
  ];
  for (const [open, close] of pairs) {
    if (
      text.startsWith(open) &&
      text.endsWith(close) &&
      text.length >= open.length + close.length
    ) {
      return text.slice(open.length, text.length - close.length);
    }
  }
  return text;
}
