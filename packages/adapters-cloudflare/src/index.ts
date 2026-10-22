import { Temporal } from "temporal-polyfill";

import {
  ContentHash,
  type AssertionSnapshot,
  type CanonicalEvent,
  type DecisionSnapshot,
  type EvidenceSnapshot,
  type ProposalSnapshot,
} from "@personal-os/domain";
import {
  OptimisticConcurrencyConflict,
  type AppendEventsInput,
  type AgentRunRecord,
  type AgentRunRecorderPort,
  type AssertionSearchInput,
  type ClockPort,
  type ContentHasherPort,
  type DecisionSearchInput,
  type EventStorePort,
  type IdGeneratorPort,
  type ProjectionPort,
  type RawEvidenceStorePort,
  type SecretStorePort,
  type VectorIndexPort,
  type VectorRecord,
  type VectorSearchResult,
  type StoredEvent,
} from "@personal-os/ports";

export class BindingSecretStore implements SecretStorePort {
  readonly #bindings: Readonly<Record<string, string | undefined>>;

  constructor(bindings: Readonly<Record<string, string | undefined>>) {
    this.#bindings = bindings;
  }

  async get(name: string): Promise<string | null> {
    const value = this.#bindings[name];
    return value === undefined || value.length === 0 ? null : value;
  }
}

export interface R2ObjectBodyLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2BucketLike {
  put(key: string, value: Uint8Array): Promise<unknown>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  delete(key: string): Promise<void>;
}

export interface VectorizeIndexLike {
  upsert(
    vectors: readonly {
      readonly id: string;
      readonly values: readonly number[];
      readonly metadata: Readonly<Record<string, string>>;
    }[],
  ): Promise<unknown>;
  deleteByIds(ids: readonly string[]): Promise<unknown>;
  query(
    vector: readonly number[],
    options: { readonly topK: number; readonly returnMetadata: true },
  ): Promise<{
    readonly matches: readonly {
      readonly id: string;
      readonly score: number;
      readonly metadata?: Readonly<Record<string, string>>;
    }[];
  }>;
}

export class CloudflareVectorizeIndex implements VectorIndexPort {
  readonly #index: VectorizeIndexLike;

  constructor(index: VectorizeIndexLike) {
    this.#index = index;
  }

  async upsert(records: readonly VectorRecord[]): Promise<void> {
    for (let offset = 0; offset < records.length; offset += 1_000) {
      await this.#index.upsert(
        records.slice(offset, offset + 1_000).map((record) => ({
          id: record.id,
          values: record.vector,
          metadata: { privacy: record.privacy, text: record.text },
        })),
      );
    }
  }

  async remove(ids: readonly string[]): Promise<void> {
    await this.#index.deleteByIds(ids);
  }

  async search(input: {
    readonly vector: readonly number[];
    readonly privacy: readonly string[];
    readonly limit: number;
  }): Promise<readonly VectorSearchResult[]> {
    const allowed = new Set(input.privacy);
    const result = await this.#index.query(input.vector, {
      topK: Math.min(100, Math.max(input.limit * 4, input.limit)),
      returnMetadata: true,
    });
    return result.matches
      .filter((match) => {
        const privacy = match.metadata?.privacy;
        return privacy !== undefined && allowed.has(privacy);
      })
      .slice(0, input.limit)
      .map((match) => ({ id: match.id, score: match.score }));
  }
}

export interface D1ResultLike<T = Record<string, unknown>> {
  readonly success: boolean;
  readonly results?: readonly T[];
}

export interface D1PreparedStatementLike {
  bind(...values: readonly unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
  run(): Promise<D1ResultLike>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch(statements: readonly D1PreparedStatementLike[]): Promise<readonly D1ResultLike[]>;
}

export class CloudflareSystemClock implements ClockPort {
  now(): Temporal.Instant {
    return Temporal.Now.instant();
  }
}

export class WebCryptoContentHasher implements ContentHasherPort {
  async sha256(content: Uint8Array): Promise<ContentHash> {
    const copy = new Uint8Array(content.byteLength);
    copy.set(content);
    const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
    const hex = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return ContentHash.fromHex(hex);
  }
}

export class WebCryptoUuidV7Generator implements IdGeneratorPort {
  generate(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    let timestamp = BigInt(Date.now());
    for (let index = 5; index >= 0; index -= 1) {
      bytes[index] = Number(timestamp & 0xffn);
      timestamp >>= 8n;
    }
    bytes[6] = (bytes[6]! & 0x0f) | 0x70;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join("-");
  }
}

export class R2RawEvidenceStore implements RawEvidenceStorePort {
  readonly #bucket: R2BucketLike;

