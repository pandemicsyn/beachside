import { bindAdapter, type BoundAdapter } from "@beachside/adapter";
import type { z } from "zod";
import { runloopAdapter } from "./adapter";

/** Credentials and setup in one object: `runloop({ apiKey, ... })`. */
export type RunloopOptions = z.input<typeof runloopAdapter.credentials> &
  z.input<typeof runloopAdapter.config>;

/** Experimental Runloop adapter; egress is open unless you set `network: "blocked"` or an allowlist. Same as `Beachside.connect({ adapter: runloopAdapter, credentials, config })`. */
export function runloop(options: RunloopOptions): BoundAdapter {
  const { apiKey, ...config } = options;

  return bindAdapter(runloopAdapter, config, { apiKey });
}
