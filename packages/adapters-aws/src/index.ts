import { createHash, randomBytes } from "node:crypto";

import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { Temporal } from "temporal-polyfill";

import {
  ContentHash,
  type AssertionSnapshot,
  type CanonicalEvent,
  type DecisionSnapshot,
  type EvidenceSnapshot,
  type ProposalSnapshot,
  type PrivacyClass,
} from "@personal-os/domain";
import {
  OptimisticConcurrencyConflict,
  type AgentRunRecord,
  type AgentRunRecorderPort,
  type AppendEventsInput,
  type AssertionSearchInput,
  type ClockPort,
  type ContentHasherPort,
  type DecisionSearchInput,
  type EventStorePort,
  type IdGeneratorPort,
  type ProjectionPort,
  type RawEvidenceStorePort,
  type SecretStorePort,
  type StoredEvent,
  type VectorIndexPort,
  type VectorRecord,
  type VectorSearchResult,
} from "@personal-os/ports";

export interface AwsSdkClientLike {
  send(command: never): Promise<unknown>;
}

async function send(client: AwsSdkClientLike, command: object): Promise<unknown> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- AWS SDK clients expose overloaded command unions; this keeps test clients structural.
  return client.send(command as never);
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return Object.fromEntries(Object.entries(value));
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function stringValue(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string.`);
  }
  return value;
}

function numberValue(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number.`);
  }
  return value;
}

function nullableStringValue(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value !== null && typeof value !== "string") {
    throw new Error(`${key} must be a string or null.`);
  }
  return value;
}

function numberArrayValue(record: Record<string, unknown>, key: string): readonly number[] {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "number")) {
    throw new Error(`${key} must be an array of numbers.`);
  }
  return value;
}

function itemFromOutput(value: unknown): Record<string, unknown> | null {
  const output = recordValue(value, "AWS command output");
  return optionalRecord(output.Item);
}

function itemsFromOutput(value: unknown): readonly Record<string, unknown>[] {
  const output = recordValue(value, "AWS command output");
  const items = output.Items;
  if (items === undefined) {
    return [];
  }
  if (!Array.isArray(items)) {
    throw new Error("AWS command output Items must be an array.");
  }
  return items.map((item) => recordValue(item, "AWS item"));
}

function lastEvaluatedKey(value: unknown): Record<string, unknown> | undefined {
  return optionalRecord(recordValue(value, "AWS command output").LastEvaluatedKey) ?? undefined;
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- callers supply the schema-owned persisted type.
function parseJson<T>(text: string): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only canonical JSON written by this adapter is read here.
  return JSON.parse(text) as T;
}

export class AwsSystemClock implements ClockPort {
  now(): Temporal.Instant {
    return Temporal.Now.instant();
  }
}

export class AwsContentHasher implements ContentHasherPort {
  async sha256(content: Uint8Array): Promise<ContentHash> {
    return ContentHash.fromHex(createHash("sha256").update(content).digest("hex"));
  }
}

export class AwsUuidV7Generator implements IdGeneratorPort {
  generate(): string {
    const bytes = randomBytes(16);
    let timestamp = BigInt(Date.now());
    for (let index = 5; index >= 0; index -= 1) {
      bytes[index] = Number(timestamp & 0xffn);
      timestamp >>= 8n;
    }
    bytes[6] = (bytes[6]! & 0x0f) | 0x70;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join("-");
  }
}

export class SsmSecretStore implements SecretStorePort {
  readonly #client: AwsSdkClientLike;
  readonly #prefix: string;

  constructor(client: AwsSdkClientLike, prefix = "/personal-os/") {
    this.#client = client;
    this.#prefix = prefix;
  }

