import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { BackupCipherPort } from "@personal-os/ports";

const FORMAT_MAGIC = new TextEncoder().encode("POSBACKUP1");
const INITIALIZATION_VECTOR_BYTES = 12;
const AUTHENTICATION_TAG_BYTES = 16;

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export class Aes256GcmBackupCipher implements BackupCipherPort {
  readonly #key: Uint8Array;

  constructor(key: Uint8Array) {
    if (key.byteLength !== 32) {
      throw new Error("The backup encryption key must contain exactly 32 bytes.");
    }
    this.#key = Uint8Array.from(key);
  }

  static fromBase64(value: string): Aes256GcmBackupCipher {
    const normalized = value.trim();
    const key = Buffer.from(normalized, "base64");
    if (key.toString("base64").replace(/=+$/u, "") !== normalized.replace(/=+$/u, "")) {
      throw new Error("PERSONAL_OS_BACKUP_KEY must be valid base64.");
    }
    return new Aes256GcmBackupCipher(key);
  }

  async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    const initializationVector = randomBytes(INITIALIZATION_VECTOR_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, initializationVector);
    const encrypted = concatenate([cipher.update(plaintext), cipher.final()]);
    return concatenate([FORMAT_MAGIC, initializationVector, cipher.getAuthTag(), encrypted]);
  }

  async decrypt(ciphertext: Uint8Array): Promise<Uint8Array> {
    const minimumLength =
      FORMAT_MAGIC.byteLength + INITIALIZATION_VECTOR_BYTES + AUTHENTICATION_TAG_BYTES;
    if (ciphertext.byteLength < minimumLength) {
      throw new Error("The encrypted backup is truncated.");
    }
    const header = ciphertext.subarray(0, FORMAT_MAGIC.byteLength);
    if (!header.every((value, index) => value === FORMAT_MAGIC[index])) {
      throw new Error("The file is not a Personal OS encrypted backup.");
    }
    const initializationVectorStart = FORMAT_MAGIC.byteLength;
    const authenticationTagStart = initializationVectorStart + INITIALIZATION_VECTOR_BYTES;
    const encryptedStart = authenticationTagStart + AUTHENTICATION_TAG_BYTES;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.#key,
      ciphertext.subarray(initializationVectorStart, authenticationTagStart),
    );
    decipher.setAuthTag(ciphertext.subarray(authenticationTagStart, encryptedStart));
    try {
      return concatenate([decipher.update(ciphertext.subarray(encryptedStart)), decipher.final()]);
    } catch {
      throw new Error("The encrypted backup could not be authenticated. Check the backup key.");
    }
  }
}
