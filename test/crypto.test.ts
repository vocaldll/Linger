import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CredentialVault } from "../src/crypto.js";

describe("CredentialVault", () => {
  it("round-trips without exposing plaintext", () => {
    const vault = new CredentialVault("a sufficiently long test master key");
    const encrypted = vault.encrypt("secret refresh token");
    assert.equal(encrypted.includes("secret refresh token"), false);
    assert.equal(vault.decrypt(encrypted), "secret refresh token");
  });

  it("rejects tampered or wrongly-keyed credentials", () => {
    const encrypted = new CredentialVault("one sufficiently long test key").encrypt("token");
    assert.throws(
      () => new CredentialVault("another sufficiently long key").decrypt(encrypted),
      /could not decrypt credentials/iu
    );
  });
});