  async get(name: string): Promise<string | null> {
    if (!name.startsWith(this.#prefix)) {
      throw new Error(`SSM parameter must be under ${this.#prefix}.`);
    }
    const output = recordValue(
      await send(this.#client, new GetParameterCommand({ Name: name, WithDecryption: true })),
      "SSM GetParameter output",
    );
    const parameter = optionalRecord(output.Parameter);
    if (parameter === null || parameter.Value === undefined) {
      return null;
    }
    return stringValue(parameter, "Value");
  }
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) {
    return Number.NEGATIVE_INFINITY;
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  return denominator === 0 ? 0 : dot / denominator;
}

export class DynamoDbVectorIndex implements VectorIndexPort {
  readonly #client: AwsSdkClientLike;
  readonly #tableName: string;

  constructor(client: AwsSdkClientLike, tableName: string) {
    this.#client = client;
    this.#tableName = tableName;
  }

  async upsert(records: readonly VectorRecord[]): Promise<void> {
    for (let offset = 0; offset < records.length; offset += 25) {
      await Promise.all(
        records.slice(offset, offset + 25).map((record) =>
          send(
            this.#client,
            new PutCommand({
              TableName: this.#tableName,
              Item: {
                projectionKey: `VECTOR#${record.id}`,
                entityType: "vector",
                vectorId: record.id,
                vector: [...record.vector],
                privacy: record.privacy,
                text: record.text,
              },
            }),
          ),
        ),
      );
    }
  }

  async remove(ids: readonly string[]): Promise<void> {
    for (let offset = 0; offset < ids.length; offset += 25) {
      await Promise.all(
        ids.slice(offset, offset + 25).map((id) =>
          send(
            this.#client,
            new DeleteCommand({
              TableName: this.#tableName,
              Key: { projectionKey: `VECTOR#${id}` },
            }),
          ),
        ),
      );
    }
  }

  async search(input: {
    readonly vector: readonly number[];
    readonly privacy: readonly PrivacyClass[];
    readonly limit: number;
  }): Promise<readonly VectorSearchResult[]> {
    const allowed = new Set<string>(input.privacy);
    const items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const output = await send(
        this.#client,
        new ScanCommand({ TableName: this.#tableName, ExclusiveStartKey: exclusiveStartKey }),
      );
      items.push(...itemsFromOutput(output));
      exclusiveStartKey = lastEvaluatedKey(output);
    } while (exclusiveStartKey !== undefined);
    return items
      .filter(
        (item) =>
          item.entityType === "vector" &&
          typeof item.privacy === "string" &&
          allowed.has(item.privacy),
      )
      .map((item) => ({
        id: stringValue(item, "vectorId"),
        score: cosineSimilarity(input.vector, numberArrayValue(item, "vector")),
      }))
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, Math.max(1, input.limit));
  }
}

export class S3RawEvidenceStore implements RawEvidenceStorePort {
  readonly #client: AwsSdkClientLike;
  readonly #bucket: string;

  constructor(client: AwsSdkClientLike, bucket: string) {
    this.#client = client;
    this.#bucket = bucket;
  }

  async put(hash: ContentHash, content: Uint8Array): Promise<string> {
    const key = `${hash.algorithm}/${hash.hex.slice(0, 2)}/${hash.hex}`;
    await send(
      this.#client,
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: content,
        ChecksumSHA256: Buffer.from(hash.hex, "hex").toString("base64"),
      }),
    );
    return key;
  }

