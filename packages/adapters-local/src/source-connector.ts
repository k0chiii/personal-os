import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { EvidenceSourceType, PrivacyClass } from "@personal-os/domain";
import type {
  SecretStorePort,
  SourceConnectorPort,
  SourceDocument,
  SourcePage,
} from "@personal-os/ports";

import { filesBelow, pageAfter } from "./directory-files.ts";

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

  async pull(input: {
    readonly cursor: string | null;
    readonly limit: number;
  }): Promise<SourcePage> {
    const files = await filesBelow(
      this.#root,
      (name) => MEDIA_TYPES[extname(name).toLocaleLowerCase()] !== undefined,
    );
    const { page, nextCursor } = pageAfter(files, input.cursor, input.limit);
    const documents = await Promise.all(
      page.map(async (relativePath): Promise<SourceDocument> => {
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
    return { documents, nextCursor };
  }
}

export class EnvironmentSecretStore implements SecretStorePort {
  async get(name: string): Promise<string | null> {
    return process.env[name] ?? null;
  }
}
