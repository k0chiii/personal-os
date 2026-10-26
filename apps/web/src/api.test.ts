import { afterEach, expect, it } from "vite-plus/test";

import {
  ApiUnreachableError,
  healthResponse,
  requestJson,
  searchResponse,
  type Session,
} from "./api.ts";

const session: Session = { apiBase: "http://127.0.0.1:9", accessToken: "" };
const fetchImpl = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = fetchImpl;
});

it("reports a dead API as unreachable", async () => {
  globalThis.fetch = () => Promise.reject(new TypeError("network down"));
  await expect(requestJson(session, "/health")).rejects.toBeInstanceOf(ApiUnreachableError);
});

it("keeps an HTTP JSON error on the response", async () => {
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ detail: "No route matches the request." }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
  await expect(requestJson(session, "/v1/missing")).rejects.toThrow(
    "No route matches the request.",
  );
});

function jsonResponse(body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

it("sends the access token as a bearer authorization header", async () => {
  let authorization: string | null = null;
  globalThis.fetch = (_input, init) => {
    authorization = new Headers(init?.headers).get("authorization");
    return jsonResponse({ status: "ok" });
  };
  await expect(
    requestJson({ ...session, accessToken: "secret-token" }, "/health"),
  ).resolves.toEqual({ status: "ok" });
  expect(authorization).toBe("Bearer secret-token");
});

it("omits authorization when the session has no access token", async () => {
  let authorization: string | null = "set";
  globalThis.fetch = (_input, init) => {
    authorization = new Headers(init?.headers).get("authorization");
    return jsonResponse(null);
  };
  await requestJson(session, "/health");
  expect(authorization).toBeNull();
});

it("accepts only an ok health payload", () => {
  expect(healthResponse({ status: "ok" })).toEqual({ status: "ok" });
  expect(() => healthResponse({ status: "down" })).toThrow("API 未接続");
  expect(() => healthResponse(null)).toThrow("API 未接続");
});

it("rejects a search payload that is missing its lists", () => {
  expect(() => searchResponse({ assertions: [] })).toThrow("API returned invalid search results.");
  expect(() => searchResponse(null)).toThrow("API returned invalid search results.");
});

it("reads assertions and decisions from a search payload", () => {
  const assertion = {
    id: "a1",
    kind: "preference",
    object: "tea",
    privacy: "private",
    validFrom: "2026-01-01T00:00:00.000Z",
  };
  expect(
    searchResponse({
      assertions: [assertion],
      decisions: [{ problem: "which tea", rationale: "morning" }],
    }),
  ).toEqual({
    assertions: [assertion],
    decisions: [{ problem: "which tea", rationale: "morning" }],
  });
});
