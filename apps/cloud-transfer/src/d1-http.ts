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

interface D1Query {
  readonly sql: string;
  readonly params: readonly unknown[];
}

type D1QueryBody = D1Query | { readonly batch: readonly D1Query[] };

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
  readonly query: D1Query;

  constructor(database: D1HttpDatabase, query: D1Query) {
    this.#database = database;
    this.query = query;
  }

  bind(...values: readonly unknown[]): D1PreparedStatementLike {
    return new D1HttpStatement(this.#database, { sql: this.query.sql, params: values });
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const result = await this.#database.execute(this.query);
    const first = result.results[0];
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the schema-owning D1 adapter supplies T.
    return first === undefined ? null : (first as T);
  }

  async all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    const result = await this.#database.execute(this.query);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the schema-owning D1 adapter supplies T.
    return { success: result.success, results: result.results as readonly T[] };
  }

  run(): Promise<D1ResultLike> {
    return this.#database.execute(this.query);
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
    return new D1HttpStatement(this, { sql: query, params: [] });
  }

  async batch(statements: readonly D1PreparedStatementLike[]): Promise<readonly D1ResultLike[]> {
    const queries = statements.map((statement) => {
      if (!(statement instanceof D1HttpStatement)) {
        throw new TypeError("D1HttpDatabase.batch only accepts statements it prepared.");
      }
      return statement.query;
    });
    if (queries.length === 0) {
      return [];
    }
    const results = await this.#post({ batch: queries });
    if (results.length !== queries.length) {
      throw new Error(
        `Cloudflare D1 returned ${results.length} results for ${queries.length} batched statements.`,
      );
    }
    return results;
  }

  async execute(query: D1Query): Promise<D1ExecutionResult> {
    const [result] = await this.#post(query);
    if (result === undefined) {
      throw new Error("Cloudflare D1 returned no result for the query.");
    }
    return result;
  }

  async #post(body: D1QueryBody): Promise<readonly D1ExecutionResult[]> {
    const response = await this.#fetch(this.#endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
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
    return envelope.result.map((item: unknown) => {
      const result = record(item);
      if (result?.success !== true) {
        throw new Error(`Cloudflare D1 query was not successful (HTTP ${response.status}).`);
      }
      return { success: true, results: rows(result.results) };
    });
  }
}
