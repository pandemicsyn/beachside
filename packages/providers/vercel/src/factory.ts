import { bindAdapter, type BoundAdapter } from "@beachside/adapter";
import type { z } from "zod";
import { vercelAdapter } from "./adapter";

/** Credentials and setup in one object: `vercel({ token, ... })`. */
export type VercelOptions = z.input<typeof vercelAdapter.credentials> &
  z.input<typeof vercelAdapter.config>;

/** Vercel Sandbox adapter for one team and project. Same as `Beachside.connect({ adapter: vercelAdapter, credentials, config })`. */
export function vercel(options: VercelOptions): BoundAdapter {
  const { token, ...config } = options;

  return bindAdapter(vercelAdapter, config, { token });
}
