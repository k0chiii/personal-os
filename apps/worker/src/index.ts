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
import { createApiHandler, type ApiAuthenticator, type ApiRateLimiter } from "@personal-os/api";
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
    return createApiHandler({
      application: personalOs,
      rateLimiter: new CloudflareNativeRateLimiter(environment.RATE_LIMITER),
      ...(authenticator === undefined ? {} : { authenticator }),
      ...(simulator === undefined ? {} : { simulator }),
    })(request);
  },
};
