import {
  StructuredOutputInvalid,
  type GenerateRequest,
  type GenerateResult,
  type LlmPort,
  type StructuredRequest,
} from "@personal-os/ports";

export class MockLlm implements LlmPort {
  readonly providerId = "mock";
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
  readonly #respond: (request: GenerateRequest) => string;

  constructor(respond: (request: GenerateRequest) => string = () => "mock response") {
    this.model = "deterministic-mock";
    this.#respond = respond;
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    return {
      text: this.#respond(request),
      provider: this.providerId,
      model: this.model,
      inputTokens: Math.ceil(request.prompt.length / 4),
      cachedInputTokens: 0,
      outputTokens: null,
      estimatedUsd: 0,
    };
  }

  async structured<T>(request: StructuredRequest<T>): Promise<T> {
    const generated = await this.generate(request);
    try {
      const value: unknown = JSON.parse(generated.text);
      return request.parse(value);
    } catch (error: unknown) {
      if (error instanceof StructuredOutputInvalid) {
        throw error;
      }
      throw new StructuredOutputInvalid(this.providerId);
    }
  }
}
