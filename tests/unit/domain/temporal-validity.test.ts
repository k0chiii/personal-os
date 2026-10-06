import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vite-plus/test";

import {
  InvalidTemporalValidityError,
  TemporalValidity,
} from "../../../packages/domain/src/shared/temporal-validity";

const instant = (value: string): Temporal.Instant => Temporal.Instant.from(value);

describe("TemporalValidity", () => {
  it("creates a bounded validity interval", () => {
    const validFrom = instant("2026-01-01T00:00:00Z");
    const validUntil = instant("2027-01-01T00:00:00Z");

    const validity = TemporalValidity.create(validFrom, validUntil);

    expect(validity.validFrom.equals(validFrom)).toBe(true);
    expect(validity.validUntil?.equals(validUntil)).toBe(true);
  });

  it("creates an open-ended validity interval", () => {
    const validFrom = instant("2026-01-01T00:00:00Z");

    const validity = TemporalValidity.create(validFrom);

    expect(validity.validFrom.equals(validFrom)).toBe(true);
    expect(validity.validUntil).toBeNull();
  });

  it("rejects validUntil earlier than validFrom", () => {
    const validFrom = instant("2026-01-02T00:00:00Z");
    const validUntil = instant("2026-01-01T00:00:00Z");

    expect(() => TemporalValidity.create(validFrom, validUntil)).toThrow(
      InvalidTemporalValidityError,
    );
  });

  it("allows equal validFrom and validUntil", () => {
    const value = instant("2026-01-01T00:00:00Z");

    expect(() => TemporalValidity.create(value, value)).not.toThrow();
  });

  it("contains validFrom", () => {
    const validity = TemporalValidity.create(
      instant("2026-01-01T00:00:00Z"),
      instant("2027-01-01T00:00:00Z"),
    );

    expect(validity.contains(instant("2026-01-01T00:00:00Z"))).toBe(true);
  });

  it("contains an instant inside the interval", () => {
    const validity = TemporalValidity.create(
      instant("2026-01-01T00:00:00Z"),
      instant("2027-01-01T00:00:00Z"),
    );

    expect(validity.contains(instant("2026-06-01T00:00:00Z"))).toBe(true);
  });

  it("does not contain an instant before validFrom", () => {
    const validity = TemporalValidity.create(
      instant("2026-01-01T00:00:00Z"),
      instant("2027-01-01T00:00:00Z"),
    );

    expect(validity.contains(instant("2025-12-31T23:59:59Z"))).toBe(false);
  });

  it("does not contain validUntil", () => {
    const validity = TemporalValidity.create(
      instant("2026-01-01T00:00:00Z"),
      instant("2027-01-01T00:00:00Z"),
    );

    expect(validity.contains(instant("2027-01-01T00:00:00Z"))).toBe(false);
  });

  it("contains later instants when validity is open-ended", () => {
    const validity = TemporalValidity.create(instant("2026-01-01T00:00:00Z"));

    expect(validity.contains(instant("2100-01-01T00:00:00Z"))).toBe(true);
  });

  it("contains nothing when the interval has zero length", () => {
    const value = instant("2026-01-01T00:00:00Z");
    const validity = TemporalValidity.create(value, value);

    expect(validity.contains(value)).toBe(false);
  });

  it("detects overlapping bounded intervals", () => {
    const left = TemporalValidity.create(
      instant("2026-01-01T00:00:00Z"),
      instant("2026-07-01T00:00:00Z"),
    );

    const right = TemporalValidity.create(
      instant("2026-06-01T00:00:00Z"),
      instant("2027-01-01T00:00:00Z"),
    );

    expect(left.overlaps(right)).toBe(true);
    expect(right.overlaps(left)).toBe(true);
  });

  it("does not treat touching boundaries as overlap", () => {
    const left = TemporalValidity.create(
      instant("2026-01-01T00:00:00Z"),
      instant("2026-06-01T00:00:00Z"),
    );

    const right = TemporalValidity.create(
      instant("2026-06-01T00:00:00Z"),
      instant("2027-01-01T00:00:00Z"),
    );

    expect(left.overlaps(right)).toBe(false);
    expect(right.overlaps(left)).toBe(false);
  });

  it("detects overlap with an open-ended interval", () => {
    const left = TemporalValidity.create(instant("2026-01-01T00:00:00Z"));

    const right = TemporalValidity.create(
      instant("2030-01-01T00:00:00Z"),
      instant("2031-01-01T00:00:00Z"),
    );

    expect(left.overlaps(right)).toBe(true);
  });

  it("detects separated intervals", () => {
    const left = TemporalValidity.create(
      instant("2026-01-01T00:00:00Z"),
      instant("2026-02-01T00:00:00Z"),
    );

    const right = TemporalValidity.create(
      instant("2026-03-01T00:00:00Z"),
      instant("2026-04-01T00:00:00Z"),
    );

    expect(left.overlaps(right)).toBe(false);
  });

  it("does not overlap a zero-length interval", () => {
    const value = instant("2026-06-01T00:00:00Z");

    const empty = TemporalValidity.create(value, value);

    const other = TemporalValidity.create(
      instant("2026-01-01T00:00:00Z"),
      instant("2027-01-01T00:00:00Z"),
    );

    expect(empty.overlaps(other)).toBe(false);
    expect(other.overlaps(empty)).toBe(false);
  });
});
