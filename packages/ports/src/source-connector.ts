import type { EvidenceSourceType, PrivacyClass } from "@personal-os/domain";

export interface SourceDocument {
  readonly externalId: string;
  readonly content: Uint8Array;
  readonly sourceType: EvidenceSourceType;
  readonly sourceUri: string;
  readonly occurredAt: string | null;
  readonly author: string | null;
  readonly privacy: PrivacyClass;
  readonly mediaType: string;
}

export interface SourcePage {
  readonly documents: readonly SourceDocument[];
  readonly nextCursor: string | null;
}

export interface SourceConnectorPort {
  readonly connectorId: string;
  pull(input: { readonly cursor: string | null; readonly limit: number }): Promise<SourcePage>;
}

export interface SecretStorePort {
  get(name: string): Promise<string | null>;
}
