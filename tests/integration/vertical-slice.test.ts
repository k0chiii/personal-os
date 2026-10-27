import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Temporal } from "temporal-polyfill";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  FileRawEvidenceStore,
  NodeContentHasher,
  SqliteEventStore,
  SqliteProjection,
  UuidV7Generator,
} from "../../packages/adapters-local/src/index.ts";
import {
  parseCanonicalBackup,
  PersonalOsApplication,
} from "../../packages/application/src/index.ts";
import { OptimisticConcurrencyConflict } from "../../packages/ports/src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class FixedClock {
  #value = Temporal.Instant.from("2026-09-04T00:00:00Z");

  now(): Temporal.Instant {
    const current = this.#value;
    this.#value = this.#value.add({ nanoseconds: 1 });
    return current;
  }
}

async function createTestSystem(): Promise<{
  readonly application: PersonalOsApplication;
  readonly events: SqliteEventStore;
  readonly projection: SqliteProjection;
  readonly ids: UuidV7Generator;
}> {
  const directory = await mkdtemp(join(tmpdir(), "personal-os-test-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "personal-os.sqlite");
  const events = new SqliteEventStore(databasePath);
  const projection = new SqliteProjection(databasePath);
  const ids = new UuidV7Generator(() => 1_788_480_000_000);
  return {
    events,
    projection,
    ids,
    application: new PersonalOsApplication({
      clock: new FixedClock(),
      idGenerator: ids,
      contentHasher: new NodeContentHasher(),
      rawEvidenceStore: new FileRawEvidenceStore(join(directory, "objects")),
      eventStore: events,
      projection,
    }),
  };
}

describe("first Vertical Slice", () => {
  it("imports Evidence, reviews a Proposal, searches, explains, verifies, and rebuilds", async () => {
    const { application, events, projection, ids } = await createTestSystem();
    const imported = await application.importTextEvidence({
      content: "私はTypeScriptが好きです。",
      sourceType: "plain_text",
      sourceUri: "conversation://2026-09-04/1",
      occurredAt: Temporal.Instant.from("2026-09-04T00:00:00Z"),
      author: "owner",
      privacy: "P1",
      mediaType: "text/plain",
      actor: "owner",
      reason: "Import an explicit Preference statement",
    });
    const duplicate = await application.importTextEvidence({
      content: "私はTypeScriptが好きです。",
      sourceType: "plain_text",
      privacy: "P1",
      mediaType: "text/plain",
      actor: "owner",
      reason: "Retry the same import",
    });

    expect(imported.deduplicated).toBe(false);
    expect(duplicate.deduplicated).toBe(true);
    expect(duplicate.evidence.id).toBe(imported.evidence.id);

    const proposal = await application.proposePreference({
      subjectId: ids.generate(),
      object: "Type Script",
      evidenceIds: [imported.evidence.id],
      epistemicOrigin: "self_stated",
      validFrom: Temporal.Instant.from("2026-09-04T00:00:00Z"),
      privacy: "P1",
      createdBy: "agent",
      actor: "archivist",
      reason: "Extract an explicit Preference candidate",
    });

    expect(await application.searchAssertions({ query: "TypeScript" })).toEqual([]);

    const assertion = await application.approveProposal({
      proposalId: proposal.id,
      actor: "owner",
      reason: "The Evidence explicitly states this Preference",
      editedObject: "TypeScript",
    });
    const searchResult = await application.searchAssertions({ query: "TypeScript" });
    expect(searchResult).toHaveLength(1);
    expect(searchResult[0]?.id).toBe(assertion.id);

    const explanation = await application.explainAssertion(assertion.id);
    expect(explanation.evidence.map((item) => item.id)).toEqual([imported.evidence.id]);
    expect(explanation.assertion.epistemicOrigin).toBe("self_stated");

    await expect(application.verify()).resolves.toEqual({ evidenceChecked: 1, eventCount: 4 });
    await projection.reset();
    expect(await application.searchAssertions({ query: "TypeScript" })).toEqual([]);
    await expect(application.rebuild()).resolves.toBe(4);
    expect(await application.searchAssertions({ query: "TypeScript" })).toHaveLength(1);
    expect(await events.readAll()).toHaveLength(4);
  });

  it("finds a Japanese substring inside a longer token and keeps ASCII phrases", async () => {
    const { application, ids } = await createTestSystem();
    const imported = await application.importTextEvidence({
      content: "私の研究テーマは TypeScript です。",
      sourceType: "plain_text",
      privacy: "P1",
      mediaType: "text/plain",
      actor: "owner",
      reason: "Import a Japanese preference",
    });
    const evidenceIds = [imported.evidence.id];
    const japanese = await application.approveProposal({
      proposalId: (
        await application.proposePreference({
          subjectId: ids.generate(),
          object: "私の研究テーマ",
          evidenceIds,
          epistemicOrigin: "self_stated",
          validFrom: Temporal.Instant.from("2026-09-04T00:00:00Z"),
          privacy: "P1",
          createdBy: "agent",
          actor: "archivist",
          reason: "Extract the research theme",
        })
      ).id,
      actor: "owner",
      reason: "The Evidence states the theme",
    });
    const typed = await application.approveProposal({
      proposalId: (
        await application.proposePreference({
          subjectId: ids.generate(),
          object: "TypeScript",
          evidenceIds,
          epistemicOrigin: "self_stated",
          validFrom: Temporal.Instant.from("2026-09-04T00:00:00Z"),
          privacy: "P1",
          createdBy: "agent",
          actor: "archivist",
          reason: "Extract the language preference",
        })
      ).id,
      actor: "owner",
      reason: "The Evidence names TypeScript",
    });

    expect(
      (await application.searchAssertions({ query: "研究" })).map((assertion) => assertion.id),
    ).toEqual([japanese.id]);
    expect(
      (await application.searchAssertions({ query: "研究テーマ" })).map(
        (assertion) => assertion.id,
      ),
    ).toEqual([japanese.id]);
    expect(
      (await application.searchAssertions({ query: "研究テ" })).map((assertion) => assertion.id),
    ).toEqual([japanese.id]);
    expect(await application.searchAssertions({ query: "テーマ研" })).toEqual([]);
    expect(
      (await application.searchAssertions({ query: "TypeScript" })).map(
        (assertion) => assertion.id,
      ),
    ).toEqual([typed.id]);
    expect(await application.searchAssertions({ query: "Script" })).toEqual([]);

    const decision = await application.recordDecision({
      subjectId: ids.generate(),
      problem: "研究テーマをどう進めるか",
      options: [
        { id: "local", label: "local-first", rejectedReason: null },
        { id: "remote", label: "remote notes", rejectedReason: "keep the notes local" },
      ],
      chosenOptionId: "local",
      criteria: [{ name: "place", description: "Keep the work on this machine" }],
      rationale: "ローカルに残す。",
      constraints: ["no remote copy"],
      stateSnapshot: "The local runtime is available.",
      evidenceIds,
      decidedAt: Temporal.Instant.from("2026-09-04T00:00:00Z"),
      privacy: "P1",
      actor: "owner",
      reason: "Record the research-theme Decision",
    });
    expect((await application.searchDecisions({ query: "研究" })).map((item) => item.id)).toEqual([
      decision.id,
    ]);
    expect(
      (await application.searchDecisions({ query: "local-first" })).map((item) => item.id),
    ).toEqual([decision.id]);
  });

  it("does not create a canonical Assertion when the owner rejects a Proposal", async () => {
    const { application, events, ids } = await createTestSystem();
    const imported = await application.importTextEvidence({
      content: "候補にすぎません。",
      sourceType: "plain_text",
      privacy: "P1",
      mediaType: "text/plain",
      actor: "owner",
      reason: "Import source text",
    });
    const proposal = await application.proposePreference({
      subjectId: ids.generate(),
      object: "A candidate",
      evidenceIds: [imported.evidence.id],
      epistemicOrigin: "agent_inference",
      validFrom: Temporal.Instant.from("2026-09-04T00:00:00Z"),
      privacy: "P1",
      createdBy: "agent",
      actor: "archivist",
      reason: "Create a candidate",
    });

    await application.rejectProposal({
      proposalId: proposal.id,
      actor: "owner",
      reason: "The source does not support this Preference",
    });

    expect(await application.searchAssertions({ query: "candidate" })).toEqual([]);
    expect((await events.readAll()).map((stored) => stored.event.type)).toEqual([
      "evidence.imported",
      "proposal.created",
      "proposal.rejected",
    ]);
  });

  it("applies temporal and privacy filters before returning Assertions", async () => {
    const { application, ids } = await createTestSystem();
    const imported = await application.importTextEvidence({
      content: "将来の好み",
      sourceType: "plain_text",
      privacy: "P3",
      mediaType: "text/plain",
      actor: "owner",
      reason: "Import restricted Evidence",
    });
    const proposal = await application.proposePreference({
      subjectId: ids.generate(),
      object: "Rust",
      evidenceIds: [imported.evidence.id],
      epistemicOrigin: "self_stated",
      validFrom: Temporal.Instant.from("2030-01-01T00:00:00Z"),
      privacy: "P3",
      createdBy: "user",
      actor: "owner",
      reason: "Record a future Preference",
    });
    await application.approveProposal({
      proposalId: proposal.id,
      actor: "owner",
      reason: "Approve the future Preference",
    });

    expect(
      await application.searchAssertions({
        query: "Rust",
        asOf: Temporal.Instant.from("2029-12-31T23:59:59Z"),
      }),
    ).toEqual([]);
    expect(
      await application.searchAssertions({
        query: "Rust",
        asOf: Temporal.Instant.from("2030-01-01T00:00:00Z"),
        privacy: ["P0", "P1"],
      }),
    ).toEqual([]);
    expect(
      await application.searchAssertions({
        query: "Rust",
        asOf: Temporal.Instant.from("2030-01-01T00:00:00Z"),
        privacy: ["P3"],
      }),
    ).toHaveLength(1);
  });

  it("supersedes an Assertion while preserving its historical truth and replay", async () => {
    const { application, events, projection, ids } = await createTestSystem();
    const oldEvidence = await application.importTextEvidence({
      content: "以前はCoffeeを選んでいた。",
      sourceType: "plain_text",
      privacy: "P1",
      mediaType: "text/plain",
      actor: "owner",
      reason: "Import the old preference",
    });
    const proposal = await application.proposePreference({
      subjectId: ids.generate(),
      object: "Coffee",
      evidenceIds: [oldEvidence.evidence.id],
      epistemicOrigin: "self_stated",
      validFrom: Temporal.Instant.from("2025-01-01T00:00:00Z"),
      privacy: "P1",
      createdBy: "user",
      actor: "owner",
      reason: "Record the old preference",
    });
    const oldAssertion = await application.approveProposal({
      proposalId: proposal.id,
      actor: "owner",
      reason: "Confirm the old preference",
    });
    const newEvidence = await application.importTextEvidence({
      content: "今はTeaを選んでいる。",
      sourceType: "plain_text",
      privacy: "P1",
      mediaType: "text/plain",
      actor: "owner",
      reason: "Import the changed preference",
    });
    const successor = await application.supersedeAssertion({
      assertionId: oldAssertion.id,
      object: "Tea",
      evidenceIds: [newEvidence.evidence.id],
      validFrom: Temporal.Instant.from("2026-01-01T00:00:00Z"),
      actor: "owner",
      reason: "The owner explicitly changed their preference",
    });

    expect(
      await application.searchAssertions({
        query: "Coffee",
        asOf: Temporal.Instant.from("2025-06-01T00:00:00Z"),
      }),
    ).toHaveLength(1);
    expect(
      await application.searchAssertions({
        query: "Coffee",
        asOf: Temporal.Instant.from("2026-06-01T00:00:00Z"),
      }),
    ).toEqual([]);
    expect(
      (
        await application.searchAssertions({
          query: "Tea",
          asOf: Temporal.Instant.from("2026-06-01T00:00:00Z"),
        })
      )[0]?.id,
    ).toBe(successor.id);
    expect((await events.readAll()).at(-1)?.event.type).toBe("assertion.superseded");

    await projection.reset();
    await application.rebuild();
    expect(
      await application.searchAssertions({
        query: "Coffee",
        asOf: Temporal.Instant.from("2025-06-01T00:00:00Z"),
      }),
    ).toHaveLength(1);
    expect(
      await application.searchAssertions({
        query: "Tea",
        asOf: Temporal.Instant.from("2026-06-01T00:00:00Z"),
      }),
    ).toHaveLength(1);
  });

  it("rejects an append with a stale stream version", async () => {
    const { application, events } = await createTestSystem();
    const imported = await application.importTextEvidence({
      content: "Concurrency",
      sourceType: "plain_text",
      privacy: "P1",
      mediaType: "text/plain",
      actor: "owner",
      reason: "Create an event stream",
    });
    const [stored] = await events.readAll();
    expect(stored).toBeDefined();

    await expect(
      events.append({
        streamId: `evidence:${imported.evidence.id}`,
        expectedVersion: 0,
        events: [stored!.event],
        actor: "owner",
        reason: "Use a stale expected version",
      }),
    ).rejects.toBeInstanceOf(OptimisticConcurrencyConflict);
  });

  it("restores canonical Events and Raw Evidence from a versioned backup", async () => {
    const source = await createTestSystem();
    const imported = await source.application.importTextEvidence({
      content: "Backup must preserve this source.",
      sourceType: "plain_text",
      privacy: "P2",
      mediaType: "text/plain",
      actor: "owner",
      reason: "Create a backup fixture",
    });
    const proposal = await source.application.proposePreference({
      subjectId: source.ids.generate(),
      object: "recoverable archives",
      evidenceIds: [imported.evidence.id],
      epistemicOrigin: "self_stated",
      validFrom: Temporal.Instant.from("2026-01-01T00:00:00Z"),
      privacy: "P2",
      createdBy: "user",
      actor: "owner",
      reason: "Create a backup fixture",
    });
    await source.application.approveProposal({
      proposalId: proposal.id,
      actor: "owner",
      reason: "Approve the backup fixture",
    });
    const serialized = JSON.stringify(await source.application.createBackup());
    const backup = parseCanonicalBackup(JSON.parse(serialized));
    const destination = await createTestSystem();

    await expect(destination.application.restoreBackup(backup)).resolves.toEqual({
      evidenceChecked: 1,
      eventCount: 4,
    });
    expect(
      await destination.application.searchAssertions({
        query: "recoverable archives",
        privacy: ["P2"],
      }),
    ).toHaveLength(1);
    expect(
      (await destination.application.explainAssertion(proposal.assertion.id)).evidence,
    ).toEqual([imported.evidence]);
    await expect(destination.application.restoreBackup(backup)).rejects.toThrow(
      "empty Event Store",
    );
  });

  it("restores a multi-event idempotent append as one atomic command", async () => {
    const source = await createTestSystem();
    const imported = await source.application.importTextEvidence({
      content: "An idempotent batch must retain every event.",
      sourceType: "plain_text",
      privacy: "P1",
      mediaType: "text/plain",
      actor: "owner",
      reason: "Create an idempotent backup fixture",
    });
    const proposal = await source.application.proposePreference({
      subjectId: source.ids.generate(),
      object: "complete restores",
      evidenceIds: [imported.evidence.id],
      epistemicOrigin: "self_stated",
      validFrom: Temporal.Instant.from("2026-01-01T00:00:00Z"),
      privacy: "P1",
      createdBy: "user",
      actor: "owner",
      reason: "Create an idempotent backup fixture",
    });
    await source.application.approveProposal({
      proposalId: proposal.id,
      actor: "owner",
      reason: "Approve the idempotent backup fixture",
    });
    const backup = await source.application.createBackup();
    const idempotencyKey = "proposal-review:test";
    const withIdempotentBatch = {
      ...backup,
      events: backup.events.map((stored) =>
        stored.streamId === `proposal:${proposal.id}` && stored.streamVersion >= 2
          ? { ...stored, idempotencyKey }
          : stored,
      ),
    };
    const destination = await createTestSystem();

    await expect(destination.application.restoreBackup(withIdempotentBatch)).resolves.toEqual({
      evidenceChecked: 1,
      eventCount: 4,
    });
    expect(await destination.events.readStream(`proposal:${proposal.id}`)).toHaveLength(3);
  });
});

describe("Decision and Context vertical slice", () => {
  it("records a Decision and Outcome, finds similar Decisions, and builds a bounded Context Pack", async () => {
    const { application, projection, ids } = await createTestSystem();
    const imported = await application.importTextEvidence({
      content: "P3を扱うため、最初はlocal providerを選ぶ。",
      sourceType: "plain_text",
      privacy: "P1",
      mediaType: "text/plain",
      actor: "owner",
      reason: "Import the Decision rationale",
    });
    const decision = await application.recordDecision({
      subjectId: ids.generate(),
      problem: "Which provider should process restricted data?",
      options: [
        { id: "local", label: "local provider", rejectedReason: null },
        { id: "remote", label: "remote provider", rejectedReason: "P3 must remain local" },
      ],
      chosenOptionId: "local",
      criteria: [{ name: "privacy", description: "Keep restricted data on the device" }],
      rationale: "The local provider can process the data without remote transfer.",
      constraints: ["P3 remote denied"],
      stateSnapshot: "The local runtime is available.",
      evidenceIds: [imported.evidence.id],
      decidedAt: Temporal.Instant.from("2026-09-04T00:00:00Z"),
      privacy: "P1",
      actor: "owner",
      reason: "Record a provider-routing Decision",
    });

    expect(await application.searchDecisions({ query: "local provider" })).toHaveLength(1);
    const withOutcome = await application.recordDecisionOutcome({
      decisionId: decision.id,
      summary: "The local provider completed the request.",
      occurredAt: Temporal.Instant.from("2026-09-05T00:00:00Z"),
      retrospective: "The privacy constraint was satisfied.",
      actor: "owner",
      reason: "Record the observed Outcome",
    });
    expect(withOutcome.outcome?.summary).toContain("completed");

    const context = await application.buildContext({
      task: "Choose a provider for a restricted request",
      query: "local provider",
      allowedPrivacy: ["P1"],
      tokenBudget: 2_000,
    });
    expect(context.relevantDecisions.map((item) => item.id)).toEqual([decision.id]);
    expect(context.rawEvidence.map((item) => item.evidence.id)).toEqual([imported.evidence.id]);
    expect(context.estimatedTokens).toBeLessThanOrEqual(context.tokenBudget);

    await projection.reset();
    await application.rebuild();
    expect(
      (await application.searchDecisions({ query: "local provider" }))[0]?.outcome,
    ).not.toBeNull();
  });

  it("includes conflicting active preferences and their Evidence as counter-evidence", async () => {
    const { application, ids } = await createTestSystem();
    const subjectId = ids.generate();
    const localEvidence = await application.importTextEvidence({
      content: "I prefer local-first systems.",
      sourceType: "plain_text",
      privacy: "P1",
      mediaType: "text/plain",
      actor: "owner",
      reason: "Import local-first preference",
    });
    const cloudEvidence = await application.importTextEvidence({
      content: "I prefer cloud-first systems.",
      sourceType: "plain_text",
      privacy: "P1",
      mediaType: "text/plain",
      actor: "owner",
      reason: "Import cloud-first preference",
    });
    for (const [object, evidenceId] of [
      ["local-first systems", localEvidence.evidence.id],
      ["cloud-first systems", cloudEvidence.evidence.id],
    ] as const) {
      const proposal = await application.proposePreference({
        subjectId,
        object,
        evidenceIds: [evidenceId],
        epistemicOrigin: "self_stated",
        validFrom: Temporal.Instant.from("2026-01-01T00:00:00Z"),
        privacy: "P1",
        createdBy: "user",
        actor: "owner",
        reason: "Record a preference",
      });
      await application.approveProposal({
        proposalId: proposal.id,
        actor: "owner",
        reason: "Approve explicit preference",
      });
    }

    const context = await application.buildContext({
      task: "Choose an architecture",
      query: "local-first",
      allowedPrivacy: ["P1"],
      tokenBudget: 4_000,
    });
    expect(context.relevantAssertions.map((item) => item.object)).toEqual(["local-first systems"]);
    expect(context.counterEvidence.map((item) => item.id)).toEqual([cloudEvidence.evidence.id]);
    expect(context.contradictions).toHaveLength(1);
    expect(context.uncertainties).toEqual(["conflicting active assertions require human review"]);
  });

  it("does not put P3 raw Evidence into a Context Pack that allows only P0 and P1", async () => {
    const { application, ids } = await createTestSystem();
    const imported = await application.importTextEvidence({
      content: "restricted source",
      sourceType: "plain_text",
      privacy: "P3",
      mediaType: "text/plain",
      actor: "owner",
      reason: "Import restricted Evidence",
    });
    await application.recordDecision({
      subjectId: ids.generate(),
      problem: "Restricted choice",
      options: [
        { id: "a", label: "Option A", rejectedReason: null },
        { id: "b", label: "Option B", rejectedReason: "Not chosen" },
      ],
      chosenOptionId: "a",
      criteria: [{ name: "privacy", description: "Keep data private" }],
      rationale: "Restricted rationale",
      stateSnapshot: "Restricted state",
      evidenceIds: [imported.evidence.id],
      decidedAt: Temporal.Instant.from("2026-09-04T00:00:00Z"),
      privacy: "P3",
      actor: "owner",
      reason: "Record a restricted Decision",
    });

    const context = await application.buildContext({
      task: "Search permitted context",
      query: "Restricted",
      allowedPrivacy: ["P0", "P1"],
      tokenBudget: 2_000,
    });
    expect(context.relevantDecisions).toEqual([]);
    expect(context.rawEvidence).toEqual([]);
    expect(context.uncertainties).toEqual(["insufficient evidence"]);
  });
});
