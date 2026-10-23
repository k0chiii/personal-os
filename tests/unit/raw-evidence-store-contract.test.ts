import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  S3RawEvidenceStore,
  type AwsSdkClientLike,
} from "../../packages/adapters-aws/src/index.ts";
import {
  R2RawEvidenceStore,
  type R2BucketLike,
  type R2ObjectBodyLike,
} from "../../packages/adapters-cloudflare/src/index.ts";
import {
  FileRawEvidenceStore,
  NodeContentHasher,
} from "../../packages/adapters-local/src/index.ts";
import type { RawEvidenceStorePort } from "../../packages/ports/src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class MemoryR2Bucket implements R2BucketLike {
  readonly #objects = new Map<string, Uint8Array>();

  async put(key: string, value: Uint8Array): Promise<void> {
    this.#objects.set(key, value.slice());
  }

  async get(key: string): Promise<R2ObjectBodyLike | null> {
    const value = this.#objects.get(key);
    if (value === undefined) {
      return null;
    }
    return { arrayBuffer: async () => value.slice().buffer };
  }

  async delete(key: string): Promise<void> {
    this.#objects.delete(key);
  }
}

class MemoryS3Client implements AwsSdkClientLike {
  readonly #objects = new Map<string, Uint8Array>();

  async send(command: unknown): Promise<unknown> {
    if (command instanceof PutObjectCommand) {
      if (
        typeof command.input.Bucket !== "string" ||
        typeof command.input.Key !== "string" ||
        !(command.input.Body instanceof Uint8Array)
      ) {
        throw new Error("Invalid PutObject input.");
      }
      this.#objects.set(
        `${command.input.Bucket}/${command.input.Key}`,
        Uint8Array.from(command.input.Body),
      );
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const value = this.#objects.get(`${command.input.Bucket}/${command.input.Key}`);
      return value === undefined
        ? {}
        : { Body: { transformToByteArray: async () => Uint8Array.from(value) } };
    }
    if (command instanceof DeleteObjectCommand) {
      this.#objects.delete(`${command.input.Bucket}/${command.input.Key}`);
      return {};
    }
    throw new Error("Unsupported S3 command.");
  }
}

function rawEvidenceStoreContract(
  name: string,
  create: () => Promise<RawEvidenceStorePort> | RawEvidenceStorePort,
): void {
  describe(`${name} RawEvidenceStorePort contract`, () => {
    it("stores content at a deterministic hash reference and supports deletion", async () => {
      const store = await create();
      const content = new TextEncoder().encode("portable evidence");
      const hash = await new NodeContentHasher().sha256(content);

      const first = await store.put(hash, content);
      const second = await store.put(hash, content);

      expect(second).toBe(first);
      expect([...(await store.get(first))]).toEqual([...content]);
      await store.delete(first);
      await expect(store.get(first)).rejects.toThrow(Error);
    });
  });
}

rawEvidenceStoreContract("local filesystem", async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-os-raw-contract-"));
  temporaryDirectories.push(directory);
  return new FileRawEvidenceStore(directory);
});

rawEvidenceStoreContract("Cloudflare R2", () => new R2RawEvidenceStore(new MemoryR2Bucket()));

rawEvidenceStoreContract("AWS S3", () => new S3RawEvidenceStore(new MemoryS3Client(), "evidence"));
