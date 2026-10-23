import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Temporal } from "temporal-polyfill";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";

import {
  FileRawEvidenceStore,
  NodeContentHasher,
  SqliteEventStore,
  SqliteProjection,
  SystemClock,
  UuidV7Generator,
} from "../../packages/adapters-local/src/index.ts";
import { PersonalOsApplication } from "../../packages/application/src/index.ts";

interface McpResponse {
  readonly id: number;
  readonly result?: {
    readonly structuredContent?: unknown;
    readonly tools?: readonly ListedTool[];
  };
  readonly error?: { readonly message: string };
}

interface ListedTool {
  readonly name: string;
  readonly inputSchema: { readonly required?: readonly string[] };
}

let stateRoot = "";

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), "personal-os-mcp-test-"));
});

afterEach(async () => {
  await rm(stateRoot, { recursive: true, force: true });
});

function openApplication(): PersonalOsApplication {
  const databasePath = join(stateRoot, "personal-os.sqlite");
  return new PersonalOsApplication({
    clock: new SystemClock(),
    idGenerator: new UuidV7Generator(),
    contentHasher: new NodeContentHasher(),
    rawEvidenceStore: new FileRawEvidenceStore(join(stateRoot, "objects")),
    eventStore: new SqliteEventStore(databasePath),
    projection: new SqliteProjection(databasePath),
  });
}

async function seedEvidence(privacy: "P1" | "P3" = "P1"): Promise<string> {
  const { evidence } = await openApplication().importEvidence({
    content: new TextEncoder().encode("紅茶が好き"),
    sourceType: "markdown",
    sourceUri: null,
    occurredAt: null,
    author: null,
    privacy,
    mediaType: "text/markdown",
    actor: "test",
    reason: "Seed Evidence",
  });
  return evidence.id;
}

