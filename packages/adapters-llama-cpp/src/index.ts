import {
  LlmRateLimited,
  LlmUnavailable,
  StructuredOutputInvalid,
  type GenerateRequest,
  type GenerateResult,
  type LlmPort,
  type StructuredRequest,
} from "../../ports/src/index.ts";

export interface LlamaCppAdapterOptions {
  readonly model: string;
  readonly endpoint?: string;
  readonly fetch?: typeof fetch;
}

export class LlamaCppAdapter implements LlmPort {
  readonly providerId = "llama.cpp";
  readonly model: string;
  readonly remote = false;
  readonly capabilities = {
    structuredOutput: true,
    toolCalling: false,
    streaming: false,
    vision: false,
    embeddings: false,
    local: true,
  } as const;
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;

  constructor(options: LlamaCppAdapterOptions) {
    this.model = options.model;
    this.#endpoint = options.endpoint ?? "http://127.0.0.1:8080/completion";
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: [request.system, request.prompt]
            .filter((item) => item !== undefined)
            .join("\n\n"),
          stream: false,
          n_predict: request.maxOutputTokens,
          temperature: 0,
        }),
      });
    } catch (error: unknown) {
      throw new LlmUnavailable(this.providerId, error instanceof Error ? error.message : undefined);
    }
    if (response.status === 429) {
      throw new LlmRateLimited(this.providerId);
    }
    if (!response.ok) {
      throw new LlmUnavailable(this.providerId, `HTTP ${response.status}`);
    }
    return parseResponse(await response.json(), this.model);
  }

  async structured<T>(request: StructuredRequest<T>): Promise<T> {
    const result = await this.generate(request);
    try {
      const value: unknown = JSON.parse(result.text);
      return request.parse(value);
    } catch (error: unknown) {
      if (error instanceof StructuredOutputInvalid) {
        throw error;
      }
      throw new StructuredOutputInvalid(this.providerId);
    }
  }
}

function parseResponse(value: unknown, model: string): GenerateResult {
  if (!isRecord(value) || typeof value.content !== "string") {
    throw new StructuredOutputInvalid("llama.cpp");
  }
  return {
    text: value.content,
    provider: "llama.cpp",
    model,
    inputTokens: finiteNumber(value.tokens_evaluated),
    cachedInputTokens: null,
    outputTokens: finiteNumber(value.tokens_predicted),
    estimatedUsd: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
