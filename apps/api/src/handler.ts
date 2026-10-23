import {
  DecisionSimulator,
  PersonalOsApplication,
  type ContextPack,
  type DecisionSimulation,
} from "@personal-os/application";
import {
  ASSERTION_KINDS,
  EPISTEMIC_ORIGINS,
  EVIDENCE_SOURCE_TYPES,
  PRIVACY_CLASSES,
  type AssertionKind,
  type EpistemicOrigin,
  type EvidenceSourceType,
  type PrivacyClass,
  type ProposalStatus,
} from "@personal-os/domain";
import {
  AssertionNotFound,
  EvidenceNotFound,
  PrivacyViolation,
  ProposalNotFound,
} from "@personal-os/ports";
import { Temporal } from "temporal-polyfill";

export interface ApiDependencies {
  readonly application: PersonalOsApplication;
  readonly simulator?: DecisionSimulator;
  readonly rateLimiter?: ApiRateLimiter;
  readonly authenticator?: ApiAuthenticator;
}

export interface ApiPrincipal {
  readonly subject: string;
}

export interface ApiAuthenticator {
  authenticate(request: Request): ApiPrincipal | null | Promise<ApiPrincipal | null>;
}

export interface ApiRateLimiter {
  check(
    key: string,
  ):
    | { readonly allowed: boolean; readonly retryAfterSeconds: number }
    | Promise<{ readonly allowed: boolean; readonly retryAfterSeconds: number }>;
}

export class FixedWindowRateLimiter implements ApiRateLimiter {
  readonly #limit: number;
  readonly #windowMilliseconds: number;
  readonly #now: () => number;
  readonly #windows = new Map<string, { count: number; resetAt: number }>();

  constructor(input: {
    readonly limit: number;
    readonly windowMilliseconds?: number;
    readonly now?: () => number;
  }) {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new RangeError("Rate limit must be a positive integer.");
    }
    this.#limit = input.limit;
    this.#windowMilliseconds = input.windowMilliseconds ?? 60_000;
    this.#now = input.now ?? Date.now;
  }

  check(key: string): { readonly allowed: boolean; readonly retryAfterSeconds: number } {
    const now = this.#now();
    const current = this.#windows.get(key);
    if (current === undefined || current.resetAt <= now) {
      this.#windows.set(key, { count: 1, resetAt: now + this.#windowMilliseconds });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    current.count += 1;
    return {
      allowed: current.count <= this.#limit,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1_000)),
    };
  }
}

