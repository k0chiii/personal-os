import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { JsonlAgentRunRecorder } from "../../packages/observability/src/index.ts";
import type { AgentRunRecord } from "../../packages/ports/src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Agent Run observability", () => {
  it("appends complete run metadata as JSON Lines", async () => {
    const directory = await mkdtemp(join(tmpdir(), "personal-os-runs-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "audit", "agent-runs.jsonl");
    const recorder = new JsonlAgentRunRecorder(filePath);
    const run: AgentRunRecord = {
      runId: "run-1",
      timestamp: "2026-09-04T00:00:00Z",
      status: "succeeded",
      provider: "openai",
      model: "example-model",
      promptVersion: "decision-simulator/v1",
      contextIds: ["assertion-1"],
      toolCalls: [],
      latencyMs: 25,
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 10,
      estimatedUsd: 0.001,
      output: "prediction",
      evalResult: "pass",
      error: null,
    };

    await recorder.record(run);
    await recorder.record({ ...run, runId: "run-2" });

    const lines = (await readFile(filePath, "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([run, { ...run, runId: "run-2" }]);
  });
});