  async get(rawObjectRef: string): Promise<Uint8Array> {
    const output = recordValue(
      await send(this.#client, new GetObjectCommand({ Bucket: this.#bucket, Key: rawObjectRef })),
      "S3 GetObject output",
    );
    const body = output.Body;
    const transform =
      (typeof body === "object" || typeof body === "function") && body !== null
        ? Reflect.get(body, "transformToByteArray")
        : undefined;
    if (typeof transform !== "function") {
      throw new Error(`Raw Evidence object not found or unreadable: ${rawObjectRef}.`);
    }
    const bytes: unknown = await Reflect.apply(transform, body, []);
    if (!(bytes instanceof Uint8Array)) {
      throw new Error(`Raw Evidence object returned invalid bytes: ${rawObjectRef}.`);
    }
    return bytes;
  }

  async delete(rawObjectRef: string): Promise<void> {
    await send(this.#client, new DeleteObjectCommand({ Bucket: this.#bucket, Key: rawObjectRef }));
  }
}

function padded(value: number): string {
  return value.toString().padStart(16, "0");
}

function eventItem(stored: StoredEvent): Record<string, unknown> {
  return {
    pk: `STREAM#${stored.streamId}`,
    sk: `EVENT#${padded(stored.streamVersion)}`,
    gsi1pk: "EVENTS",
    gsi1sk: stored.globalPosition,
    entityType: "event",
    globalPosition: stored.globalPosition,
    streamId: stored.streamId,
    streamVersion: stored.streamVersion,
    payloadJson: JSON.stringify(stored.event),
    actor: stored.actor,
    reason: stored.reason,
    idempotencyKey: stored.idempotencyKey,
  };
}

function storedEventFromItem(item: Record<string, unknown>): StoredEvent {
  return {
    globalPosition: numberValue(item, "globalPosition"),
    streamId: stringValue(item, "streamId"),
    streamVersion: numberValue(item, "streamVersion"),
    event: parseJson<CanonicalEvent>(stringValue(item, "payloadJson")),
    actor: stringValue(item, "actor"),
    reason: stringValue(item, "reason"),
    idempotencyKey: nullableStringValue(item, "idempotencyKey"),
  };
}

function isContiguousFrom(
  events: readonly StoredEvent[],
  afterPosition: number,
  expected: number,
): boolean {
  return (
    events.length === expected &&
    events.every((event, index) => event.globalPosition === afterPosition + index + 1)
  );
}

export class DynamoDbEventStore implements EventStorePort {
  readonly #client: AwsSdkClientLike;
  readonly #tableName: string;

  constructor(client: AwsSdkClientLike, tableName: string) {
    this.#client = client;
    this.#tableName = tableName;
  }

  async append(input: AppendEventsInput): Promise<readonly StoredEvent[]> {
    if (input.events.length === 0) {
      return [];
    }
    if (input.events.length > 20) {
      throw new Error("A DynamoDB append is limited to 20 Events per transaction.");
    }
    if (input.idempotencyKey !== undefined) {
      const previous = await this.#command(input.idempotencyKey);
      if (previous !== null) {
        return this.#readVersionRange(
          stringValue(previous, "streamId"),
          numberValue(previous, "firstVersion"),
          numberValue(previous, "lastVersion"),
        );
      }
    }
    const [actualVersion, globalPosition] = await Promise.all([
      this.getStreamVersion(input.streamId),
      this.#globalPosition(),
    ]);
    if (actualVersion !== input.expectedVersion) {
      throw new OptimisticConcurrencyConflict(input.streamId, input.expectedVersion, actualVersion);
    }
    const stored = input.events.map((event, index): StoredEvent => ({
      globalPosition: globalPosition + index + 1,
      streamId: input.streamId,
      streamVersion: actualVersion + index + 1,
      event,
      actor: input.actor,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey ?? null,
    }));
    const transactItems: Record<string, unknown>[] = stored.map((item) => ({
      Put: {
        TableName: this.#tableName,
        Item: eventItem(item),
        ConditionExpression: "attribute_not_exists(pk)",
      },
    }));
    transactItems.push({
      Update: {
        TableName: this.#tableName,
        Key: { pk: `STREAM#${input.streamId}`, sk: "META" },
        UpdateExpression: "SET #value = :next",
        ConditionExpression:
          actualVersion === 0 ? "attribute_not_exists(#value)" : "#value = :expected",
        ExpressionAttributeNames: { "#value": "version" },
        ExpressionAttributeValues: {
          ":next": actualVersion + input.events.length,
          ...(actualVersion === 0 ? {} : { ":expected": actualVersion }),
        },
      },
    });
    transactItems.push({
      Update: {
        TableName: this.#tableName,
        Key: { pk: "META", sk: "GLOBAL" },
        UpdateExpression: "SET #value = :next",
        ConditionExpression:
          globalPosition === 0 ? "attribute_not_exists(#value)" : "#value = :expected",
        ExpressionAttributeNames: { "#value": "position" },
        ExpressionAttributeValues: {
          ":next": globalPosition + input.events.length,
          ...(globalPosition === 0 ? {} : { ":expected": globalPosition }),
        },
      },
    });
    if (input.idempotencyKey !== undefined) {
      transactItems.push({
        Put: {
          TableName: this.#tableName,
          Item: {
            pk: `IDEMPOTENCY#${input.idempotencyKey}`,
            sk: "COMMAND",
            entityType: "command",
            streamId: input.streamId,
            firstVersion: actualVersion + 1,
            lastVersion: actualVersion + input.events.length,
          },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      });
    }
    try {
      await send(this.#client, new TransactWriteCommand({ TransactItems: transactItems }));
      return stored;
    } catch (error: unknown) {
      if (input.idempotencyKey !== undefined) {
        const previous = await this.#command(input.idempotencyKey);
        if (previous !== null) {
          return this.#readVersionRange(
            stringValue(previous, "streamId"),
            numberValue(previous, "firstVersion"),
            numberValue(previous, "lastVersion"),
          );
        }
      }
      const currentVersion = await this.getStreamVersion(input.streamId);
      if (currentVersion !== actualVersion) {
        throw new OptimisticConcurrencyConflict(
          input.streamId,
          input.expectedVersion,
          currentVersion,
        );
      }
      throw error;
    }
  }

  async readStream(streamId: string): Promise<readonly StoredEvent[]> {
    const items = await this.#queryAll({
      TableName: this.#tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :event)",
      ExpressionAttributeValues: { ":pk": `STREAM#${streamId}`, ":event": "EVENT#" },
    });
    return items.map(storedEventFromItem);
  }

