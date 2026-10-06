import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    ignorePatterns: ["dist/**", "coverage/**"],
    plugins: ["typescript", "import"],
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
      "import/no-cycle": [
        "error",
        {
          ignoreTypes: false,
        },
      ],
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
      {
        files: ["packages/domain/**/*.ts"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: ["@personal-os/adapters-*"],
                  message: "Domain must not depend on infrastructure adapters.",
                },
                {
                  regex: "^(\\.\\./)+(packages/)?adapters-[^/]+(/|$)",
                  message: "Domain must not bypass package boundaries with relative imports.",
                },
              ],
            },
          ],
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
