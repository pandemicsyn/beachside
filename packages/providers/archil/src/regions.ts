/**
 * Region and fetch types the public declarations need. Kept apart from the transport so a
 * consumer's type check never loads the official SDK's declarations, which need Node types.
 */

/**
 * Archil control planes that run sandboxes, from the official SDK's region table and the
 * regions page. `gcp-us-central1` serves storage only, so it is not offered.
 */
export const REGION_NAMES = ["aws-us-east-1", "aws-us-west-2", "aws-eu-west-1"] as const;

export type Region = (typeof REGION_NAMES)[number];

export const REGIONS = {
  "aws-us-east-1": "https://control.green.us-east-1.aws.prod.archil.com",
  "aws-us-west-2": "https://control.green.us-west-2.aws.prod.archil.com",
  "aws-eu-west-1": "https://control.green.eu-west-1.aws.prod.archil.com",
} as const satisfies Record<Region, string>;

/** The fetch signature the adapter accepts; tests inject a deterministic fixture. */
export type NativeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
