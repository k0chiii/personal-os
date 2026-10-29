import {
  BindingSecretStore,
  CloudflareSystemClock,
  CloudflareVectorizeIndex,
  D1AgentRunRecorder,
  D1EventStore,
  D1Projection,
  R2RawEvidenceStore,
  WebCryptoContentHasher,
  WebCryptoUuidV7Generator,
  type D1DatabaseLike,
  type R2BucketLike,
  type VectorizeIndexLike,
} from "@personal-os/adapters-cloudflare";
import { OpenAiAdapter } from "@personal-os/adapters-openai";
import {
  createApiHandler,
  quotesMemory,
  type ApiAuthenticator,
  type ApiRateLimiter,
  type ConversationVoice,
} from "@personal-os/api";
import { DecisionSimulator, PersonalOsApplication, ProviderRouter } from "@personal-os/application";
import { HybridAssertionRetriever, LocalHashEmbedding } from "@personal-os/retrieval";

export interface CloudflareRateLimitBinding {
  limit(input: { readonly key: string }): Promise<{ readonly success: boolean }>;
}

export interface WorkerEnvironment {
  readonly DB: D1DatabaseLike;
  readonly EVIDENCE: R2BucketLike;
  readonly VECTORIZE: VectorizeIndexLike;
  readonly RATE_LIMITER: CloudflareRateLimitBinding;
  readonly REQUIRE_ACCESS?: string;
  readonly OPENAI_API_KEY?: string;
  readonly OPENAI_MODEL?: string;
  readonly AI?: WorkersAiBinding;
}

interface WorkersAiBinding {
  run(
    model: string,
    input: {
      readonly messages: readonly {
        readonly role: "system" | "user" | "assistant";
        readonly content: string;
      }[];
      readonly temperature?: number;
      readonly max_tokens?: number;
      readonly repetition_penalty?: number;
    },
  ): Promise<unknown>;
}

function application(environment: WorkerEnvironment): PersonalOsApplication {
  const projection = new D1Projection(environment.DB);
  return new PersonalOsApplication({
    clock: new CloudflareSystemClock(),
    idGenerator: new WebCryptoUuidV7Generator(),
    contentHasher: new WebCryptoContentHasher(),
    rawEvidenceStore: new R2RawEvidenceStore(environment.EVIDENCE),
    eventStore: new D1EventStore(environment.DB),
    projection,
    assertionRetriever: new HybridAssertionRetriever(
      projection,
      new LocalHashEmbedding(256),
      new CloudflareVectorizeIndex(environment.VECTORIZE),
    ),
  });
}

export class CloudflareNativeRateLimiter implements ApiRateLimiter {
  readonly #binding: CloudflareRateLimitBinding;

  constructor(binding: CloudflareRateLimitBinding) {
    this.#binding = binding;
  }

  async check(
    key: string,
  ): Promise<{ readonly allowed: boolean; readonly retryAfterSeconds: number }> {
    const result = await this.#binding.limit({ key });
    return { allowed: result.success, retryAfterSeconds: result.success ? 0 : 60 };
  }
}

const QUESTION_REWRITE_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const QUESTION_REWRITE_SYSTEM =
  "次の一文を、同じ種類の名前を残したまま、日本語の一文に短く書き直す。説明や前置きは書かない。";

function workersAiWording(ai: NonNullable<WorkerEnvironment["AI"]>): {
  rewrite(prompt: string): Promise<string>;
} {
  return {
    async rewrite(prompt: string): Promise<string> {
      const result = await ai.run(QUESTION_REWRITE_MODEL, {
        messages: [
          { role: "system", content: QUESTION_REWRITE_SYSTEM },
          { role: "user", content: prompt },
        ],
      });
      return workersAiText(result);
    },
  };
}

