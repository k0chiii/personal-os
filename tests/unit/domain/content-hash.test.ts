import { describe, expect, it } from "vite-plus/test";

import {
  ContentHash,
  InvalidContentHashError,
} from "../../../packages/domain/src/shared/content-hash";

const HEX_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const HEX_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const EMPTY_CONTENT_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("ContentHash", () => {
  it("parses a canonical SHA-256 content hash", () => {
    const hash = ContentHash.parse(`sha256:${HEX_A}`);

    expect(hash.algorithm).toBe("sha256");
    expect(hash.hex).toBe(HEX_A);
    expect(hash.toString()).toBe(`sha256:${HEX_A}`);
  });

  it("creates a content hash from raw SHA-256 hex", () => {
    const hash = ContentHash.fromHex(HEX_A);

    expect(hash.toString()).toBe(`sha256:${HEX_A}`);
  });

  it("normalizes uppercase hexadecimal characters", () => {
    const hash = ContentHash.parse(`SHA256:${HEX_A.toUpperCase()}`);

    expect(hash.toString()).toBe(`sha256:${HEX_A}`);
  });

  it("rejects an empty value", () => {
    expect(() => ContentHash.parse("")).toThrow(InvalidContentHashError);
  });

  it("rejects an empty digest", () => {
    expect(() => ContentHash.parse("sha256:")).toThrow(InvalidContentHashError);
  });

  it("rejects a value without an algorithm prefix", () => {
    expect(() => ContentHash.parse(HEX_A)).toThrow(InvalidContentHashError);
  });

  it("rejects an unsupported algorithm", () => {
    expect(() => ContentHash.parse(`sha512:${HEX_A}`)).toThrow(InvalidContentHashError);
  });

  it("rejects a digest shorter than 64 hexadecimal characters", () => {
    expect(() => ContentHash.parse(`sha256:${"a".repeat(63)}`)).toThrow(InvalidContentHashError);
  });

  it("rejects a digest longer than 64 hexadecimal characters", () => {
    expect(() => ContentHash.parse(`sha256:${"a".repeat(65)}`)).toThrow(InvalidContentHashError);
  });

  it("rejects non-hexadecimal characters", () => {
    expect(() => ContentHash.parse(`sha256:${"g".repeat(64)}`)).toThrow(InvalidContentHashError);
  });

  it("considers equal hashes equal", () => {
    const left = ContentHash.parse(`sha256:${HEX_A}`);
    const right = ContentHash.fromHex(HEX_A);

    expect(left.equals(right)).toBe(true);
  });

  it("considers different hashes unequal", () => {
    const left = ContentHash.fromHex(HEX_A);
    const right = ContentHash.fromHex(HEX_B);

    expect(left.equals(right)).toBe(false);
  });

  it("accepts the SHA-256 digest of empty content", () => {
    const hash = ContentHash.fromHex(EMPTY_CONTENT_SHA256);

    expect(hash.toString()).toBe(`sha256:${EMPTY_CONTENT_SHA256}`);
  });
});
