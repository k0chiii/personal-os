import { afterEach, expect, it } from "vite-plus/test";

import { ApiUnreachableError, requestJson, type Session } from "./api.ts";

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
