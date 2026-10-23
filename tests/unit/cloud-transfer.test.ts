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

  it("sends a maintenance batch as one transactional request", async () => {
    const bodies: string[] = [];
    const database = new D1HttpDatabase({
      accountId: "account-id",
      databaseId: "database-id",
      apiToken: "secret-token",
      fetch: async (_input, init) => {
        if (typeof init?.body !== "string") {
          throw new TypeError("Expected a JSON string request body.");
        }
        bodies.push(init.body);
        return Response.json({
          success: true,
          result: [
            { success: true, results: [] },
            { success: true, results: [{ id: "second" }] },
          ],
        });
      },
    });

    const results = await database.batch([
      database.prepare("FIRST"),
      database.prepare("SECOND WHERE id = ?").bind("second"),
    ]);

    expect(bodies).toEqual([
      JSON.stringify({
        batch: [
          { sql: "FIRST", params: [] },
          { sql: "SECOND WHERE id = ?", params: ["second"] },
        ],
      }),
    ]);
    expect(results).toEqual([
      { success: true, results: [] },
      { success: true, results: [{ id: "second" }] },
    ]);
  });

  it("rejects a batch whose result count does not match its statements", async () => {
    const database = new D1HttpDatabase({
      accountId: "account-id",
      databaseId: "database-id",
      apiToken: "secret-token",
      fetch: async () => Response.json({ success: true, result: [{ success: true, results: [] }] }),
    });

    await expect(
      database.batch([database.prepare("FIRST"), database.prepare("SECOND")]),
    ).rejects.toThrow("Cloudflare D1 returned 1 results for 2 batched statements.");
  });

  it("fails the whole batch when any statement result is unsuccessful", async () => {
    const database = new D1HttpDatabase({
      accountId: "account-id",
      databaseId: "database-id",
      apiToken: "secret-token",
      fetch: async () =>
        Response.json({
          success: true,
          result: [
            { success: true, results: [] },
            { success: false, results: [] },
          ],
        }),
    });

    await expect(
      database.batch([database.prepare("FIRST"), database.prepare("SECOND")]),
    ).rejects.toThrow("Cloudflare D1 query was not successful (HTTP 200).");
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
