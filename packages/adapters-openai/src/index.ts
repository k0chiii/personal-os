import {
  LlmRateLimited,
  LlmUnavailable,
  StructuredOutputInvalid,
  type GenerateRequest,
  type GenerateResult,
  type LlmPort,
  type StructuredRequest,
} from "@personal-os/ports";

export interface OpenAiAdapterOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly endpoint?: string;
  readonly fetch?: typeof fetch;
}

export class OpenAiAdapter implements LlmPort {
  readonly providerId = "openai";
  readonly model: string;
  readonly remote = true;
  readonly capabilities = {
    structuredOutput: true,
    toolCalling: true,
    streaming: true,
    vision: true,
    embeddings: false,
    local: false,
  } as const;
  readonly #apiKey: string;
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;

  constructor(options: OpenAiAdapterOptions) {
    this.#apiKey = options.apiKey;
    this.model = options.model;
    this.#endpoint = options.endpoint ?? "https://api.openai.com/v1/responses";
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          instructions: request.system,
          input: request.prompt,
          max_output_tokens: request.maxOutputTokens,
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
    return parseOpenAiResponse(await response.json(), this.model);
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

function parseOpenAiResponse(value: unknown, model: string): GenerateResult {
  if (!isRecord(value)) {
    throw new StructuredOutputInvalid("openai");
  }
  const outputText = outputTextOf(value.output);
  if (outputText === null) {
    throw new StructuredOutputInvalid("openai");
  }
  const usage = isRecord(value.usage) ? value.usage : {};
  const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : {};
  return {
    text: outputText,
    provider: "openai",
    model,
    inputTokens: nullableNumber(usage.input_tokens),
    cachedInputTokens: nullableNumber(inputDetails.cached_tokens),
    outputTokens: nullableNumber(usage.output_tokens),
    estimatedUsd: null,
  };
}

// The REST Responses payload has no top-level output_text; only the SDK synthesizes that field.
function outputTextOf(output: unknown): string | null {
  if (!Array.isArray(output)) {
    return null;
  }
  const texts: string[] = [];
  for (const item of output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }
    for (const part of item.content) {
      if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") {
        texts.push(part.text);
      }
    }
  }
  return texts.length === 0 ? null : texts.join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
