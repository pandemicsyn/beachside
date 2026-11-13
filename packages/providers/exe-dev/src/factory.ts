import { bindAdapter, type BoundAdapter } from "@beachside/adapter";
import type { z } from "zod";
import { exeDevAdapter } from "./adapter";

/** Either credential, or both: an API token and an SSH key that signs tokens locally. */
export type ExeDevCredentials = z.input<typeof exeDevAdapter.credentials>;

/** Credentials and setup in one object: `exeDev({ token, ... })`. */
export type ExeDevOptions = z.input<typeof exeDevAdapter.credentials> &
  z.input<typeof exeDevAdapter.config>;

/** Experimental exe.dev adapter. Same as `Beachside.connect({ adapter: exeDevAdapter, credentials, config })`. */
export function exeDev(options: ExeDevOptions): BoundAdapter {
  const { token, sshKey, ...config } = options;

  const credentials: ExeDevCredentials = {};

  if (token !== undefined) credentials.token = token;

  if (sshKey !== undefined) credentials.sshKey = sshKey;

  return bindAdapter(exeDevAdapter, config, credentials);
}
