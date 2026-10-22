import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
} from "@personal-os/adapters-cloudflare";

interface D1HttpDatabaseOptions {
  readonly accountId: string;
  readonly databaseId: string;
  readonly apiToken: string;
  readonly fetch?: typeof fetch;
}

interface D1ExecutionResult {
  readonly success: true;
  readonly results: readonly Record<string, unknown>[];
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${label} cannot be empty.`);
  }
  return normalized;
}

function rows(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("Cloudflare D1 returned an invalid row.");
    }
    return Object.fromEntries(Object.entries(item));
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

class D1HttpStatement implements D1PreparedStatementLike {
  readonly #database: D1HttpDatabase;
  readonly #query: string;
  readonly #parameters: readonly unknown[];

  constructor(database: D1HttpDatabase, query: string, parameters: readonly unknown[] = []) {
    this.#database = database;
    this.#query = query;
    this.#parameters = parameters;
  }

  bind(...values: readonly unknown[]): D1PreparedStatementLike {
    return new D1HttpStatement(this.#database, this.#query, values);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const result = await this.#database.execute(this.#query, this.#parameters);
    const first = result.results[0];
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the schema-owning D1 adapter supplies T.
    return first === undefined ? null : (first as T);
  }

  async all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    const result = await this.#database.execute(this.#query, this.#parameters);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the schema-owning D1 adapter supplies T.
    return { success: result.success, results: result.results as readonly T[] };
  }

  run(): Promise<D1ResultLike> {
    return this.#database.execute(this.#query, this.#parameters);
  }
}

export class D1HttpDatabase implements D1DatabaseLike {
  readonly #endpoint: string;
  readonly #apiToken: string;
  readonly #fetch: typeof fetch;

  constructor(options: D1HttpDatabaseOptions) {
    const accountId = nonEmpty(options.accountId, "Cloudflare account ID");
    const databaseId = nonEmpty(options.databaseId, "Cloudflare D1 database ID");
    this.#apiToken = nonEmpty(options.apiToken, "Cloudflare API token");
    this.#endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`;
    this.#fetch = options.fetch ?? fetch;
  }

  prepare(query: string): D1PreparedStatementLike {
    return new D1HttpStatement(this, query);
  }

  async batch(statements: readonly D1PreparedStatementLike[]): Promise<readonly D1ResultLike[]> {
    const results: D1ResultLike[] = [];
    for (const statement of statements) {
      results.push(await statement.run());
    }
    return results;
  }

  async execute(query: string, parameters: readonly unknown[]): Promise<D1ExecutionResult> {
    const response = await this.#fetch(this.#endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql: query, params: parameters }),
      signal: AbortSignal.timeout(30_000),
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Cloudflare D1 returned a non-JSON response (HTTP ${response.status}).`);
    }
    const envelope = record(payload);
    if (!response.ok || envelope?.success !== true || !Array.isArray(envelope.result)) {
      throw new Error(`Cloudflare D1 query failed (HTTP ${response.status}).`);
    }
    const result = record(envelope.result[0]);
    if (result?.success !== true) {
      throw new Error(`Cloudflare D1 query was not successful (HTTP ${response.status}).`);
    }
    return { success: true, results: rows(result.results) };
  }
}