const TALK_SYSTEM =
  "あなたは、この人の記憶を根拠に話す対話相手です。日本語で、友達に話すように1つか2つの短い文で返してください。記憶の文は根拠であり、読む原稿ではありません。同じ文をそのまま出したり、改行で並べたりしないでください。相手の最後の発言に自分の言葉で答え、その答えに関係する記憶だけを言い換えて織り込んでください。関係ない記憶は出さないでください。これまでの返事に原文が混ざっていても、それに倣わないでください。記憶にない事実は作らないでください。記憶がなくても会話は続けてください。見出し、箇条書き、ラベルは書かないでください。";
const TALK_RETRY_SYSTEM =
  "さっきの返事は記憶の原文でした。原文は出さず、相手の発言に自分の言葉で一文だけ返してください。関係する根拠は言い換えてください。";

export function workersAiVoice(ai: WorkersAiBinding): ConversationVoice {
  return {
    async reply(input) {
      const first = await speak(ai, input, TALK_SYSTEM);
      if (acceptsTalk(first, input.memory)) return first;
      const system = quotesMemory(first, input.memory) ? TALK_RETRY_SYSTEM : TALK_SYSTEM;
      return speak(ai, input, system);
    },
  };
}

async function speak(
  ai: WorkersAiBinding,
  input: {
    readonly message: string;
    readonly memory: readonly string[];
    readonly history: readonly { readonly role: "owner" | "system"; readonly text: string }[];
  },
  system: string,
): Promise<string> {
  try {
    const result = await ai.run(QUESTION_REWRITE_MODEL, {
      messages: [
        { role: "system", content: system },
        ...input.history.map((line) => ({
          role: line.role === "owner" ? ("user" as const) : ("assistant" as const),
          content: line.text,
        })),
        { role: "user", content: talkUserContent(input.message, input.memory) },
      ],
      temperature: 0.4,
      max_tokens: 180,
      repetition_penalty: 1.2,
    });
    return workersAiText(result).trim();
  } catch {
    return "";
  }
}

function talkUserContent(message: string, memory: readonly string[]): string {
  if (memory.length === 0) return message;
  return `根拠:\n${memory.join("\n")}\n\n相手:\n${message}`;
}

function acceptsTalk(spoken: string, memory: readonly string[]): boolean {
  return spoken.length > 0 && !quotesMemory(spoken, memory);
}

function workersAiText(result: unknown): string {
  if (typeof result === "string") return result;
  if (typeof result !== "object" || result === null) return "";
  if ("response" in result && typeof result.response === "string") return result.response;
  if ("result" in result && result.result !== result) return workersAiText(result.result);
  return "";
}

function accessAuthenticator(required: boolean): ApiAuthenticator | undefined {
  return required
    ? {
        authenticate(request: Request) {
          const email = request.headers.get("CF-Access-Authenticated-User-Email")?.trim();
          return email === undefined || email.length === 0 ? null : { subject: email };
        },
      }
    : undefined;
}

export default {
  async fetch(request: Request, environment: WorkerEnvironment): Promise<Response> {
    const personalOs = application(environment);
    const apiKey = await new BindingSecretStore({
      OPENAI_API_KEY: environment.OPENAI_API_KEY,
    }).get("OPENAI_API_KEY");
    const simulator =
      apiKey === null
        ? undefined
        : new DecisionSimulator(
            personalOs,
            new ProviderRouter([
              new OpenAiAdapter({
                apiKey,
                model: environment.OPENAI_MODEL ?? "gpt-5-mini",
              }),
            ]),
            {
              recorder: new D1AgentRunRecorder(environment.DB),
              clock: new CloudflareSystemClock(),
              idGenerator: new WebCryptoUuidV7Generator(),
              promptVersion: "decision-simulator/v1",
              monotonicMilliseconds: () => performance.now(),
            },
          );
    const authenticator = accessAuthenticator(environment.REQUIRE_ACCESS === "true");
    const ai = environment.AI;
    return createApiHandler({
      application: personalOs,
      rateLimiter: new CloudflareNativeRateLimiter(environment.RATE_LIMITER),
      ...(authenticator === undefined ? {} : { authenticator }),
      ...(simulator === undefined ? {} : { simulator }),
      ...(ai === undefined ? {} : { wording: workersAiWording(ai), voice: workersAiVoice(ai) }),
    })(request);
  },
};
