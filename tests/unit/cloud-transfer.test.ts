import { describe, expect, it } from "vite-plus/test";

import { D1HttpDatabase } from "../../apps/cloud-transfer/src/d1-http.ts";

describe("Cloudflare D1 HTTP operator adapter", () => {
  it("sends bound parameters without exposing credentials in the result", async () => {
    const requests: { readonly url: string; readonly init: RequestInit }[] = [];
    const database = new D1HttpDatabase({
      accountId: "account-id",
      databaseId: "database-id",
      apiToken: "secret-token",
      fetch: async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        requests.push({ url, init: init ?? {} });
        return Response.json({
          success: true,
          result: [{ success: true, results: [{ version: 7 }] }],
        });
      },
    });

    await expect(
      database.prepare("SELECT ? AS version").bind(7).first<{ readonly version: number }>(),
    ).resolves.toEqual({ version: 7 });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain("/accounts/account-id/d1/database/database-id/query");
    expect(requests[0]?.init.body).toBe(
      JSON.stringify({ sql: "SELECT ? AS version", params: [7] }),
    );
    expect(new Headers(requests[0]?.init.headers).get("authorization")).toBe("Bearer secret-token");
  });

  it("executes maintenance batches in order", async () => {
    const queries: string[] = [];
    const database = new D1HttpDatabase({
      accountId: "account-id",
      databaseId: "database-id",
      apiToken: "secret-token",
      fetch: async (_input, init) => {
        if (typeof init?.body !== "string") {
          throw new TypeError("Expected a JSON string request body.");
        }
        const body: unknown = JSON.parse(init.body);
        if (typeof body !== "object" || body === null || !("sql" in body)) {
          throw new TypeError("Expected a SQL request body.");
        }
        const sql = Reflect.get(body, "sql");
        if (typeof sql !== "string") {
          throw new TypeError("Expected SQL to be a string.");
        }
        queries.push(sql);
        return Response.json({ success: true, result: [{ success: true, results: [] }] });
      },
    });

    await database.batch([database.prepare("FIRST"), database.prepare("SECOND")]);
    expect(queries).toEqual(["FIRST", "SECOND"]);
  });

  it("reports API failure without echoing SQL or parameters", async () => {
    const database = new D1HttpDatabase({
      accountId: "account-id",
      databaseId: "database-id",
      apiToken: "secret-token",
      fetch: async () =>
        Response.json(
          { success: false, errors: [{ message: "SELECT private-value" }] },
          { status: 403 },
        ),
    });

    const error = await database
      .prepare("SELECT ?")
      .bind("private-value")
      .run()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) {
      throw new TypeError("Expected an Error instance.");
    }
    expect(error.message).toBe("Cloudflare D1 query failed (HTTP 403).");
  });
});
