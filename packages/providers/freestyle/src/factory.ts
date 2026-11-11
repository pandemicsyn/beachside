import { bindAdapter, type BoundAdapter } from "@beachside/adapter";
import type { z } from "zod";
import { freestyleAdapter } from "./adapter";

/** Credentials and setup in one object: `freestyle({ apiKey, ... })`. */
export type FreestyleOptions = z.input<typeof freestyleAdapter.credentials> &
  z.input<typeof freestyleAdapter.config>;

/** Freestyle VMs adapter. Same as `Beachside.connect({ adapter: freestyleAdapter, credentials, config })`. */
export function freestyle(options: FreestyleOptions): BoundAdapter {
  const { apiKey, ...config } = options;

  return bindAdapter(freestyleAdapter, config, { apiKey });
}
