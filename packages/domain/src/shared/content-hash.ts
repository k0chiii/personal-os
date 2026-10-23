export type ContentHashAlgorithm = "sha256";

export type InvalidContentHashReason =
  | "empty"
  | "missing-prefix"
  | "unsupported-algorithm"
  | "empty-digest"
  | "invalid-length"
  | "invalid-hex";

const SHA256_ALGORITHM: ContentHashAlgorithm = "sha256";
const SHA256_HEX_LENGTH = 64;
const HEX_REGEX = /^[0-9a-f]+$/;

export class InvalidContentHashError extends Error {
  readonly reason: InvalidContentHashReason;

  constructor(reason: InvalidContentHashReason) {
    super(`Invalid ContentHash: ${reason}.`);
    this.name = "InvalidContentHashError";
    this.reason = reason;
  }
}

export class ContentHash {
  readonly #algorithm: ContentHashAlgorithm;
  readonly #hex: string;

  private constructor(algorithm: ContentHashAlgorithm, hex: string) {
    this.#algorithm = algorithm;
    this.#hex = hex;
  }

  static parse(value: string): ContentHash {
    if (value.length === 0) {
      throw new InvalidContentHashError("empty");
    }

    const normalized = value.toLowerCase();
    const separatorIndex = normalized.indexOf(":");

    if (separatorIndex === -1) {
      throw new InvalidContentHashError("missing-prefix");
    }

    const algorithm = normalized.slice(0, separatorIndex);
    const hex = normalized.slice(separatorIndex + 1);

    if (algorithm !== SHA256_ALGORITHM) {
      throw new InvalidContentHashError("unsupported-algorithm");
    }

    return ContentHash.fromValidatedParts(SHA256_ALGORITHM, hex);
  }

  static fromHex(hex: string): ContentHash {
    return ContentHash.fromValidatedParts(SHA256_ALGORITHM, hex.toLowerCase());
  }

  static #validateHex(hex: string): void {
    if (hex.length === 0) {
      throw new InvalidContentHashError("empty-digest");
    }

    if (hex.length !== SHA256_HEX_LENGTH) {
      throw new InvalidContentHashError("invalid-length");
    }

    if (!HEX_REGEX.test(hex)) {
      throw new InvalidContentHashError("invalid-hex");
    }
  }

  private static fromValidatedParts(algorithm: ContentHashAlgorithm, hex: string): ContentHash {
    ContentHash.#validateHex(hex);

    return new ContentHash(algorithm, hex);
  }

  get algorithm(): ContentHashAlgorithm {
    return this.#algorithm;
  }

  get hex(): string {
    return this.#hex;
  }

  equals(other: ContentHash): boolean {
    return this.#algorithm === other.#algorithm && this.#hex === other.#hex;
  }

  toString(): string {
    return `${this.#algorithm}:${this.#hex}`;
  }
}
