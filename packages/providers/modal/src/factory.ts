import { bindAdapter, type BoundAdapter } from "@beachside/adapter";
import type { z } from "zod";
import { modalAdapter } from "./adapter";

/** Credentials and setup in one object: `modal({ tokenId, tokenSecret, ... })`. */
export type ModalOptions = z.input<typeof modalAdapter.credentials> &
  z.input<typeof modalAdapter.config>;

/** Experimental Modal adapter for one Modal app and environment. Same as `Beachside.connect({ adapter: modalAdapter, credentials, config })`. */
export function modal(options: ModalOptions): BoundAdapter {
  const { tokenId, tokenSecret, ...config } = options;

  return bindAdapter(modalAdapter, config, { tokenId, tokenSecret });
}
