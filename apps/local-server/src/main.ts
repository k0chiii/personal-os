import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { buffer } from "node:stream/consumers";
import { fileURLToPath } from "node:url";

import {
  FileRawEvidenceStore,
  NodeContentHasher,
  SqliteEventStore,
  SqliteProjection,
  SystemClock,
  UuidV7Generator,
  ensureParentDirectory,
} from "@personal-os/adapters-local";
import { createApiHandler } from "@personal-os/api";
import { PersonalOsApplication } from "@personal-os/application";

const HOST = "127.0.0.1";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

interface Config {
  readonly stateRoot: string;
  readonly webDist: string;
  readonly port: number;
}

function config(): Config {
  const port = Number(process.env.PERSONAL_OS_PORT ?? "8787");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PERSONAL_OS_PORT must be an integer from 0 to 65535.");
  }
  return {
    stateRoot: resolve(process.env.PERSONAL_OS_HOME ?? ".personal-os"),
    webDist: resolve(
      process.env.PERSONAL_OS_WEB_DIST ?? fileURLToPath(new URL("../../web/dist", import.meta.url)),
    ),
    port,
  };
}

async function createApplication(stateRoot: string): Promise<PersonalOsApplication> {
  const databasePath = join(stateRoot, "personal-os.sqlite");
  await ensureParentDirectory(databasePath);
  return new PersonalOsApplication({
    clock: new SystemClock(),
    idGenerator: new UuidV7Generator(),
    contentHasher: new NodeContentHasher(),
    rawEvidenceStore: new FileRawEvidenceStore(join(stateRoot, "objects")),
    eventStore: new SqliteEventStore(databasePath),
    projection: new SqliteProjection(databasePath),
  });
}

// Mirrors run_worker_first in apps/worker/wrangler.jsonc.
function isApiPath(pathname: string): boolean {
  return pathname === "/health" || pathname.startsWith("/v1/");
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function staticFile(webDist: string, pathname: string): Promise<string> {
  const candidate = resolve(webDist, `.${pathname}`);
  if (candidate.startsWith(webDist + sep) && (await isFile(candidate))) {
    return candidate;
  }
  return join(webDist, "index.html");
}

async function toRequest(incoming: IncomingMessage, url: URL): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) {
        headers.append(name, item);
      }
    }
  }
  const method = incoming.method ?? "GET";
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }
  return new Request(url, { method, headers, body: await buffer(incoming) });
}

async function writeResponse(outgoing: ServerResponse, response: Response): Promise<void> {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

async function main(): Promise<void> {
  const { stateRoot, webDist, port } = config();
  if (!(await isFile(join(webDist, "index.html")))) {
    throw new Error(
      `No web build at ${webDist}. Run "pnpm build" first, then rerun "pnpm personal:serve".`,
    );
  }
  const handle = createApiHandler({ application: await createApplication(stateRoot) });
  const server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? "/", `http://${HOST}`);
    const respond = async (): Promise<void> => {
      if (isApiPath(url.pathname)) {
        await writeResponse(outgoing, await handle(await toRequest(incoming, url)));
        return;
      }
      if (incoming.method !== "GET" && incoming.method !== "HEAD") {
        outgoing.writeHead(405, { allow: "GET, HEAD" }).end();
        return;
      }
      const file = await staticFile(webDist, url.pathname);
      const body = await readFile(file);
      outgoing.writeHead(200, {
        "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
        "content-length": body.byteLength,
      });
      outgoing.end(incoming.method === "HEAD" ? undefined : body);
    };
    respond().catch((error: unknown) => {
      process.stderr.write(
        `personal-os-serve: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      if (!outgoing.headersSent) {
        outgoing.writeHead(500);
      }
      outgoing.end();
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, HOST, resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Local server did not bind a TCP port.");
  }
  process.stdout.write(`Personal OS console: http://${HOST}:${address.port}/\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `personal-os-serve: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
