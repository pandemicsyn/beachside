import { createDaytonaAdapter } from "./index";
import type {
  AllowNetworkSetting,
  ImageInput,
  Preserve,
  ResourceMinimums,
} from "@beachside/adapter";
import { bindAdapter, type BoundAdapter } from "@beachside/adapter";

/** First-party Daytona adapter. Configure `network` once here; omitted create calls use it. Defaults to provider-managed daytona-default egress. */
export function daytona(options: {
  apiKey: string;
  target: string;
  environment?: ImageInput;
  /** @deprecated Use `lifecycle: { lifetimeSeconds }`. */
  ttlMinutes?: number;
  preview?: { access: "protected" | "public" };
  lifecycle?: {
    /** Wall-clock lifetime (default 900), rounded up to minutes; `create()` can override it per sandbox. */
    lifetimeSeconds?: number;
    /** Stop the sandbox after this many idle seconds, rounded up to minutes. Omit to keep it running until its lifetime ends. */
    idleSeconds?: number;
    suspension?: { preserve: "filesystem" | "filesystem+memory" };
  };
  snapshots?: {
    restartAfterCapture?: boolean;
    /** `Preserve.FILESYSTEM_AND_MEMORY` takes hot snapshots of running Linux VMs; containers reject it. */
    preserve?: Preserve;
  };
  /** Minimum `{ vcpus, memoryMiB }`; OCI builds use it and prepared snapshots must meet it. */
  resources?: ResourceMinimums;
  /**
   * Outbound network: `blocked`, `internet`, Daytona's tier-dependent `daytona-default` (default),
   * or an allowlist `{ allow: [...] }` of host names or IPv4 ranges (not both).
   */
  network?: "blocked" | "internet" | "daytona-default" | AllowNetworkSetting;
  /** @deprecated Use `network`. */
  networkPolicy?: "blocked" | "internet" | "daytona-default";
}): BoundAdapter {
  const config = {
    target: options.target,
    environment: options.environment,
    ttlMinutes: options.ttlMinutes,
    lifecycle: options.lifecycle,
    preview: options.preview,
    snapshots: options.snapshots,
    resources: options.resources,
    network: options.network,
    networkPolicy: options.networkPolicy,
  };

  return bindAdapter(createDaytonaAdapter(), config, { apiKey: options.apiKey });
}
