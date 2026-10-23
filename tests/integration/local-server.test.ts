import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it } from "vite-plus/test";

const INDEX_HTML = "<!doctype html><title>Personal OS</title><main id=main></main>\n";

let root = "";
let child: ChildProcess | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "personal-os-local-server-test-"));
});

afterEach(async () => {
  child?.kill();
  child = undefined;
  await rm(root, { recursive: true, force: true });
});

function serve(webDist: string): ChildProcess {
  return spawn(process.execPath, ["apps/local-server/src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PERSONAL_OS_HOME: join(root, "home"),
      PERSONAL_OS_WEB_DIST: webDist,
      PERSONAL_OS_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function startServer(): Promise<string> {
  const webDist = join(root, "dist");
  await mkdir(join(webDist, "assets"), { recursive: true });
  await writeFile(join(webDist, "index.html"), INDEX_HTML);
  await writeFile(join(webDist, "assets", "app.js"), "console.log(1);\n");
  child = serve(webDist);
  const server = child;
  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    server.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      const match = /http:\/\/127\.0\.0\.1:\d+\//u.exec(stdout);
      if (match !== null) {
        resolve(match[0]);
      }
    });
    server.once("error", reject);
    server.once("exit", (code) => reject(new Error(`local server exited with ${code}`)));
  });
}

it("serves health and the web index on one loopback origin", async () => {
  const origin = await startServer();

  const health = await fetch(new URL("/health", origin));
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ status: "ok" });

  const index = await fetch(origin);
  expect(index.status).toBe(200);
  expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(await index.text()).toBe(INDEX_HTML);

  const asset = await fetch(new URL("/assets/app.js", origin));
  expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  expect(await asset.text()).toBe("console.log(1);\n");

  const deepLink = await fetch(new URL("/timeline/today", origin));
  expect(await deepLink.text()).toBe(INDEX_HTML);

  const proposals = await fetch(new URL("/v1/proposals?status=pending", origin));
  expect(proposals.status).toBe(200);
  expect(await proposals.json()).toEqual([]);

  const missing = await fetch(new URL("/v1/missing", origin));
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({
    code: "not_found",
    detail: "No route matches the request.",
  });
});

it("routes the Worker's run_worker_first patterns to the API", async () => {
  const wrangler = await readFile("apps/worker/wrangler.jsonc", "utf8");
  const patterns: unknown = JSON.parse(
    /"run_worker_first":\s*(\[[^\]]*\])/u.exec(wrangler)?.[1] ?? "null",
  );
  expect(patterns).toEqual(["/health", "/v1/*"]);
  const origin = await startServer();
  for (const path of ["/health", "/v1/worker-first-probe"]) {
    const response = await fetch(new URL(path, origin));
    expect(response.headers.get("content-type")).toBe("application/json");
  }
  const page = await fetch(new URL("/v1", origin));
  expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
});

it("refuses to start without a web build", async () => {
  const webDist = join(root, "no-dist");
  child = serve(webDist);
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const server = child;
  const exitCode = await new Promise<number | null>((resolve) => server.once("close", resolve));
  expect(exitCode).toBe(1);
  expect(stderr).toContain(`No web build at ${webDist}. Run "pnpm build" first`);
});
