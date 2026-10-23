#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  Aes256GcmBackupCipher,
  DirectorySourceConnector,
  FileRawEvidenceStore,
  NodeContentHasher,
  SqliteEventStore,
  SqliteProjection,
  SystemClock,
  UuidV7Generator,
  ensureParentDirectory,
} from "@personal-os/adapters-local";
import {
  parseCanonicalBackup,
  PersonalOsApplication,
  SourceIngestionService,
} from "@personal-os/application";
import {
  ASSERTION_KINDS,
  EPISTEMIC_ORIGINS,
  EVIDENCE_SOURCE_TYPES,
  PRIVACY_CLASSES,
} from "@personal-os/domain";
import { Temporal } from "temporal-polyfill";

const HELP = `Personal OS v1 candidate local CLI

Commands:
  personal id
  personal evidence import <file> --source-type <markdown|json|plain_text> --privacy <P0|P1|P2|P3> [--source-uri <uri>] [--occurred-at <instant>] [--author <name>] [--actor <name>] [--reason <text>]
  personal evidence purge <uuidv7> --actor <name> --reason <text>
  personal preference propose --subject <uuidv7> --value <text> --evidence <uuidv7[,uuidv7]> --valid-from <instant> --privacy <P0|P1|P2|P3> [--origin <origin>] [--created-by <agent|user>] [--actor <name>] [--reason <text>]
  personal intent propose --kind <goal|project|artifact|research_topic|value|belief|constraint> --subject <uuidv7> --value <text> --evidence <uuidv7[,uuidv7]> --valid-from <instant> --privacy <P0|P1|P2|P3> [--predicate <name>] [--origin <origin>] [--created-by <agent|user>] [--actor <name>] [--reason <text>]
  personal source sync <directory> --privacy <P0|P1|P2|P3> [--cursor <path>] [--limit <number>] [--actor <name>] [--reason <text>]
  personal retention run --before <instant> --privacy <P0,P1,P2,P3> --actor <name> --reason <text>
  personal proposal approve <uuidv7> --actor <name> --reason <text> [--edit <text>]
  personal proposal reject <uuidv7> --actor <name> --reason <text>
  personal assertion supersede <uuidv7> --value <text> --evidence <uuidv7[,uuidv7]> --valid-from <instant> [--origin <origin>] [--privacy <P0|P1|P2|P3>] --actor <name> --reason <text>
  personal assertion dispute <uuidv7> --actor <name> --reason <text>
  personal assertion retract <uuidv7> --actor <name> --reason <text>
  personal search <query> [--at <instant>] [--privacy <P0,P1,P2,P3>] [--limit <number>]
  personal decision record --subject <uuidv7> --problem <text> --options <id=label|id=label> --chosen <id> --criteria <name=description> --rationale <text> --state <text> --evidence <uuidv7[,uuidv7]> --decided-at <instant> --privacy <P0|P1|P2|P3> [--constraints <text|text>] [--actor <name>] [--reason <text>]
  personal decision outcome <uuidv7> --summary <text> --occurred-at <instant> [--retrospective <text>] --actor <name> --reason <text>
  personal decision search <query> [--at <instant>] [--privacy <P0,P1,P2,P3>] [--limit <number>]
  personal context build <query> --task <text> --privacy <P0,P1,P2,P3> --tokens <number> [--at <instant>]
  personal current [--privacy <P0,P1,P2,P3>] [--at <instant>]
  personal profile [--privacy <P0,P1,P2,P3>] [--at <instant>]
  personal explain <assertion-uuidv7>
  personal backup create <file>
  personal backup restore <file>
  personal backup create-encrypted <file>
  personal backup restore-encrypted <file>
  personal rebuild
  personal doctor
  personal verify

State defaults to .personal-os in the current directory. Set PERSONAL_OS_HOME to override it.
Encrypted backups require PERSONAL_OS_BACKUP_KEY containing a base64-encoded 32-byte key.
`;

interface ParsedArguments {
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string>;
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const flagValue = args[index + 1];
    if (flagValue === undefined || flagValue.startsWith("--")) {
      throw new Error(`Missing value for ${value}.`);
    }
    flags.set(value.slice(2), flagValue);
    index += 1;
  }
  return { positional, flags };
}