  async readAll(afterPosition = 0): Promise<readonly StoredEvent[]> {
    const head = await this.#globalPosition();
    const expected = Math.max(0, head - afterPosition);
    const indexed = await this.#queryAll({
      TableName: this.#tableName,
      IndexName: "byGlobalPosition",
      KeyConditionExpression: "gsi1pk = :events AND gsi1sk BETWEEN :first AND :head",
      ExpressionAttributeValues: {
        ":events": "EVENTS",
        ":first": afterPosition + 1,
        ":head": head,
      },
    });
    const fromIndex = indexed.map(storedEventFromItem);
    if (isContiguousFrom(fromIndex, afterPosition, expected)) {
      return fromIndex;
    }
    // The global-position GSI is eventually consistent, so a lagging index falls back to a strongly consistent base-table scan.
    const scanned = (await this.#consistentEventScan(afterPosition, head)).toSorted(
      (left, right) => left.globalPosition - right.globalPosition,
    );
    if (!isContiguousFrom(scanned, afterPosition, expected)) {
      throw new Error(
        `DynamoDB Event log is incomplete: expected positions ${afterPosition + 1}..${head}, found ${scanned.length} Events.`,
      );
    }
    return scanned;
  }

  async #consistentEventScan(afterPosition: number, head: number): Promise<readonly StoredEvent[]> {
    const items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const output = await send(
        this.#client,
        new ScanCommand({
          TableName: this.#tableName,
          ConsistentRead: true,
          FilterExpression: "entityType = :event AND globalPosition BETWEEN :first AND :head",
          ExpressionAttributeValues: {
            ":event": "event",
            ":first": afterPosition + 1,
            ":head": head,
          },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      items.push(...itemsFromOutput(output));
      exclusiveStartKey = lastEvaluatedKey(output);
    } while (exclusiveStartKey !== undefined);
    return items.map(storedEventFromItem);
  }

  async getStreamVersion(streamId: string): Promise<number> {
    const item = itemFromOutput(
      await send(
        this.#client,
        new GetCommand({
          TableName: this.#tableName,
          Key: { pk: `STREAM#${streamId}`, sk: "META" },
          ConsistentRead: true,
        }),
      ),
    );
    return item === null ? 0 : numberValue(item, "version");
  }

  async #globalPosition(): Promise<number> {
    const item = itemFromOutput(
      await send(
        this.#client,
        new GetCommand({
          TableName: this.#tableName,
          Key: { pk: "META", sk: "GLOBAL" },
          ConsistentRead: true,
        }),
      ),
    );
    return item === null ? 0 : numberValue(item, "position");
  }

  async #command(key: string): Promise<Record<string, unknown> | null> {
    return itemFromOutput(
      await send(
        this.#client,
        new GetCommand({
          TableName: this.#tableName,
          Key: { pk: `IDEMPOTENCY#${key}`, sk: "COMMAND" },
          ConsistentRead: true,
        }),
      ),
    );
  }

  async #readVersionRange(
    streamId: string,
    firstVersion: number,
    lastVersion: number,
  ): Promise<readonly StoredEvent[]> {
    return (await this.readStream(streamId)).filter(
      (event) => event.streamVersion >= firstVersion && event.streamVersion <= lastVersion,
    );
  }

  async #queryAll(
    input: ConstructorParameters<typeof QueryCommand>[0],
  ): Promise<readonly Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const output = await send(
        this.#client,
        new QueryCommand({ ...input, ExclusiveStartKey: exclusiveStartKey }),
      );
      items.push(...itemsFromOutput(output));
      exclusiveStartKey = lastEvaluatedKey(output);
    } while (exclusiveStartKey !== undefined);
    return items;
  }
}

function eventEvidenceIds(event: CanonicalEvent): readonly string[] {
  switch (event.type) {
    case "evidence.imported":
    case "evidence.purged":
      return [event.evidence.id];
    case "assertion.created":
      return event.assertion.evidenceIds;
    case "assertion.superseded":
      return [...event.previous.evidenceIds, ...event.successor.evidenceIds];
    case "assertion.disputed":
    case "assertion.retracted":
      return event.assertion.evidenceIds;
    case "decision.recorded":
    case "decision.outcome_recorded":
      return event.decision.evidenceIds;
    default:
      return [];
  }
}

