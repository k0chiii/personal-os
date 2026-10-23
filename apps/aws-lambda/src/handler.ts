import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from "aws-lambda";

import {
  AwsContentHasher,
  AwsSystemClock,
  AwsUuidV7Generator,
  DynamoDbAgentRunRecorder,
  DynamoDbEventStore,
  DynamoDbProjection,
  DynamoDbVectorIndex,
  S3RawEvidenceStore,
  SsmSecretStore,
} from "@personal-os/adapters-aws";
import { OpenAiAdapter } from "@personal-os/adapters-openai";
import { createApiHandler, FixedWindowRateLimiter } from "@personal-os/api";
import { DecisionSimulator, PersonalOsApplication, ProviderRouter } from "@personal-os/application";
import { HybridAssertionRetriever, LocalHashEmbedding } from "@personal-os/retrieval";

import { AUTHENTICATED_SUBJECT_HEADER, ownerAuthenticator } from "./owner-authenticator.ts";

interface Runtime {
  readonly handle: (request: Request) => Promise<Response>;
}

let runtimePromise: Promise<Runtime> | undefined;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function authenticatedSubject(event: APIGatewayProxyEventV2): string | null {
  const requestContext: unknown = event.requestContext;
  if (!isRecord(requestContext) || !isRecord(requestContext.authorizer)) {
    return null;
  }
  const jwt = requestContext.authorizer.jwt;
  if (!isRecord(jwt) || !isRecord(jwt.claims)) {
    return null;
  }
  return typeof jwt.claims.sub === "string" ? jwt.claims.sub : null;
}

async function openAiApiKey(): Promise<string | null> {
  const parameterName = process.env.OPENAI_API_KEY_PARAMETER?.trim();
  if (parameterName === undefined || parameterName.length === 0) {
    return null;
  }
  const value = await new SsmSecretStore(new SSMClient({})).get(parameterName);
  if (value === null || value.length === 0) {
    throw new Error(`SSM parameter ${parameterName} has no value.`);
  }
  return value;
}

async function createRuntime(): Promise<Runtime> {
  const eventTableName = requiredEnvironment("EVENT_TABLE_NAME");
  const projectionTableName = requiredEnvironment("PROJECTION_TABLE_NAME");
  const evidenceBucketName = requiredEnvironment("EVIDENCE_BUCKET_NAME");
  const ownerSubject = requiredEnvironment("OWNER_SUBJECT").trim();
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const clock = new AwsSystemClock();
  const idGenerator = new AwsUuidV7Generator();
  const projection = new DynamoDbProjection(documentClient, projectionTableName);
  const application = new PersonalOsApplication({
    clock,
    idGenerator,
    contentHasher: new AwsContentHasher(),
    rawEvidenceStore: new S3RawEvidenceStore(new S3Client({}), evidenceBucketName),
    eventStore: new DynamoDbEventStore(documentClient, eventTableName),
    projection,
    assertionRetriever: new HybridAssertionRetriever(
      projection,
      new LocalHashEmbedding(256),
      new DynamoDbVectorIndex(documentClient, projectionTableName),
    ),
  });
  const apiKey = await openAiApiKey();
  const simulator =
    apiKey === null
      ? undefined
      : new DecisionSimulator(
          application,
          new ProviderRouter([
            new OpenAiAdapter({
              apiKey,
              model: process.env.OPENAI_MODEL ?? "gpt-5-mini",
            }),
          ]),
          {
            recorder: new DynamoDbAgentRunRecorder(documentClient, projectionTableName),
            clock,
            idGenerator,
            promptVersion: "decision-simulator/v1",
            monotonicMilliseconds: () => performance.now(),
          },
        );
  return {
    handle: createApiHandler({
      application,
      rateLimiter: new FixedWindowRateLimiter({
        limit: Number.parseInt(process.env.RATE_LIMIT_PER_MINUTE ?? "120", 10),
      }),
      authenticator: ownerAuthenticator(ownerSubject),
      ...(simulator === undefined ? {} : { simulator }),
    }),
  };
}

function requestFromEvent(event: APIGatewayProxyEventV2): Request {
  const domainName = event.requestContext.domainName;
  const path = event.rawPath;
  const query = event.rawQueryString.length === 0 ? "" : `?${event.rawQueryString}`;
  const body =
    event.body === undefined
      ? undefined
      : event.isBase64Encoded
        ? Buffer.from(event.body, "base64")
        : event.body;
  const headers = new Headers();
  Object.entries(event.headers).forEach(([name, value]) => {
    if (value !== undefined) {
      headers.set(name, value);
    }
  });
  const subject = authenticatedSubject(event);
  if (subject !== null && subject.length > 0) {
    headers.set(AUTHENTICATED_SUBJECT_HEADER, subject);
  } else {
    headers.delete(AUTHENTICATED_SUBJECT_HEADER);
  }
  return new Request(`https://${domainName}${path}${query}`, {
    method: event.requestContext.http.method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

async function resultFromResponse(response: Response): Promise<APIGatewayProxyResultV2> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return {
    statusCode: response.status,
    headers,
    body: await response.text(),
    isBase64Encoded: false,
  };
}

export async function handler(
  event: APIGatewayProxyEventV2,
  _context: Context,
): Promise<APIGatewayProxyResultV2> {
  runtimePromise ??= createRuntime();
  try {
    return await resultFromResponse(await (await runtimePromise).handle(requestFromEvent(event)));
  } catch (error: unknown) {
    runtimePromise = undefined;
    const detail = error instanceof Error ? error.message : "Unknown Lambda error.";
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "lambda_initialization_failed", detail }),
      isBase64Encoded: false,
    };
  }
}
