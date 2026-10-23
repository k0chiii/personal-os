import { createInterface } from "node:readline";
import { join, resolve } from "node:path";

import {
  FileRawEvidenceStore,
  NodeContentHasher,
  SqliteEventStore,
  SqliteProjection,
  SystemClock,
  UuidV7Generator,
  ensureParentDirectory,
} from "@personal-os/adapters-local";
import { OllamaAdapter } from "@personal-os/adapters-ollama";
import {
  DecisionSimulator,
  PersonalOsApplication,
  ProviderRouter,
  type AssertionExplanation,
  type ProposePreferenceInput,
} from "@personal-os/application";
import {
  ASSERTION_KINDS,
  EPISTEMIC_ORIGINS,
  PRIVACY_CLASSES,
  type PrivacyClass,
} from "@personal-os/domain";
import { Temporal } from "temporal-polyfill";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

const allowedPrivacySchema = { type: "array", items: { enum: PRIVACY_CLASSES } } as const;

const proposalProperties = {
  subjectId: { type: "string" },
  object: { type: "string" },
  evidenceIds: { type: "array", items: { type: "string" }, minItems: 1 },
  epistemicOrigin: { enum: EPISTEMIC_ORIGINS, default: "agent_inference" },
  validFrom: { type: "string", description: "ISO instant. Defaults to now." },
  validUntil: { type: "string" },
  privacy: { enum: PRIVACY_CLASSES },
  actor: { type: "string" },
  reason: { type: "string" },
} as const;

const proposalRequired = ["subjectId", "object", "evidenceIds", "privacy", "actor", "reason"];

const tools = [
  {
    name: "personal_os_current",
    description: "Read the current Personal OS state.",
    inputSchema: {
      type: "object",
      properties: { privacy: allowedPrivacySchema },
      required: ["privacy"],
      additionalProperties: false,
    },
  },
  {
    name: "personal_os_search",
    description: "Search Assertions and Decisions with temporal and privacy filters.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        privacy: allowedPrivacySchema,
        at: { type: "string" },
      },
      required: ["query", "privacy"],
      additionalProperties: false,
    },
  },
  {
    name: "personal_os_explain",
    description: "Explain an Assertion using its canonical Evidence provenance.",
    inputSchema: {
      type: "object",
      properties: { assertionId: { type: "string" }, privacy: allowedPrivacySchema },
      required: ["assertionId", "privacy"],
      additionalProperties: false,
    },
  },
  {
    name: "personal_os_context",
    description: "Build a bounded Context Pack with counter-evidence and uncertainty.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string" },
        query: { type: "string" },
        privacy: allowedPrivacySchema,
        tokenBudget: { type: "integer", minimum: 1 },
        at: { type: "string" },
      },
      required: ["task", "query", "privacy", "tokenBudget"],
      additionalProperties: false,
    },
  },
  {
    name: "personal_os_simulate",
    description: "Simulate a Decision with a local Ollama provider and grounded Context Pack.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string" },
        query: { type: "string" },
        privacy: allowedPrivacySchema,
        tokenBudget: { type: "integer", minimum: 1 },
      },
      required: ["task", "query", "privacy", "tokenBudget"],
      additionalProperties: false,
    },
  },
  {
    name: "personal_os_propose_preference",
    description:
      "Propose a Preference for human review. Creates a pending Proposal, never an Assertion.",
    inputSchema: {
      type: "object",
      properties: proposalProperties,
      required: proposalRequired,
      additionalProperties: false,
    },
  },
  {
    name: "personal_os_propose_assertion",
    description:
      "Propose an Assertion of any kind for human review. Creates a pending Proposal, never an Assertion.",
    inputSchema: {
      type: "object",
      properties: {
        ...proposalProperties,
        kind: { enum: ASSERTION_KINDS },
        predicate: { type: "string" },
      },
      required: [...proposalRequired, "kind"],
      additionalProperties: false,
    },
  },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestValue(value: unknown): JsonRpcRequest {
  if (
    !isRecord(value) ||
    value.jsonrpc !== "2.0" ||
    typeof value.method !== "string" ||
    (value.id !== undefined &&
      value.id !== null &&
      typeof value.id !== "string" &&
      typeof value.id !== "number")
  ) {
    throw new Error("Invalid JSON-RPC request.");
  }
  return {
    jsonrpc: "2.0",
    method: value.method,
    ...(value.id === undefined ? {} : { id: value.id }),
    ...(value.params === undefined ? {} : { params: value.params }),
  };
}

function argumentsValue(params: unknown): Record<string, unknown> {
  if (!isRecord(params) || !isRecord(params.arguments)) {
    throw new Error("tools/call params.arguments must be an object.");
  }
  return params.arguments;
}

function stringValue(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value;
}

