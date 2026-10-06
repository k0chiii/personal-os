declare const idBrand: unique symbol;

type BrandedId<Name extends string> = string & { readonly [idBrand]: Name };

type IdTypeName = "EntityId" | "AssertionId" | "EvidenceId" | "DecisionId" | "ProposalId";

const UUID_V7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidIdError extends Error {
  readonly idType: IdTypeName;

  constructor(idType: IdTypeName) {
    super(`${idType} must be a valid UUID v7`);
    this.name = "InvalidIdError";
    this.idType = idType;
  }
}

function isBrandedId<Name extends IdTypeName>(
  value: string,
  _name: Name,
): value is BrandedId<Name> {
  return UUID_V7_REGEX.test(value.toLowerCase());
}

function parseId<Name extends IdTypeName>(value: string, name: Name): BrandedId<Name> {
  const normalized = value.toLowerCase();
  if (!isBrandedId(normalized, name)) {
    throw new InvalidIdError(name);
  }
  return normalized;
}

export type EntityId = BrandedId<"EntityId">;
export const EntityId = {
  parse: (value: string): EntityId => parseId<"EntityId">(value, "EntityId"),
} as const;

export type AssertionId = BrandedId<"AssertionId">;
export const AssertionId = {
  parse: (value: string): AssertionId => parseId<"AssertionId">(value, "AssertionId"),
} as const;

export type EvidenceId = BrandedId<"EvidenceId">;
export const EvidenceId = {
  parse: (value: string): EvidenceId => parseId<"EvidenceId">(value, "EvidenceId"),
} as const;

export type DecisionId = BrandedId<"DecisionId">;
export const DecisionId = {
  parse: (value: string): DecisionId => parseId<"DecisionId">(value, "DecisionId"),
} as const;

export type ProposalId = BrandedId<"ProposalId">;
export const ProposalId = {
  parse: (value: string): ProposalId => parseId<"ProposalId">(value, "ProposalId"),
} as const;
