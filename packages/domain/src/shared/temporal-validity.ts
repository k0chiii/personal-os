import { Temporal } from "temporal-polyfill";

export class InvalidTemporalValidityError extends Error {
  constructor() {
    super("validUntil must not be earlier than validFrom.");
    this.name = "InvalidTemporalValidityError";
  }
}

export class TemporalValidity {
  readonly #validFrom: Temporal.Instant;
  readonly #validUntil: Temporal.Instant | null;

  private constructor(validFrom: Temporal.Instant, validUntil: Temporal.Instant | null) {
    this.#validFrom = validFrom;
    this.#validUntil = validUntil;
  }

  static create(
    validFrom: Temporal.Instant,
    validUntil: Temporal.Instant | null = null,
  ): TemporalValidity {
    if (validUntil !== null && Temporal.Instant.compare(validUntil, validFrom) < 0) {
      throw new InvalidTemporalValidityError();
    }

    return new TemporalValidity(validFrom, validUntil);
  }

  get validFrom(): Temporal.Instant {
    return this.#validFrom;
  }

  get validUntil(): Temporal.Instant | null {
    return this.#validUntil;
  }

  contains(instant: Temporal.Instant): boolean {
    if (Temporal.Instant.compare(instant, this.#validFrom) < 0) {
      return false;
    }

    if (this.#validUntil === null) {
      return true;
    }

    return Temporal.Instant.compare(instant, this.#validUntil) < 0;
  }

  overlaps(other: TemporalValidity): boolean {
    if (this.#isEmpty() || other.#isEmpty()) {
      return false;
    }

    const thisStartsBeforeOtherEnds =
      other.#validUntil === null ||
      Temporal.Instant.compare(this.#validFrom, other.#validUntil) < 0;

    const otherStartsBeforeThisEnds =
      this.#validUntil === null || Temporal.Instant.compare(other.#validFrom, this.#validUntil) < 0;

    return thisStartsBeforeOtherEnds && otherStartsBeforeThisEnds;
  }

  #isEmpty(): boolean {
    return (
      this.#validUntil !== null && Temporal.Instant.compare(this.#validFrom, this.#validUntil) === 0
    );
  }
}
