import { describe, expect, it } from "vite-plus/test";

import { FixedWindowRateLimiter } from "../../apps/api/src/handler.ts";
import { CloudflareNativeRateLimiter } from "../../apps/worker/src/index.ts";
import { DecisionCritic, type ContextPack } from "../../packages/application/src/index.ts";

function emptyContext(contradictions: readonly string[] = []): ContextPack {
  return {
    task: "evaluate a choice",
    temporalScope: "2026-10-20T00:00:00Z",
    currentState: {
      preferences: [],
      intents: {
        goal: [],
        project: [],
        artifact: [],
        research_topic: [],
        value: [],
        belief: [],
        constraint: [],
      },
    },
    relevantAssertions: [],
    relevantDecisions: [],
    rawEvidence: [],
    counterEvidence: [],
    contradictions,
    uncertainties: [],
    privacyPolicy: ["P0"],
    tokenBudget: 1_000,
    estimatedTokens: 0,
  };
}

describe("v1 operational services", () => {
  it("enforces a fixed request limit and resets at the next window", () => {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter({
      limit: 2,
      windowMilliseconds: 10_000,
      now: () => now,
    });

    expect(limiter.check("owner").allowed).toBe(true);
    expect(limiter.check("owner").allowed).toBe(true);
    expect(limiter.check("owner")).toEqual({ allowed: false, retryAfterSeconds: 10 });
    now = 11_000;
    expect(limiter.check("owner").allowed).toBe(true);
  });

  it("delegates Cloudflare rate limiting to the platform binding", async () => {
    const keys: string[] = [];
    const limiter = new CloudflareNativeRateLimiter({
      async limit(input) {
        keys.push(input.key);
        return { success: keys.length === 1 };
      },
    });

    await expect(limiter.check("owner")).resolves.toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
    await expect(limiter.check("owner")).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
    expect(keys).toEqual(["owner", "owner"]);
  });

  it("makes the Critic abstain when the retrieved context is contradictory", () => {
    const report = new DecisionCritic().review({
      context: emptyContext(["Two active Assertions disagree."]),
      prediction: null,
    });

    expect(report.recommendation).toBe("abstain");
    expect(report.issues).toEqual([
      {
        code: "conflicting_assertions",
        severity: "error",
        detail: "Two active Assertions disagree.",
        contextIds: [],
      },
    ]);
  });
});
