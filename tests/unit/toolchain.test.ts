import { describe, expect, it } from "vite-plus/test";

describe("Vite+ test runner", () => {
  it("runs unit tests from tests/unit", () => {
    expect(1 + 1).toBe(2);
  });
});
