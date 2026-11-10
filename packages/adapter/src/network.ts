import { z } from "zod";
import { AdapterError } from "./errors";

/** Policy name an adapter declares in `supports.network` when it can enforce an egress allowlist. */
export const ALLOW_NETWORK_POLICY = "allow" as const;

/** The most entries an allowlist may hold before any provider limit applies. */
export const MAX_ALLOWLIST_ENTRIES = 256;

/**
 * A parsed egress allowlist: outbound HTTP(S) to `hosts` (exact names or `*.` wildcards, matched by
 * Host header or TLS SNI) plus any traffic to `cidrs` (IPv4). Entries are lowercased, deduplicated
 * and sorted, so equal lists compare equal through `canonical`.
 */
export type EgressAllowlist = {
  readonly hosts: readonly string[];
  readonly cidrs: readonly string[];
  /** Stable text form, for comparing a configured list with one recorded on a sandbox. */
  readonly canonical: string;
};

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

function parseHost(entry: string): string | undefined {
  const host = entry.toLowerCase().replace(/\.$/, "");
  const bare = host.startsWith("*.") ? host.slice(2) : host;

  if (host.length > 253 || !bare.includes(".")) return undefined;

  return bare.split(".").every((label) => LABEL.test(label)) && !/^[0-9.]+$/.test(bare)
    ? host
    : undefined;
}

function parseIpv4(value: string): number | undefined {
  const parts = value.split(".");

  if (parts.length !== 4 || !parts.every((part) => /^(0|[1-9][0-9]{0,2})$/.test(part)))
    return undefined;
  const octets = parts.map(Number);

  if (octets.some((octet) => octet > 255)) return undefined;

  return octets.reduce((total, octet) => total * 256 + octet, 0);
}

function parseCidr(entry: string): string | undefined {
  const [address, prefix, extra] = entry.split("/");

  if (extra !== undefined || address === undefined) return undefined;
  const value = parseIpv4(address);

  if (value === undefined) return undefined;

  if (prefix !== undefined && !/^(0|[1-9][0-9]?)$/.test(prefix)) return undefined;
  const bits = prefix === undefined ? 32 : Number(prefix);

  if (bits > 32) return undefined;
  // Mask host bits so 10.1.2.3/8 and 10.0.0.0/8 are the same range.
  const size = 2 ** (32 - bits);
  const network = Math.floor(value / size) * size;
  const octets = [24, 16, 8, 0].map((shift) => Math.floor(network / 2 ** shift) % 256);

  return `${octets.join(".")}/${bits}`;
}

/** Parses `network: { allow }` entries, rejecting anything no provider can enforce as written. */
export function parseEgressAllowlist(entries: readonly string[]): EgressAllowlist {
  if (entries.length === 0 || entries.length > MAX_ALLOWLIST_ENTRIES)
    throw new AdapterError(
      "INVALID_ARGUMENT",
      `An egress allowlist needs 1 to ${MAX_ALLOWLIST_ENTRIES} entries; use network "blocked" to allow nothing`,
    );
  const hosts = new Set<string>();
  const cidrs = new Set<string>();

  for (const raw of entries) {
    const entry = raw.trim();
    const cidr = parseCidr(entry);

    if (cidr === "0.0.0.0/0")
      throw new AdapterError(
        "INVALID_ARGUMENT",
        'Allowlist entry 0.0.0.0/0 allows everything; use network "internet" instead',
      );

    if (cidr) {
      cidrs.add(cidr);
      continue;
    }

    const host = parseHost(entry);

    if (!host)
      throw new AdapterError(
        "INVALID_ARGUMENT",
        `Allowlist entry ${JSON.stringify(entry.slice(0, 100))} is not a host name, a *. wildcard host or an IPv4 address or CIDR range; leave out schemes, ports and paths`,
      );
    hosts.add(host);
  }

  const sortedHosts = [...hosts].sort();
  const sortedCidrs = [...cidrs].sort();

  return {
    hosts: sortedHosts,
    cidrs: sortedCidrs,
    canonical: [...sortedHosts, ...sortedCidrs].join(","),
  };
}

/** Adapter config shape for an allowlist: `network: { allow: ["github.com", "10.0.0.0/8"] }`. */
export const AllowNetworkSetting = z.strictObject({
  allow: z.array(z.string().min(1).max(256)).min(1).max(MAX_ALLOWLIST_ENTRIES),
});