  constructor(bucket: R2BucketLike) {
    this.#bucket = bucket;
  }

  async put(hash: ContentHash, content: Uint8Array): Promise<string> {
    const key = `${hash.algorithm}/${hash.hex.slice(0, 2)}/${hash.hex}`;
    await this.#bucket.put(key, content);
    return key;
  }

  async get(rawObjectRef: string): Promise<Uint8Array> {
    const object = await this.#bucket.get(rawObjectRef);
    if (object === null) {
      throw new Error(`Raw Evidence object not found: ${rawObjectRef}.`);
    }
    return new Uint8Array(await object.arrayBuffer());
  }

  async delete(rawObjectRef: string): Promise<void> {
    await this.#bucket.delete(rawObjectRef);
  }
}

interface EventRow {
  readonly global_position: number;
  readonly stream_id: string;
  readonly stream_version: number;
  readonly payload_json: string;
  readonly actor: string;
  readonly reason: string;
  readonly idempotency_key: string | null;
}

interface VersionRow {
  readonly version: number;
}

interface CommandRow {
  readonly stream_id: string;
  readonly first_version: number;
  readonly last_version: number;
}

interface JsonRow {
  readonly payload_json: string;
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- callers provide the schema-owned persisted type.
function parseJson<T>(text: string): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only canonical JSON written by this adapter is read here.
  return JSON.parse(text) as T;
}

function storedEvent(row: EventRow): StoredEvent {
  return {
    globalPosition: row.global_position,
    streamId: row.stream_id,
    streamVersion: row.stream_version,
    event: parseJson<CanonicalEvent>(row.payload_json),
    actor: row.actor,
    reason: row.reason,
    idempotencyKey: row.idempotency_key,
  };
}

function resultRows<T>(result: D1ResultLike<T>): readonly T[] {
  return result.results ?? [];
}

export class D1EventStore implements EventStorePort {
  readonly #database: D1DatabaseLike;

  constructor(database: D1DatabaseLike) {
    this.#database = database;
  }

  async append(input: AppendEventsInput): Promise<readonly StoredEvent[]> {
    if (input.events.length === 0) {
      return [];
    }
    if (input.idempotencyKey !== undefined) {
      const previous = await this.#database
        .prepare(
          "SELECT stream_id, first_version, last_version FROM processed_commands WHERE idempotency_key = ?",
        )
        .bind(input.idempotencyKey)
        .first<CommandRow>();
      if (previous !== null) {
        return this.#readVersionRange(
          previous.stream_id,
          previous.first_version,
          previous.last_version,
        );
      }
    }

