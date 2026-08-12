import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";

function deriveKey(masterKey: string): Buffer {
  return createHash("sha256").update(masterKey, "utf8").digest();
}

export class CredentialVault {
  readonly #key: Buffer;

  constructor(masterKey: string) {
    this.#key = deriveKey(masterKey);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  decrypt(payload: string): string {
    const [version, encodedIv, encodedTag, encodedCiphertext, extra] = payload.split(".");
    if (version !== VERSION || !encodedIv || !encodedTag || !encodedCiphertext || extra !== undefined) {
      throw new Error("Unsupported or malformed encrypted credential");
    }

    try {
      const decipher = createDecipheriv(ALGORITHM, this.#key, Buffer.from(encodedIv, "base64url"));
      decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(encodedCiphertext, "base64url")),
        decipher.final()
      ]).toString("utf8");
    } catch {
      throw new Error("Could not decrypt credentials; the Linger master key may have changed");
    }
  }
}