export function createApiHandler(
  dependencies: ApiDependencies,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ status: "ok" });
      }

      if (
        dependencies.authenticator !== undefined &&
        (await dependencies.authenticator.authenticate(request)) === null
      ) {
        return problem(401, "authentication_required", "An authenticated identity is required.");
      }

      if (dependencies.rateLimiter !== undefined) {
        const clientKey =
          request.headers.get("cf-connecting-ip") ??
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          "anonymous";
        const rateLimit = await dependencies.rateLimiter.check(clientKey);
        if (!rateLimit.allowed) {
          return Response.json(
            { code: "rate_limited", detail: "Request rate limit exceeded." },
            { status: 429, headers: { "retry-after": String(rateLimit.retryAfterSeconds) } },
          );
        }
      }

      if (request.method === "POST" && url.pathname === "/v1/evidence") {
        const body = recordBody(await request.json());
        const occurredAt = optionalStringField(body, "occurredAt");
        return json(
          await dependencies.application.importTextEvidence({
            content: stringField(body, "content"),
            sourceType: evidenceSourceTypeField(body, "sourceType"),
            sourceUri: optionalStringField(body, "sourceUri"),
            occurredAt: occurredAt === null ? null : Temporal.Instant.from(occurredAt),
            author: optionalStringField(body, "author"),
            privacy: privacyClassField(body, "privacy"),
            mediaType: stringField(body, "mediaType"),
            actor: stringField(body, "actor"),
            reason: stringField(body, "reason"),
          }),
          201,
        );
      }

      const purgeEvidenceMatch = /^\/v1\/evidence\/([^/]+)$/.exec(url.pathname);
      if (request.method === "DELETE" && purgeEvidenceMatch !== null) {
        const body = recordBody(await request.json());
        return json(
          await dependencies.application.purgeEvidence({
            evidenceId: purgeEvidenceMatch[1]!,
            actor: stringField(body, "actor"),
            reason: stringField(body, "reason"),
          }),
        );
      }

      if (request.method === "POST" && url.pathname === "/v1/retention/run") {
        const body = recordBody(await request.json());
        return json(
          await dependencies.application.executeRetention({
            importedBefore: Temporal.Instant.from(stringField(body, "importedBefore")),
            privacy: privacyField(body, "privacy"),
            actor: stringField(body, "actor"),
            reason: stringField(body, "reason"),
          }),
        );
      }

      if (request.method === "GET" && url.pathname === "/v1/self/current") {
        const privacy = url.searchParams.get("privacy");
        return json(
          await dependencies.application.getCurrentState({
            ...(privacy === null ? {} : { privacy: parsePrivacyQuery(privacy) }),
          }),
        );
      }

      if (request.method === "GET" && url.pathname === "/v1/intents") {
        const privacy = url.searchParams.get("privacy");
        const state = await dependencies.application.getCurrentState({
          ...(privacy === null ? {} : { privacy: parsePrivacyQuery(privacy) }),
        });
        return json({ asOf: state.asOf, intents: state.intents });
      }

      if (request.method === "GET" && url.pathname === "/v1/proposals") {
        const status = url.searchParams.get("status");
        return json(await dependencies.application.listProposals(proposalStatus(status)));
      }

      if (request.method === "GET" && url.pathname === "/v1/timeline") {
        const privacy = url.searchParams.get("privacy");
        const limit = url.searchParams.get("limit");
        return json(
          await dependencies.application.getTimeline({
            privacy: privacy === null ? ["P0", "P1", "P2", "P3"] : parsePrivacyQuery(privacy),
            ...(limit === null ? {} : { limit: Number.parseInt(limit, 10) }),
          }),
        );
      }

      const assertionMatch = /^\/v1\/assertions\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && assertionMatch !== null) {
        return json(await dependencies.application.explainAssertion(assertionMatch[1]!));
      }

      if (request.method === "POST" && url.pathname === "/v1/search") {
        const body = recordBody(await request.json());
        const query = stringField(body, "query");
        const privacy = privacyField(body, "privacy");
        const at = optionalStringField(body, "at");
        const [assertions, decisions] = await Promise.all([
          dependencies.application.searchAssertions({
            query,
            privacy,
            ...(at === null ? {} : { asOf: Temporal.Instant.from(at) }),
          }),
          dependencies.application.searchDecisions({
            query,
            privacy,
            ...(at === null ? {} : { asOf: Temporal.Instant.from(at) }),
          }),
        ]);
        return json({ assertions, decisions });
      }

      if (request.method === "POST" && url.pathname === "/v1/context") {
        return json(await buildContext(dependencies.application, await request.json()));
      }

      if (request.method === "POST" && url.pathname === "/v1/simulations") {
        if (dependencies.simulator === undefined) {
          return problem(503, "simulation_unavailable", "No Decision Simulator is configured.");
        }
        return json(await simulate(dependencies.simulator, await request.json()));
      }

      if (request.method === "POST" && url.pathname === "/v1/proposals") {
        const body = recordBody(await request.json());
        const validUntil = optionalStringField(body, "validUntil");
        return json(
          await dependencies.application.proposeAssertion({
            subjectId: stringField(body, "subjectId"),
            kind: assertionKindField(body, "kind"),
            ...(optionalStringField(body, "predicate") === null
              ? {}
              : { predicate: stringField(body, "predicate") }),
            object: stringField(body, "object"),
            evidenceIds: stringArrayField(body, "evidenceIds"),
            epistemicOrigin: epistemicOriginField(body, "epistemicOrigin"),
            validFrom: Temporal.Instant.from(stringField(body, "validFrom")),
            validUntil: validUntil === null ? null : Temporal.Instant.from(validUntil),
            privacy: privacyClassField(body, "privacy"),
            createdBy: createdByField(body, "createdBy"),
            actor: stringField(body, "actor"),
            reason: stringField(body, "reason"),
          }),
          201,
        );
      }

      const approveMatch = /^\/v1\/proposals\/([^/]+)\/approve$/.exec(url.pathname);
      if (request.method === "POST" && approveMatch !== null) {
        const body = recordBody(await request.json());
        const editedObject = optionalStringField(body, "editedObject");
        const assertion = await dependencies.application.approveProposal({
          proposalId: approveMatch[1]!,
          actor: stringField(body, "actor"),
          reason: stringField(body, "reason"),
          ...(editedObject === null ? {} : { editedObject }),
        });
        return json(assertion, 201);
      }

      const rejectMatch = /^\/v1\/proposals\/([^/]+)\/reject$/.exec(url.pathname);
      if (request.method === "POST" && rejectMatch !== null) {
        const body = recordBody(await request.json());
        return json(
          await dependencies.application.rejectProposal({
            proposalId: rejectMatch[1]!,
            actor: stringField(body, "actor"),
            reason: stringField(body, "reason"),
          }),
        );
      }

      return problem(404, "not_found", "No route matches the request.");
    } catch (error: unknown) {
      return errorResponse(error);
    }
  };
}

async function buildContext(
  application: PersonalOsApplication,
  value: unknown,
): Promise<ContextPack> {
  const body = recordBody(value);
  const at = optionalStringField(body, "at");
  return application.buildContext({
    task: stringField(body, "task"),
    query: stringField(body, "query"),
    allowedPrivacy: privacyField(body, "privacy"),
    tokenBudget: numberField(body, "tokenBudget"),
    ...(at === null ? {} : { asOf: Temporal.Instant.from(at) }),
  });
}

