import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, expect, it } from "vite-plus/test";

let outDir = "";

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "personal-os-web-build-"));
  await promisify(execFile)(
    join(process.cwd(), "node_modules", ".bin", "vp"),
    ["build", "--outDir", outDir, "--emptyOutDir"],
    { cwd: join(process.cwd(), "apps", "web"), env: { ...process.env, NODE_ENV: "production" } },
  );
}, 120_000);

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

interface ManifestIcon {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly purpose: string;
}

function pngSize(png: Buffer): string {
  expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
  return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
}

it("links an installable manifest with maskable 192 and 512 icons", async () => {
  const html = await readFile(join(outDir, "index.html"), "utf8");
  expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
  expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');

  const manifest: { readonly icons: readonly ManifestIcon[] } = JSON.parse(
    await readFile(join(outDir, "manifest.webmanifest"), "utf8"),
  );
  expect(manifest).toMatchObject({
    name: "Personal OS",
    start_url: "/",
    scope: "/",
    display: "standalone",
  });
  for (const size of ["192x192", "512x512"]) {
    expect(manifest.icons).toContainEqual(
      expect.objectContaining({ sizes: size, purpose: "maskable" }),
    );
  }
  for (const icon of manifest.icons) {
    expect(icon.type).toBe("image/png");
    expect(pngSize(await readFile(join(outDir, icon.src)))).toBe(icon.sizes);
  }
});

it("registers a service worker that precaches the shell and leaves the API to the network", async () => {
  const register = await readFile(join(outDir, "registerSW.js"), "utf8");
  expect(register).toContain("navigator.serviceWorker.register('/sw.js'");

  const worker = await readFile(join(outDir, "sw.js"), "utf8");
  const precached = [...worker.matchAll(/\{url:"([^"]+)",revision:/gu)].map((match) => match[1]);
  const assets = (await readdir(join(outDir, "assets"))).map((name) => `assets/${name}`);
  expect(precached).toEqual(
    expect.arrayContaining(["index.html", "manifest.webmanifest", "icon-512.png", ...assets]),
  );
  expect(precached.filter((url) => /^\/?(v1|health)/u.test(url ?? ""))).toEqual([]);
  const routes = [...worker.matchAll(/registerRoute\((new \w+\.\w+|[^,]+)/gu)];
  expect(routes.map((match) => match[1]?.replace(/^new \w+\./u, ""))).toEqual(["NavigationRoute"]);

  const denylist = /denylist:\[([^\]]*)\]/u.exec(worker)?.[1] ?? "";
  const patterns = [...denylist.matchAll(/\/(.+?)\/u/gu)].map(
    (match) => new RegExp(match[1] ?? ""),
  );
  const shellServes = (path: string): boolean => !patterns.some((pattern) => pattern.test(path));
  expect(shellServes("/")).toBe(true);
  expect(shellServes("/timeline/today")).toBe(true);
  expect(shellServes("/health")).toBe(false);
  expect(shellServes("/v1/missing")).toBe(false);
});
