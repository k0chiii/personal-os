import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vite-plus/test";

it("serves MCP initialize, tool discovery, and read calls over stdio", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "personal-os-mcp-test-"));
  try {
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
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "personal_os_current", arguments: {} },
        },
      ]
        .map((request) => JSON.stringify(request))
        .join("\n") + "\n",
    );
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const responses: unknown[] = stdout
      .trim()
      .split("\n")
      .map((line) => {
        const value: unknown = JSON.parse(line);
        return value;
      });
    expect(responses).toHaveLength(3);
    expect(responses[0]).toMatchObject({
      id: 1,
      result: { protocolVersion: "2025-06-18", serverInfo: { name: "personal-os" } },
    });
    expect(responses[1]).toMatchObject({
      id: 2,
      result: {
        tools: expect.arrayContaining([expect.objectContaining({ name: "personal_os_search" })]),
      },
    });
    expect(responses[2]).toMatchObject({
      id: 3,
      result: { structuredContent: { preferences: [], recentDecisions: [] } },
    });
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
