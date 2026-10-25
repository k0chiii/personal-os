import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  ASSERTION_KINDS,
  ASSERTION_STATUSES,
  ContentHash,
  EPISTEMIC_ORIGINS,
  EVIDENCE_SOURCE_TYPES,
  PRIVACY_CLASSES,
  PROPOSAL_STATUSES,
  type AssertionSnapshot,
  type CanonicalEvent,
  type DecisionSnapshot,
  type EvidenceSnapshot,
  type ProposalSnapshot,
} from "@personal-os/domain";
import {
  OptimisticConcurrencyConflict,
  type AppendEventsInput,
  type AssertionSearchInput,
  type ClockPort,
  type ContentHasherPort,
  type DecisionSearchInput,
  type EventStorePort,
  type IdGeneratorPort,
  type ProjectionPort,
  type RawEvidenceStorePort,
  type StoredEvent,
} from "@personal-os/ports";
import { Temporal } from "temporal-polyfill";

export class SystemClock implements ClockPort {
  now(): Temporal.Instant {
    return Temporal.Now.instant();
  }
}

export class NodeContentHasher implements ContentHasherPort {
  async sha256(content: Uint8Array): Promise<ContentHash> {
    const hex = createHash("sha256").update(content).digest("hex");
    return ContentHash.fromHex(hex);
  }
}

export class UuidV7Generator implements IdGeneratorPort {
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  generate(): string {
    const bytes = randomBytes(16);
    let timestamp = BigInt(this.#now());
    for (let index = 5; index >= 0; index -= 1) {
      bytes[index] = Number(timestamp & 0xffn);
      timestamp >>= 8n;
    }
    bytes[6] = (bytes[6]! & 0x0f) | 0x70;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join("-");
  }
}

export class FileRawEvidenceStore implements RawEvidenceStorePort {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async put(hash: ContentHash, content: Uint8Array): Promise<string> {
    const relativePath = join(hash.algorithm, hash.hex.slice(0, 2), hash.hex);
    const target = join(this.#root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    try {
      await writeFile(target, content, { flag: "wx" });
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
    }
    return relativePath;
  }

