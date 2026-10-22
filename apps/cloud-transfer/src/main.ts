import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  AwsContentHasher,
  AwsSystemClock,
  AwsUuidV7Generator,
  DynamoDbEventStore,
  DynamoDbProjection,
  S3RawEvidenceStore,
} from "@personal-os/adapters-aws";
import { D1EventStore, D1Projection } from "@personal-os/adapters-cloudflare";
import { Aes256GcmBackupCipher } from "@personal-os/adapters-local";
import { PersonalOsApplication } from "@personal-os/application";

import { D1HttpDatabase } from "./d1-http.ts";

type Provider = "aws" | "cloudflare";
type Command = "export" | "restore" | "verify" | "rebuild";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}.`);
  }
  return value;
}

function awsApplication(): PersonalOsApplication {
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return new PersonalOsApplication({
    clock: new AwsSystemClock(),
    idGenerator: new AwsUuidV7Generator(),
    contentHasher: new AwsContentHasher(),
    rawEvidenceStore: new S3RawEvidenceStore(
      new S3Client({}),
      requiredEnvironment("EVIDENCE_BUCKET_NAME"),
    ),
    eventStore: new DynamoDbEventStore(documentClient, requiredEnvironment("EVENT_TABLE_NAME")),
    projection: new DynamoDbProjection(
      documentClient,
      requiredEnvironment("PROJECTION_TABLE_NAME"),
    ),
  });
}

function cloudflareApplication(): PersonalOsApplication {
  const accountId = requiredEnvironment("CLOUDFLARE_ACCOUNT_ID");
  const database = new D1HttpDatabase({
    accountId,
    databaseId: requiredEnvironment("CLOUDFLARE_D1_DATABASE_ID"),
    apiToken: requiredEnvironment("CLOUDFLARE_API_TOKEN"),
  });
  const r2Client = new S3Client({
    region: "auto",
    endpoint:
      process.env.CLOUDFLARE_R2_ENDPOINT?.trim() || `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requiredEnvironment("CLOUDFLARE_R2_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnvironment("CLOUDFLARE_R2_SECRET_ACCESS_KEY"),
    },
  });
  return new PersonalOsApplication({
    clock: new AwsSystemClock(),
    idGenerator: new AwsUuidV7Generator(),
    contentHasher: new AwsContentHasher(),
    rawEvidenceStore: new S3RawEvidenceStore(
      r2Client,
      requiredEnvironment("CLOUDFLARE_R2_BUCKET_NAME"),
    ),
    eventStore: new D1EventStore(database),
    projection: new D1Projection(database),
  });
}

function application(selectedProvider: Provider): PersonalOsApplication {
  return selectedProvider === "aws" ? awsApplication() : cloudflareApplication();
}

function cipher(): Aes256GcmBackupCipher {
  return Aes256GcmBackupCipher.fromBase64(requiredEnvironment("PERSONAL_OS_BACKUP_KEY"));
}

async function writeExclusive(file: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(resolve(file), "wx", 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

function parseProvider(value: string | undefined): Provider {
  if (value !== "aws" && value !== "cloudflare") {
    throw new Error("Provider must be aws or cloudflare.");
  }
  return value;
}

function command(value: string | undefined): Command {
  if (value !== "export" && value !== "restore" && value !== "verify" && value !== "rebuild") {
    throw new Error("Command must be export, restore, verify, or rebuild.");
  }
  return value;
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const selectedCommand = command(process.argv[2]);
  const selectedProvider = parseProvider(process.argv[3]);
  const personalOs = application(selectedProvider);

  switch (selectedCommand) {
    case "export": {
      const file = process.argv[4];
      if (file === undefined) {
        throw new Error("Export requires an output file path.");
      }
      const report = await personalOs.verify();
      await writeExclusive(file, await personalOs.createEncryptedBackup(cipher()));
      output({ command: selectedCommand, provider: selectedProvider, file: resolve(file), report });
      break;
    }
    case "restore": {
      const file = process.argv[4];
      if (file === undefined) {
        throw new Error("Restore requires an input file path.");
      }
      const report = await personalOs.restoreEncryptedBackup(
        await readFile(resolve(file)),
        cipher(),
      );
      output({ command: selectedCommand, provider: selectedProvider, report });
      break;
    }
    case "verify":
      output({
        command: selectedCommand,
        provider: selectedProvider,
        report: await personalOs.verify(),
      });
      break;
    case "rebuild": {
      const eventCount = await personalOs.rebuild();
      output({
        command: selectedCommand,
        provider: selectedProvider,
        eventCount,
        report: await personalOs.verify(),
      });
      break;
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown cloud transfer failure.";
  process.stderr.write(`personal-os cloud transfer: ${message}\n`);
  process.exitCode = 1;
});
