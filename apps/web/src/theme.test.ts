import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");

describe("theme tokens", () => {
  it("maps sidebar, accent, and ink onto the shadcn theme without violet", () => {
    expect(css).toContain("--sidebar: #11130f");
    expect(css).toContain("--accent: #b9f265");
    expect(css).toContain("--ink: #1c211d");
    expect(css).toContain("--color-sidebar: var(--sidebar)");
    expect(css).toContain("--color-primary: var(--accent)");
    expect(css).toContain("--color-accent: var(--accent)");
    expect(css).toContain("--color-foreground: var(--ink)");
    expect(css.match(/#11130f/g)).toEqual(["#11130f"]);
    expect(css.match(/#b9f265/g)).toEqual(["#b9f265"]);
    expect(css.match(/#1c211d/g)).toEqual(["#1c211d"]);
    expect(css.toLowerCase()).not.toContain("violet");
    expect(css.toLowerCase()).not.toContain("purple");
    expect(css).not.toContain("#71717a");
  });
});
