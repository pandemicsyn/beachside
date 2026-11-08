import { bindAdapter, type BoundAdapter } from "@beachside/adapter";
import type { z } from "zod";
import { boatAdapter } from "./adapter";

/** Credentials and setup in one object: `boat({ apiKey, ... })`. */
export type BoatOptions = z.input<typeof boatAdapter.credentials> &
  z.input<typeof boatAdapter.config>;

/** Experimental Boat adapter; set `network: "internet"` explicitly, since Boat has no egress controls. Same as `Beachside.connect({ adapter: boatAdapter, credentials, config })`. */
export function boat(options: BoatOptions): BoundAdapter {
  const { apiKey, ...config } = options;

  return bindAdapter(boatAdapter, config, { apiKey });
}