async function simulate(simulator: DecisionSimulator, value: unknown): Promise<DecisionSimulation> {
  const body = recordBody(value);
  const preferLocal = optionalBooleanField(body, "preferLocal");
  return simulator.simulate({
    task: stringField(body, "task"),
    query: stringField(body, "query"),
    allowedPrivacy: privacyField(body, "privacy"),
    tokenBudget: numberField(body, "tokenBudget"),
    ...(preferLocal === null ? {} : { preferLocal }),
  });
}

function recordBody(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError("Request body must be a JSON object.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${key} must be a non-empty string.`);
  }
  return value;
}

function optionalStringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new TypeError(`${key} must be a string.`);
  }
  return value;
}

function optionalBooleanField(body: Record<string, unknown>, key: string): boolean | null {
  const value = body[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "boolean") {
    throw new TypeError(`${key} must be a boolean.`);
  }
  return value;
}

function numberField(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${key} must be a finite number.`);
  }
  return value;
}

function stringArrayField(body: Record<string, unknown>, key: string): readonly string[] {
  const value = body[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new TypeError(`${key} must be an array of strings.`);
  }
  return value;
}

function privacyClassField(body: Record<string, unknown>, key: string): PrivacyClass {
  const value = stringField(body, key);
  const matched = PRIVACY_CLASSES.find((privacy) => privacy === value);
  if (matched === undefined) {
    throw new TypeError(`${key} contains an unsupported privacy class.`);
  }
  return matched;
}

function epistemicOriginField(body: Record<string, unknown>, key: string): EpistemicOrigin {
  const value = stringField(body, key);
  const matched = EPISTEMIC_ORIGINS.find((origin) => origin === value);
  if (matched === undefined) {
    throw new TypeError(`${key} contains an unsupported epistemic origin.`);
  }
  return matched;
}

function evidenceSourceTypeField(body: Record<string, unknown>, key: string): EvidenceSourceType {
  const value = stringField(body, key);
  const matched = EVIDENCE_SOURCE_TYPES.find((sourceType) => sourceType === value);
  if (matched === undefined) {
    throw new TypeError(`${key} contains an unsupported Evidence source type.`);
  }
  return matched;
}

function createdByField(body: Record<string, unknown>, key: string): "agent" | "user" {
  const value = stringField(body, key);
  if (value !== "agent" && value !== "user") {
    throw new TypeError(`${key} must be agent or user.`);
  }
  return value;
}

function assertionKindField(body: Record<string, unknown>, key: string): AssertionKind {
  const value = body[key] ?? "preference";
  if (typeof value !== "string") {
    throw new TypeError(`${key} must be a string.`);
  }
  const matched = ASSERTION_KINDS.find((kind) => kind === value);
  if (matched === undefined) {
    throw new TypeError(`${key} contains an unsupported Assertion kind.`);
  }
  return matched;
}

function proposalStatus(value: string | null): ProposalStatus | undefined {
  if (value === null) {
    return undefined;
  }
  const matched = (["pending", "approved", "rejected"] as const).find((status) => status === value);
  if (matched === undefined) {
    throw new TypeError("status contains an unsupported Proposal status.");
  }
  return matched;
}

function privacyField(body: Record<string, unknown>, key: string): readonly PrivacyClass[] {
  const value = body[key];
  if (!Array.isArray(value)) {
    throw new TypeError(`${key} must be an array.`);
  }
  return value.map((item) => {
    if (typeof item !== "string") {
      throw new TypeError(`${key} contains a non-string value.`);
    }
    const matched = PRIVACY_CLASSES.find((privacy) => privacy === item);
    if (matched === undefined) {
      throw new TypeError(`${key} contains an unsupported privacy class.`);
    }
    return matched;
  });
}

function parsePrivacyQuery(value: string): readonly PrivacyClass[] {
  return value.split(",").map((item) => {
    const matched = PRIVACY_CLASSES.find((privacy) => privacy === item.trim());
    if (matched === undefined) {
      throw new TypeError("privacy contains an unsupported privacy class.");
    }
    return matched;
  });
}

function errorResponse(error: unknown): Response {
  if (
    error instanceof AssertionNotFound ||
    error instanceof EvidenceNotFound ||
    error instanceof ProposalNotFound
  ) {
    return problem(404, error.name, error.message);
  }
  if (error instanceof PrivacyViolation) {
    return problem(403, error.name, error.message);
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return problem(400, "invalid_request", error.message);
  }
  const message = error instanceof Error ? error.message : "Unknown server error.";
  return problem(500, "internal_error", message);
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function problem(status: number, code: string, detail: string): Response {
  return Response.json({ code, detail }, { status });
}