    const actualVersion = await this.getStreamVersion(input.streamId);
    if (actualVersion !== input.expectedVersion) {
      throw new OptimisticConcurrencyConflict(input.streamId, input.expectedVersion, actualVersion);
    }
    const statements = input.events.map((event, index) =>
      this.#database
        .prepare(
          `INSERT INTO canonical_events (
            stream_id, stream_version, event_id, event_type, occurred_at,
            payload_json, actor, reason, idempotency_key
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.streamId,
          actualVersion + index + 1,
          event.eventId,
          event.type,
          event.occurredAt,
          JSON.stringify(event),
          input.actor,
          input.reason,
          input.idempotencyKey ?? null,
        ),
    );
    if (input.idempotencyKey !== undefined) {
      statements.push(
        this.#database
          .prepare(
            `INSERT INTO processed_commands (
              idempotency_key, stream_id, first_version, last_version
            ) VALUES (?, ?, ?, ?)`,
          )
          .bind(
            input.idempotencyKey,
            input.streamId,
            actualVersion + 1,
            actualVersion + input.events.length,
          ),
      );
    }
    try {
      await this.#database.batch(statements);
    } catch (error: unknown) {
      const currentVersion = await this.getStreamVersion(input.streamId);
      if (currentVersion !== actualVersion) {
        throw new OptimisticConcurrencyConflict(
          input.streamId,
          input.expectedVersion,
          currentVersion,
        );
      }
      throw error;
    }
    return this.#readVersionRange(
      input.streamId,
      actualVersion + 1,
      actualVersion + input.events.length,
    );
  }

  async readStream(streamId: string): Promise<readonly StoredEvent[]> {
    const result = await this.#database
      .prepare(
        `SELECT global_position, stream_id, stream_version, payload_json, actor, reason,
          idempotency_key FROM canonical_events WHERE stream_id = ? ORDER BY stream_version`,
      )
      .bind(streamId)
      .all<EventRow>();
    return resultRows(result).map(storedEvent);
  }

  async readAll(afterPosition = 0): Promise<readonly StoredEvent[]> {
    const result = await this.#database
      .prepare(
        `SELECT global_position, stream_id, stream_version, payload_json, actor, reason,
          idempotency_key FROM canonical_events WHERE global_position > ? ORDER BY global_position`,
      )
      .bind(afterPosition)
      .all<EventRow>();
    return resultRows(result).map(storedEvent);
  }

  async getStreamVersion(streamId: string): Promise<number> {
    const row = await this.#database
      .prepare(
        "SELECT COALESCE(MAX(stream_version), 0) AS version FROM canonical_events WHERE stream_id = ?",
      )
      .bind(streamId)
      .first<VersionRow>();
    return row?.version ?? 0;
  }

  async #readVersionRange(
    streamId: string,
    firstVersion: number,
    lastVersion: number,
  ): Promise<readonly StoredEvent[]> {
    const result = await this.#database
      .prepare(
        `SELECT global_position, stream_id, stream_version, payload_json, actor, reason,
          idempotency_key FROM canonical_events
          WHERE stream_id = ? AND stream_version BETWEEN ? AND ? ORDER BY stream_version`,
      )
      .bind(streamId, firstVersion, lastVersion)
      .all<EventRow>();
    return resultRows(result).map(storedEvent);
  }
}

export class D1AgentRunRecorder implements AgentRunRecorderPort {
  readonly #database: D1DatabaseLike;

  constructor(database: D1DatabaseLike) {
    this.#database = database;
  }

  async record(run: AgentRunRecord): Promise<void> {
    await this.#database
      .prepare(
        `INSERT INTO agent_runs (
          run_id, timestamp, status, provider, model, prompt_version, context_ids_json,
          tool_calls_json, latency_ms, input_tokens, cached_input_tokens, output_tokens,
          estimated_usd, output, eval_result, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        run.runId,
        run.timestamp,
        run.status,
        run.provider,
        run.model,
        run.promptVersion,
        JSON.stringify(run.contextIds),
        JSON.stringify(run.toolCalls),
        run.latencyMs,
        run.inputTokens,
        run.cachedInputTokens,
        run.outputTokens,
        run.estimatedUsd,
        run.output,
        run.evalResult,
        run.error,
      )
      .run();
  }
}

function eventEvidenceIds(event: CanonicalEvent): readonly string[] {
  switch (event.type) {
    case "evidence.imported":
    case "evidence.purged":
      return [event.evidence.id];
    case "assertion.created":
      return event.assertion.evidenceIds;
    case "assertion.superseded":
      return [...event.previous.evidenceIds, ...event.successor.evidenceIds];
    case "assertion.disputed":
    case "assertion.retracted":
      return event.assertion.evidenceIds;
    case "decision.recorded":
    case "decision.outcome_recorded":
      return event.decision.evidenceIds;
    default:
      return [];
  }
}

function likePattern(query: string): string {
  return `%${query
    .trim()
    .toLocaleLowerCase()
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_")}%`;
}

export class D1Projection implements ProjectionPort {
  readonly #database: D1DatabaseLike;

  constructor(database: D1DatabaseLike) {
    this.#database = database;
  }

  async reset(): Promise<void> {
    await this.#database.batch(
      [
        "evidence_projection",
        "proposal_projection",
        "assertion_projection",
        "decision_projection",
        "audit_projection",
      ].map((table) => this.#database.prepare(`DELETE FROM ${table}`)),
    );
  }

  async apply(events: readonly StoredEvent[]): Promise<void> {
    for (const stored of events) {
      await this.#applyEvent(stored);
    }
  }

  async findEvidenceByHash(hash: ContentHash): Promise<EvidenceSnapshot | null> {
    return this.#readJson<EvidenceSnapshot>(
      "SELECT payload_json FROM evidence_projection WHERE content_hash = ?",
      hash.toString(),
    );
  }

  async getEvidence(id: string): Promise<EvidenceSnapshot | null> {
    return this.#readJson<EvidenceSnapshot>(
      "SELECT payload_json FROM evidence_projection WHERE id = ?",
      id,
    );
  }

