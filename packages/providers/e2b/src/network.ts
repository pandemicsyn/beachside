import {
  ALLOW_NETWORK_POLICY,
  allowlistFromCanonical,
  parseEgressAllowlist,
} from "@beachside/adapter";

/** Network policies one E2B connection creates with: its allowlist, or blocked and internet. */
export function e2bNetworkPolicies(allowlist: string | undefined): string[] {
  return allowlist ? [ALLOW_NETWORK_POLICY] : ["internet", "blocked"];
}

/** E2B create fields for egress: `allowOut` entries, sent over a deny-all `denyOut`. */
export type E2BEgress = { allowOut?: string[] };

/** Native create fields for an allowlist: `allowOut` entries over a deny-all `denyOut`. */
export function e2bEgress(allowlist: string | undefined): E2BEgress {
  const egress: E2BEgress = {};

  if (!allowlist) return egress;
  const list = allowlistFromCanonical(allowlist);
  egress.allowOut = [...list.hosts, ...list.cidrs];

  return egress;
}

/** Whether a sandbox's native egress rules are exactly the requested allowlist, or none. */
export function e2bEgressMatches(
  record: { allowOut?: string[]; denyOut?: string[] },
  allowlist: string | undefined,
): boolean {
  if (!allowlist) return !record.allowOut?.length;

  if (!record.denyOut?.includes("0.0.0.0/0") || !record.allowOut?.length) return false;

  try {
    return parseEgressAllowlist(record.allowOut).canonical === allowlist;
  } catch {
    return false;
  }
}
