import { bindAdapter, type BoundAdapter } from "@beachside/adapter";
import type { z } from "zod";
import { archilAdapter } from "./adapter";

/** Credentials and setup in one object: `archil({ apiKey, region, ... })`. */
export type ArchilOptions = z.input<typeof archilAdapter.credentials> &
  z.input<typeof archilAdapter.config>;

/** Experimental Archil Sandboxes adapter. Same as `Beachside.connect({ adapter: archilAdapter, credentials, config })`. */
export function archil(options: ArchilOptions): BoundAdapter {
  const { apiKey, registry, ...config } = options;

  return bindAdapter(archilAdapter, config, registry ? { apiKey, registry } : { apiKey });
}
