import { expect, test } from "bun:test";
import { createHash, createPublicKey, verify } from "node:crypto";
import { openSshKey } from "./keys.test-support";
import { parseSigningKey, signToken } from "./sshsig";

function sshString(value: Uint8Array | string): Buffer {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);

  return Buffer.concat([length, bytes]);
}

function readString(bytes: Buffer, at: number): [Buffer, number] {
  const length = bytes.readUInt32BE(at);

  return [bytes.subarray(at + 4, at + 4 + length), at + 4 + length];
}

test("signed tokens carry the exact permissions JSON and a verifiable SSHSIG", () => {
  const key = parseSigningKey(openSshKey());
  const token = signToken(key, { exp: 2_000_000_000, cmds: ["ls", "ssh"] });
  const [prefix, payload = "", signature = ""] = token.split(".");

  expect(prefix).toBe("exe0");
  expect(Buffer.from(payload, "base64url").toString()).toBe(
    '{"exp":2000000000,"cmds":["ls","ssh"]}',
  );
  const blob = Buffer.from(signature, "base64url");
  expect(blob.subarray(0, 6).toString()).toBe("SSHSIG");
  let at = 10;
  let field: Buffer;
  [field, at] = readString(blob, at);
  expect(field.equals(key.publicKey)).toBe(true);
  [field, at] = readString(blob, at);
  expect(field.toString()).toBe("v0@exe.dev");
  [, at] = readString(blob, at);
  [field, at] = readString(blob, at);
  expect(field.toString()).toBe("sha512");
  [field] = readString(blob, at);
  const [, sigAt] = readString(field, 0);
  const [raw] = readString(field, sigAt);
  const hash = createHash("sha512").update(Buffer.from(payload, "base64url")).digest();

  const signed = Buffer.concat([
    Buffer.from("SSHSIG"),
    ...["v0@exe.dev", "", "sha512"].map(sshString),
    sshString(hash),
  ]);

  const pub = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: key.publicKey.subarray(-32).toString("base64url") },
    format: "jwk",
  });

  expect(verify(null, signed, pub, raw)).toBe(true);
  expect(key.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
});

test("VM tokens sign in the VM's own namespace", () => {
  const key = parseSigningKey(openSshKey());
  const blob = Buffer.from(signToken(key, { exp: 1 }, "bs-1").split(".")[2] ?? "", "base64url");

  expect(blob.includes(Buffer.from("v0@bs-1.exe.xyz"))).toBe(true);
});

test("only unencrypted OpenSSH Ed25519 keys are accepted", () => {
  expect(() => parseSigningKey("not a key")).toThrow(/OpenSSH Ed25519/);

  const encrypted = openSshKey().replace(
    /(-----BEGIN OPENSSH PRIVATE KEY-----\n)([\s\S]+?)(\n-----END)/,
    (_, head: string, body: string, tail: string) => {
      const bytes = Buffer.from(body.replace(/\s+/g, ""), "base64");
      // Swap the cipher name "none" for "aes!" (same length) to look like an encrypted key.
      bytes.write("aes!", 15 + 4, "latin1");

      return `${head}${bytes.toString("base64")}${tail}`;
    },
  );

  expect(() => parseSigningKey(encrypted)).toThrow(/passphrase/);
});
