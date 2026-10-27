export interface Session {
  apiBase: string;
  accessToken: string;
}

export interface Proposal {
  id: string;
  assertion: {
    kind: string;
    object: string;
    privacy: string;
    evidenceIds: string[];
  };
  createdAt: string;
}

export interface TimelineEntry {
  operation: string;
  occurredAt: string;
  actor: string;
  reason: string;
  entityType: string;
  entityId: string;
  privacy: string;
}

export interface Assertion {
  id: string;
  kind: string;
  object: string;
  privacy: string;
  validFrom: string;
}

export interface CurrentState {
  asOf: string;
  preferences: Assertion[];
  intents: Record<string, Assertion[]>;
}

export interface Decision {
  problem: string;
  rationale: string;
}

export interface SearchResults {
  assertions: Assertion[];
  decisions: Decision[];
}

export interface HealthStatus {
  status: "ok";
}

export class ApiUnreachableError extends Error {
  static readonly text = "API サーバーに接続できません";

  constructor(cause: unknown) {
    super(ApiUnreachableError.text, { cause });
    this.name = "ApiUnreachableError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string {
  const property = value[key];
  if (typeof property !== "string") throw new Error(`API response is missing ${key}.`);
  return property;
}

function stringList(value: unknown, message: string): string[] {
  if (!Array.isArray(value)) throw new Error(message);
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error(message);
    items.push(item);
  }
  return items;
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

export async function requestJson(
  session: Session,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  if (session.accessToken.length > 0) headers.set("authorization", `Bearer ${session.accessToken}`);
  let response: Response;
  try {
    response = await fetch(`${session.apiBase}${path}`, {
      headers,
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });
  } catch (cause: unknown) {
    throw new ApiUnreachableError(cause);
  }
  const text = await response.text();
  const contentType = response.headers.get("content-type");
  const value =
    text.length === 0
      ? null
      : contentType?.includes("application/json") === true
        ? parseJson(text)
        : text;
  if (!response.ok) {
    const detail = isRecord(value) && typeof value.detail === "string" ? value.detail : null;
    throw new Error(detail ?? `Request failed (${response.status})`);
  }
  return value;
}

export function healthResponse(value: unknown): HealthStatus {
  if (!isRecord(value) || value.status !== "ok") throw new Error("API 未接続");
  return { status: "ok" };
}

export function proposalsResponse(value: unknown): Proposal[] {
  if (!Array.isArray(value)) throw new Error("API returned an invalid proposal list.");
  return value.map((item) => {
    if (!isRecord(item) || !isRecord(item.assertion)) throw new Error("Invalid proposal.");
    return {
      id: stringField(item, "id"),
      assertion: {
        kind: stringField(item.assertion, "kind"),
        object: stringField(item.assertion, "object"),
        privacy: stringField(item.assertion, "privacy"),
        evidenceIds: stringList(item.assertion.evidenceIds, "Invalid proposal Evidence IDs."),
      },
      createdAt: stringField(item, "createdAt"),
    };
  });
}

export function timelineResponse(value: unknown): TimelineEntry[] {
  if (!Array.isArray(value)) throw new Error("API returned an invalid timeline.");
  return value.map((item) => {
    if (!isRecord(item)) throw new Error("Invalid timeline entry.");
    return {
      operation: stringField(item, "operation"),
      occurredAt: stringField(item, "occurredAt"),
      actor: stringField(item, "actor"),
      reason: stringField(item, "reason"),
      entityType: stringField(item, "entityType"),
      entityId: stringField(item, "entityId"),
      privacy: stringField(item, "privacy"),
    };
  });
}

export function assertionResponse(value: unknown): Assertion {
  if (!isRecord(value)) throw new Error("Invalid assertion.");
  return {
    id: stringField(value, "id"),
    kind: stringField(value, "kind"),
    object: stringField(value, "object"),
    privacy: stringField(value, "privacy"),
    validFrom: stringField(value, "validFrom"),
  };
}

export function currentStateResponse(value: unknown): CurrentState {
  if (!isRecord(value) || !Array.isArray(value.preferences) || !isRecord(value.intents)) {
    throw new Error("API returned an invalid current state.");
  }
  const intents: Record<string, Assertion[]> = {};
  for (const [kind, assertions] of Object.entries(value.intents)) {
    if (!Array.isArray(assertions)) throw new Error("Invalid intent group.");
    intents[kind] = assertions.map(assertionResponse);
  }
  return {
    asOf: stringField(value, "asOf"),
    preferences: value.preferences.map(assertionResponse),
    intents,
  };
}

function decisionResponse(value: unknown): Decision {
  if (!isRecord(value)) throw new Error("Invalid Decision result.");
  return {
    problem: stringField(value, "problem"),
    rationale: stringField(value, "rationale"),
  };
}

export interface Question {
  kind: string;
  code: "missing" | "conflict" | "uncited";
  prompt: string;
}

const QUESTION_CODES = ["missing", "conflict", "uncited"] as const;

export function questionsResponse(value: unknown): Question[] {
  if (!isRecord(value) || !Array.isArray(value.questions)) {
    throw new Error("API returned an invalid question list.");
  }
  return value.questions.map((item) => {
    if (!isRecord(item)) throw new Error("Invalid question.");
    const code = stringField(item, "code");
    const matched = QUESTION_CODES.find((candidate) => candidate === code);
    if (matched === undefined) throw new Error("Invalid question.");
    return {
      kind: stringField(item, "kind"),
      code: matched,
      prompt: stringField(item, "prompt"),
    };
  });
}

export function createdEvidenceId(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.evidence)) {
    throw new Error("API returned invalid evidence.");
  }
  return stringField(value.evidence, "id");
}

export function searchResponse(value: unknown): SearchResults {
  if (!isRecord(value) || !Array.isArray(value.assertions) || !Array.isArray(value.decisions)) {
    throw new Error("API returned invalid search results.");
  }
  return {
    assertions: value.assertions.map(assertionResponse),
    decisions: value.decisions.map(decisionResponse),
  };
}
