import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Temporal } from "temporal-polyfill";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { createApiHandler } from "../../apps/api/src/handler.ts";
import {
  FileRawEvidenceStore,
  MockLlm,
  NodeContentHasher,
  SqliteEventStore,
  SqliteProjection,
  UuidV7Generator,
} from "../../packages/adapters-local/src/index.ts";
import {
  DecisionSimulator,
  PersonalOsApplication,
  ProviderRouter,
} from "../../packages/application/src/index.ts";
import { InMemoryAgentRunRecorder } from "../../packages/observability/src/index.ts";

let temporaryDirectory = "";
let application: PersonalOsApplication;
let ids: UuidV7Generator;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "personal-os-api-test-"));
  const databasePath = join(temporaryDirectory, "personal-os.sqlite");
  ids = new UuidV7Generator(() => 1_788_480_000_000);
  application = new PersonalOsApplication({
    clock: { now: () => Temporal.Instant.from("2026-09-04T00:00:00Z") },
    idGenerator: ids,
    contentHasher: new NodeContentHasher(),
    rawEvidenceStore: new FileRawEvidenceStore(join(temporaryDirectory, "objects")),
    eventStore: new SqliteEventStore(databasePath),
    projection: new SqliteProjection(databasePath),
  });
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

async function seedPreference(): Promise<string> {
  const evidence = await application.importTextEvidence({
    content: "I prefer local-first software.",
    sourceType: "plain_text",
    privacy: "P1",
    mediaType: "text/plain",
    actor: "owner",
    reason: "Seed an API test",
  });
  const proposal = await application.proposePreference({
    subjectId: ids.generate(),
    object: "local-first software",
    evidenceIds: [evidence.evidence.id],
    epistemicOrigin: "self_stated",
    validFrom: Temporal.Instant.from("2026-09-04T00:00:00Z"),
    privacy: "P1",
    createdBy: "user",
    actor: "owner",
    reason: "Seed an API test",
  });
  const assertion = await application.approveProposal({
    proposalId: proposal.id,
    actor: "owner",
    reason: "Approve the API test fixture",
  });
  return assertion.id;
}

describe("HTTP API", () => {
  it("keeps health public while requiring an injected authenticated principal", async () => {
    const handle = createApiHandler({
      application,
      authenticator: {
        authenticate(request) {
          const subject = request.headers.get("x-test-subject");
          return subject === null ? null : { subject };
        },
      },
    });

    await expect(handle(new Request("http://localhost/health"))).resolves.toMatchObject({
      status: 200,
    });
    await expect(handle(new Request("http://localhost/v1/self/current"))).resolves.toMatchObject({
      status: 401,
    });
    await expect(
      handle(
        new Request("http://localhost/v1/self/current", {
          headers: { "x-test-subject": "owner" },
        }),
      ),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("imports Evidence through the HTTP boundary", async () => {
    const handle = createApiHandler({ application });
    const response = await handle(
      new Request("http://localhost/v1/evidence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "Portable evidence",
          sourceType: "plain_text",
          sourceUri: "api://contract",
          privacy: "P1",
          mediaType: "text/plain",
          actor: "owner",
          reason: "Import through HTTP",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      deduplicated: false,
      evidence: { sourceUri: "api://contract", privacy: "P1" },
    });
  });

  it("serves search, provenance, Context Pack, and simulation endpoints", async () => {
    const assertionId = await seedPreference();
    const recorder = new InMemoryAgentRunRecorder();
    const simulator = new DecisionSimulator(
      application,
      new ProviderRouter([new MockLlm(() => "Choose local-first software.")]),
      {
        recorder,
        clock: { now: () => Temporal.Instant.from("2026-09-04T00:00:01Z") },
        idGenerator: ids,
        promptVersion: "decision-simulator/v1",
        monotonicMilliseconds: (() => {
          let value = 100;
          return () => value++;
        })(),
      },
    );
    const handle = createApiHandler({ application, simulator });

    const search = await handle(
      new Request("http://localhost/v1/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "local-first", privacy: ["P1"] }),
      }),
    );
    const searchBody: unknown = await search.json();
    expect(search.status).toBe(200);
    expect(searchBody).toMatchObject({ assertions: [{ id: assertionId }] });

    const current = await handle(
      new Request("http://localhost/v1/self/current?privacy=P1", { method: "GET" }),
    );
    expect(await current.json()).toMatchObject({ preferences: [{ id: assertionId }] });

    const explanation = await handle(new Request(`http://localhost/v1/assertions/${assertionId}`));
    expect(await explanation.json()).toMatchObject({
      assertion: { id: assertionId },
      evidence: [{ privacy: "P1" }],
    });

    const context = await handle(
      new Request("http://localhost/v1/context", {
        method: "POST",
        body: JSON.stringify({
          task: "Recommend software",
          query: "local-first",
          privacy: ["P1"],
          tokenBudget: 1_000,
        }),
      }),
    );
    expect(await context.json()).toMatchObject({ relevantAssertions: [{ id: assertionId }] });

    const simulation = await handle(
      new Request("http://localhost/v1/simulations", {
        method: "POST",
        body: JSON.stringify({
          task: "Recommend software",
          query: "local-first",
          privacy: ["P1"],
          tokenBudget: 1_000,
        }),
      }),
    );
    expect(await simulation.json()).toMatchObject({
      status: "generated",
      prediction: "Choose local-first software.",
      provider: "mock",
    });
    expect(recorder.runs).toHaveLength(1);
    expect(recorder.runs[0]).toMatchObject({
      status: "succeeded",
      provider: "mock",
      model: "deterministic-mock",
      promptVersion: "decision-simulator/v1",
      contextIds: expect.arrayContaining([assertionId]),
      output: "Choose local-first software.",
      error: null,
    });
  });

  it("returns a stable problem response for an invalid body", async () => {
    const handle = createApiHandler({ application });
    const response = await handle(
      new Request("http://localhost/v1/search", {
        method: "POST",
        body: JSON.stringify({ query: "missing privacy" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_request" });
  });

  it("answers a talk from the voice, and from memory when the voice is absent", async () => {
    await seedPreference();
    const voiced = createApiHandler({
      application,
      voice: {
        async reply({ message, memory, history }) {
          return `${history.map((line) => line.text).join(" ")} 聞いた。${message} ${memory.join(" ")}`.trim();
        },
      },
    });
    const talked = await voiced(
      new Request("http://localhost/v1/talk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "local-first",
          privacy: ["P1"],
          history: [
            { role: "owner", text: "さっきの話" },
            { role: "system", text: "紅茶だよ" },
          ],
        }),
      }),
    );
    expect(talked.status).toBe(200);
    expect(await talked.json()).toEqual({
      reply: "さっきの話 紅茶だよ 聞いた。local-first local-first software",
    });

    const plain = createApiHandler({ application });
    const remembered = await plain(
      new Request("http://localhost/v1/talk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "local-first", privacy: ["P1"] }),
      }),
    );
    expect(await remembered.json()).toEqual({ reply: "local-first software" });

    const empty = await plain(
      new Request("http://localhost/v1/talk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "nothing-stored-zzz", privacy: ["P1"] }),
      }),
    );
    expect(await empty.json()).toEqual({ reply: "記憶にはまだない話だね。続きを聞かせて。" });

    const broken = createApiHandler({
      application,
      voice: {
        reply() {
          return Promise.reject(new Error("model down"));
        },
      },
    });
    const fellBack = await broken(
      new Request("http://localhost/v1/talk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "local-first", privacy: ["P1"] }),
      }),
    );
    expect(await fellBack.json()).toEqual({ reply: "local-first software" });
  });
});
