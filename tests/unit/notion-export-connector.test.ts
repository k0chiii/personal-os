import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Temporal } from "temporal-polyfill";
import { afterEach, expect, it } from "vite-plus/test";

import {
  FileRawEvidenceStore,
  NodeContentHasher,
  NotionExportSourceConnector,
  SqliteEventStore,
  SqliteProjection,
  UuidV7Generator,
} from "../../packages/adapters-local/src/index.ts";
import {
  PersonalOsApplication,
  SourceIngestionService,
} from "../../packages/application/src/index.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/notion-export-mini", import.meta.url));
const HOME = "1f0c6a2e9b7d4c3a8e5f2b1d0c9a8e7f";
const READING = "4b2a9c8d7e6f45a3b2c1d0e9f8a7b6c5";
const WEEKLY = "7d6c5b4a3f2e41d0c9b8a7f6e5d4c3b2";
const WEEKLY_COPY = "9e8d7c6b5a4f43e2d1c0b9a8f7e6d5c4";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "personal-os-notion-"));
  roots.push(root);
  return root;
}

async function testSystem() {
  const root = await temporaryRoot();
  const database = join(root, "personal-os.sqlite");
  const projection = new SqliteProjection(database);
  let now = Temporal.Instant.from("2026-10-23T00:00:00Z");
  const application = new PersonalOsApplication({
    clock: {
      now: () => {
        now = now.add({ nanoseconds: 1 });
        return now;
      },
    },
    idGenerator: new UuidV7Generator(() => 1_792_454_400_000),
    contentHasher: new NodeContentHasher(),
    rawEvidenceStore: new FileRawEvidenceStore(join(root, "objects")),
    eventStore: new SqliteEventStore(database),
    projection,
  });
  return { application, projection, ingestion: new SourceIngestionService(application) };
}

it("imports every exported page as Evidence and creates no Proposal or Assertion", async () => {
  const system = await testSystem();
  const connector = new NotionExportSourceConnector({ root: FIXTURE, privacy: "P1" });

  const result = await system.ingestion.ingest({
    connector,
    cursor: null,
    actor: "owner",
    reason: "Sync Notion export",
  });

  expect(result).toMatchObject({ imported: 3, deduplicated: 1, nextCursor: null, skipped: [] });
  const evidence = await system.projection.listEvidence();
  expect(new Set(evidence.map((item) => item.sourceUri))).toEqual(
    new Set([HOME, READING, WEEKLY].map((id) => `https://www.notion.so/${id}`)),
  );
  expect(evidence.every((item) => item.privacy === "P1")).toBe(true);
  expect(evidence.every((item) => item.mediaType === "text/markdown")).toBe(true);
  expect(await system.application.listProposals()).toEqual([]);
  expect(await system.projection.listAssertions()).toEqual([]);
});

it("deduplicates a second sync of the same export by content hash", async () => {
  const system = await testSystem();
  const connector = new NotionExportSourceConnector({ root: FIXTURE, privacy: "P2" });
  const sync = () =>
    system.ingestion.ingest({ connector, cursor: null, actor: "owner", reason: "Sync" });

  const first = await sync();
  const second = await sync();

  expect(second).toMatchObject({ imported: 0, deduplicated: 4 });
  expect(second.evidenceIds).toEqual(first.evidenceIds);
  expect(await system.projection.listEvidence()).toHaveLength(3);
});

it("pages through the export one file per pull until the cursor runs out", async () => {
  const connector = new NotionExportSourceConnector({ root: FIXTURE, privacy: "P2" });
  const externalIds: string[] = [];
  let cursor: string | null = null;
  let pulls = 0;
  do {
    const page = await connector.pull({ cursor, limit: 1 });
    expect(page.documents).toHaveLength(1);
    externalIds.push(...page.documents.map((document) => document.externalId));
    cursor = page.nextCursor;
    pulls += 1;
  } while (cursor !== null && pulls < 10);

  expect(externalIds).toEqual([HOME, READING, WEEKLY, WEEKLY_COPY]);
});

it("skips files that are not readable Notion pages and says why", async () => {
  const root = await temporaryRoot();
  const pageId = "0a1b2c3d4e5f46a7b8c9d0e1f2a3b4c5";
  await mkdir(join(root, "Trash"));
  await writeFile(join(root, `Kept ${pageId}.html`), "<html><body>Kept</body></html>");
  await writeFile(join(root, `Trash/Kept again ${pageId}.md`), "# Kept again");
  await writeFile(join(root, "notes.md"), "# No page id");
  await writeFile(join(root, `Broken ${"b".repeat(32)}.md`), Uint8Array.of(0xff, 0xfe, 0x00));
  await writeFile(join(root, `Blank ${"c".repeat(32)}.md`), " \n");
  const connector = new NotionExportSourceConnector({ root, privacy: "P3" });

  const page = await connector.pull({ cursor: null, limit: 100 });

  expect(page.documents).toEqual([
    expect.objectContaining({
      externalId: pageId,
      sourceType: "plain_text",
      mediaType: "text/html",
      privacy: "P3",
    }),
  ]);
  expect(page.skipped).toEqual([
    { externalId: `Blank ${"c".repeat(32)}.md`, reason: "page is empty" },
    { externalId: `Broken ${"b".repeat(32)}.md`, reason: "content is not valid UTF-8" },
    {
      externalId: `Trash/Kept again ${pageId}.md`,
      reason: `duplicate of Notion page Kept ${pageId}.html`,
    },
    { externalId: "notes.md", reason: "file name has no Notion page id" },
  ]);
});
