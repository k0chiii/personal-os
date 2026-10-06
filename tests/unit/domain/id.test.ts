import { describe, expect, it } from "vite-plus/test";

import {
  AssertionId,
  DecisionId,
  EntityId,
  EvidenceId,
  InvalidIdError,
  ProposalId,
} from "../../../packages/domain/src/shared/id";

const VALID_UUID_V7 = "017f22e2-79b0-7cc3-98c4-dc0c0c07398f";

const idParsers = [
  ["EntityId", EntityId.parse],
  ["AssertionId", AssertionId.parse],
  ["EvidenceId", EvidenceId.parse],
  ["DecisionId", DecisionId.parse],
  ["ProposalId", ProposalId.parse],
] as const;

describe("ID parsing", () => {
  it.each(idParsers)("%s accepts a valid UUIDv7", (_name, parse) => {
    expect(parse(VALID_UUID_V7)).toBe(VALID_UUID_V7);
  });

  it.each(idParsers)("%s normalizes uppercase hexadecimal characters", (_name, parse) => {
    expect(parse(VALID_UUID_V7.toUpperCase())).toBe(VALID_UUID_V7);
  });

  it.each(idParsers)("%s rejects an empty string", (_name, parse) => {
    expect(() => parse("")).toThrow(InvalidIdError);
  });

  it.each(idParsers)("%s rejects arbitrary text", (_name, parse) => {
    expect(() => parse("not-an-id")).toThrow(InvalidIdError);
  });

  it.each(idParsers)("%s rejects UUIDv4", (_name, parse) => {
    expect(() => parse("550e8400-e29b-41d4-a716-446655440000")).toThrow(InvalidIdError);
  });

  it.each(idParsers)("%s rejects a UUID with an invalid variant", (_name, parse) => {
    expect(() => parse("017f22e2-79b0-7cc3-78c4-dc0c0c07398f")).toThrow(InvalidIdError);
  });

  it.each(idParsers)("%s rejects malformed UUID syntax", (_name, parse) => {
    expect(() => parse("017f22e279b07cc398c4dc0c0c07398f")).toThrow(InvalidIdError);
  });
});

describe("ID brands", () => {
  it("keeps different ID kinds separate in TypeScript", () => {
    const evidenceId = EvidenceId.parse(VALID_UUID_V7);

    // @ts-expect-error EvidenceId must not be assignable to AssertionId.
    const assertionId: AssertionId = evidenceId;

    expect(assertionId).toBe(evidenceId);
  });
});
