import assert from "node:assert/strict";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Temporal } from "temporal-polyfill";

import {
  AwsContentHasher,
  AwsSystemClock,
  AwsUuidV7Generator,
  DynamoDbEventStore,
  DynamoDbProjection,
  DynamoDbVectorIndex,
  S3RawEvidenceStore,
} from "@personal-os/adapters-aws";
import { PersonalOsApplication } from "@personal-os/application";
import { OptimisticConcurrencyConflict } from "@personal-os/ports";
import { HybridAssertionRetriever, LocalHashEmbedding } from "@personal-os/retrieval";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}.`);
  }
  return value;
}

function isolatedResource(name: string, value: string): string {
  if (!value.toLocaleLowerCase().includes("contract")) {
    throw new Error(`${name} must name a disposable resource containing "contract".`);
  }
  return value;
}

async function run(): Promise<void> {
  if (process.env.PERSONAL_OS_AWS_LIVE_CONTRACT !== "true") {
    throw new Error("Set PERSONAL_OS_AWS_LIVE_CONTRACT=true to acknowledge live AWS writes.");
  }

  const eventTableName = isolatedResource(
    "EVENT_TABLE_NAME",
    requiredEnvironment("EVENT_TABLE_NAME"),
  );
  const projectionTableName = isolatedResource(
    "PROJECTION_TABLE_NAME",
    requiredEnvironment("PROJECTION_TABLE_NAME"),
  );
  const evidenceBucketName = isolatedResource(
    "EVIDENCE_BUCKET_NAME",
    requiredEnvironment("EVIDENCE_BUCKET_NAME"),
  );
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const eventStore = new DynamoDbEventStore(documentClient, eventTableName);
  const projection = new DynamoDbProjection(documentClient, projectionTableName);
  const application = new PersonalOsApplication({
    clock: new AwsSystemClock(),
    idGenerator: new AwsUuidV7Generator(),
    contentHasher: new AwsContentHasher(),
    rawEvidenceStore: new S3RawEvidenceStore(new S3Client({}), evidenceBucketName),
    eventStore,
    projection,
    assertionRetriever: new HybridAssertionRetriever(
      projection,
      new LocalHashEmbedding(256),
      new DynamoDbVectorIndex(documentClient, projectionTableName),
    ),
  });

  const runId = new AwsUuidV7Generator().generate();
  const imported = await application.importTextEvidence({
    content: `Portable live AWS contract ${runId}`,
    sourceType: "plain_text",
    privacy: "P1",
    mediaType: "text/plain",
    actor: "contract",
    reason: "Exercise real DynamoDB and S3 adapters",
  });
  assert.equal(imported.deduplicated, false);

  const proposal = await application.proposePreference({
    subjectId: "018f47a8-7b7c-7a5d-8f3a-1234567890ab",
    object: `portable live contract ${runId}`,
    evidenceIds: [imported.evidence.id],
    epistemicOrigin: "self_stated",
    validFrom: Temporal.Now.instant(),
    privacy: "P1",
    createdBy: "user",
    actor: "contract",
    reason: "Exercise proposal persistence",
  });
  const assertion = await application.approveProposal({
    proposalId: proposal.id,
    actor: "contract",
    reason: "Exercise approved projection",
  });

  const search = await application.searchAssertions({
    query: `portable ${runId}`,
    privacy: ["P1"],
  });
  assert.ok(search.some((candidate) => candidate.id === assertion.id));

  const canonical = await eventStore.readAll();
  assert.deepEqual(
    canonical.map((stored) => stored.globalPosition),
    canonical.map((_stored, index) => index + 1),
  );
  const runEventTypes = canonical
    .filter(
      (stored) =>
        (stored.event.type === "evidence.imported" &&
          stored.event.evidence.id === imported.evidence.id) ||
        (stored.event.type === "assertion.created" && stored.event.assertion.id === assertion.id),
    )
    .map((stored) => stored.event.type);
  assert.deepEqual(runEventTypes, ["evidence.imported", "assertion.created"]);
  assert.equal(await application.rebuild(), canonical.length);
  assert.ok(
    (await application.searchAssertions({ query: runId, privacy: ["P1"] })).some(
      (candidate) => candidate.id === assertion.id,
    ),
  );

  const idempotentInput = {
    streamId: `contract:idempotency:${runId}`,
    expectedVersion: 0,
    events: [{ ...canonical[0]!.event, eventId: new AwsUuidV7Generator().generate() }],
    actor: "contract",
    reason: "Exercise DynamoDB idempotency",
    idempotencyKey: `contract-${runId}`,
  } as const;
  const first = await eventStore.append(idempotentInput);
  const second = await eventStore.append(idempotentInput);
  assert.deepEqual(second, first);
  await assert.rejects(
    eventStore.append({
      streamId: `contract:conflict:${runId}`,
      expectedVersion: 1,
      events: [{ ...canonical[0]!.event, eventId: new AwsUuidV7Generator().generate() }],
      actor: "contract",
      reason: "Exercise optimistic concurrency",
    }),
    OptimisticConcurrencyConflict,
  );
  const integrity = await application.verify();
  assert.ok(integrity.evidenceChecked >= 1);
  process.stdout.write(
    `${JSON.stringify({ status: "passed", runId, events: canonical.length, assertionId: assertion.id })}\n`,
  );
}

await run();
