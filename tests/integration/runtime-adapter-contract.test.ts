import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";

import {
  AwsContentHasher,
  AwsSystemClock,
  AwsUuidV7Generator,
  DynamoDbEventStore,
  DynamoDbProjection,
  S3RawEvidenceStore,
  type AwsSdkClientLike,
} from "../../packages/adapters-aws/src/index.ts";
import {
  CloudflareSystemClock,
  D1EventStore,
  D1Projection,
  R2RawEvidenceStore,
  WebCryptoContentHasher,
  WebCryptoUuidV7Generator,
  type D1DatabaseLike,
  type R2BucketLike,
} from "../../packages/adapters-cloudflare/src/index.ts";
import {
  FileRawEvidenceStore,
  NodeContentHasher,
  SqliteEventStore,
  SqliteProjection,
  SystemClock,
  UuidV7Generator,
} from "../../packages/adapters-local/src/index.ts";
import { PersonalOsApplication } from "../../packages/application/src/index.ts";
import {
  OptimisticConcurrencyConflict,
  type EventStorePort,
} from "../../packages/ports/src/index.ts";
import { Miniflare } from "miniflare";
import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vite-plus/test";

interface RuntimeHarness {
  readonly application: PersonalOsApplication;
  readonly eventStore: EventStorePort;
  close(): Promise<void>;
}

type HarnessFactory = () => Promise<RuntimeHarness>;

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return Object.fromEntries(Object.entries(value));
}

class InMemoryAwsClient implements AwsSdkClientLike {
  readonly #tables = new Map<string, Map<string, Record<string, unknown>>>();
  readonly #objects = new Map<string, Uint8Array>();

  async send(command: unknown): Promise<unknown> {
    if (command instanceof PutObjectCommand) {
      const bucket = requiredString(command.input.Bucket, "Bucket");
      const key = requiredString(command.input.Key, "Key");
      if (!(command.input.Body instanceof Uint8Array)) {
        throw new Error("Test S3 Body must be Uint8Array.");
      }
      this.#objects.set(`${bucket}/${key}`, Uint8Array.from(command.input.Body));
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const object = this.#objects.get(
        `${requiredString(command.input.Bucket, "Bucket")}/${requiredString(command.input.Key, "Key")}`,
      );
      return object === undefined
        ? {}
        : { Body: { transformToByteArray: async () => Uint8Array.from(object) } };
    }
    if (command instanceof DeleteObjectCommand) {
      this.#objects.delete(
        `${requiredString(command.input.Bucket, "Bucket")}/${requiredString(command.input.Key, "Key")}`,
      );
      return {};
    }
    if (command instanceof GetCommand) {
      const table = this.#table(requiredString(command.input.TableName, "TableName"));
      const key = this.#key(record(command.input.Key, "Key"));
      return { Item: table.get(key) };
    }
    if (command instanceof PutCommand) {
      const table = this.#table(requiredString(command.input.TableName, "TableName"));
      const item = record(command.input.Item, "Item");
      table.set(this.#key(item), item);
      return {};
    }
    if (command instanceof ScanCommand) {
      return {
        Items: [...this.#table(requiredString(command.input.TableName, "TableName")).values()],
      };
    }
    if (command instanceof QueryCommand) {
      const table = this.#table(requiredString(command.input.TableName, "TableName"));
      const values = record(command.input.ExpressionAttributeValues, "ExpressionAttributeValues");
      const items = [...table.values()];
      if (command.input.IndexName === "byGlobalPosition") {
        const after = values[":after"];
        if (typeof after !== "number") {
          throw new Error(":after must be a number.");
        }
        return {
          Items: items
            .filter((item) => item.gsi1pk === values[":events"] && Number(item.gsi1sk) > after)
            .sort((left, right) => Number(left.gsi1sk) - Number(right.gsi1sk)),
        };
      }
      return {
        Items: items
          .filter(
            (item) =>
              item.pk === values[":pk"] &&
              typeof item.sk === "string" &&
              item.sk.startsWith(requiredString(values[":event"], ":event")),
          )
          .sort((left, right) => String(left.sk).localeCompare(String(right.sk))),
      };
    }
    if (command instanceof BatchWriteCommand) {
      const requestItems = record(command.input.RequestItems, "RequestItems");
      Object.entries(requestItems).forEach(([tableName, requests]) => {
        if (!Array.isArray(requests)) {
          throw new Error("BatchWrite requests must be an array.");
        }
        requests.forEach((request) => {
          const deleteRequest = record(record(request, "request").DeleteRequest, "DeleteRequest");
          this.#table(tableName).delete(this.#key(record(deleteRequest.Key, "Key")));
        });
      });
      return {};
    }
    if (command instanceof TransactWriteCommand) {
      for (const entry of command.input.TransactItems ?? []) {
        if (entry.Put !== undefined) {
          const table = this.#table(requiredString(entry.Put.TableName, "TableName"));
          const item = record(entry.Put.Item, "Item");
          const key = this.#key(item);
          if (entry.Put.ConditionExpression !== undefined && table.has(key)) {
            throw new Error("Conditional check failed.");
          }
          table.set(key, item);
        } else if (entry.Update !== undefined) {
          const table = this.#table(requiredString(entry.Update.TableName, "TableName"));
          const keyValue = record(entry.Update.Key, "Key");
          const key = this.#key(keyValue);
          const item = { ...(table.get(key) ?? keyValue) };
          const names = record(entry.Update.ExpressionAttributeNames, "ExpressionAttributeNames");
          const values = record(
            entry.Update.ExpressionAttributeValues,
            "ExpressionAttributeValues",
          );
          item[requiredString(names["#value"], "#value")] = values[":next"];
          table.set(key, item);
        }
      }
      return {};
    }
    throw new Error(`Unsupported AWS command: ${command?.constructor.name ?? "unknown"}.`);
  }

  #table(name: string): Map<string, Record<string, unknown>> {
    let table = this.#tables.get(name);
    if (table === undefined) {
      table = new Map();
      this.#tables.set(name, table);
    }
    return table;
  }

  #key(item: Record<string, unknown>): string {
    if (typeof item.projectionKey === "string") {
      return item.projectionKey;
    }
    return `${requiredString(item.pk, "pk")}|${requiredString(item.sk, "sk")}`;
  }
}

