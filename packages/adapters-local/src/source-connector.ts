import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import type { EvidenceSourceType, PrivacyClass } from "@personal-os/domain";
import type { SecretStorePort, SourceConnectorPort, SourceDocument } from "@personal-os/ports";

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".json": "application/json",
  ".txt": "text/plain",
};

function sourceType(extension: string): EvidenceSourceType {
  return extension === ".json"
    ? "json"
    : extension === ".md" || extension === ".markdown"
      ? "markdown"
      : "plain_text";
}

async function filesBelow(root: string, directory = root): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesBelow(root, path)));
    } else if (
      entry.isFile() &&
      MEDIA_TYPES[extname(entry.name).toLocaleLowerCase()] !== undefined
    ) {
      files.push(relative(root, path));
    }
  }
  // Code-unit order, so the sort agrees with the `file > cursor` comparison in pull().
  return files.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export class DirectorySourceConnector implements SourceConnectorPort {
  readonly connectorId: string;
  readonly #root: string;
  readonly #privacy: PrivacyClass;

  constructor(input: {
    readonly root: string;
    readonly privacy: PrivacyClass;
    readonly connectorId?: string;
  }) {
    this.#root = input.root;
    this.#privacy = input.privacy;
    this.connectorId = input.connectorId ?? `directory:${input.root}`;
  }

  async pull(input: { readonly cursor: string | null; readonly limit: number }): Promise<{
    readonly documents: readonly SourceDocument[];
    readonly nextCursor: string | null;
  }> {
    const files = await filesBelow(this.#root);
    const cursor = input.cursor;
    const start = cursor === null ? 0 : files.findIndex((file) => file > cursor);
    const pageFiles = files.slice(
      start < 0 ? files.length : start,
      Math.max(1, input.limit) + (start < 0 ? files.length : start),
    );
    const documents = await Promise.all(
      pageFiles.map(async (relativePath): Promise<SourceDocument> => {
        const absolutePath = join(this.#root, relativePath);
        const metadata = await stat(absolutePath);
        const extension = extname(relativePath).toLocaleLowerCase();
        return {
          externalId: relativePath,
          content: await readFile(absolutePath),
          sourceType: sourceType(extension),
          sourceUri: pathToFileURL(absolutePath).toString(),
          occurredAt: metadata.mtime.toISOString(),
          author: null,
          privacy: this.#privacy,
          mediaType: MEDIA_TYPES[extension]!,
        };
      }),
    );
    const last = pageFiles.at(-1) ?? null;
    return { documents, nextCursor: last === null || last === files.at(-1) ? null : last };
  }
}

export class EnvironmentSecretStore implements SecretStorePort {
  async get(name: string): Promise<string | null> {
    return process.env[name] ?? null;
  }
}