  async listEvidence(): Promise<readonly EvidenceSnapshot[]> {
    const result = await this.#database
      .prepare("SELECT payload_json FROM evidence_projection ORDER BY id")
      .all<JsonRow>();
    return resultRows(result).map((row) => parseJson<EvidenceSnapshot>(row.payload_json));
  }

  async getProposal(id: string): Promise<ProposalSnapshot | null> {
    return this.#readJson<ProposalSnapshot>(
      "SELECT payload_json FROM proposal_projection WHERE id = ?",
      id,
    );
  }

  async getAssertion(id: string): Promise<AssertionSnapshot | null> {
    return this.#readJson<AssertionSnapshot>(
      "SELECT payload_json FROM assertion_projection WHERE id = ?",
      id,
    );
  }

  async listAssertions(): Promise<readonly AssertionSnapshot[]> {
    const result = await this.#database
      .prepare("SELECT payload_json FROM assertion_projection ORDER BY id")
      .all<JsonRow>();
    return resultRows(result).map((row) => parseJson<AssertionSnapshot>(row.payload_json));
  }

  async getDecision(id: string): Promise<DecisionSnapshot | null> {
    return this.#readJson<DecisionSnapshot>(
      "SELECT payload_json FROM decision_projection WHERE id = ?",
      id,
    );
  }

  async searchAssertions(input: AssertionSearchInput): Promise<readonly AssertionSnapshot[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
    const query = input.query.trim();
    const statement =
      query.length === 0
        ? this.#database
            .prepare(
              `SELECT payload_json FROM assertion_projection
               WHERE status IN ('active', 'superseded', 'retracted')
                 AND valid_from_ms <= ? AND (valid_until_ms IS NULL OR valid_until_ms > ?)
               ORDER BY valid_from_ms DESC LIMIT ?`,
            )
            .bind(input.asOf.epochMilliseconds, input.asOf.epochMilliseconds, limit * 4)
        : this.#database
            .prepare(
              `SELECT payload_json FROM assertion_projection
               WHERE search_text LIKE ? ESCAPE '\\'
                 AND status IN ('active', 'superseded', 'retracted')
                 AND valid_from_ms <= ? AND (valid_until_ms IS NULL OR valid_until_ms > ?)
               ORDER BY valid_from_ms DESC LIMIT ?`,
            )
            .bind(
              likePattern(query),
              input.asOf.epochMilliseconds,
              input.asOf.epochMilliseconds,
              limit * 4,
            );
    const result = await statement.all<JsonRow>();
    const allowed = input.privacy === undefined ? null : new Set(input.privacy);
    return resultRows(result)
      .map((row) => parseJson<AssertionSnapshot>(row.payload_json))
      .filter((assertion) => allowed === null || allowed.has(assertion.privacy))
      .slice(0, limit);
  }

  async searchDecisions(input: DecisionSearchInput): Promise<readonly DecisionSnapshot[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
    const query = input.query.trim();
    const statement =
      query.length === 0
        ? this.#database
            .prepare(
              `SELECT payload_json FROM decision_projection WHERE decided_at_ms <= ?
               ORDER BY decided_at_ms DESC LIMIT ?`,
            )
            .bind(input.asOf.epochMilliseconds, limit * 4)
        : this.#database
            .prepare(
              `SELECT payload_json FROM decision_projection
               WHERE search_text LIKE ? ESCAPE '\\' AND decided_at_ms <= ?
               ORDER BY decided_at_ms DESC LIMIT ?`,
            )
            .bind(likePattern(query), input.asOf.epochMilliseconds, limit * 4);
    const result = await statement.all<JsonRow>();
    const allowed = input.privacy === undefined ? null : new Set(input.privacy);
    return resultRows(result)
      .map((row) => parseJson<DecisionSnapshot>(row.payload_json))
      .filter((decision) => allowed === null || allowed.has(decision.privacy))
      .slice(0, limit);
  }

  async #readJson<T>(query: string, value: string): Promise<T | null> {
    const row = await this.#database.prepare(query).bind(value).first<JsonRow>();
    return row === null ? null : parseJson<T>(row.payload_json);
  }

  async #applyEvent(stored: StoredEvent): Promise<void> {
    const event = stored.event;
    const statements: D1PreparedStatementLike[] = [];
    switch (event.type) {
      case "evidence.imported":
      case "evidence.purged":
        statements.push(
          this.#database
            .prepare(
              `INSERT INTO evidence_projection (id, content_hash, payload_json) VALUES (?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET content_hash = excluded.content_hash,
                 payload_json = excluded.payload_json`,
            )
            .bind(event.evidence.id, event.evidence.contentHash, JSON.stringify(event.evidence)),
        );
        break;
      case "proposal.created":
        statements.push(this.#upsertProposal(event.proposal));
        break;
      case "proposal.approved":
      case "proposal.rejected": {
        const proposal = await this.getProposal(event.proposalId);
        if (proposal === null) {
          throw new Error(`Cannot project review for missing proposal ${event.proposalId}.`);
        }
        statements.push(
          this.#upsertProposal({
            ...proposal,
            status: event.type === "proposal.approved" ? "approved" : "rejected",
            reviewedAt: event.occurredAt,
            reviewedBy: event.audit.actor,
            reviewReason: event.audit.reason,
          }),
        );
        break;
      }
      case "assertion.created": {
        statements.push(this.#upsertAssertion(event.assertion));
        const proposal = await this.getProposal(event.proposalId);
        if (proposal === null) {
          throw new Error(`Cannot project assertion for missing proposal ${event.proposalId}.`);
        }
        statements.push(this.#upsertProposal({ ...proposal, assertion: event.assertion }));
        break;
      }
      case "assertion.superseded":
        statements.push(
          this.#upsertAssertion(event.previous),
          this.#upsertAssertion(event.successor),
        );
        break;
      case "assertion.disputed":
      case "assertion.retracted":
        statements.push(this.#upsertAssertion(event.assertion));
        break;
      case "decision.recorded":
      case "decision.outcome_recorded":
        statements.push(this.#upsertDecision(event.decision));
        break;
    }
    statements.push(
      this.#database
        .prepare(
          `INSERT INTO audit_projection (
            event_id, operation, actor, reason, occurred_at, evidence_ids_json
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(event_id) DO UPDATE SET operation = excluded.operation,
            actor = excluded.actor, reason = excluded.reason,
            occurred_at = excluded.occurred_at, evidence_ids_json = excluded.evidence_ids_json`,
        )
        .bind(
          event.eventId,
          event.type,
          stored.actor,
          stored.reason,
          event.occurredAt,
          JSON.stringify(eventEvidenceIds(event)),
        ),
    );
    await this.#database.batch(statements);
  }

  #upsertProposal(proposal: ProposalSnapshot): D1PreparedStatementLike {
    return this.#database
      .prepare(
        `INSERT INTO proposal_projection (id, status, payload_json) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload_json = excluded.payload_json`,
      )
      .bind(proposal.id, proposal.status, JSON.stringify(proposal));
  }

  #upsertAssertion(assertion: AssertionSnapshot): D1PreparedStatementLike {
    return this.#database
      .prepare(
        `INSERT INTO assertion_projection (
          id, privacy, status, valid_from_ms, valid_until_ms, search_text, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET privacy = excluded.privacy, status = excluded.status,
          valid_from_ms = excluded.valid_from_ms, valid_until_ms = excluded.valid_until_ms,
          search_text = excluded.search_text, payload_json = excluded.payload_json`,
      )
      .bind(
        assertion.id,
        assertion.privacy,
        assertion.status,
        Temporal.Instant.from(assertion.validFrom).epochMilliseconds,
        assertion.validUntil === null
          ? null
          : Temporal.Instant.from(assertion.validUntil).epochMilliseconds,
        `${assertion.subjectId} ${assertion.object}`.toLocaleLowerCase(),
        JSON.stringify(assertion),
      );
  }

  #upsertDecision(decision: DecisionSnapshot): D1PreparedStatementLike {
    return this.#database
      .prepare(
        `INSERT INTO decision_projection (
          id, privacy, decided_at_ms, search_text, payload_json
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET privacy = excluded.privacy,
          decided_at_ms = excluded.decided_at_ms, search_text = excluded.search_text,
          payload_json = excluded.payload_json`,
      )
      .bind(
        decision.id,
        decision.privacy,
        Temporal.Instant.from(decision.decidedAt).epochMilliseconds,
        `${decision.problem} ${decision.rationale} ${decision.options
          .map((option) => option.label)
          .join(" ")}`.toLocaleLowerCase(),
        JSON.stringify(decision),
      );
  }
}
