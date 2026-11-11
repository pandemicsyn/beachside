import { generateKeyPairSync } from "node:crypto";

function sshString(value: Uint8Array | string): Buffer {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);

  return Buffer.concat([length, bytes]);
}

/** A fresh unencrypted OpenSSH Ed25519 private key, generated per test so none is committed. */
export function openSshKey(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const pub = Buffer.from(jwk.x ?? "", "base64url");
  const seed = Buffer.from(jwk.d ?? "", "base64url");
  const publicBlob = Buffer.concat([sshString("ssh-ed25519"), sshString(pub)]);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(0x5eed5eed);

  let secret = Buffer.concat([
    check,
    check,
    sshString("ssh-ed25519"),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString("test"),
  ]);

  const padding = (8 - (secret.length % 8)) % 8;
  secret = Buffer.concat([secret, Buffer.from(Array.from({ length: padding }, (_, i) => i + 1))]);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(1);

  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "latin1"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    count,
    sshString(publicBlob),
    sshString(secret),
  ]);

  const lines = body.toString("base64").match(/.{1,70}/g) ?? [];

  return [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    ...lines,
    "-----END OPENSSH PRIVATE KEY-----",
    "",
  ].join("\n");
}