function optionalStringValue(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string.`);
  }
  return value;
}

function numberValue(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    throw new Error(`${key} must be a positive integer.`);
  }
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], key: string): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new Error(`${key} must be one of ${allowed.join(", ")}.`);
  }
  return match;
}

function privacyValue(input: Record<string, unknown>): readonly PrivacyClass[] {
  const value = input.privacy;
  if (value === undefined) {
    throw new Error("privacy is required.");
  }
  if (!Array.isArray(value)) {
    throw new Error("privacy must be an array.");
  }
  return value.map((item) => enumValue(item, PRIVACY_CLASSES, "privacy"));
}

function evidenceIdsValue(input: Record<string, unknown>): readonly string[] {
  const value = input.evidenceIds;
  if (!Array.isArray(value) || value.length === 0 || !value.every((id) => typeof id === "string")) {
    throw new Error("evidenceIds must be a non-empty array of strings.");
  }
  return value;
}

function proposalInput(input: Record<string, unknown>): ProposePreferenceInput {
  const origin = input.epistemicOrigin ?? "agent_inference";
  const validFrom = optionalStringValue(input, "validFrom");
  const validUntil = optionalStringValue(input, "validUntil");
  return {
    subjectId: stringValue(input, "subjectId"),
    object: stringValue(input, "object"),
    evidenceIds: evidenceIdsValue(input),
    epistemicOrigin: enumValue(origin, EPISTEMIC_ORIGINS, "epistemicOrigin"),
    validFrom: validFrom === null ? Temporal.Now.instant() : Temporal.Instant.from(validFrom),
    validUntil: validUntil === null ? null : Temporal.Instant.from(validUntil),
    privacy: enumValue(input.privacy, PRIVACY_CLASSES, "privacy"),
    createdBy: "agent",
    actor: stringValue(input, "actor"),
    reason: stringValue(input, "reason"),
  };
}

async function explainWithinPrivacy(
  application: PersonalOsApplication,
  input: Record<string, unknown>,
): Promise<AssertionExplanation> {
  const assertionId = stringValue(input, "assertionId");
  const allowed = new Set(privacyValue(input));
  const explanation = await application.explainAssertion(assertionId);
  if (!allowed.has(explanation.assertion.privacy)) {
    throw new Error(`Assertion not found: ${assertionId}.`);
  }
  return {
    assertion: explanation.assertion,
    evidence: explanation.evidence.filter((item) => allowed.has(item.privacy)),
  };
}

async function createRuntime(): Promise<{
  readonly application: PersonalOsApplication;
  readonly simulator: DecisionSimulator;
}> {
  const stateRoot = resolve(process.env.PERSONAL_OS_HOME ?? ".personal-os");
  const databasePath = join(stateRoot, "personal-os.sqlite");
  await ensureParentDirectory(databasePath);
  const clock = new SystemClock();
  const idGenerator = new UuidV7Generator();
  const application = new PersonalOsApplication({
    clock,
    idGenerator,
    contentHasher: new NodeContentHasher(),
    rawEvidenceStore: new FileRawEvidenceStore(join(stateRoot, "objects")),
    eventStore: new SqliteEventStore(databasePath),
    projection: new SqliteProjection(databasePath),
  });
  const provider = new OllamaAdapter({
    model: process.env.OLLAMA_MODEL ?? "llama3.2",
    ...(process.env.OLLAMA_ENDPOINT === undefined ? {} : { endpoint: process.env.OLLAMA_ENDPOINT }),
  });
  return {
    application,
    simulator: new DecisionSimulator(application, new ProviderRouter([provider])),
  };
}

async function callTool(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  params: unknown,
): Promise<unknown> {
  if (!isRecord(params) || typeof params.name !== "string") {
    throw new Error("tools/call params.name must be a string.");
  }
  const input = argumentsValue(params);
  const at = optionalStringValue(input, "at");
  switch (params.name) {
    case "personal_os_current":
      return runtime.application.getCurrentState({ privacy: privacyValue(input) });
    case "personal_os_search":
      return Promise.all([
        runtime.application.searchAssertions({
          query: stringValue(input, "query"),
          privacy: privacyValue(input),
          ...(at === null ? {} : { asOf: Temporal.Instant.from(at) }),
        }),
        runtime.application.searchDecisions({
          query: stringValue(input, "query"),
          privacy: privacyValue(input),
          ...(at === null ? {} : { asOf: Temporal.Instant.from(at) }),
        }),
      ]).then(([assertions, decisions]) => ({ assertions, decisions }));
    case "personal_os_explain":
      return explainWithinPrivacy(runtime.application, input);
    case "personal_os_context":
      return runtime.application.buildContext({
        task: stringValue(input, "task"),
        query: stringValue(input, "query"),
        allowedPrivacy: privacyValue(input),
        tokenBudget: numberValue(input, "tokenBudget"),
        ...(at === null ? {} : { asOf: Temporal.Instant.from(at) }),
      });
    case "personal_os_simulate":
      return runtime.simulator.simulate({
        task: stringValue(input, "task"),
        query: stringValue(input, "query"),
        allowedPrivacy: privacyValue(input),
        tokenBudget: numberValue(input, "tokenBudget"),
        preferLocal: true,
      });
    case "personal_os_propose_preference":
      return runtime.application.proposePreference(proposalInput(input));
    case "personal_os_propose_assertion": {
      const predicate = optionalStringValue(input, "predicate");
      return runtime.application.proposeAssertion({
        ...proposalInput(input),
        kind: enumValue(input.kind, ASSERTION_KINDS, "kind"),
        ...(predicate === null ? {} : { predicate }),
      });
    }
    default:
      throw new Error(`Unknown tool: ${params.name}.`);
  }
}

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
  const runtime = await createRuntime();
  const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    let request: JsonRpcRequest;
    try {
      const value: unknown = JSON.parse(line);
      request = requestValue(value);
    } catch (error: unknown) {
      write({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: error instanceof Error ? error.message : "Parse error" },
      });
      continue;
    }
    if (request.id === undefined) {
      continue;
    }
    try {
      let result: unknown;
      switch (request.method) {
        case "initialize":
          result = {
            protocolVersion: "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "personal-os", version: "0.1.0" },
          };
          break;
        case "ping":
          result = {};
          break;
        case "tools/list":
          result = { tools };
          break;
        case "tools/call": {
          const output = await callTool(runtime, request.params);
          result = {
            content: [{ type: "text", text: JSON.stringify(output) }],
            structuredContent: output,
          };
          break;
        }
        default:
          throw new Error(`Method not found: ${request.method}.`);
      }
      write({ jsonrpc: "2.0", id: request.id, result });
    } catch (error: unknown) {
      write({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Internal error",
        },
      });
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `personal-os-mcp: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