  async get(rawObjectRef: string): Promise<Uint8Array> {
    return readFile(join(this.#root, rawObjectRef));
  }

  async delete(rawObjectRef: string): Promise<void> {
    const target = join(this.#root, rawObjectRef);
    try {
      await access(target, constants.F_OK);
      await unlink(target);
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

interface NodeError extends Error {
  readonly code?: string;
}

function isNodeError(error: unknown): error is NodeError {
  return error instanceof Error;
}

type UnknownRecord = Record<string, unknown>;

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown, label: string): UnknownRecord {
  if (!isUnknownRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function stringValue(record: UnknownRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string.`);
  }
  return value;
}

function nullableStringValue(record: UnknownRecord, key: string): string | null {
  const value = record[key];
  if (value !== null && typeof value !== "string") {
    throw new Error(`${key} must be a string or null.`);
  }
  return value;
}

function numberValue(record: UnknownRecord, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number.`);
  }
  return value;
}

function nullableNumberValue(record: UnknownRecord, key: string): number | null {
  const value = record[key];
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`${key} must be a finite number or null.`);
  }
  return value;
}

function stringArrayValue(record: UnknownRecord, key: string): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${key} must be an array of strings.`);
  }
  return value;
}

function enumValue<T extends string>(record: UnknownRecord, key: string, allowed: readonly T[]): T {
  const value = stringValue(record, key);
  const matched = allowed.find((candidate) => candidate === value);
  if (matched === undefined) {
    throw new Error(`${key} has an unsupported value.`);
  }
  return matched;
}

function parseJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}

function parseEvidenceSnapshot(value: unknown): EvidenceSnapshot {
  const record = recordValue(value, "Evidence");
  return {
    id: stringValue(record, "id"),
    sourceType: enumValue(record, "sourceType", EVIDENCE_SOURCE_TYPES),
    sourceUri: nullableStringValue(record, "sourceUri"),
    contentHash: ContentHash.parse(stringValue(record, "contentHash")).toString(),
    occurredAt: nullableStringValue(record, "occurredAt"),
    importedAt: stringValue(record, "importedAt"),
    author: nullableStringValue(record, "author"),
    privacy: enumValue(record, "privacy", PRIVACY_CLASSES),
    rawObjectRef: stringValue(record, "rawObjectRef"),
    mediaType: stringValue(record, "mediaType"),
    purgedAt: record.purgedAt === undefined ? null : nullableStringValue(record, "purgedAt"),
  };
}

function parseAssertionSnapshot(value: unknown): AssertionSnapshot {
  const record = recordValue(value, "Assertion");
  return {
    id: stringValue(record, "id"),
    subjectId: stringValue(record, "subjectId"),
    kind: enumValue(record, "kind", ASSERTION_KINDS),
    predicate: stringValue(record, "predicate"),
    object: stringValue(record, "object"),
    evidenceIds: stringArrayValue(record, "evidenceIds"),
    epistemicOrigin: enumValue(record, "epistemicOrigin", EPISTEMIC_ORIGINS),
    confidence: nullableNumberValue(record, "confidence"),
    validFrom: stringValue(record, "validFrom"),
    validUntil: nullableStringValue(record, "validUntil"),
    recordedAt: stringValue(record, "recordedAt"),
    privacy: enumValue(record, "privacy", PRIVACY_CLASSES),
    status: enumValue(record, "status", ASSERTION_STATUSES),
  };
}

function parseProposalSnapshot(value: unknown): ProposalSnapshot {
  const record = recordValue(value, "Proposal");
  return {
    id: stringValue(record, "id"),
    assertion: parseAssertionSnapshot(record.assertion),
    status: enumValue(record, "status", PROPOSAL_STATUSES),
    createdAt: stringValue(record, "createdAt"),
    createdBy: enumValue(record, "createdBy", ["agent", "user"]),
    reviewedAt: nullableStringValue(record, "reviewedAt"),
    reviewedBy: nullableStringValue(record, "reviewedBy"),
    reviewReason: nullableStringValue(record, "reviewReason"),
  };
}

function parseDecisionSnapshot(value: unknown): DecisionSnapshot {
  const record = recordValue(value, "Decision");
  const optionsValue = record.options;
  const criteriaValue = record.criteria;
  if (!Array.isArray(optionsValue) || !Array.isArray(criteriaValue)) {
    throw new Error("Decision options and criteria must be arrays.");
  }
  const outcomeValue = record.outcome;
  let outcome: DecisionSnapshot["outcome"] = null;
  if (outcomeValue !== null) {
    const outcomeRecord = recordValue(outcomeValue, "Decision Outcome");
    outcome = {
      summary: stringValue(outcomeRecord, "summary"),
      occurredAt: stringValue(outcomeRecord, "occurredAt"),
      recordedAt: stringValue(outcomeRecord, "recordedAt"),
    };
  }
  return {
    id: stringValue(record, "id"),
    subjectId: stringValue(record, "subjectId"),
    problem: stringValue(record, "problem"),
    options: optionsValue.map((optionValue) => {
      const option = recordValue(optionValue, "Decision Option");
      return {
        id: stringValue(option, "id"),
        label: stringValue(option, "label"),
        rejectedReason: nullableStringValue(option, "rejectedReason"),
      };
    }),
    chosenOptionId: stringValue(record, "chosenOptionId"),
    criteria: criteriaValue.map((criterionValue) => {
      const criterion = recordValue(criterionValue, "Decision Criterion");
      return {
        name: stringValue(criterion, "name"),
        description: stringValue(criterion, "description"),
      };
    }),
    rationale: stringValue(record, "rationale"),
    constraints: stringArrayValue(record, "constraints"),
    stateSnapshot: stringValue(record, "stateSnapshot"),
    evidenceIds: stringArrayValue(record, "evidenceIds"),
    decidedAt: stringValue(record, "decidedAt"),
    recordedAt: stringValue(record, "recordedAt"),
    privacy: enumValue(record, "privacy", PRIVACY_CLASSES),
    outcome,
    retrospective: nullableStringValue(record, "retrospective"),
  };
}

function parseAudit(value: unknown): { readonly actor: string; readonly reason: string } {
  const record = recordValue(value, "Audit metadata");
  return { actor: stringValue(record, "actor"), reason: stringValue(record, "reason") };
}

function parseCanonicalEvent(text: string): CanonicalEvent {
  const record = recordValue(parseJson(text), "Canonical Event");
  const type = stringValue(record, "type");
  const common = {
    eventId: stringValue(record, "eventId"),
    occurredAt: stringValue(record, "occurredAt"),
  };
  switch (type) {
    case "evidence.imported":
      return { type, ...common, evidence: parseEvidenceSnapshot(record.evidence) };
    case "evidence.purged":
      return {
        type,
        ...common,
        evidence: parseEvidenceSnapshot(record.evidence),
        audit: parseAudit(record.audit),
      };
    case "proposal.created":
      return { type, ...common, proposal: parseProposalSnapshot(record.proposal) };
    case "proposal.approved":
      return {
        type,
        ...common,
        proposalId: stringValue(record, "proposalId"),
        assertionId: stringValue(record, "assertionId"),
        audit: parseAudit(record.audit),
      };
    case "proposal.rejected":
      return {
        type,
        ...common,
        proposalId: stringValue(record, "proposalId"),
        audit: parseAudit(record.audit),
      };
    case "assertion.created":
      return {
        type,
        ...common,
        assertion: parseAssertionSnapshot(record.assertion),
        proposalId: stringValue(record, "proposalId"),
        audit: parseAudit(record.audit),
      };
    case "assertion.superseded":
      return {
        type,
        ...common,
        previous: parseAssertionSnapshot(record.previous),
        successor: parseAssertionSnapshot(record.successor),
        audit: parseAudit(record.audit),
      };
    case "assertion.disputed":
    case "assertion.retracted":
      return {
        type,
        ...common,
        assertion: parseAssertionSnapshot(record.assertion),
        audit: parseAudit(record.audit),
      };
    case "decision.recorded":
    case "decision.outcome_recorded":
      return {
        type,
        ...common,
        decision: parseDecisionSnapshot(record.decision),
        audit: parseAudit(record.audit),
      };
    default:
      throw new Error(`Unsupported Canonical Event type: ${type}.`);
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
  readonly first_position: number;
  readonly last_position: number;
}

function eventRow(value: unknown): EventRow {
  const record = recordValue(value, "Event row");
  return {
    global_position: numberValue(record, "global_position"),
    stream_id: stringValue(record, "stream_id"),
    stream_version: numberValue(record, "stream_version"),
    payload_json: stringValue(record, "payload_json"),
    actor: stringValue(record, "actor"),
    reason: stringValue(record, "reason"),
    idempotency_key: nullableStringValue(record, "idempotency_key"),
  };
}

function commandRow(value: unknown): CommandRow | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = recordValue(value, "Processed command row");
  return {
    first_position: numberValue(record, "first_position"),
    last_position: numberValue(record, "last_position"),
  };
}

function versionRow(value: unknown): VersionRow {
  const record = recordValue(value, "Stream version row");
  return { version: numberValue(record, "version") };
}

function eventFromRow(row: EventRow): StoredEvent {
  return {
    globalPosition: row.global_position,
    streamId: row.stream_id,
    streamVersion: row.stream_version,
    event: parseCanonicalEvent(row.payload_json),
    actor: row.actor,
    reason: row.reason,
    idempotencyKey: row.idempotency_key,
  };
}

const SQLITE_SCHEMA_VERSION = 2;

function ensureSchemaVersion(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO schema_metadata (singleton, schema_version) VALUES (1, 1);
  `);
  const record = recordValue(
    database.prepare("SELECT schema_version FROM schema_metadata WHERE singleton = 1").get(),
    "Schema metadata",
  );
  const version = numberValue(record, "schema_version");
  if (version > SQLITE_SCHEMA_VERSION || version < 1) {
    throw new Error(
      `Unsupported SQLite schema version ${version}; latest supported version is ${SQLITE_SCHEMA_VERSION}.`,
    );
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  if (version === 1) {
    database.exec("BEGIN IMMEDIATE;");
    try {
      database
        .prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, ?)")
        .run(Temporal.Now.instant().toString());
      database.prepare("UPDATE schema_metadata SET schema_version = 2 WHERE singleton = 1").run();
      database.exec("COMMIT;");
    } catch (error: unknown) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }
}

export class SqliteEventStore implements EventStorePort {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    ensureSchemaVersion(this.#database);
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS canonical_events (
        global_position INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id TEXT NOT NULL,
        stream_version INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        idempotency_key TEXT,
        UNIQUE(stream_id, stream_version)
      );
      CREATE TABLE IF NOT EXISTS processed_commands (
        idempotency_key TEXT PRIMARY KEY,
        first_position INTEGER NOT NULL,
        last_position INTEGER NOT NULL
      );
    `);
  }

  async append(input: AppendEventsInput): Promise<readonly StoredEvent[]> {
    if (input.events.length === 0) {
      return [];
    }

    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      if (input.idempotencyKey !== undefined) {
        const previous = commandRow(
          this.#database
            .prepare(
              "SELECT first_position, last_position FROM processed_commands WHERE idempotency_key = ?",
            )
            .get(input.idempotencyKey),
        );
        if (previous !== undefined) {
          this.#database.exec("COMMIT;");
          return this.#readPositionRange(previous.first_position, previous.last_position);
        }
      }

      const actualVersion = this.#currentVersion(input.streamId);
      if (actualVersion !== input.expectedVersion) {
        throw new OptimisticConcurrencyConflict(
          input.streamId,
          input.expectedVersion,
          actualVersion,
        );
      }

      const insert = this.#database.prepare(`
        INSERT INTO canonical_events (
          stream_id, stream_version, event_id, event_type, occurred_at,
          payload_json, actor, reason, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      let firstPosition = 0;
      let lastPosition = 0;
      input.events.forEach((event, index) => {
        const result = insert.run(
          input.streamId,
          actualVersion + index + 1,
          event.eventId,
          event.type,
          event.occurredAt,
          JSON.stringify(event),
          input.actor,
          input.reason,
          input.idempotencyKey ?? null,
        );
        const position = Number(result.lastInsertRowid);
        firstPosition ||= position;
        lastPosition = position;
      });

      if (input.idempotencyKey !== undefined) {
        this.#database
          .prepare(
            "INSERT INTO processed_commands (idempotency_key, first_position, last_position) VALUES (?, ?, ?)",
          )
          .run(input.idempotencyKey, firstPosition, lastPosition);
      }
      this.#database.exec("COMMIT;");
      return this.#readPositionRange(firstPosition, lastPosition);
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  async readStream(streamId: string): Promise<readonly StoredEvent[]> {
    const rows = this.#database
      .prepare(
        "SELECT global_position, stream_id, stream_version, payload_json, actor, reason, idempotency_key FROM canonical_events WHERE stream_id = ? ORDER BY stream_version",
      )
      .all(streamId);
    return rows.map(eventRow).map(eventFromRow);
  }

  async readAll(afterPosition = 0): Promise<readonly StoredEvent[]> {
    const rows = this.#database
      .prepare(
        "SELECT global_position, stream_id, stream_version, payload_json, actor, reason, idempotency_key FROM canonical_events WHERE global_position > ? ORDER BY global_position",
      )
      .all(afterPosition);
    return rows.map(eventRow).map(eventFromRow);
  }

  async getStreamVersion(streamId: string): Promise<number> {
    return this.#currentVersion(streamId);
  }

  #currentVersion(streamId: string): number {
    const row = versionRow(
      this.#database
        .prepare(
          "SELECT COALESCE(MAX(stream_version), 0) AS version FROM canonical_events WHERE stream_id = ?",
        )
        .get(streamId),
    );
    return row.version;
  }

  #readPositionRange(first: number, last: number): readonly StoredEvent[] {
    const rows = this.#database
      .prepare(
        "SELECT global_position, stream_id, stream_version, payload_json, actor, reason, idempotency_key FROM canonical_events WHERE global_position BETWEEN ? AND ? ORDER BY global_position",
      )
      .all(first, last);
    return rows.map(eventRow).map(eventFromRow);
  }
}

interface JsonRow {
  readonly payload_json: string;
}

function instantMilliseconds(value: string): number {
  return Temporal.Instant.from(value).epochMilliseconds;
}

function jsonRow(value: unknown): JsonRow {
  const record = recordValue(value, "JSON projection row");
  return { payload_json: stringValue(record, "payload_json") };
}

function optionalJsonRow(value: unknown): JsonRow | undefined {
  return value === undefined ? undefined : jsonRow(value);
}

export class SqliteProjection implements ProjectionPort {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    ensureSchemaVersion(this.#database);
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS evidence_projection (
        id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS proposal_projection (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assertion_projection (
        id TEXT PRIMARY KEY,
        privacy TEXT NOT NULL,
        status TEXT NOT NULL,
        valid_from_ms INTEGER NOT NULL,
        valid_until_ms INTEGER,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assertion_evidence_projection (
        assertion_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        PRIMARY KEY(assertion_id, evidence_id)
      );
      CREATE TABLE IF NOT EXISTS decision_projection (
        id TEXT PRIMARY KEY,
        privacy TEXT NOT NULL,
        decided_at_ms INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_projection (
        event_id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        evidence_ids_json TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS assertion_fts USING fts5(
        assertion_id UNINDEXED,
        subject_id UNINDEXED,
        object,
        tokenize = 'unicode61'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS decision_fts USING fts5(
        decision_id UNINDEXED,
        problem,
        rationale,
        options,
        tokenize = 'unicode61'
      );
    `);
  }

  async reset(): Promise<void> {
    this.#database.exec(`
      DELETE FROM evidence_projection;
      DELETE FROM proposal_projection;
      DELETE FROM assertion_projection;
      DELETE FROM assertion_evidence_projection;
      DELETE FROM decision_projection;
      DELETE FROM audit_projection;
      DELETE FROM assertion_fts;
      DELETE FROM decision_fts;
    `);
  }

  async apply(events: readonly StoredEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      for (const stored of events) {
        this.#applyEvent(stored);
      }
      this.#database.exec("COMMIT;");
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  async findEvidenceByHash(hash: ContentHash): Promise<EvidenceSnapshot | null> {
    const row = optionalJsonRow(
      this.#database
        .prepare("SELECT payload_json FROM evidence_projection WHERE content_hash = ?")
        .get(hash.toString()),
    );
    return row === undefined ? null : parseEvidenceSnapshot(parseJson(row.payload_json));
  }

  async getEvidence(id: string): Promise<EvidenceSnapshot | null> {
    const row = optionalJsonRow(
      this.#database.prepare("SELECT payload_json FROM evidence_projection WHERE id = ?").get(id),
    );
    return row === undefined ? null : parseEvidenceSnapshot(parseJson(row.payload_json));
  }

  async listEvidence(): Promise<readonly EvidenceSnapshot[]> {
    const rows = this.#database
      .prepare("SELECT payload_json FROM evidence_projection ORDER BY id")
      .all();
    return rows.map(jsonRow).map((row) => parseEvidenceSnapshot(parseJson(row.payload_json)));
  }

  async getProposal(id: string): Promise<ProposalSnapshot | null> {
    const row = optionalJsonRow(
      this.#database.prepare("SELECT payload_json FROM proposal_projection WHERE id = ?").get(id),
    );
    return row === undefined ? null : parseProposalSnapshot(parseJson(row.payload_json));
  }

  async getAssertion(id: string): Promise<AssertionSnapshot | null> {
    const row = optionalJsonRow(
      this.#database.prepare("SELECT payload_json FROM assertion_projection WHERE id = ?").get(id),
    );
    return row === undefined ? null : parseAssertionSnapshot(parseJson(row.payload_json));
  }

  async listAssertions(): Promise<readonly AssertionSnapshot[]> {
    const rows = this.#database
      .prepare("SELECT payload_json FROM assertion_projection ORDER BY id")
      .all();
    return rows.map(jsonRow).map((row) => parseAssertionSnapshot(parseJson(row.payload_json)));
  }

  async getDecision(id: string): Promise<DecisionSnapshot | null> {
    const row = optionalJsonRow(
      this.#database.prepare("SELECT payload_json FROM decision_projection WHERE id = ?").get(id),
    );
    return row === undefined ? null : parseDecisionSnapshot(parseJson(row.payload_json));
  }

  async searchAssertions(input: AssertionSearchInput): Promise<readonly AssertionSnapshot[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
    const asOf = input.asOf.epochMilliseconds;
    const rows =
      input.query.trim().length === 0
        ? this.#database
            .prepare(
              `SELECT payload_json FROM assertion_projection
             WHERE status IN ('active', 'superseded', 'retracted') AND valid_from_ms <= ?
               AND (valid_until_ms IS NULL OR valid_until_ms > ?)
             ORDER BY valid_from_ms DESC LIMIT ?`,
            )
            .all(asOf, asOf, limit * 4)
        : this.#database
            .prepare(
              `SELECT a.payload_json FROM assertion_projection a
             JOIN assertion_fts f ON f.assertion_id = a.id
             WHERE assertion_fts MATCH ? AND a.status IN ('active', 'superseded', 'retracted')
               AND a.valid_from_ms <= ?
               AND (a.valid_until_ms IS NULL OR a.valid_until_ms > ?)
             ORDER BY bm25(assertion_fts), a.valid_from_ms DESC LIMIT ?`,
            )
            .all(ftsPhrase(input.query), asOf, asOf, limit * 4);

    const allowed = input.privacy === undefined ? null : new Set(input.privacy);
    return rows
      .map(jsonRow)
      .map((row) => parseAssertionSnapshot(parseJson(row.payload_json)))
      .filter((assertion) => allowed === null || allowed.has(assertion.privacy))
      .slice(0, limit);
  }

  async searchDecisions(input: DecisionSearchInput): Promise<readonly DecisionSnapshot[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
    const asOf = input.asOf.epochMilliseconds;
    const rows =
      input.query.trim().length === 0
        ? this.#database
            .prepare(
              "SELECT payload_json FROM decision_projection WHERE decided_at_ms <= ? ORDER BY decided_at_ms DESC LIMIT ?",
            )
            .all(asOf, limit * 4)
        : this.#database
            .prepare(
              `SELECT d.payload_json FROM decision_projection d
               JOIN decision_fts f ON f.decision_id = d.id
               WHERE decision_fts MATCH ? AND d.decided_at_ms <= ?
               ORDER BY bm25(decision_fts), d.decided_at_ms DESC LIMIT ?`,
            )
            .all(ftsPhrase(input.query), asOf, limit * 4);
    const allowed = input.privacy === undefined ? null : new Set(input.privacy);
    return rows
      .map(jsonRow)
      .map((row) => parseDecisionSnapshot(parseJson(row.payload_json)))
      .filter((decision) => allowed === null || allowed.has(decision.privacy))
      .slice(0, limit);
  }

  #applyEvent(stored: StoredEvent): void {
    const event = stored.event;
    switch (event.type) {
      case "evidence.imported":
        this.#database
          .prepare(
            "INSERT OR IGNORE INTO evidence_projection (id, content_hash, payload_json) VALUES (?, ?, ?)",
          )
          .run(event.evidence.id, event.evidence.contentHash, JSON.stringify(event.evidence));
        break;
      case "evidence.purged":
        this.#database
          .prepare(
            "INSERT OR REPLACE INTO evidence_projection (id, content_hash, payload_json) VALUES (?, ?, ?)",
          )
          .run(event.evidence.id, event.evidence.contentHash, JSON.stringify(event.evidence));
        break;
      case "proposal.created":
        this.#database
          .prepare(
            "INSERT OR REPLACE INTO proposal_projection (id, status, payload_json) VALUES (?, ?, ?)",
          )
          .run(event.proposal.id, event.proposal.status, JSON.stringify(event.proposal));
        break;
      case "proposal.approved":
        this.#updateProposalReview(event.proposalId, "approved", event.occurredAt, event.audit);
        break;
      case "proposal.rejected":
        this.#updateProposalReview(event.proposalId, "rejected", event.occurredAt, event.audit);
        break;
      case "assertion.created":
        this.#upsertAssertion(event.assertion);
        this.#replaceProposalAssertion(event.proposalId, event.assertion);
        break;
      case "assertion.superseded":
        this.#upsertAssertion(event.previous);
        this.#upsertAssertion(event.successor);
        break;
      case "assertion.disputed":
      case "assertion.retracted":
        this.#upsertAssertion(event.assertion);
        break;
      case "decision.recorded":
      case "decision.outcome_recorded":
        this.#upsertDecision(event.decision);
        break;
    }

    const evidenceIds =
      event.type === "evidence.imported"
        ? [event.evidence.id]
        : event.type === "assertion.created"
          ? event.assertion.evidenceIds
          : event.type === "assertion.superseded"
            ? [...event.previous.evidenceIds, ...event.successor.evidenceIds]
            : event.type === "assertion.disputed" || event.type === "assertion.retracted"
              ? event.assertion.evidenceIds
              : event.type === "decision.recorded" || event.type === "decision.outcome_recorded"
                ? event.decision.evidenceIds
                : [];
    this.#database
      .prepare(
        "INSERT OR REPLACE INTO audit_projection (event_id, operation, actor, reason, occurred_at, evidence_ids_json) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.eventId,
        event.type,
        stored.actor,
        stored.reason,
        event.occurredAt,
        JSON.stringify(evidenceIds),
      );
  }

  #updateProposalReview(
    proposalId: string,
    status: "approved" | "rejected",
    reviewedAt: string,
    audit: { readonly actor: string; readonly reason: string },
  ): void {
    const row = optionalJsonRow(
      this.#database
        .prepare("SELECT payload_json FROM proposal_projection WHERE id = ?")
        .get(proposalId),
    );
    if (row === undefined) {
      throw new Error(`Cannot project review for missing proposal ${proposalId}.`);
    }
    const proposal = parseProposalSnapshot(parseJson(row.payload_json));
    const updated: ProposalSnapshot = {
      ...proposal,
      status,
      reviewedAt,
      reviewedBy: audit.actor,
      reviewReason: audit.reason,
    };
    this.#database
      .prepare("UPDATE proposal_projection SET status = ?, payload_json = ? WHERE id = ?")
      .run(status, JSON.stringify(updated), proposalId);
  }

  #replaceProposalAssertion(proposalId: string, assertion: AssertionSnapshot): void {
    const row = optionalJsonRow(
      this.#database
        .prepare("SELECT payload_json FROM proposal_projection WHERE id = ?")
        .get(proposalId),
    );
    if (row === undefined) {
      throw new Error(`Cannot project assertion for missing proposal ${proposalId}.`);
    }
    const proposal = parseProposalSnapshot(parseJson(row.payload_json));
    const updated: ProposalSnapshot = { ...proposal, assertion };
    this.#database
      .prepare("UPDATE proposal_projection SET payload_json = ? WHERE id = ?")
      .run(JSON.stringify(updated), proposalId);
  }

  #upsertAssertion(assertion: AssertionSnapshot): void {
    this.#database
      .prepare(
        `INSERT OR REPLACE INTO assertion_projection (
          id, privacy, status, valid_from_ms, valid_until_ms, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        assertion.id,
        assertion.privacy,
        assertion.status,
        instantMilliseconds(assertion.validFrom),
        assertion.validUntil === null ? null : instantMilliseconds(assertion.validUntil),
        JSON.stringify(assertion),
      );
    this.#database
      .prepare("DELETE FROM assertion_evidence_projection WHERE assertion_id = ?")
      .run(assertion.id);
    const insertEvidence = this.#database.prepare(
      "INSERT INTO assertion_evidence_projection (assertion_id, evidence_id) VALUES (?, ?)",
    );
    assertion.evidenceIds.forEach((evidenceId) => insertEvidence.run(assertion.id, evidenceId));
    this.#database.prepare("DELETE FROM assertion_fts WHERE assertion_id = ?").run(assertion.id);
    this.#database
      .prepare("INSERT INTO assertion_fts (assertion_id, subject_id, object) VALUES (?, ?, ?)")
      .run(assertion.id, assertion.subjectId, ftsIndexedText(assertion.object));
  }

  #upsertDecision(decision: DecisionSnapshot): void {
    this.#database
      .prepare(
        "INSERT OR REPLACE INTO decision_projection (id, privacy, decided_at_ms, payload_json) VALUES (?, ?, ?, ?)",
      )
      .run(
        decision.id,
        decision.privacy,
        instantMilliseconds(decision.decidedAt),
        JSON.stringify(decision),
      );
    this.#database.prepare("DELETE FROM decision_fts WHERE decision_id = ?").run(decision.id);
    this.#database
      .prepare(
        "INSERT INTO decision_fts (decision_id, problem, rationale, options) VALUES (?, ?, ?, ?)",
      )
      .run(
        decision.id,
        ftsIndexedText(decision.problem),
        ftsIndexedText(decision.rationale),
        ftsIndexedText(decision.options.map((option) => option.label).join(" ")),
      );
  }
}

const JAPANESE_GRAPHEME = /^(?:\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|ー)$/u;

function japaneseBigrams(text: string): readonly string[] {
  const characters = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text.normalize("NFKC")),
    (segment) => segment.segment,
  );
  const bigrams: string[] = [];
  let previous: string | undefined;
  for (const character of characters) {
    if (!JAPANESE_GRAPHEME.test(character)) {
      previous = undefined;
      continue;
    }
    if (previous !== undefined) {
      bigrams.push(`${previous}${character}`);
    }
    previous = character;
  }
  return [...new Set(bigrams)];
}

function ftsQuote(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

function ftsIndexedText(text: string): string {
  const bigrams = japaneseBigrams(text);
  return bigrams.length === 0 ? text : `${text} ${bigrams.join(" ")}`;
}

function ftsPhrase(query: string): string {
  const trimmed = query.trim();
  const bigrams = japaneseBigrams(trimmed);
  if (bigrams.length === 0) {
    return ftsQuote(trimmed);
  }
  const latin = trimmed
    .replaceAll(/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|ー/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
  const terms = bigrams.map(ftsQuote);
  return latin.length === 0 ? terms.join(" AND ") : [ftsQuote(latin), ...terms].join(" AND ");
}

export async function ensureParentDirectory(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}
