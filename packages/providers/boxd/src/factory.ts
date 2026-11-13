import { bindAdapter, type BoundAdapter } from "@beachside/adapter";
import type { z } from "zod";
import { boxdAdapter } from "./adapter";

/** Credentials and setup in one object: `boxd({ apiKey, ... })`. */
export type BoxdOptions = z.input<typeof boxdAdapter.credentials> &
  z.input<typeof boxdAdapter.config>;

/** boxd adapter; egress is open unless you set `network: "blocked"` or an allowlist. Same as `Beachside.connect({ adapter: boxdAdapter, credentials, config })`. */
export function boxd(options: BoxdOptions): BoundAdapter {
  const { apiKey, ...config } = options;

  return bindAdapter(boxdAdapter, config, { apiKey });
}