export class DynamoDbProjection implements ProjectionPort {
  readonly #client: AwsSdkClientLike;
  readonly #tableName: string;

  constructor(client: AwsSdkClientLike, tableName: string) {
    this.#client = client;
    this.#tableName = tableName;
  }

  async reset(): Promise<void> {
    const items = await this.#scanAll();
    for (let index = 0; index < items.length; index += 25) {
      await send(
        this.#client,
        new BatchWriteCommand({
          RequestItems: {
            [this.#tableName]: items.slice(index, index + 25).map((item) => ({
              DeleteRequest: { Key: { projectionKey: stringValue(item, "projectionKey") } },
            })),
          },
        }),
      );
    }
  }

  async apply(events: readonly StoredEvent[]): Promise<void> {
    for (const stored of events) {
      await this.#applyEvent(stored);
    }
  }

  async findEvidenceByHash(hash: ContentHash): Promise<EvidenceSnapshot | null> {
    const item = (await this.#scanAll()).find(
      (candidate) =>
        candidate.entityType === "evidence" && candidate.contentHash === hash.toString(),
    );
    return item === undefined
      ? null
      : parseJson<EvidenceSnapshot>(stringValue(item, "payloadJson"));
  }

  async getEvidence(id: string): Promise<EvidenceSnapshot | null> {
    return this.#getSnapshot<EvidenceSnapshot>(`EVIDENCE#${id}`);
  }

  async listEvidence(): Promise<readonly EvidenceSnapshot[]> {
    return (await this.#scanAll())
      .filter((item) => item.entityType === "evidence")
      .map((item) => parseJson<EvidenceSnapshot>(stringValue(item, "payloadJson")))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async getProposal(id: string): Promise<ProposalSnapshot | null> {
    return this.#getSnapshot<ProposalSnapshot>(`PROPOSAL#${id}`);
  }

  async getAssertion(id: string): Promise<AssertionSnapshot | null> {
    return this.#getSnapshot<AssertionSnapshot>(`ASSERTION#${id}`);
  }

  async listAssertions(): Promise<readonly AssertionSnapshot[]> {
    return (await this.#scanAll())
      .filter((item) => item.entityType === "assertion")
      .map((item) => parseJson<AssertionSnapshot>(stringValue(item, "payloadJson")))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async getDecision(id: string): Promise<DecisionSnapshot | null> {
    return this.#getSnapshot<DecisionSnapshot>(`DECISION#${id}`);
  }

  async searchAssertions(input: AssertionSearchInput): Promise<readonly AssertionSnapshot[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
    const query = input.query.trim().toLocaleLowerCase();
    const allowed = input.privacy === undefined ? null : new Set(input.privacy);
    const asOf = input.asOf.epochMilliseconds;
    return (await this.#scanAll())
      .filter((item) => item.entityType === "assertion")
      .map((item) => parseJson<AssertionSnapshot>(stringValue(item, "payloadJson")))
      .filter((assertion) => {
        const validFrom = Temporal.Instant.from(assertion.validFrom).epochMilliseconds;
        const validUntil =
          assertion.validUntil === null
            ? null
            : Temporal.Instant.from(assertion.validUntil).epochMilliseconds;
        return (
          ["active", "superseded", "retracted"].includes(assertion.status) &&
          validFrom <= asOf &&
          (validUntil === null || validUntil > asOf) &&
          (allowed === null || allowed.has(assertion.privacy)) &&
          (query.length === 0 ||
            `${assertion.subjectId} ${assertion.object}`.toLocaleLowerCase().includes(query))
        );
      })
      .sort((left, right) => right.validFrom.localeCompare(left.validFrom))
      .slice(0, limit);
  }

  async searchDecisions(input: DecisionSearchInput): Promise<readonly DecisionSnapshot[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
    const query = input.query.trim().toLocaleLowerCase();
    const allowed = input.privacy === undefined ? null : new Set(input.privacy);
    return (await this.#scanAll())
      .filter((item) => item.entityType === "decision")
      .map((item) => parseJson<DecisionSnapshot>(stringValue(item, "payloadJson")))
      .filter(
        (decision) =>
          Temporal.Instant.compare(Temporal.Instant.from(decision.decidedAt), input.asOf) <= 0 &&
          (allowed === null || allowed.has(decision.privacy)) &&
          (query.length === 0 ||
            `${decision.problem} ${decision.rationale} ${decision.options
              .map((option) => option.label)
              .join(" ")}`
              .toLocaleLowerCase()
              .includes(query)),
      )
      .sort((left, right) => right.decidedAt.localeCompare(left.decidedAt))
      .slice(0, limit);
  }

  async #getSnapshot<T>(key: string): Promise<T | null> {
    const item = itemFromOutput(
      await send(
        this.#client,
        new GetCommand({ TableName: this.#tableName, Key: { projectionKey: key } }),
      ),
    );
    return item === null ? null : parseJson<T>(stringValue(item, "payloadJson"));
  }

  async #put(
    projectionKey: string,
    entityType: string,
    snapshot: unknown,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await send(
      this.#client,
      new PutCommand({
        TableName: this.#tableName,
        Item: { projectionKey, entityType, payloadJson: JSON.stringify(snapshot), ...extra },
      }),
    );
  }

  async #applyEvent(stored: StoredEvent): Promise<void> {
    const event = stored.event;
    switch (event.type) {
      case "evidence.imported":
      case "evidence.purged":
        await this.#put(`EVIDENCE#${event.evidence.id}`, "evidence", event.evidence, {
          contentHash: event.evidence.contentHash,
        });
        break;
      case "proposal.created":
        await this.#put(`PROPOSAL#${event.proposal.id}`, "proposal", event.proposal);
        break;
      case "proposal.approved":
      case "proposal.rejected": {
        const proposal = await this.getProposal(event.proposalId);
        if (proposal === null) {
          throw new Error(`Cannot project review for missing proposal ${event.proposalId}.`);
        }
        await this.#put(`PROPOSAL#${proposal.id}`, "proposal", {
          ...proposal,
          status: event.type === "proposal.approved" ? "approved" : "rejected",
          reviewedAt: event.occurredAt,
          reviewedBy: event.audit.actor,
          reviewReason: event.audit.reason,
        });
        break;
      }
      case "assertion.created": {
        await this.#put(`ASSERTION#${event.assertion.id}`, "assertion", event.assertion);
        const proposal = await this.getProposal(event.proposalId);
        if (proposal === null) {
          throw new Error(`Cannot project assertion for missing proposal ${event.proposalId}.`);
        }
        await this.#put(`PROPOSAL#${proposal.id}`, "proposal", {
          ...proposal,
          assertion: event.assertion,
        });
        break;
      }
      case "assertion.superseded":
        await this.#put(`ASSERTION#${event.previous.id}`, "assertion", event.previous);
        await this.#put(`ASSERTION#${event.successor.id}`, "assertion", event.successor);
        break;
      case "assertion.disputed":
      case "assertion.retracted":
        await this.#put(`ASSERTION#${event.assertion.id}`, "assertion", event.assertion);
        break;
      case "decision.recorded":
      case "decision.outcome_recorded":
        await this.#put(`DECISION#${event.decision.id}`, "decision", event.decision);
        break;
    }
    await this.#put(`AUDIT#${event.eventId}`, "audit", {
      eventId: event.eventId,
      operation: event.type,
      actor: stored.actor,
      reason: stored.reason,
      occurredAt: event.occurredAt,
      evidenceIds: eventEvidenceIds(event),
    });
  }

  async #scanAll(): Promise<readonly Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const output = await send(
        this.#client,
        new ScanCommand({ TableName: this.#tableName, ExclusiveStartKey: exclusiveStartKey }),
      );
      items.push(...itemsFromOutput(output));
      exclusiveStartKey = lastEvaluatedKey(output);
    } while (exclusiveStartKey !== undefined);
    return items;
  }
}

export class DynamoDbAgentRunRecorder implements AgentRunRecorderPort {
  readonly #client: AwsSdkClientLike;
  readonly #tableName: string;

  constructor(client: AwsSdkClientLike, tableName: string) {
    this.#client = client;
    this.#tableName = tableName;
  }

  async record(run: AgentRunRecord): Promise<void> {
    await send(
      this.#client,
      new PutCommand({
        TableName: this.#tableName,
        Item: {
          projectionKey: `AGENT_RUN#${run.runId}`,
          entityType: "agentRun",
          payloadJson: JSON.stringify(run),
          timestamp: run.timestamp,
          status: run.status,
        },
      }),
    );
  }
}
