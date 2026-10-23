import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vite-plus/test";

import { DirectorySourceConnector } from "../../packages/adapters-local/src/source-connector.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("pages files in the same order the cursor comparison uses", async () => {
  const root = await mkdtemp(join(tmpdir(), "personal-os-source-"));
  roots.push(root);
  // localeCompare orders "a.md" before "B.md"; the cursor comparison (`file > cursor`) does not.
  await writeFile(join(root, "a.md"), "lower", "utf8");
  await writeFile(join(root, "B.md"), "upper", "utf8");
  const connector = new DirectorySourceConnector({ root, privacy: "P2" });

  const first = await connector.pull({ cursor: null, limit: 1 });
  const second = await connector.pull({ cursor: first.nextCursor, limit: 1 });

  expect(first.documents.map((document) => document.externalId)).toEqual(["B.md"]);
  expect(first.nextCursor).toBe("B.md");
  expect(second.documents.map((document) => document.externalId)).toEqual(["a.md"]);
  expect(second.nextCursor).toBeNull();
});