function requiredFlag(arguments_: ParsedArguments, name: string): string {
  const value = arguments_.flags.get(name);
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`--${name} is required.`);
  }
  return value;
}

function optionalFlag(arguments_: ParsedArguments, name: string): string | undefined {
  return arguments_.flags.get(name);
}

function oneOf<T extends string>(value: string, allowed: readonly T[], field: string): T {
  if (!allowed.some((candidate) => candidate === value)) {
    throw new Error(`${field} must be one of: ${allowed.join(", ")}.`);
  }
  return allowed.find((candidate) => candidate === value)!;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function keyValueList(
  value: string,
  field: string,
): readonly { readonly key: string; readonly value: string }[] {
  return value.split("|").map((entry) => {
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error(`--${field} entries must use key=value.`);
    }
    return { key: entry.slice(0, separator).trim(), value: entry.slice(separator + 1).trim() };
  });
}

function privacyList(value: string): readonly (typeof PRIVACY_CLASSES)[number][] {
  return value.split(",").map((item) => oneOf(item.trim(), PRIVACY_CLASSES, "privacy"));
}

function backupCipherFromEnvironment(): Aes256GcmBackupCipher {
  const value = process.env.PERSONAL_OS_BACKUP_KEY;
  if (value === undefined || value.trim().length === 0) {
    throw new Error("PERSONAL_OS_BACKUP_KEY is required for encrypted backups.");
  }
  return Aes256GcmBackupCipher.fromBase64(value);
}

async function createApplication(): Promise<{
  readonly application: PersonalOsApplication;
  readonly idGenerator: UuidV7Generator;
}> {
  const stateRoot = resolve(process.env.PERSONAL_OS_HOME ?? ".personal-os");
  const databasePath = join(stateRoot, "personal-os.sqlite");
  await ensureParentDirectory(databasePath);
  const idGenerator = new UuidV7Generator();
  return {
    idGenerator,
    application: new PersonalOsApplication({
      clock: new SystemClock(),
      idGenerator,
      contentHasher: new NodeContentHasher(),
      rawEvidenceStore: new FileRawEvidenceStore(join(stateRoot, "objects")),
      eventStore: new SqliteEventStore(databasePath),
      projection: new SqliteProjection(databasePath),
    }),
  };
}

