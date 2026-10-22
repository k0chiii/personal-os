import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vite-plus/test";

describe("Personal Ontology v0.1", () => {
  it("versions every defined term and documents property domain/range", async () => {
    const text = await readFile(resolve("ontology/personal-os-v0.1.jsonld"), "utf8");
    const value: unknown = JSON.parse(text);
    expect(value).toMatchObject({
      id: "https://personal-os.dev/ontology/v0.1",
      type: "pos:Ontology",
    });
    if (!isRecord(value) || !Array.isArray(value["@graph"])) {
      throw new TypeError("Ontology graph is missing.");
    }
    const terms = value["@graph"];
    expect(terms.length).toBeGreaterThan(20);
    for (const term of terms) {
      expect(term).toEqual(
        expect.objectContaining({ id: expect.any(String), definition: expect.any(String) }),
      );
    }
    const properties = terms.filter((term) => isRecord(term) && term.type !== "pos:Class");
    expect(properties.length).toBeGreaterThan(10);
    for (const property of properties) {
      expect(property).toEqual(
        expect.objectContaining({ domain: expect.any(String), range: expect.any(String) }),
      );
    }
  });

  it("maps every v0.1 competency question", async () => {
    const mapping = await readFile(resolve("ontology/competency-questions.md"), "utf8");
    for (let number = 1; number <= 10; number += 1) {
      expect(mapping).toContain(`CQ-${String(number).padStart(2, "0")}`);
    }
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
