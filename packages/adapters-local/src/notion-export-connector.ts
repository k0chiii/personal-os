import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { EvidenceSourceType, PrivacyClass } from "@personal-os/domain";
import type { SourceConnectorPort, SourceDocument, SourcePage } from "@personal-os/ports";

import { filesBelow, pageAfter } from "./directory-files.ts";

export interface NotionExportSkip {
  readonly externalId: string;
  readonly reason: string;
}

export interface NotionExportPage extends SourcePage {
  readonly skipped: readonly NotionExportSkip[];
}

// Notion's "Markdown & CSV" and "HTML" exports name each page `<Title> <32 hex page id>.<ext>`.
const PAGE_FILE = /^.* ([0-9a-f]{32})\.(md|html)$/u;

const FORMATS: Readonly<
  Record<string, { readonly sourceType: EvidenceSourceType; readonly mediaType: string }>
> = {
  ".md": { sourceType: "markdown", mediaType: "text/markdown" },
  ".html": { sourceType: "plain_text", mediaType: "text/html" },
};

const utf8 = new TextDecoder("utf-8", { fatal: true });

function notionPageId(relativePath: string): string | null {
  return PAGE_FILE.exec(basename(relativePath))?.[1] ?? null;
}

function notionPageProblem(content: Uint8Array): string | null {
  let text: string;
  try {
    text = utf8.decode(content);
  } catch {
    return "content is not valid UTF-8";
  }
  return text.trim().length === 0 ? "page is empty" : null;
}

export class NotionExportSourceConnector implements SourceConnectorPort {
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
    this.connectorId = input.connectorId ?? `notion-export:${input.root}`;
  }

  async pull(input: {
    readonly cursor: string | null;
    readonly limit: number;
  }): Promise<NotionExportPage> {
    const files = await filesBelow(
      this.#root,
      (name) => FORMATS[extname(name).toLocaleLowerCase()] !== undefined,
    );
    const firstFileForPage = new Map<string, string>();
    for (const file of files) {
      const pageId = notionPageId(file);
      if (pageId !== null && !firstFileForPage.has(pageId)) {
        firstFileForPage.set(pageId, file);
      }
    }
    const { page, nextCursor } = pageAfter(files, input.cursor, input.limit);
    const results = await Promise.all(
      page.map(async (relativePath): Promise<SourceDocument | NotionExportSkip> => {
        const pageId = notionPageId(relativePath);
        if (pageId === null) {
          return { externalId: relativePath, reason: "file name has no Notion page id" };
        }
        const original = firstFileForPage.get(pageId)!;
        if (original !== relativePath) {
          return { externalId: relativePath, reason: `duplicate of Notion page ${original}` };
        }
        const content = await readFile(join(this.#root, relativePath));
        const problem = notionPageProblem(content);
        if (problem !== null) {
          return { externalId: relativePath, reason: problem };
        }
        const format = FORMATS[extname(relativePath).toLocaleLowerCase()]!;
        return {
          externalId: pageId,
          content,
          sourceType: format.sourceType,
          sourceUri: `https://www.notion.so/${pageId}`,
          occurredAt: null,
          author: null,
          privacy: this.#privacy,
          mediaType: format.mediaType,
        };
      }),
    );
    return {
      documents: results.filter((result): result is SourceDocument => "content" in result),
      skipped: results.filter((result): result is NotionExportSkip => "reason" in result),
      nextCursor,
    };
  }
}
