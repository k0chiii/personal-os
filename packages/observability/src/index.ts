import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { AgentRunRecord, AgentRunRecorderPort } from "../../ports/src/index.ts";

export class InMemoryAgentRunRecorder implements AgentRunRecorderPort {
  readonly runs: AgentRunRecord[] = [];

  async record(run: AgentRunRecord): Promise<void> {
    this.runs.push(structuredClone(run));
  }
}

export class JsonlAgentRunRecorder implements AgentRunRecorderPort {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  async record(run: AgentRunRecord): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });
    await appendFile(this.#filePath, `${JSON.stringify(run)}\n`, { encoding: "utf8" });
  }
}