export type AllowNetworkSetting = z.infer<typeof AllowNetworkSetting>;

/**
 * Checks an allowlist against one provider's limits before anything is created, so an oversized or
 * unsupported list fails at connect with the provider's limit in the message.
 */
export function checkAllowlistLimits(
  provider: string,
  allowlist: EgressAllowlist,
  limits: {
    maxHosts?: number;
    maxCidrs?: number;
    wildcards?: boolean;
    cidrs?: boolean;
    hosts?: boolean;
  },
): void {
  if (limits.hosts === false && allowlist.hosts.length)
    throw new AdapterError(
      "UNSUPPORTED",
      `${provider} allowlists take IPv4 ranges only, not host names`,
    );

  if (limits.cidrs === false && allowlist.cidrs.length)
    throw new AdapterError(
      "UNSUPPORTED",
      `${provider} allowlists take host names only, not IP ranges`,
    );

  if (limits.wildcards === false && allowlist.hosts.some((host) => host.startsWith("*.")))
    throw new AdapterError("UNSUPPORTED", `${provider} allowlists take exact host names only`);

  if (limits.maxHosts !== undefined && allowlist.hosts.length > limits.maxHosts)
    throw new AdapterError(
      "UNSUPPORTED",
      `${provider} allowlists hold at most ${limits.maxHosts} host names; this one has ${allowlist.hosts.length}`,
    );

  if (limits.maxCidrs !== undefined && allowlist.cidrs.length > limits.maxCidrs)
    throw new AdapterError(
      "UNSUPPORTED",
      `${provider} allowlists hold at most ${limits.maxCidrs} IP ranges; this one has ${allowlist.cidrs.length}`,
    );
}

export type AllowlistLimits = Parameters<typeof checkAllowlistLimits>[2];

/** A problem with a configured allowlist, kept as plain JSON until `connect` throws it. */
export type AllowlistError = { code: "INVALID_ARGUMENT" | "UNSUPPORTED"; message: string };

/** JSON-safe config fields for an allowlist: its canonical form, or why it was refused. */
export type AllowlistConfig = { allowlist?: string; allowlistError?: AllowlistError };

/** Adapter `network` setup value: a named policy, or an allowlist. */
export type NetworkSetting = string | AllowNetworkSetting;

/** The portable policy name a `network` setup value selects: `allow` for an allowlist. */
export function networkPolicyName<T extends string>(
  setting: T | AllowNetworkSetting,
): T | typeof ALLOW_NETWORK_POLICY {
  if (AllowNetworkSetting.safeParse(setting).success) return ALLOW_NETWORK_POLICY;

  // SAFETY: A setting that is not an allowlist is the named policy `T`.
  return setting as T;
}

/**
 * Config-transform helper: parses an allowlist setting into JSON-safe fields. Problems are kept as
 * `allowlistError` instead of failing the config parse, so `connect` can report them with their
 * reason through `throwAllowlistError`.
 */
export function allowlistConfig(
  provider: string,
  setting: NetworkSetting | undefined,
  limits: AllowlistLimits = {},
): AllowlistConfig {
  const parsed = AllowNetworkSetting.safeParse(setting);

  if (!parsed.success) return {};

  try {
    const list = parseEgressAllowlist(parsed.data.allow);
    checkAllowlistLimits(provider, list, limits);

    return { allowlist: list.canonical };
  } catch (error) {
    return {
      allowlistError: {
        code:
          error instanceof AdapterError && error.code === "UNSUPPORTED"
            ? "UNSUPPORTED"
            : "INVALID_ARGUMENT",
        message: error instanceof Error ? error.message : `Invalid ${provider} allowlist`,
      },
    };
  }
}

/** Throws the allowlist problem `allowlistConfig` recorded, from `connect`, before any native call. */
export function throwAllowlistError(config: { allowlistError?: AllowlistError }): void {
  if (config.allowlistError)
    throw new AdapterError(config.allowlistError.code, config.allowlistError.message);
}

/** Splits a canonical allowlist string back into hosts and IPv4 ranges. */
export function allowlistFromCanonical(canonical: string): EgressAllowlist {
  return parseEgressAllowlist(canonical.split(","));
}
