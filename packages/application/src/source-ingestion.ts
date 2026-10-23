import type { SourceConnectorPort, SourceSkip } from "@personal-os/ports";
import { Temporal } from "temporal-polyfill";

import { PersonalOsApplication } from "./personal-os.ts";

export interface SourceIngestionResult {
  readonly connectorId: string;
  readonly nextCursor: string | null;
  readonly imported: number;
  readonly deduplicated: number;
  readonly evidenceIds: readonly string[];
  readonly skipped: readonly SourceSkip[];
}

export class SourceIngestionService {
  readonly #application: PersonalOsApplication;

  constructor(application: PersonalOsApplication) {
    this.#application = application;
  }

  async ingest(input: {
    readonly connector: SourceConnectorPort;
    readonly cursor: string | null;
    readonly limit?: number;
    readonly actor: string;
    readonly reason: string;
  }): Promise<SourceIngestionResult> {
    const page = await input.connector.pull({
      cursor: input.cursor,
      limit: Math.max(1, Math.min(input.limit ?? 100, 1_000)),
    });
    let imported = 0;
    let deduplicated = 0;
    const evidenceIds: string[] = [];
    for (const document of page.documents) {
      const result = await this.#application.importEvidence({
        content: document.content,
        sourceType: document.sourceType,
        sourceUri: document.sourceUri,
        occurredAt:
          document.occurredAt === null ? null : Temporal.Instant.from(document.occurredAt),
        author: document.author,
        privacy: document.privacy,
        mediaType: document.mediaType,
        actor: input.actor,
        reason: `${input.reason} (${input.connector.connectorId}:${document.externalId})`,
      });
      evidenceIds.push(result.evidence.id);
      if (result.deduplicated) {
        deduplicated += 1;
      } else {
        imported += 1;
      }
    }
    return {
      connectorId: input.connector.connectorId,
      nextCursor: page.nextCursor,
      imported,
      deduplicated,
      evidenceIds,
      skipped: page.skipped,
    };
  }
}
