import type { AssertionSnapshot, PrivacyClass } from "@personal-os/domain";
import type { Temporal } from "temporal-polyfill";

export interface EmbeddingPort {
  readonly providerId: string;
  readonly dimensions: number;
  readonly remote: boolean;
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface VectorRecord {
  readonly id: string;
  readonly vector: readonly number[];
  readonly privacy: PrivacyClass;
  readonly text: string;
}

export interface VectorSearchResult {
  readonly id: string;
  readonly score: number;
}

export interface VectorIndexPort {
  upsert(records: readonly VectorRecord[]): Promise<void>;
  remove(ids: readonly string[]): Promise<void>;
  search(input: {
    readonly vector: readonly number[];
    readonly privacy: readonly PrivacyClass[];
    readonly limit: number;
  }): Promise<readonly VectorSearchResult[]>;
}

export interface RankedAssertionResult {
  readonly assertion: AssertionSnapshot;
  readonly score: number;
  readonly lexicalRank: number | null;
  readonly semanticRank: number | null;
}

export interface AssertionRetrieverPort {
  search(input: {
    readonly query: string;
    readonly asOf?: Temporal.Instant;
    readonly privacy: readonly PrivacyClass[];
    readonly queryPrivacy?: readonly PrivacyClass[];
    readonly limit?: number;
  }): Promise<readonly RankedAssertionResult[]>;
}
