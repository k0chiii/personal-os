import {
  LlmRateLimited,
  LlmUnavailable,
  StructuredOutputInvalid,
  isLoopbackEndpoint,
  type GenerateRequest,
  type GenerateResult,
  type LlmCapabilities,
  type LlmPort,
  type StructuredRequest,
} from "@personal-os/ports";

export interface OllamaAdapterOptions {
  readonly model: string;
  readonly endpoint?: string;
  readonly fetch?: typeof fetch;
}

export class OllamaAdapter implements LlmPort {
  readonly providerId = "ollama";
  readonly model: string;
  readonly remote: boolean;
  readonly capabilities: LlmCapabilities;
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;

  constructor(options: OllamaAdapterOptions) {
    this.model = options.model;
    this.#endpoint = options.endpoint ?? "http://127.0.0.1:11434/v1/chat/completions";
    this.#fetch = options.fetch ?? globalThis.fetch;
    const local = isLoopbackEndpoint(this.#endpoint);
    this.remote = !local;
    this.capabilities = {
      structuredOutput: true,
      toolCalling: false,
      streaming: false,
      vision: false,
      embeddings: false,
      local,
    };
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          messages: [
            ...(request.system === undefined ? [] : [{ role: "system", content: request.system }]),
            { role: "user", content: request.prompt },
          ],
          max_tokens: request.maxOutputTokens,
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
    return parseOllamaResponse(await response.json(), this.model);
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

function parseOllamaResponse(value: unknown, model: string): GenerateResult {
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    throw new StructuredOutputInvalid("ollama");
  }
  const first = value.choices[0];
  if (!isRecord(first) || !isRecord(first.message) || typeof first.message.content !== "string") {
    throw new StructuredOutputInvalid("ollama");
  }
  const usage = isRecord(value.usage) ? value.usage : {};
  return {
    text: first.message.content,
    provider: "ollama",
    model,
    inputTokens: nullableNumber(usage.prompt_tokens),
    cachedInputTokens: null,
    outputTokens: nullableNumber(usage.completion_tokens),
    estimatedUsd: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
