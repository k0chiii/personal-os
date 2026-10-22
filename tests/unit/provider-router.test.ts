import { describe, expect, it } from "vite-plus/test";

import { MockLlm } from "../../packages/adapters-local/src/index.ts";
import { ProviderRouter } from "../../packages/application/src/index.ts";
import {
  LlmUnavailable,
  PrivacyViolation,
  type GenerateRequest,
  type GenerateResult,
  type LlmPort,
  type StructuredRequest,
} from "../../packages/ports/src/index.ts";

class RemoteStub implements LlmPort {
  readonly providerId = "remote-stub";
  readonly model = "remote-test";
  readonly remote = true;
  readonly capabilities = {
    structuredOutput: false,
    toolCalling: false,
    streaming: false,
    vision: false,
    embeddings: false,
    local: false,
  } as const;
  calls = 0;
  readonly #fail: boolean;

  constructor(fail = false) {
    this.#fail = fail;
  }

  async generate(_request: GenerateRequest): Promise<GenerateResult> {
    this.calls += 1;
    if (this.#fail) {
      throw new LlmUnavailable(this.providerId);
    }
    return {
      text: "remote response",
      provider: this.providerId,
      model: this.model,
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      estimatedUsd: null,
    };
  }

  async structured<T>(_request: StructuredRequest<T>): Promise<T> {
    throw new Error("Not implemented for this test.");
  }
}

describe("ProviderRouter", () => {
  it("never sends P3 data to a remote-only provider", async () => {
    const remote = new RemoteStub();
    const router = new ProviderRouter([remote]);

    await expect(router.generate({ prompt: "restricted", privacy: ["P3"] })).rejects.toBeInstanceOf(
      PrivacyViolation,
    );
    expect(remote.calls).toBe(0);
  });

  it("uses a local provider for P3 even when a remote provider is listed first", async () => {
    const remote = new RemoteStub();
    const local = new MockLlm(() => "local response");
    const router = new ProviderRouter([remote, local]);

    const result = await router.generate({ prompt: "restricted", privacy: ["P3"] });

    expect(result.provider).toBe("mock");
    expect(remote.calls).toBe(0);
  });

  it("falls back after a retryable provider failure", async () => {
    const remote = new RemoteStub(true);
    const local = new MockLlm(() => "fallback response");
    const router = new ProviderRouter([remote, local]);

    const result = await router.generate({ prompt: "public", privacy: ["P0"] });

    expect(result.text).toBe("fallback response");
    expect(remote.calls).toBe(1);
  });
});
