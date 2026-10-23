import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Temporal } from "temporal-polyfill";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  Aes256GcmBackupCipher,
  DirectorySourceConnector,
  FileRawEvidenceStore,
  NodeContentHasher,
  SqliteEventStore,
  SqliteProjection,
  UuidV7Generator,
} from "../../packages/adapters-local/src/index.ts";
import {
  PersonalOsApplication,
  SourceIngestionService,
} from "../../packages/application/src/index.ts";
import {
  HybridAssertionRetriever,
  InMemoryVectorIndex,
  LocalHashEmbedding,
} from "../../packages/retrieval/src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class IncrementingClock {
  #value = Temporal.Instant.from("2026-10-20T00:00:00Z");

  now(): Temporal.Instant {
    const value = this.#value;
    this.#value = value.add({ nanoseconds: 1 });
    return value;
  }
}

async function testSystem(): Promise<{
  readonly application: PersonalOsApplication;
  readonly projection: SqliteProjection;
  readonly ids: UuidV7Generator;
  readonly root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "personal-os-v1-"));
  temporaryDirectories.push(root);
  const database = join(root, "personal-os.sqlite");
  const projection = new SqliteProjection(database);
  const ids = new UuidV7Generator(() => 1_792_454_400_000);
  return {
    root,
    projection,
    ids,
    application: new PersonalOsApplication({
      clock: new IncrementingClock(),
      idGenerator: ids,
      contentHasher: new NodeContentHasher(),
      rawEvidenceStore: new FileRawEvidenceStore(join(root, "objects")),
      eventStore: new SqliteEventStore(database),
      projection,
    }),
  };
}

async function approvedGoal(system: Awaited<ReturnType<typeof testSystem>>): Promise<string> {
  const imported = await system.application.importTextEvidence({
    content: "2027年までに個人知識基盤を安定運用する。",
    sourceType: "plain_text",
    privacy: "P1",
    mediaType: "text/plain",
    actor: "owner",
    reason: "Record a goal",
  });
  const proposal = await system.application.proposeAssertion({
    kind: "goal",
    subjectId: system.ids.generate(),
    object: "個人知識基盤を安定運用する",
    evidenceIds: [imported.evidence.id],
    epistemicOrigin: "self_stated",
    validFrom: Temporal.Instant.from("2026-10-20T00:00:00Z"),
    privacy: "P1",
    createdBy: "user",
    actor: "owner",
    reason: "Propose an explicit goal",
  });
  return (
    await system.application.approveProposal({
      proposalId: proposal.id,
      actor: "owner",
      reason: "Confirm the goal",
    })
  ).id;
}

describe("v1 capabilities", () => {
  it("reviews generic temporal intents and exposes an auditable timeline", async () => {
    const system = await testSystem();
    const assertionId = await approvedGoal(system);
    const state = await system.application.getCurrentState({ privacy: ["P1"] });
    const timeline = await system.application.getTimeline({ privacy: ["P1"] });

    expect(state.intents.goal.map((assertion) => assertion.id)).toEqual([assertionId]);
    expect(state.preferences).toEqual([]);
    expect(await system.application.listProposals("approved")).toHaveLength(1);
    expect(timeline.map((entry) => entry.operation)).toEqual([
      "assertion.created",
      "proposal.approved",
      "proposal.created",
      "evidence.imported",
    ]);
    expect(timeline.every((entry) => entry.actor.length > 0 && entry.reason.length > 0)).toBe(true);
  });

  it("combines lexical and local semantic retrieval without exposing P3 remotely", async () => {
    const system = await testSystem();
    const assertionId = await approvedGoal(system);
    const assertion = await system.projection.getAssertion(assertionId);
    expect(assertion).not.toBeNull();
    const retriever = new HybridAssertionRetriever(
      system.projection,
      new LocalHashEmbedding(128),
      new InMemoryVectorIndex(),
    );
    const result = await retriever.search({
      query: "知識基盤の運用目標",
      privacy: ["P1"],
    });
    expect(result[0]?.assertion.id).toBe(assertionId);
    expect(result[0]?.semanticRank).toBe(1);
  });

  it("ingests a directory in cursor pages and deduplicates repeated content", async () => {
    const system = await testSystem();
    const source = join(system.root, "source");
    await mkdir(source);
    await writeFile(join(source, "a.md"), "同じ本文", "utf8");
    await writeFile(join(source, "b.txt"), "同じ本文", "utf8");
    const connector = new DirectorySourceConnector({ root: source, privacy: "P2" });
    const ingestion = new SourceIngestionService(system.application);

    const first = await ingestion.ingest({
      connector,
      cursor: null,
      limit: 1,
      actor: "owner",
      reason: "Test source sync",
    });
    const second = await ingestion.ingest({
      connector,
      cursor: first.nextCursor,
      limit: 1,
      actor: "owner",
      reason: "Test source sync",
    });
    expect(first.imported).toBe(1);
    expect(first.nextCursor).toBe("a.md");
    expect(second.imported).toBe(0);
    expect(second.deduplicated).toBe(1);
    expect(second.nextCursor).toBeNull();
  });

  it("purges raw Evidence, retains the audit event, and backs up only retained bytes", async () => {
    const system = await testSystem();
    const imported = await system.application.importTextEvidence({
      content: "delete after retention",
      sourceType: "plain_text",
      privacy: "P3",
      mediaType: "text/plain",
      actor: "owner",
      reason: "Create retention fixture",
    });
    await system.application.purgeEvidence({
      evidenceId: imported.evidence.id,
      actor: "owner",
      reason: "Retention policy expired",
    });

    expect((await system.application.createBackup()).rawObjects).toEqual([]);
    expect((await system.application.getTimeline({ privacy: ["P3"] }))[0]?.operation).toBe(
      "evidence.purged",
    );
    await expect(system.application.verify()).resolves.toEqual({
      evidenceChecked: 1,
      eventCount: 2,
    });
  });

  it("round-trips authenticated encrypted backups and rejects the wrong key", async () => {
    const source = await testSystem();
    await approvedGoal(source);
    const cipher = new Aes256GcmBackupCipher(new Uint8Array(32).fill(7));
    const encrypted = await source.application.createEncryptedBackup(cipher);
    expect(new TextDecoder().decode(encrypted)).not.toContain("個人知識基盤");

    const destination = await testSystem();
    await expect(
      destination.application.restoreEncryptedBackup(encrypted, cipher),
    ).resolves.toEqual({
      evidenceChecked: 1,
      eventCount: 4,
    });
    await expect(
      (await testSystem()).application.restoreEncryptedBackup(
        encrypted,
        new Aes256GcmBackupCipher(new Uint8Array(32).fill(8)),
      ),
    ).rejects.toThrow("could not be authenticated");
  });
});
