import { describe, expect, it } from "vite-plus/test";

import { LlamaCppAdapter } from "../../packages/adapters-llama-cpp/src/index.ts";
import { MockLlm } from "../../packages/adapters-local/src/index.ts";
import { OllamaAdapter } from "../../packages/adapters-ollama/src/index.ts";
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

  it.each([
    [
      "Ollama",
      (endpoint: string, fetch: typeof globalThis.fetch) =>
        new OllamaAdapter({ model: "m", endpoint, fetch }),
    ],
    [
      "llama.cpp",
      (endpoint: string, fetch: typeof globalThis.fetch) =>
        new LlamaCppAdapter({ model: "m", endpoint, fetch }),
    ],
  ] as const)(
    "treats an externally hosted %s endpoint as remote for P3 routing",
    async (_name, createAdapter) => {
      let requests = 0;
      const fetch: typeof globalThis.fetch = async () => {
        requests += 1;
        return Response.json({});
      };
      for (const endpoint of [
        "https://llm.example.com/v1/chat/completions",
        "http://127.0.0.1.attacker.example:11434/completion",
        "http://192.168.1.20:11434/completion",
      ]) {
        const external = createAdapter(endpoint, fetch);
        expect(external.remote).toBe(true);
        expect(external.capabilities.local).toBe(false);
        await expect(
          new ProviderRouter([external]).generate({ prompt: "restricted", privacy: ["P3"] }),
        ).rejects.toBeInstanceOf(PrivacyViolation);
      }
      expect(requests).toBe(0);

      for (const endpoint of [
        "http://localhost:11434/x",
        "http://127.0.0.1:8080/x",
        "http://[::1]:8080/x",
      ]) {
        const loopback = createAdapter(endpoint, fetch);
        expect(loopback.remote).toBe(false);
        expect(loopback.capabilities.local).toBe(true);
      }
    },
  );

  it("falls back after a retryable provider failure", async () => {
    const remote = new RemoteStub(true);
    const local = new MockLlm(() => "fallback response");
    const router = new ProviderRouter([remote, local]);

    const result = await router.generate({ prompt: "public", privacy: ["P0"] });

    expect(result.text).toBe("fallback response");
    expect(remote.calls).toBe(1);
  });
});
