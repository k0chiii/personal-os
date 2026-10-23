import { DeleteCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vite-plus/test";

import {
  CloudflareVectorizeIndex,
  type VectorizeIndexLike,
} from "../../packages/adapters-cloudflare/src/index.ts";
import {
  DynamoDbVectorIndex,
  type AwsSdkClientLike,
} from "../../packages/adapters-aws/src/index.ts";
import type { VectorIndexPort, VectorRecord } from "../../packages/ports/src/index.ts";

class FakeVectorize implements VectorizeIndexLike {
  readonly records = new Map<
    string,
    { readonly values: readonly number[]; readonly metadata: Readonly<Record<string, string>> }
  >();

  async upsert(
    vectors: readonly {
      readonly id: string;
      readonly values: readonly number[];
      readonly metadata: Readonly<Record<string, string>>;
    }[],
  ): Promise<void> {
    for (const vector of vectors) this.records.set(vector.id, vector);
  }

  async deleteByIds(ids: readonly string[]): Promise<void> {
    for (const id of ids) this.records.delete(id);
  }

  async query(
    vector: readonly number[],
    options: { readonly topK: number; readonly returnMetadata: unknown },
  ): Promise<{
    readonly matches: readonly {
      readonly id: string;
      readonly score: number;
      readonly metadata?: Readonly<Record<string, string>>;
    }[];
  }> {
    if (
      options.returnMetadata !== "all" &&
      options.returnMetadata !== "indexed" &&
      options.returnMetadata !== "none"
    ) {
      throw new Error(
        `Vectorize rejects returnMetadata=${JSON.stringify(options.returnMetadata)}.`,
      );
    }
    const maxTopK = options.returnMetadata === "all" ? 50 : 100;
    if (!Number.isInteger(options.topK) || options.topK < 1 || options.topK > maxTopK) {
      throw new Error(
        `Vectorize rejects topK=${options.topK} with returnMetadata=${options.returnMetadata}.`,
      );
    }
    return {
      matches: [...this.records.entries()]
        .map(([id, record]) => ({
          id,
          score: record.values.reduce((total, value, index) => total + value * vector[index]!, 0),
          ...(options.returnMetadata === "none" ? {} : { metadata: record.metadata }),
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, options.topK),
    };
  }
}

class FakeDynamoDb implements AwsSdkClientLike {
  readonly items = new Map<string, Record<string, unknown>>();

  async send(command: unknown): Promise<unknown> {
    if (command instanceof PutCommand) {
      const item = command.input.Item;
      if (item === undefined || typeof item.projectionKey !== "string") {
        throw new Error("A projection key is required.");
      }
      this.items.set(item.projectionKey, Object.fromEntries(Object.entries(item)));
      return {};
    }
    if (command instanceof DeleteCommand) {
      const key = command.input.Key?.projectionKey;
      if (typeof key === "string") this.items.delete(key);
      return {};
    }
    if (command instanceof ScanCommand) {
      return { Items: [...this.items.values()] };
    }
    throw new Error("Unsupported DynamoDB command.");
  }
}

const records: readonly VectorRecord[] = [
  { id: "public", vector: [1, 0], privacy: "P1", text: "public" },
  { id: "restricted", vector: [0.9, 0.1], privacy: "P3", text: "restricted" },
];

async function verifyContract(index: VectorIndexPort): Promise<void> {
  await index.upsert(records);
  expect(await index.search({ vector: [1, 0], privacy: ["P1"], limit: 10 })).toEqual([
    { id: "public", score: 1 },
  ]);
  await index.remove(["public"]);
  expect(await index.search({ vector: [1, 0], privacy: ["P1"], limit: 10 })).toEqual([]);
}

describe("cloud vector index contract", () => {
  it("preserves privacy filtering and deletion with Cloudflare Vectorize", async () => {
    await verifyContract(new CloudflareVectorizeIndex(new FakeVectorize()));
    expect.assertions(2);
  });

  it("keeps large Cloudflare Vectorize searches within the metadata query limits", async () => {
    const index = new CloudflareVectorizeIndex(new FakeVectorize());
    await index.upsert(records);

    await expect(index.search({ vector: [1, 0], privacy: ["P1"], limit: 40 })).resolves.toEqual([
      { id: "public", score: 1 },
    ]);
  });

  it("preserves privacy filtering and deletion with DynamoDB", async () => {
    await verifyContract(new DynamoDbVectorIndex(new FakeDynamoDb(), "projection"));
    expect.assertions(2);
  });
});