async function session(
  calls: readonly { readonly method: string; readonly params?: unknown }[],
): Promise<readonly McpResponse[]> {
  const child = spawn(process.execPath, ["apps/mcp-server/src/main.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PERSONAL_OS_HOME: stateRoot },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end(
    calls
      .map((call, index) => JSON.stringify({ jsonrpc: "2.0", id: index + 1, ...call }))
      .join("\n") + "\n",
  );
  // "close" fires after stdout and stderr have drained; "exit" can precede the final chunks.
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  const responses = stdout
    .trim()
    .split("\n")
    .map((line) => {
      const response: McpResponse = JSON.parse(line);
      return response;
    });
  expect(responses).toHaveLength(calls.length);
  return responses;
}

function callTool(name: string, args: Record<string, unknown>) {
  return { method: "tools/call", params: { name, arguments: args } };
}

function preferenceArgs(evidenceId: string, privacy: string | undefined) {
  return {
    subjectId: "01a16770-0000-7000-8000-000000000001",
    object: "紅茶",
    evidenceIds: [evidenceId],
    actor: "mcp-test",
    reason: "User said so in chat",
    ...(privacy === undefined ? {} : { privacy }),
  };
}

it("serves MCP initialize, tool discovery, and read calls over stdio", async () => {
  const responses = await session([
    { method: "initialize", params: {} },
    { method: "tools/list", params: {} },
    callTool("personal_os_current", { privacy: ["P0", "P1", "P2", "P3"] }),
  ]);
  expect(responses[0]).toMatchObject({
    result: { protocolVersion: "2025-06-18", serverInfo: { name: "personal-os" } },
  });
  expect(responses[1]).toMatchObject({
    result: {
      tools: expect.arrayContaining([expect.objectContaining({ name: "personal_os_search" })]),
    },
  });
  expect(responses[2]).toMatchObject({
    result: { structuredContent: { preferences: [], recentDecisions: [] } },
  });
});

it("lists propose tools, no review tools, and requires privacy on every tool", async () => {
  const [list] = await session([{ method: "tools/list", params: {} }]);
  const tools = list!.result!.tools!;
  const names = tools.map((tool) => tool.name);
  expect(names).toEqual(
    expect.arrayContaining(["personal_os_propose_preference", "personal_os_propose_assertion"]),
  );
  expect(names.filter((name) => /approve|reject|review|supersede|retract/.test(name))).toEqual([]);
  expect(
    tools.filter((tool) => !tool.inputSchema.required?.includes("privacy")).map((t) => t.name),
  ).toEqual([]);
});

it("creates a pending Proposal and never an Assertion when proposing with privacy", async () => {
  const evidenceId = await seedEvidence("P3");
  const responses = await session([
    callTool("personal_os_propose_preference", preferenceArgs(evidenceId, "P3")),
    callTool("personal_os_propose_assertion", {
      ...preferenceArgs(evidenceId, "P1"),
      kind: "goal",
      object: "毎朝走る",
      validFrom: "2026-10-01T00:00:00Z",
    }),
    callTool("personal_os_current", { privacy: ["P0", "P1", "P2", "P3"] }),
  ]);
  expect(responses[0]).toMatchObject({
    result: {
      structuredContent: {
        status: "pending",
        assertion: { kind: "preference", object: "紅茶", privacy: "P3" },
        createdBy: "agent",
      },
    },
  });
  expect(responses[1]).toMatchObject({
    result: {
      structuredContent: {
        status: "pending",
        assertion: { kind: "goal", privacy: "P1", validFrom: "2026-10-01T00:00:00Z" },
      },
    },
  });
  expect(responses[2]).toMatchObject({
    result: { structuredContent: { preferences: [], intents: { goal: [] } } },
  });
  const pending = await openApplication().listProposals("pending");
  expect(pending.map((proposal) => proposal.assertion.object).sort()).toEqual(["毎朝走る", "紅茶"]);
});

it("fails closed when any tool omits privacy", async () => {
  const evidenceId = await seedEvidence();
  const responses = await session([
    callTool("personal_os_propose_preference", preferenceArgs(evidenceId, undefined)),
    callTool("personal_os_propose_assertion", {
      ...preferenceArgs(evidenceId, undefined),
      kind: "goal",
    }),
    callTool("personal_os_propose_preference", preferenceArgs(evidenceId, "secret")),
    callTool("personal_os_current", {}),
    callTool("personal_os_search", { query: "紅茶" }),
    callTool("personal_os_explain", { assertionId: "01a16770-0000-7000-8000-000000000002" }),
    callTool("personal_os_context", { task: "t", query: "q", tokenBudget: 100 }),
    callTool("personal_os_simulate", { task: "t", query: "q", tokenBudget: 100 }),
  ]);
  for (const response of responses) {
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toMatch(/privacy/);
  }
  expect(await openApplication().listProposals()).toEqual([]);
});

it("hides an Assertion from explain outside the allowed privacy", async () => {
  const evidenceId = await seedEvidence("P3");
  const application = openApplication();
  const proposal = await application.proposePreference({
    ...preferenceArgs(evidenceId, undefined),
    epistemicOrigin: "self_stated",
    validFrom: Temporal.Instant.from("2026-10-01T00:00:00Z"),
    privacy: "P3",
    createdBy: "user",
  });
  const assertion = await application.approveProposal({
    proposalId: proposal.id,
    actor: "owner",
    reason: "Confirmed",
  });
  const responses = await session([
    callTool("personal_os_explain", { assertionId: assertion.id, privacy: ["P0", "P1"] }),
    callTool("personal_os_explain", { assertionId: assertion.id, privacy: ["P3"] }),
  ]);
  expect(responses[0]!.error?.message).toBe(`Assertion not found: ${assertion.id}.`);
  expect(responses[1]).toMatchObject({
    result: {
      structuredContent: { assertion: { id: assertion.id }, evidence: [{ id: evidenceId }] },
    },
  });
});
