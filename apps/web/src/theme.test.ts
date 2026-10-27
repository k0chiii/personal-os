import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");

describe("theme tokens", () => {
  it("uses the shadcn neutral palette", () => {
    expect(css).toContain("--background: oklch(1 0 0)");
    expect(css).toContain("--foreground: oklch(0.145 0 0)");
    expect(css).toContain("--primary: oklch(0.205 0 0)");
    expect(css).toContain("--primary-foreground: oklch(0.985 0 0)");
    expect(css).toContain("--sidebar: oklch(0.985 0 0)");
    expect(css).toContain("--color-primary: var(--primary)");
    expect(css).toContain("--color-foreground: var(--foreground)");
    expect(css).toContain("--connected: oklch(0.894 0.18 128.139)");
    expect(css.match(/var\(--connected\)/gu)).toHaveLength(2);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}/u);
    expect(css.toLowerCase()).not.toContain("violet");
    expect(css.toLowerCase()).not.toContain("purple");
  });
});