async function localHarness(): Promise<RuntimeHarness> {
  const root = await mkdtemp(join(tmpdir(), "personal-os-local-contract-"));
  const databasePath = join(root, "personal-os.sqlite");
  const eventStore = new SqliteEventStore(databasePath);
  const projection = new SqliteProjection(databasePath);
  return {
    application: new PersonalOsApplication({
      clock: new SystemClock(),
      idGenerator: new UuidV7Generator(),
      contentHasher: new NodeContentHasher(),
      rawEvidenceStore: new FileRawEvidenceStore(join(root, "evidence")),
      eventStore,
      projection,
    }),
    eventStore,
    async close(): Promise<void> {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function cloudflareHarness(): Promise<RuntimeHarness> {
  const rootPath = process.cwd();
  const miniflare = new Miniflare({
    workers: [
      {
        config: {
          name: "runtime-contract",
          compatibilityDate: "2026-10-01",
          manifest: {
            mainModule: "index.js",
            modulesRoot: rootPath,
            modules: {
              "index.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response('ok'); } }",
              },
            },
          },
          env: {
            DB: { type: "d1", id: "runtime-contract" },
            EVIDENCE: { type: "r2", name: "runtime-contract" },
          },
        },
        dev: { rootPath },
      },
    ],
  });
  const nativeDatabase = await miniflare.getD1Database("DB");
  const schema = await readFile(
    new URL("../../apps/worker/migrations/0001_initial.sql", import.meta.url),
    "utf8",
  );
  for (const statement of schema
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)) {
    await nativeDatabase.prepare(statement).run();
  }
  const database: D1DatabaseLike = nativeDatabase;
  const bindings = await miniflare.getBindings<{ readonly EVIDENCE: R2BucketLike }>();
  const bucket = bindings.EVIDENCE;
  const eventStore = new D1EventStore(database);
  const projection = new D1Projection(database);
  return {
    application: new PersonalOsApplication({
      clock: new CloudflareSystemClock(),
      idGenerator: new WebCryptoUuidV7Generator(),
      contentHasher: new WebCryptoContentHasher(),
      rawEvidenceStore: new R2RawEvidenceStore(bucket),
      eventStore,
      projection,
    }),
    eventStore,
    async close(): Promise<void> {
      await miniflare.dispose();
    },
  };
}

async function awsHarness(): Promise<RuntimeHarness> {
  const client = new InMemoryAwsClient();
  const eventStore = new DynamoDbEventStore(client, "events");
  const projection = new DynamoDbProjection(client, "projections");
  return {
    application: new PersonalOsApplication({
      clock: new AwsSystemClock(),
      idGenerator: new AwsUuidV7Generator(),
      contentHasher: new AwsContentHasher(),
      rawEvidenceStore: new S3RawEvidenceStore(client, "evidence"),
      eventStore,
      projection,
    }),
    eventStore,
    async close(): Promise<void> {},
  };
}

const adapters: readonly [string, HarnessFactory][] = [
  ["SQLite/filesystem", localHarness],
  ["D1/R2", cloudflareHarness],
  ["DynamoDB/S3", awsHarness],
];

describe.each(adapters)("runtime adapter contract: %s", (_name, createHarness) => {
  it("preserves idempotency, concurrency, projection replay, and temporal search", async () => {
    const harness = await createHarness();
    try {
      const imported = await harness.application.importTextEvidence({
        content: "I prefer portable, local-first systems.",
        sourceType: "plain_text",
        privacy: "P1",
        mediaType: "text/plain",
        actor: "owner",
        reason: "Runtime adapter contract",
      });
      const duplicate = await harness.application.importTextEvidence({
        content: "I prefer portable, local-first systems.",
        sourceType: "plain_text",
        privacy: "P1",
        mediaType: "text/plain",
        actor: "owner",
        reason: "Runtime adapter contract duplicate",
      });
      expect(duplicate.deduplicated).toBe(true);
      expect(duplicate.evidence.id).toBe(imported.evidence.id);

      const proposal = await harness.application.proposePreference({
        subjectId: "018f47a8-7b7c-7a5d-8f3a-1234567890ab",
        object: "local-first systems",
        evidenceIds: [imported.evidence.id],
        epistemicOrigin: "self_stated",
        validFrom: Temporal.Instant.from("2026-01-01T00:00:00Z"),
        privacy: "P1",
        createdBy: "agent",
        actor: "archivist",
        reason: "Runtime adapter contract proposal",
      });
      await harness.application.approveProposal({
        proposalId: proposal.id,
        actor: "owner",
        reason: "Evidence supports the preference",
      });
      expect(
        await harness.application.searchAssertions({
          query: "local-first",
          asOf: Temporal.Instant.from("2027-01-01T00:00:00Z"),
          privacy: ["P1"],
        }),
      ).toHaveLength(1);

      const canonical = await harness.eventStore.readAll();
      expect(canonical).toHaveLength(4);
      const replayed = await harness.application.rebuild();
      expect(replayed).toBe(4);
      expect(
        await harness.application.searchAssertions({
          query: "local-first",
          asOf: Temporal.Instant.from("2027-01-01T00:00:00Z"),
          privacy: ["P1"],
        }),
      ).toHaveLength(1);

      await expect(
        harness.eventStore.append({
          streamId: "contract:concurrency",
          expectedVersion: 1,
          events: [{ ...canonical[0]!.event, eventId: "contract-conflict-event" }],
          actor: "contract",
          reason: "Expected version must be enforced",
        }),
      ).rejects.toBeInstanceOf(OptimisticConcurrencyConflict);

      const idempotentInput = {
        streamId: "contract:idempotency",
        expectedVersion: 0,
        events: [{ ...canonical[0]!.event, eventId: "contract-idempotent-event" }],
        actor: "contract",
        reason: "Idempotency must be enforced",
        idempotencyKey: "contract-idempotency-key",
      } as const;
      const first = await harness.eventStore.append(idempotentInput);
      const second = await harness.eventStore.append(idempotentInput);
      expect(second).toEqual(first);
      expect(await harness.eventStore.getStreamVersion("contract:idempotency")).toBe(1);
    } finally {
      await harness.close();
    }
  });
});
