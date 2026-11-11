import { createHash, createPrivateKey, sign, type KeyObject } from "node:crypto";
import { AdapterError } from "@beachside/adapter";

/**
 * Local exe.dev token signing (https://exe.dev/docs/https-api-local-key). A token is
 * `exe0.<base64url(permissions)>.<base64url(SSHSIG blob)>`, where the blob is the
 * `ssh-keygen -Y sign` signature of the exact permissions JSON in namespace `v0@exe.dev`
 * (account tokens) or `v0@<vm>.exe.xyz` (tokens for one VM's HTTPS proxy). Only unencrypted
 * OpenSSH Ed25519 keys are accepted; the key never leaves this process.
 */

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function sshString(value: Uint8Array | string): Buffer {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);

  return Buffer.concat([length, bytes]);
}

class Reader {
  #offset = 0;

  constructor(readonly bytes: Buffer) {}

  take(length: number): Buffer {
    if (length < 0 || this.#offset + length > this.bytes.length) throw invalid();
    const value = this.bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;

    return value;
  }

  uint32(): number {
    return this.take(4).readUInt32BE(0);
  }

  string(): Buffer {
    return this.take(this.uint32());
  }
}

const invalid = () =>
  new AdapterError(
    "INVALID_ARGUMENT",
    "exe.dev sshKey must be an unencrypted OpenSSH Ed25519 private key",
  );

export type SigningKey = {
  /** The SSH wire-format public key (`ssh-ed25519` + 32 bytes). */
  publicKey: Buffer;
  /** OpenSSH fingerprint, `SHA256:...`, safe to show. */
  fingerprint: string;
  privateKey: KeyObject;
};

/** Parse an `-----BEGIN OPENSSH PRIVATE KEY-----` Ed25519 key without a passphrase. */
export function parseSigningKey(pem: string): SigningKey {
  const match =
    /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]+?)-----END OPENSSH PRIVATE KEY-----/.exec(pem);

  if (!match?.[1]) throw invalid();
  const reader = new Reader(Buffer.from(match[1].replace(/\s+/g, ""), "base64"));
  const magic = reader.take(15).toString("latin1");

  if (magic !== "openssh-key-v1\0") throw invalid();
  const cipher = reader.string().toString("latin1");
  const kdf = reader.string().toString("latin1");
  reader.string();

  if (cipher !== "none" || kdf !== "none")
    throw new AdapterError(
      "INVALID_ARGUMENT",
      "exe.dev sshKey must not be passphrase-protected; use a dedicated key without a passphrase",
    );

  if (reader.uint32() !== 1) throw invalid();
  const publicKey = Buffer.from(reader.string());
  const secret = new Reader(reader.string());

  if (secret.uint32() !== secret.uint32()) throw invalid();

  if (secret.string().toString("latin1") !== "ssh-ed25519") throw invalid();
  const pub = secret.string();
  const priv = secret.string();

  if (pub.length !== 32 || priv.length !== 64 || !priv.subarray(32).equals(pub)) throw invalid();
  const key = new Reader(publicKey);

  if (key.string().toString("latin1") !== "ssh-ed25519" || !key.string().equals(pub))
    throw invalid();

  const privateKey = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", d: base64url(priv.subarray(0, 32)), x: base64url(pub) },
    format: "jwk",
  });

  return {
    publicKey,
    fingerprint: `SHA256:${createHash("sha256").update(publicKey).digest("base64").replace(/=+$/, "")}`,
    privateKey,
  };
}

/** The SSHSIG blob `ssh-keygen -Y sign -n <namespace>` produces for `message` (SHA-512). */
export function sshSignature(key: SigningKey, namespace: string, message: Uint8Array): Buffer {
  const hash = createHash("sha512").update(message).digest();

  const signed = Buffer.concat([
    Buffer.from("SSHSIG", "latin1"),
    sshString(namespace),
    sshString(""),
    sshString("sha512"),
    sshString(hash),
  ]);

  const signature = sign(null, signed, key.privateKey);

  const version = Buffer.alloc(4);
  version.writeUInt32BE(1);

  return Buffer.concat([
    Buffer.from("SSHSIG", "latin1"),
    version,
    sshString(key.publicKey),
    sshString(namespace),
    sshString(""),
    sshString("sha512"),
    sshString(Buffer.concat([sshString("ssh-ed25519"), sshString(signature)])),
  ]);
}

export type TokenPermissions = {
  /** Expiry, whole UTC epoch seconds. */
  exp: number;
  nbf?: number;
  cmds?: readonly string[];
};

/**
 * A signed `exe0` token. Field order is fixed and the JSON has no whitespace, as exe.dev's
 * permission rules require; nothing secret goes into the payload.
 */
export function signToken(key: SigningKey, permissions: TokenPermissions, vm?: string): string {
  // JSON.stringify keeps this key order and leaves out the fields that are undefined.
  const fields = { exp: permissions.exp, nbf: permissions.nbf, cmds: permissions.cmds };
  const json = Buffer.from(JSON.stringify(fields), "utf8");
  const namespace = vm === undefined ? "v0@exe.dev" : `v0@${vm}.exe.xyz`;

  return `exe0.${base64url(json)}.${base64url(sshSignature(key, namespace, json))}`;
}
