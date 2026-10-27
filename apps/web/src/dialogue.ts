import type { SearchResults } from "./api.ts";

declare const turnIdBrand: unique symbol;

/** Minted by `send` or preserved by `retry`. Callers do not construct one. */
export type TurnId = string & { readonly [turnIdBrand]: never };

export type OwnerUtterance = {
  /** Trimmed, non-empty. This is the search `query`. */
  readonly text: string;
};

/** At least one paragraph. Empty search is the fixed sentence, not an empty array. */
export type SystemUtterance = {
  readonly paragraphs: readonly [string, ...string[]];
};

export type SendFailure = {
  readonly message: string;
};

/**
 * One owner sentence and where the system answer stands.
 * `idle` has no sentence. `sending` has no system turn yet.
 * `reply` has frozen paragraphs. `failed` has no system turn.
 */
export type Turn =
  | { readonly phase: "idle" }
  | { readonly phase: "sending"; readonly id: TurnId; readonly owner: OwnerUtterance }
  | {
      readonly phase: "reply";
      readonly id: TurnId;
      readonly owner: OwnerUtterance;
      readonly system: SystemUtterance;
    }
  | {
      readonly phase: "failed";
      readonly id: TurnId;
      readonly owner: OwnerUtterance;
      readonly failure: SendFailure;
    };

type PastTurn = Extract<Turn, { phase: "reply" | "failed" }>;
type OpenTurn = Extract<Turn, { phase: "idle" | "sending" | "failed" }>;

/**
 * Single source of the dialogue.
 * `past` is sealed. `open` is the only live turn.
 * A failed turn lives in `open` until retry settles it or a new `send` moves it to `past`.
 */
export type Transcript = {
  readonly past: readonly PastTurn[];
  readonly open: OpenTurn;
};

type Assert<T extends true> = T;
type _ReplyIsNotOpen = Assert<Extract<OpenTurn, { phase: "reply" }> extends never ? true : false>;
type _SendingIsNotPast = Assert<
  Extract<PastTurn, { phase: "sending" | "idle" }> extends never ? true : false
>;

export type StoredTurn = Exclude<Turn, { phase: "idle" }>;

/**
 * `accepted` means `sending` is `open` and the shell should POST /v1/search
 * with `sending.owner.text`. Refusal keeps the same `transcript` reference.
 */
export type Handoff =
  | { readonly accepted: false; readonly transcript: Transcript }
  | {
      readonly accepted: true;
      readonly transcript: Transcript;
      readonly sending: Extract<Turn, { phase: "sending" }>;
    };

const EMPTY_HIT = "記憶には見つかりませんでした。";

/** `{ past: [], open: { phase: "idle" } }`. */
export function emptyTranscript(): Transcript {
  return { past: [], open: { phase: "idle" } };
}

/**
 * Refuse when `open` is `sending` or `text` trims empty.
 * From `idle`, replace `open` with `sending`.
 * From `failed`, append that failure to `past`, then replace `open` with a new `sending`.
 * `nextId` defaults to `() => crypto.randomUUID()`.
 */
export function send(
  transcript: Transcript,
  text: string,
  nextId: () => string = () => crypto.randomUUID(),
): Handoff {
  if (transcript.open.phase === "sending") return { accepted: false, transcript };
  const query = text.trim();
  if (query.length === 0) return { accepted: false, transcript };
  const sending = {
    phase: "sending" as const,
    id: nextId() as TurnId,
    owner: { text: query },
  };
  const past =
    transcript.open.phase === "failed" ? [...transcript.past, transcript.open] : transcript.past;
  return { accepted: true, transcript: { past, open: sending }, sending };
}

/** Same id and owner as the open failure, phase `sending`. Refuse otherwise. */
export function retry(transcript: Transcript): Handoff {
  if (transcript.open.phase !== "failed") return { accepted: false, transcript };
  const sending = {
    phase: "sending" as const,
    id: transcript.open.id,
    owner: transcript.open.owner,
  };
  return { accepted: true, transcript: { past: transcript.past, open: sending }, sending };
}

/**
 * If `open` is not `sending` with this id, return `transcript`.
 * Otherwise append `{ phase: "reply", system: { paragraphs } }` and set `open` to `idle`.
 * Paragraphs: each non-blank `assertion.object`, then each non-blank `decision.problem`
 * and `decision.rationale`. If that list is empty, one paragraph:
 * `記憶には見つかりませんでした。`
 */
export function settle(transcript: Transcript, id: TurnId, results: SearchResults): Transcript {
  if (transcript.open.phase !== "sending" || transcript.open.id !== id) return transcript;
  const reply = {
    phase: "reply" as const,
    id: transcript.open.id,
    owner: transcript.open.owner,
    system: { paragraphs: paragraphsOf(results) },
  };
  return { past: [...transcript.past, reply], open: { phase: "idle" } };
}

/** If `open` is not `sending` with this id, return `transcript`. Otherwise set `open` to `failed`. */
export function fail(transcript: Transcript, id: TurnId, failure: SendFailure): Transcript {
  if (transcript.open.phase !== "sending" || transcript.open.id !== id) return transcript;
  return {
    past: transcript.past,
    open: {
      phase: "failed",
      id: transcript.open.id,
      owner: transcript.open.owner,
      failure,
    },
  };
}

/** `past`, then `open` when `open` is not `idle`. */
export function visible(transcript: Transcript): readonly StoredTurn[] {
  if (transcript.open.phase === "idle") return transcript.past;
  return [...transcript.past, transcript.open];
}

function paragraphsOf(results: SearchResults): SystemUtterance["paragraphs"] {
  const paragraphs: string[] = [];
  for (const assertion of results.assertions) {
    const object = assertion.object.trim();
    if (object.length > 0) paragraphs.push(object);
  }
  for (const decision of results.decisions) {
    const problem = decision.problem.trim();
    if (problem.length > 0) paragraphs.push(problem);
    const rationale = decision.rationale.trim();
    if (rationale.length > 0) paragraphs.push(rationale);
  }
  const first = paragraphs[0];
  if (first === undefined) return [EMPTY_HIT];
  return [first, ...paragraphs.slice(1)];
}