async function run(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const [resource, action, id] = parsed.positional;
  if (resource === undefined || resource === "help" || parsed.flags.has("help")) {
    process.stdout.write(HELP);
    return;
  }

  const { application, idGenerator } = await createApplication();
  if (resource === "id") {
    writeJson({ id: idGenerator.generate() });
    return;
  }

  if (resource === "evidence" && action === "import") {
    if (id === undefined) {
      throw new Error("A source file is required.");
    }
    const filePath = resolve(id);
    const sourceType = oneOf(
      requiredFlag(parsed, "source-type"),
      EVIDENCE_SOURCE_TYPES,
      "source-type",
    );
    const privacy = oneOf(requiredFlag(parsed, "privacy"), PRIVACY_CLASSES, "privacy");
    const occurredAt = optionalFlag(parsed, "occurred-at");
    const result = await application.importEvidence({
      content: await readFile(filePath),
      sourceType,
      sourceUri: optionalFlag(parsed, "source-uri") ?? filePath,
      occurredAt: occurredAt === undefined ? null : Temporal.Instant.from(occurredAt),
      author: optionalFlag(parsed, "author") ?? null,
      privacy,
      mediaType: sourceType === "json" ? "application/json" : "text/plain",
      actor: optionalFlag(parsed, "actor") ?? "local-user",
      reason: optionalFlag(parsed, "reason") ?? "Import Evidence from the local CLI",
    });
    writeJson(result);
    return;
  }

  if (resource === "evidence" && action === "purge") {
    if (id === undefined) {
      throw new Error("An Evidence ID is required.");
    }
    writeJson(
      await application.purgeEvidence({
        evidenceId: id,
        actor: requiredFlag(parsed, "actor"),
        reason: requiredFlag(parsed, "reason"),
      }),
    );
    return;
  }

  if (resource === "source" && action === "sync") {
    if (id === undefined) {
      throw new Error("A source directory is required.");
    }
    const cursor = optionalFlag(parsed, "cursor");
    const limit = optionalFlag(parsed, "limit");
    writeJson(
      await new SourceIngestionService(application).ingest({
        connector: new DirectorySourceConnector({
          root: resolve(id),
          privacy: oneOf(requiredFlag(parsed, "privacy"), PRIVACY_CLASSES, "privacy"),
        }),
        cursor: cursor ?? null,
        ...(limit === undefined ? {} : { limit: Number.parseInt(limit, 10) }),
        actor: optionalFlag(parsed, "actor") ?? "local-user",
        reason: optionalFlag(parsed, "reason") ?? "Synchronize a directory Source Connector",
      }),
    );
    return;
  }

  if (resource === "retention" && action === "run") {
    writeJson(
      await application.executeRetention({
        importedBefore: Temporal.Instant.from(requiredFlag(parsed, "before")),
        privacy: privacyList(requiredFlag(parsed, "privacy")),
        actor: requiredFlag(parsed, "actor"),
        reason: requiredFlag(parsed, "reason"),
      }),
    );
    return;
  }

  if (resource === "preference" && action === "propose") {
    const validUntil = optionalFlag(parsed, "valid-until");
    const proposal = await application.proposePreference({
      subjectId: requiredFlag(parsed, "subject"),
      object: requiredFlag(parsed, "value"),
      evidenceIds: requiredFlag(parsed, "evidence")
        .split(",")
        .map((value) => value.trim()),
      epistemicOrigin: oneOf(
        optionalFlag(parsed, "origin") ?? "self_stated",
        EPISTEMIC_ORIGINS,
        "origin",
      ),
      confidence: null,
      validFrom: Temporal.Instant.from(requiredFlag(parsed, "valid-from")),
      validUntil: validUntil === undefined ? null : Temporal.Instant.from(validUntil),
      privacy: oneOf(requiredFlag(parsed, "privacy"), PRIVACY_CLASSES, "privacy"),
      createdBy: oneOf(
        optionalFlag(parsed, "created-by") ?? "agent",
        ["agent", "user"],
        "created-by",
      ),
      actor: optionalFlag(parsed, "actor") ?? "local-user",
      reason: optionalFlag(parsed, "reason") ?? "Create a Preference proposal",
    });
    writeJson(proposal);
    return;
  }

  if (resource === "intent" && action === "propose") {
    const validUntil = optionalFlag(parsed, "valid-until");
    const predicate = optionalFlag(parsed, "predicate");
    const proposal = await application.proposeAssertion({
      subjectId: requiredFlag(parsed, "subject"),
      kind: oneOf(requiredFlag(parsed, "kind"), ASSERTION_KINDS, "kind"),
      ...(predicate === undefined ? {} : { predicate }),
      object: requiredFlag(parsed, "value"),
      evidenceIds: requiredFlag(parsed, "evidence")
        .split(",")
        .map((value) => value.trim()),
      epistemicOrigin: oneOf(
        optionalFlag(parsed, "origin") ?? "self_stated",
        EPISTEMIC_ORIGINS,
        "origin",
      ),
      confidence: null,
      validFrom: Temporal.Instant.from(requiredFlag(parsed, "valid-from")),
      validUntil: validUntil === undefined ? null : Temporal.Instant.from(validUntil),
      privacy: oneOf(requiredFlag(parsed, "privacy"), PRIVACY_CLASSES, "privacy"),
      createdBy: oneOf(
        optionalFlag(parsed, "created-by") ?? "agent",
        ["agent", "user"],
        "created-by",
      ),
      actor: optionalFlag(parsed, "actor") ?? "local-user",
      reason: optionalFlag(parsed, "reason") ?? "Create an intent proposal",
    });
    writeJson(proposal);
    return;
  }

  if (resource === "proposal" && action === "approve") {
    if (id === undefined) {
      throw new Error("A Proposal ID is required.");
    }
    const editedObject = optionalFlag(parsed, "edit");
    const assertion = await application.approveProposal({
      proposalId: id,
      actor: requiredFlag(parsed, "actor"),
      reason: requiredFlag(parsed, "reason"),
      ...(editedObject === undefined ? {} : { editedObject }),
    });
    writeJson(assertion);
    return;
  }

  if (resource === "proposal" && action === "reject") {
    if (id === undefined) {
      throw new Error("A Proposal ID is required.");
    }
    const proposal = await application.rejectProposal({
      proposalId: id,
      actor: requiredFlag(parsed, "actor"),
      reason: requiredFlag(parsed, "reason"),
    });
    writeJson(proposal);
    return;
  }

  if (resource === "assertion" && action === "supersede") {
    if (id === undefined) {
      throw new Error("An Assertion ID is required.");
    }
    const origin = optionalFlag(parsed, "origin");
    const privacy = optionalFlag(parsed, "privacy");
    writeJson(
      await application.supersedeAssertion({
        assertionId: id,
        object: requiredFlag(parsed, "value"),
        evidenceIds: requiredFlag(parsed, "evidence")
          .split(",")
          .map((value) => value.trim()),
        validFrom: Temporal.Instant.from(requiredFlag(parsed, "valid-from")),
        ...(origin === undefined
          ? {}
          : { epistemicOrigin: oneOf(origin, EPISTEMIC_ORIGINS, "origin") }),
        ...(privacy === undefined ? {} : { privacy: oneOf(privacy, PRIVACY_CLASSES, "privacy") }),
        actor: requiredFlag(parsed, "actor"),
        reason: requiredFlag(parsed, "reason"),
      }),
    );
    return;
  }

  if (resource === "assertion" && (action === "dispute" || action === "retract")) {
    if (id === undefined) {
      throw new Error("An Assertion ID is required.");
    }
    const input = {
      assertionId: id,
      actor: requiredFlag(parsed, "actor"),
      reason: requiredFlag(parsed, "reason"),
    };
    writeJson(
      action === "dispute"
        ? await application.disputeAssertion(input)
        : await application.retractAssertion(input),
    );
    return;
  }

  if (resource === "decision" && action === "record") {
    const options = keyValueList(requiredFlag(parsed, "options"), "options");
    const criteria = keyValueList(requiredFlag(parsed, "criteria"), "criteria");
    const constraints = optionalFlag(parsed, "constraints");
    const decision = await application.recordDecision({
      subjectId: requiredFlag(parsed, "subject"),
      problem: requiredFlag(parsed, "problem"),
      options: options.map((option) => ({
        id: option.key,
        label: option.value,
        rejectedReason: null,
      })),
      chosenOptionId: requiredFlag(parsed, "chosen"),
      criteria: criteria.map((criterion) => ({
        name: criterion.key,
        description: criterion.value,
      })),
      rationale: requiredFlag(parsed, "rationale"),
      constraints:
        constraints === undefined ? [] : constraints.split("|").map((item) => item.trim()),
      stateSnapshot: requiredFlag(parsed, "state"),
      evidenceIds: requiredFlag(parsed, "evidence")
        .split(",")
        .map((item) => item.trim()),
      decidedAt: Temporal.Instant.from(requiredFlag(parsed, "decided-at")),
      privacy: oneOf(requiredFlag(parsed, "privacy"), PRIVACY_CLASSES, "privacy"),
      actor: optionalFlag(parsed, "actor") ?? "local-user",
      reason: optionalFlag(parsed, "reason") ?? "Record a Decision",
    });
    writeJson(decision);
    return;
  }

  if (resource === "decision" && action === "outcome") {
    if (id === undefined) {
      throw new Error("A Decision ID is required.");
    }
    writeJson(
      await application.recordDecisionOutcome({
        decisionId: id,
        summary: requiredFlag(parsed, "summary"),
        occurredAt: Temporal.Instant.from(requiredFlag(parsed, "occurred-at")),
        retrospective: optionalFlag(parsed, "retrospective") ?? null,
        actor: requiredFlag(parsed, "actor"),
        reason: requiredFlag(parsed, "reason"),
      }),
    );
    return;
  }

  if (resource === "decision" && action === "search") {
    const at = optionalFlag(parsed, "at");
    const privacy = optionalFlag(parsed, "privacy");
    const limit = optionalFlag(parsed, "limit");
    writeJson(
      await application.searchDecisions({
        query: id ?? "",
        ...(at === undefined ? {} : { asOf: Temporal.Instant.from(at) }),
        ...(privacy === undefined ? {} : { privacy: privacyList(privacy) }),
        ...(limit === undefined ? {} : { limit: Number.parseInt(limit, 10) }),
      }),
    );
    return;
  }

  if (resource === "context" && action === "build") {
    const at = optionalFlag(parsed, "at");
    writeJson(
      await application.buildContext({
        task: requiredFlag(parsed, "task"),
        query: id ?? "",
        allowedPrivacy: privacyList(requiredFlag(parsed, "privacy")),
        tokenBudget: Number.parseInt(requiredFlag(parsed, "tokens"), 10),
        ...(at === undefined ? {} : { asOf: Temporal.Instant.from(at) }),
      }),
    );
    return;
  }

  if (resource === "current") {
    const at = optionalFlag(parsed, "at");
    const privacy = optionalFlag(parsed, "privacy");
    writeJson(
      await application.getCurrentState({
        ...(at === undefined ? {} : { asOf: Temporal.Instant.from(at) }),
        ...(privacy === undefined ? {} : { privacy: privacyList(privacy) }),
      }),
    );
    return;
  }

  if (resource === "profile") {
    const at = optionalFlag(parsed, "at");
    const privacy = optionalFlag(parsed, "privacy");
    process.stdout.write(
      await application.generateMasterDocument({
        ...(at === undefined ? {} : { asOf: Temporal.Instant.from(at) }),
        ...(privacy === undefined ? {} : { privacy: privacyList(privacy) }),
      }),
    );
    return;
  }

  if (resource === "search") {
    const query = action ?? "";
    const at = optionalFlag(parsed, "at");
    const privacy = optionalFlag(parsed, "privacy");
    const limit = optionalFlag(parsed, "limit");
    const assertions = await application.searchAssertions({
      query,
      ...(at === undefined ? {} : { asOf: Temporal.Instant.from(at) }),
      ...(privacy === undefined
        ? {}
        : {
            privacy: privacyList(privacy),
          }),
      ...(limit === undefined ? {} : { limit: Number.parseInt(limit, 10) }),
    });
    writeJson(assertions);
    return;
  }

  if (resource === "explain") {
    if (action === undefined) {
      throw new Error("An Assertion ID is required.");
    }
    writeJson(await application.explainAssertion(action));
    return;
  }

  if (resource === "backup" && action === "create") {
    if (id === undefined) {
      throw new Error("A backup file is required.");
    }
    const backup = await application.createBackup();
    const filePath = resolve(id);
    await ensureParentDirectory(filePath);
    await writeFile(filePath, `${JSON.stringify(backup, null, 2)}\n`, "utf8");
    writeJson({ file: filePath, events: backup.events.length, objects: backup.rawObjects.length });
    return;
  }

  if (resource === "backup" && action === "restore") {
    if (id === undefined) {
      throw new Error("A backup file is required.");
    }
    const backup = parseCanonicalBackup(JSON.parse(await readFile(resolve(id), "utf8")));
    writeJson(await application.restoreBackup(backup));
    return;
  }

  if (resource === "backup" && action === "create-encrypted") {
    if (id === undefined) {
      throw new Error("A backup file is required.");
    }
    const encrypted = await application.createEncryptedBackup(backupCipherFromEnvironment());
    const filePath = resolve(id);
    await ensureParentDirectory(filePath);
    await writeFile(filePath, encrypted);
    writeJson({ file: filePath, encryptedBytes: encrypted.byteLength });
    return;
  }

  if (resource === "backup" && action === "restore-encrypted") {
    if (id === undefined) {
      throw new Error("A backup file is required.");
    }
    writeJson(
      await application.restoreEncryptedBackup(
        await readFile(resolve(id)),
        backupCipherFromEnvironment(),
      ),
    );
    return;
  }

  if (resource === "rebuild") {
    writeJson({ replayedEvents: await application.rebuild() });
    return;
  }

  if (resource === "verify" || resource === "doctor") {
    writeJson(await application.verify());
    return;
  }

  throw new Error(`Unknown command: ${parsed.positional.join(" ")}.`);
}

run(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`personal: ${message}\n`);
  process.exitCode = 1;
});
