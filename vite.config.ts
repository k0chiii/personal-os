import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    ignorePatterns: ["dist/**", "coverage/**"],
    plugins: ["typescript"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    categories: {
      correctness: "error",
      suspicious: "warn",
    },
    rules: {
      eqeqeq: "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
      "typescript/no-explicit-any": "error",
    },
    overrides: [
      {
        files: ["apps/web/**"],
        env: {
          browser: true,
        },
      },
      {
        files: ["apps/api/**", "apps/mcp-server/**"],
        env: {
          node: true,
        },
      },
      {
        files: ["packages/**"],
        rules: {
          "no-console": "error",
        },
      },
      {
        files: ["**/*.test.ts", "**/*.spec.ts"],
        plugins: ["vitest"],
        rules: {
          "typescript/no-explicit-any": "off",
          "vitest/no-disabled-tests": "error",
        },
      },
    ],
  },
  fmt: {
    ignorePatterns: ["dist/**", "coverage/**"],
  },
  test: {
    include: ["**/*.test.ts", "**/*.spec.ts", "tests/unit/**/*.ts", "tests/integration/**/*.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**"],
  },
});
