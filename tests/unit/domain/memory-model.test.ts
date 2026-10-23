import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vite-plus/test";

import {
  approveProposal,
  changeAssertionStatus,
  createPreferenceAssertion,
  createProposal,
  DomainInvariantError,
} from "../../../packages/domain/src/index.ts";

const id = (suffix: number): string =>
  `017f22e2-79b0-7cc3-98c4-dc0c0c0739${suffix.toString(16).padStart(2, "0")}`;

const instant = (value: string): Temporal.Instant => Temporal.Instant.from(value);

describe("Preference Assertion", () => {
  it("requires supporting Evidence", () => {
    expect(() =>
      createPreferenceAssertion({
        id: id(1),
        subjectId: id(2),
        object: "TypeScript",
        evidenceIds: [],
        epistemicOrigin: "self_stated",
        validFrom: instant("2026-01-01T00:00:00Z"),
        recordedAt: instant("2026-01-02T00:00:00Z"),
        privacy: "P1",
      }),
    ).toThrow(DomainInvariantError);
  });

  it("does not invent a numeric confidence", () => {
    const assertion = createPreferenceAssertion({
      id: id(1),
      subjectId: id(2),
      object: "TypeScript",
      evidenceIds: [id(3)],
      epistemicOrigin: "self_stated",
      validFrom: instant("2026-01-01T00:00:00Z"),
      recordedAt: instant("2026-01-02T00:00:00Z"),
      privacy: "P1",
    });

    expect(assertion.confidence).toBeNull();
  });

  it("allows a human reviewer to edit a Proposal while approving it", () => {
    const assertion = createPreferenceAssertion({
      id: id(1),
      subjectId: id(2),
      object: "Type Script",
      evidenceIds: [id(3)],
      epistemicOrigin: "self_stated",
      validFrom: instant("2026-01-01T00:00:00Z"),
      recordedAt: instant("2026-01-02T00:00:00Z"),
      privacy: "P1",
    });
    const proposal = createProposal({
      id: id(4),
      assertion,
      createdAt: instant("2026-01-02T00:00:00Z"),
      createdBy: "agent",
    });

    const approved = approveProposal({
      proposal,
      reviewedAt: instant("2026-01-03T00:00:00Z"),
      actor: "owner",
      reason: "Correct the spelling before canonical write",
      editedObject: "TypeScript",
    });

    expect(approved.status).toBe("approved");
    expect(approved.assertion.object).toBe("TypeScript");
    expect(approved.reviewedBy).toBe("owner");
  });

  it("closes a superseded Assertion without mutating its historical start", () => {
    const assertion = createPreferenceAssertion({
      id: id(1),
      subjectId: id(2),
      object: "Coffee",
      evidenceIds: [id(3)],
      epistemicOrigin: "self_stated",
      validFrom: instant("2025-01-01T00:00:00Z"),
      recordedAt: instant("2025-01-02T00:00:00Z"),
      privacy: "P1",
    });

    const superseded = changeAssertionStatus(
      assertion,
      "superseded",
      instant("2026-01-01T00:00:00Z"),
    );

    expect(superseded).toMatchObject({
      status: "superseded",
      validFrom: "2025-01-01T00:00:00Z",
      validUntil: "2026-01-01T00:00:00Z",
    });
    expect(assertion.status).toBe("active");
  });

  it("rejects a second status transition", () => {
    const assertion = createPreferenceAssertion({
      id: id(1),
      subjectId: id(2),
      object: "Coffee",
      evidenceIds: [id(3)],
      epistemicOrigin: "self_stated",
      validFrom: instant("2025-01-01T00:00:00Z"),
      recordedAt: instant("2025-01-02T00:00:00Z"),
      privacy: "P1",
    });

    const disputed = changeAssertionStatus(assertion, "disputed");
    expect(() => changeAssertionStatus(disputed, "retracted")).toThrow(DomainInvariantError);
  });
});
