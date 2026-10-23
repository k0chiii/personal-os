import type { AssertionSnapshot, PrivacyClass } from "@personal-os/domain";
import {
  PrivacyViolation,
  type AssertionRetrieverPort,
  type EmbeddingPort,
  type ProjectionPort,
  type RankedAssertionResult,
  type VectorIndexPort,
  type VectorRecord,
  type VectorSearchResult,
} from "@personal-os/ports";
import { Temporal } from "temporal-polyfill";

function normalized(vector: readonly number[]): readonly number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude === 0 ? vector : vector.map((value) => value / magnitude);
}

function tokens(text: string): readonly string[] {
  const normalizedText = text.normalize("NFKC").toLocaleLowerCase();
  const words = normalizedText.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const characters = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
      normalizedText.replaceAll(/\s/gu, ""),
    ),
    (segment) => segment.segment,
  );
  const bigrams = characters
    .slice(0, -1)
    .map((character, index) => `${character}${characters[index + 1]}`);
  return [...words, ...bigrams];
}

function bucket(
  token: string,
  dimensions: number,
): { readonly index: number; readonly sign: number } {
  let hash = 2_166_136_261;
  for (const character of token) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return { index: (hash >>> 1) % dimensions, sign: (hash & 1) === 0 ? 1 : -1 };
}

export class LocalHashEmbedding implements EmbeddingPort {
  readonly providerId = "local-hash";
  readonly remote = false;
  readonly dimensions: number;

  constructor(dimensions = 256) {
    if (!Number.isInteger(dimensions) || dimensions < 8) {
      throw new RangeError("Embedding dimensions must be an integer of at least 8.");
    }
    this.dimensions = dimensions;
  }

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    return texts.map((text) => {
      const vector = Array.from({ length: this.dimensions }, () => 0);
      for (const token of tokens(text)) {
        const location = bucket(token, this.dimensions);
        vector[location.index] = vector[location.index]! + location.sign;
      }
      return normalized(vector);
    });
  }
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) {
    throw new Error("Vector dimensions do not match.");
  }
  return left.reduce((sum, value, index) => sum + value * right[index]!, 0);
}

export class InMemoryVectorIndex implements VectorIndexPort {
  readonly #records = new Map<string, VectorRecord>();

  async upsert(records: readonly VectorRecord[]): Promise<void> {
    for (const record of records) {
      this.#records.set(record.id, record);
    }
  }

  async remove(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      this.#records.delete(id);
    }
  }

  async search(input: {
    readonly vector: readonly number[];
    readonly privacy: readonly PrivacyClass[];
    readonly limit: number;
  }): Promise<readonly VectorSearchResult[]> {
    const allowed = new Set(input.privacy);
    return [...this.#records.values()]
      .filter((record) => allowed.has(record.privacy))
      .map((record) => ({ id: record.id, score: cosine(input.vector, record.vector) }))
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, Math.max(1, input.limit));
  }
}

export type RankedAssertion = RankedAssertionResult;

export class HybridAssertionRetriever implements AssertionRetrieverPort {
  readonly #projection: ProjectionPort;
  readonly #embedding: EmbeddingPort;
  readonly #index: VectorIndexPort;

  constructor(projection: ProjectionPort, embedding: EmbeddingPort, index: VectorIndexPort) {
    this.#projection = projection;
    this.#embedding = embedding;
    this.#index = index;
  }

  async index(assertions: readonly AssertionSnapshot[]): Promise<void> {
    if (this.#embedding.remote && assertions.some((assertion) => assertion.privacy === "P3")) {
      throw new PrivacyViolation();
    }
    const texts = assertions.map(
      (assertion) => `${assertion.kind} ${assertion.predicate} ${assertion.object}`,
    );
    const vectors = await this.#embedding.embed(texts);
    await this.#index.upsert(
      assertions.map((assertion, index) => ({
        id: assertion.id,
        vector: vectors[index]!,
        privacy: assertion.privacy,
        text: texts[index]!,
      })),
    );
  }

  async search(input: {
    readonly query: string;
    readonly asOf?: Temporal.Instant;
    readonly privacy: readonly PrivacyClass[];
    readonly queryPrivacy?: readonly PrivacyClass[];
    readonly limit?: number;
  }): Promise<readonly RankedAssertion[]> {
    if (this.#embedding.remote && input.queryPrivacy?.includes("P3")) {
      throw new PrivacyViolation();
    }
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
    const asOf = input.asOf ?? Temporal.Now.instant();
    const allowed = new Set(input.privacy);
    const eligibleAssertions = (await this.#projection.listAssertions()).filter((assertion) => {
      const validFrom = Temporal.Instant.from(assertion.validFrom);
      const validUntil =
        assertion.validUntil === null ? null : Temporal.Instant.from(assertion.validUntil);
      return (
        ["active", "superseded", "retracted"].includes(assertion.status) &&
        Temporal.Instant.compare(validFrom, asOf) <= 0 &&
        (validUntil === null || Temporal.Instant.compare(validUntil, asOf) > 0) &&
        allowed.has(assertion.privacy)
      );
    });
    await this.index(eligibleAssertions);
    const [queryVector] = await this.#embedding.embed([input.query]);
    const [lexical, semantic] = await Promise.all([
      this.#projection.searchAssertions({
        query: input.query,
        asOf,
        privacy: input.privacy,
        limit: limit * 2,
      }),
      this.#index.search({ vector: queryVector!, privacy: input.privacy, limit: limit * 2 }),
    ]);
    const lexicalRank = new Map(lexical.map((assertion, index) => [assertion.id, index + 1]));
    const semanticRank = new Map(semantic.map((result, index) => [result.id, index + 1]));
    const eligibleIds = new Set(eligibleAssertions.map((assertion) => assertion.id));
    const ids = [...new Set([...lexicalRank.keys(), ...semanticRank.keys()])];
    const assertions = await Promise.all(ids.map((id) => this.#projection.getAssertion(id)));
    return assertions
      .filter(
        (assertion): assertion is AssertionSnapshot =>
          assertion !== null && eligibleIds.has(assertion.id),
      )
      .map((assertion) => {
        const lexicalPosition = lexicalRank.get(assertion.id) ?? null;
        const semanticPosition = semanticRank.get(assertion.id) ?? null;
        const score =
          (lexicalPosition === null ? 0 : 1 / (60 + lexicalPosition)) +
          (semanticPosition === null ? 0 : 1 / (60 + semanticPosition));
        return {
          assertion,
          score,
          lexicalRank: lexicalPosition,
          semanticRank: semanticPosition,
        };
      })
      .sort(
        (left, right) =>
          right.score - left.score || left.assertion.id.localeCompare(right.assertion.id),
      )
      .slice(0, limit);
  }
}
