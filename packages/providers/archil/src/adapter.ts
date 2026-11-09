import { createHash } from "node:crypto";
import { Sandbox as NativeSandbox, type SandboxProcess, type SandboxProcessOutput } from "disk";
import { z } from "zod";
import {
  AdapterCheckpointError,
  AdapterError,
  AdapterFilesystemError,
  assertResourceScope,
  DEFAULT_LIFETIME_SECONDS,
  defineAdapter,
  listedTime,
  MountSpec as MountSpecSchema,
  Preserve,
  PreserveSchema,
  resolveSnapshot,
  ResourceMinimums,
  sandboxReference,
  unknownSandboxFacts,
  type AdapterSession,
  type AttemptContext,
  type CreateInput,
  type DestroyInput,
  type ExecInput,
  type ExecValue,
  type FileWriteInput,
  type ImageInfo,
  type MountSpec,
  type ObserveContext,
  type OperationOutcome,
  type ProcessStartContext,
  type ReadContext,
  type ResourceReference,
  type Sandbox,
  type SandboxInfo,
  type SandboxReference,
  type SandboxState,
  type SnapshotInfo,
  type SnapshotProfile,
  type VolumeInfo,
} from "@beachside/adapter";
import {
  directoryValue,
  Exists,
  filesystem,
  statValue,
  type Downloader,
  type GuestRunner,
} from "./filesystem";
import {
  exitCode,
  frameRelay,
  launcher,
  observeProcess,
  ProcessReference,
  sendInput,
  type ProcessOptions,
} from "./process";
import { checkEnv, commandLine } from "./shell";
import { createControl, nativeFailure, refusedBeforeEffect, type NativeFailure } from "./transport";
import { REGION_NAMES, REGIONS, type NativeFetch } from "./regions";

/** Setup default image, sent explicitly: Archil's REST and SDK documentation disagree on theirs. */
export const DEFAULT_IMAGE = "node:24-bookworm";

/** Per-stream bytes an exec keeps; the rest is drained and reported as truncated. */
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Finite exec stdin, sent in 1 MiB frames over the process connection. */
export const MAX_STDIN_BYTES = 8 * 1024 * 1024;

/** Largest buffered file read or write; streams have no bound. */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** Archil caps every powered-on session at 24 hours. */
export const MAX_SESSION_SECONDS = 86_400;

/** Archil's create bounds: `vcpu_count` 1–32, `mem_size_mib` 256–65536. */
const VCPUS = { min: 1, max: 32, fallback: 1 } as const;

const MEMORY = { min: 256, max: 65_536, fallback: 2048 } as const;

/** The source's state after a capture that restored it. */
const sourceAfter = {
  running: "running",
  suspended: "suspended",
  stopped: "stopped",
} as const satisfies Record<string, SandboxState>;

/** The capture token's source state: running unless the plan named a parked source. */
function capturedState(value: SandboxState | undefined): "running" | "suspended" | "stopped" {
  if (value === "suspended" || value === "stopped") return value;

  return "running";
}

/** Holders that keep a snapshot restorable are named with this prefix. */
const HOLDER_PREFIX = "bs-snap-";

const PreparedImageId = /^[0-9a-f]{64}$/;

/**
 * Egress policies: `blocked` denies all egress and `internet` leaves it open, both custom
 * policies that need a paid plan. `archil-managed` sends no policy and requires Archil's
 * managed allowlist, which is what every Free-plan sandbox gets.
 */
const NETWORK_POLICIES = ["blocked", "internet", "archil-managed"] as const;

const NetworkPolicy = z.enum(NETWORK_POLICIES);

type NetworkPolicy = z.infer<typeof NetworkPolicy>;

/** The request's policy, refused unless Archil can apply it exactly. */
function networkPolicy(value: string | undefined): NetworkPolicy {
  const parsed = NetworkPolicy.safeParse(value);

  if (!parsed.success)
    throw new AdapterError(
      "UNSUPPORTED",
      "Archil network policies are blocked, internet and archil-managed",
    );

  return parsed.data;
}

const OciImage = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[^\s\0]+$/, "Use an OCI image reference");

const Lifetime = z.number().int().min(60).max(MAX_SESSION_SECONDS);

const Configuration = z.strictObject({
  /** Archil region that runs the sandboxes; each has its own control plane. */
  region: z.enum(REGION_NAMES),
  /** Control-plane URL override, for tests and private deployments. */
  baseUrl: z.url().optional(),
  /** `blocked` or `internet` (paid plans), or `archil-managed` (Free plan's allowlist). */
  network: NetworkPolicy.default("blocked"),
  /** Default image: an OCI reference, or a 64-hex image id from `beachside image build`. */
  image: OciImage.optional(),
  /** Exact minimums mapped onto `vcpu_count` and `mem_size_mib`. */
  resources: ResourceMinimums.optional(),
  lifecycle: z
    .strictObject({
      /** Each powered-on session's budget (`max_ttl_seconds`); expiry pauses the sandbox. */
      lifetimeSeconds: Lifetime.default(DEFAULT_LIFETIME_SECONDS),
      /** Pause after this long without a process connection; omitted, idle expiry is off. */
      idleSeconds: Lifetime.optional(),
      suspension: z
        .strictObject({
          /** `filesystem+memory` pauses; `filesystem` stops and later cold-boots. */
          preserve: PreserveSchema.default(Preserve.FILESYSTEM_AND_MEMORY),
        })
        .optional(),
    })
    .default({ lifetimeSeconds: DEFAULT_LIFETIME_SECONDS }),
  preview: z
    .strictObject({
      /** `protected` mints a port token sent as a header; `public` exposes the port. */
      access: z.enum(["protected", "public"]).default("protected"),
    })
    .default({ access: "protected" }),
  snapshots: z
    .strictObject({
      /** `filesystem+memory` (default) restores running processes; `filesystem` cold-boots. */
      preserve: PreserveSchema.optional(),
    })
    .optional(),
});

const Credentials = z.strictObject({
  apiKey: z.string().min(1),
  /** Registry login for private images in `beachside image build`; never stored. */
  registry: z.strictObject({ username: z.string().min(1), password: z.string().min(1) }).optional(),
});

const Id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

const Name = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);

/** The control plane's sandbox record; unknown fields pass through to the SDK. */
const Wire = z.looseObject({
  sandbox_id: Id,
  name: z.string().max(63),
  status: z.string().min(1).max(32),
  vcpu_count: z.number(),
  mem_size_mib: z.number(),
  max_ttl_seconds: z.number().optional(),
  idle_ttl_seconds: z.number().optional(),
  base_image: z.string().max(1024).optional(),
  mounts: z
    .array(
      z.looseObject({
        disk_id: z.string().max(128),
        path: z.string().max(4096).optional(),
        subdirectory: z.string().max(4096).optional(),
        read_only: z.boolean().optional(),
      }),
    )
    .max(64)
    .optional(),
  created_at: z.string().max(64),
  exit_reason: z.string().max(1024).optional(),
  checkpoint: z.string().max(256).optional(),
});

type Wire = z.infer<typeof Wire>;

type NativeMount = { disk_id: string; path: string; read_only: boolean; subdirectory?: string };

type CreateBody = {
  name: string;
  vcpu_count: number;
  mem_size_mib: number;
  max_ttl_seconds: number;
  idle_ttl_seconds: number;
  image_id?: string;
  base_image?: string;
  env?: Record<string, string>;
  network?: { egress: { default: "deny" } };
  mounts?: NativeMount[];
};

type ForkBody = { name: string; checkpoint: string };

type ImageRequest = { source: string; registry_auth?: { username: string; password: string } };

/** Every request body this adapter sends; each is a plain JSON object. */
type RequestBody = CreateBody | ForkBody | ImageRequest | { timeout: number } | { name: string };

/** A destroy with the disks it leaves mounted, saved for the durability report. */
type DestroyPrepared = DestroyInput & { mounts: { id: string; path: string }[] };

const Network = z.looseObject({
  egress: z.looseObject({ default: z.string().max(16).optional() }).optional(),
  managed: z.boolean().optional(),
});

const Disk = z.looseObject({
  id: Id,
  name: z.string().min(1).max(128),
  status: z.string().max(32),
  allowSandboxMount: z.boolean().optional(),
  sandboxDisk: z.boolean().optional(),
});

type Disk = z.infer<typeof Disk>;

const NativeImage = z.looseObject({
  image_id: z.string().regex(PreparedImageId),
  source: z.string().max(1024),
  status: z.enum(["building", "ready", "failed"]),
  failure_reason: z.string().max(128).optional(),
  created_at: z.string().max(64).optional(),
});

type NativeImage = z.infer<typeof NativeImage>;

const Port = z.looseObject({ hostname: z.string().regex(/^[A-Za-z0-9.-]{1,253}$/) });

const PortToken = Port.extend({ token: z.string().regex(/^[^\r\n]{1,8192}$/) });

/** The name and mounts are saved before dispatch, so a lost create is found by name. */
const CreateToken = z.strictObject({
  name: Name,
  id: Id.optional(),
  network: NetworkPolicy,
  mounts: z.array(MountSpecSchema).max(32).optional(),
});

type CreateToken = z.infer<typeof CreateToken>;

const DestroyToken = z.strictObject({
  id: Id,
  stage: z.enum(["stopping", "deleting"]),
  mounts: z.array(z.strictObject({ id: z.string().max(128), path: z.string().max(4096) })).max(64),
});

const LifecycleToken = z.strictObject({
  id: Id,
  action: z.enum(["pause", "stop", "resume", "start"]),
});

const CaptureToken = z.strictObject({
  name: Name,
  source: Id,
  sourceState: z.enum(["running", "suspended", "stopped"]),
  preserve: PreserveSchema,
  holder: Id.optional(),
});

type CaptureToken = z.infer<typeof CaptureToken>;

const DeleteToken = z.strictObject({ id: Id });

const VolumeToken = z.strictObject({ name: z.string().max(128), id: Id.optional() });

const ImageToken = z.strictObject({ id: z.string().regex(PreparedImageId), source: z.string() });

const memoryProfile: SnapshotProfile = {
  id: "archil-fork-memory",
  preserve: Preserve.FILESYSTEM_AND_MEMORY,
  sourceStates: ["running", "suspended"],
  interruption: "pause",
  sourceAfter: "unchanged",
  connections: "dropped",
  consistency: "crash-consistent",
  restoreExecution: "resume",
  mountHandling: "none",
};

const filesystemProfile: SnapshotProfile = {
  id: "archil-fork-filesystem",
  preserve: Preserve.FILESYSTEM,
  sourceStates: ["running", "suspended", "stopped"],
  interruption: "pause",
  sourceAfter: "unchanged",
  connections: "dropped",
  consistency: "crash-consistent",
  restoreExecution: "fresh",
  mountHandling: "none",
};

/** A restore forks the holder; it keeps the holder's size and network policy. */
const restoreSupport = {
  networkPolicies: [...NETWORK_POLICIES],
  resources: false,
  mounts: false,
  independentLifecycle: false,
};

function digest(prefix: string, value: string): string {
  return `${prefix}${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function attemptName(submissionId: string): string {
  return digest("bs-", submissionId);
}

function holderName(submissionId: string): string {
  return digest(HOLDER_PREFIX, submissionId);
}

function state(native: string): SandboxState {
  switch (native) {
    case "pending":
      return "creating";
    case "running":
      return "running";
    case "paused":
      return "suspended";
    case "stopped":
    case "exited":
    case "failed":
      return "stopped";
    case "deleting":
      return "destroying";
    case "deleted":
      return "destroyed";
    default:
      return "unknown";
  }
}

const stoppedStates = new Set(["stopped", "exited", "failed"]);

function readContext(signal: AbortSignal, seconds = 30): ReadContext {
  return { signal, deadline: Date.now() + seconds * 1000 };
}

function callSignal(ctx: ReadContext): AbortSignal {
  return AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.max(1, ctx.deadline - Date.now()))]);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);

      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);

    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };

    signal.addEventListener("abort", stop, { once: true });
  });
}

/** The fields the SDK `Sandbox` needs to open process connections; nothing else is read. */
function sdkWire(id: string): ConstructorParameters<typeof NativeSandbox>[0] {
  const epoch = new Date(0).toISOString();

  return {
    sandbox_id: id,
    name: "",
    status: "running",
    vcpu_count: 1,
    mem_size_mib: MEMORY.fallback,
    max_ttl_seconds: 0,
    idle_ttl_seconds: 0,
    max_concurrent_execs: 0,
    base_image: "",
    enable_service_ingress: false,
    created_at: epoch,
    last_active_at: epoch,
  };
}

/** Whether a process start failed before the start message left this client. */
function startNeverSent(error: Error): boolean {
  return (
    error.message.startsWith("Process connection failed after") || error.name === "ArchilApiError"
  );
}

export type ArchilAdapterOptions = {
  /** Control-plane fetch; tests inject a deterministic fixture. */
  fetch?: NativeFetch;
  /** Poll interval while waiting for boot, pause, stop, fork or deletion. */
  pollIntervalMs?: number;
  /** Longest a mutation waits in-call before returning a pending result. */
  settleSeconds?: number;
};

/** Constructing a definition performs no provider IO. */
export function createArchilAdapter(options: ArchilAdapterOptions = {}) {
  const pollMs = options.pollIntervalMs ?? 1000;
  const settleSeconds = options.settleSeconds ?? 180;

  return defineAdapter({
    name: "archil",
    displayName: "Archil",
    config: Configuration,
    credentials: Credentials,
    async connect({ config, credentials, host }) {
      // Choices Archil cannot honor reject before any provider IO.
      const vcpus = Math.ceil(config.resources?.vcpus ?? VCPUS.fallback);
      const memoryMiB = Math.max(MEMORY.min, config.resources?.memoryMiB ?? MEMORY.fallback);

      if (vcpus > VCPUS.max || memoryMiB > MEMORY.max)
        throw new AdapterError(
          "UNSUPPORTED",
          `Archil sandboxes have at most ${VCPUS.max} vCPU and ${MEMORY.max} MiB`,
        );

      const image = config.image ?? DEFAULT_IMAGE;

      const defaultImage = PreparedImageId.test(image)
        ? ({ kind: "prepared", value: image } as const)
        : ({ kind: "oci", value: image } as const);

      const suspension = config.lifecycle.suspension?.preserve ?? Preserve.FILESYSTEM_AND_MEMORY;
      const snapshotPreserve = config.snapshots?.preserve ?? Preserve.FILESYSTEM_AND_MEMORY;

      const snapshotProfile =
        snapshotPreserve === Preserve.FILESYSTEM ? filesystemProfile : memoryProfile;

      const snapshotSupport = {
        status: "supported" as const,
        value: {
          // One profile per connection: a request for the other preserve never switches modes.
          profiles: [snapshotProfile],
          defaultProfileId: snapshotProfile.id,
        },
      };

      const baseUrl = config.baseUrl ?? REGIONS[config.region];

      const control = createControl({
        apiKey: credentials.apiKey,
        baseUrl,
        fetch: options.fetch ?? globalThis.fetch,
      });

      const secrets = [
        ...control.secrets,
        ...(credentials.registry ? [credentials.registry.password] : []),
      ];

      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native throws are normalized at this boundary.
      const failure = (error: unknown): NativeFailure => nativeFailure(error, secrets);

      const read = async (
        method: string,
        path: string,
        ctx: ReadContext,
        init: Parameters<typeof control.call>[2] = {},
      ) => {
        try {
          return await control.call(method, path, init, callSignal(ctx));
        } catch (error) {
          throw failure(error).error;
        }
      };

      /** The record at `path`, or null on 404. */
      const maybe = async (path: string, ctx: ReadContext) => {
        try {
          return await control.call("GET", path, {}, callSignal(ctx));
        } catch (error) {
          const native = failure(error);

          if (native.status === 404) return null;
          throw native.error;
        }
      };

      const sandboxPath = (id: string, suffix = "") =>
        `/api/sandboxes/${encodeURIComponent(Id.parse(id))}${suffix}`;

      // Archil exposes no account id to an API key; one authenticated read proves the key.
      await read("GET", "/api/sandboxes", readContext(host.signal));

      if (defaultImage.kind === "prepared") {
        const found = await maybe(`/api/images/${defaultImage.value}`, readContext(host.signal));

        if (!found)
          throw new AdapterError("NOT_FOUND", "Archil image is unavailable to this API key");
      }

      const scope = {
        authority: {
          kind: "api-key",
          id: createHash("sha256")
            .update("beachside:archil:api-key-scope:v1\0")
            .update(credentials.apiKey)
            .digest("hex"),
        },
        partition: { region: config.region, endpoint: control.baseUrl },
      };

      const checkedRef = (ref: SandboxReference) => {
        assertResourceScope(ref, { provider: "archil", scope });

        if (
          ref.kind !== "sandbox" ||
          ref.generation !== undefined ||
          !Id.safeParse(ref.nativeId).success
        )
          throw new AdapterError("CONFLICT", "Invalid Archil sandbox identity");
      };

      const find = async (id: string, ctx: ReadContext): Promise<Wire | null> => {
        const found = await maybe(sandboxPath(id), ctx);

        if (found === null) return null;
        const wire = Wire.safeParse(found);

        if (!wire.success)
          throw new AdapterError("UNAVAILABLE", "Archil sandbox record is invalid");

        if (wire.data.sandbox_id !== id)
          throw new AdapterError("CONFLICT", "Archil returned a different sandbox identity");

        return wire.data.status === "deleted" ? null : wire.data;
      };

      /** Every sandbox in the region, oldest first; Archil has no filter or pagination. */
      const listAll = async (ctx: ReadContext): Promise<Wire[]> => {
        const data = z
          .looseObject({ sandboxes: z.array(z.unknown()).max(100_000).optional() })
          .safeParse(await read("GET", "/api/sandboxes", ctx));

        if (!data.success) throw new AdapterError("UNAVAILABLE", "Archil sandbox list is invalid");

        return (data.data.sandboxes ?? []).flatMap((item) => {
          const wire = Wire.safeParse(item);

          return wire.success && wire.data.status !== "deleted" ? [wire.data] : [];
        });
      };

      const findByName = async (name: string, ctx: ReadContext): Promise<Wire | null> => {
        const matches = (await listAll(ctx)).filter((wire) => wire.name === name);

        if (matches.length > 1)
          throw new AdapterError("CONFLICT", "Archil returned several sandboxes for one name");

        return matches[0] ?? null;
      };

      const requireWire = async (box: Sandbox, ctx: ReadContext) => {
        if (box.reference) checkedRef(box.reference);
        const wire = await find(box.id, ctx);

        if (!wire)
          throw new AdapterError(
            "NOT_FOUND",
            "Archil sandbox is unavailable in the verified account",
          );

        return wire;
      };

      const requireRunning = async (box: Sandbox, ctx: ReadContext) => {
        const wire = await requireWire(box, ctx);

        if (wire.status !== "running")
          throw new AdapterError(
            "CONFLICT",
            `Archil sandbox is ${wire.status}; commands and files need a running sandbox`,
          );

        return wire;
      };

      const network = async (id: string, ctx: ReadContext) => {
        const parsed = Network.safeParse(await read("GET", sandboxPath(id, "/network"), ctx));

        if (!parsed.success)
          throw new AdapterError("UNAVAILABLE", "Archil network policy is invalid");

        return parsed.data;
      };

      /** The portable name of a sandbox's egress policy, or null for any other policy. */
      const policyOf = (value: z.infer<typeof Network>) =>
        value.managed
          ? "archil-managed"
          : value.egress?.default === "deny"
            ? "blocked"
            : value.egress?.default === undefined || value.egress.default === "allow"
              ? "internet"
              : null;

      const observation = (wire: Wire, ref: SandboxReference | null): SandboxInfo => ({
        reference: ref,
        state: state(wire.status),
        nativeState: wire.status,
        observedAt: new Date().toISOString(),
        ...unknownSandboxFacts(),
        // A running session's deadline moves with renewals and Archil does not report it.
        expires:
          wire.status === "running" || wire.status === "pending"
            ? {
                status: "unknown",
                reason: `Archil reports a ${wire.max_ttl_seconds ?? "default"}s session budget, not the session deadline`,
              }
            : { status: "none" },
        idleStop: {
          status: "known",
          value:
            wire.idle_ttl_seconds && wire.idle_ttl_seconds > 0
              ? { seconds: wire.idle_ttl_seconds, action: "suspend" }
              : null,
        },
        resources:
          wire.vcpu_count > 0 && Number.isSafeInteger(wire.mem_size_mib) && wire.mem_size_mib > 0
            ? { status: "known", value: { vcpus: wire.vcpu_count, memoryMiB: wire.mem_size_mib } }
            : { status: "unknown", reason: "Archil did not report the sandbox size" },
      });

      /** Poll a read until it settles, the local wait ends, or the caller aborts. */
      const settle = async <T>(
        signal: AbortSignal,
        check: (ctx: ReadContext) => Promise<T | undefined>,
        seconds = settleSeconds,
      ): Promise<T | undefined> => {
        const until = Date.now() + seconds * 1000;

        for (;;) {
          const value = await check(readContext(signal));

          if (value !== undefined || Date.now() + pollMs > until) return value;
          await delay(pollMs, signal);
        }
      };

      /** Wait for a sandbox to leave transitional states; returns the settled record or null. */
      const settled = (id: string, signal: AbortSignal, done: (wire: Wire) => boolean) =>
        settle(signal, async (ctx) => {
          const wire = await find(id, ctx);

          if (!wire) return { wire: null };

          return done(wire) ? { wire } : undefined;
        });

      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native throws are normalized at this boundary.
      const rejection = (ctx: AttemptContext, error: unknown, reason: string) => {
        const native = failure(error);

        return refusedBeforeEffect(native)
          ? ctx.reject(native.error.code, native.error.message)
          : ctx.unknown(`${reason}; do not replay`);
      };

      /** One mutation request; throws the raw failure so callers can classify it. */
      const send = (
        method: string,
        path: string,
        body: RequestBody | undefined,
        signal: AbortSignal,
        seconds = 60,
      ) =>
        control.call(
          method,
          path,
          body === undefined ? {} : { body },
          callSignal(readContext(signal, seconds)),
        );

      /** Sandboxes this client is pausing or snapshotting; process observers wait them out. */
      const held = new Set<string>();

      /** An SDK `Sandbox` on the adapter's single-attempt client, for process connections. */
      const native = (id: string, signal: AbortSignal) =>
        new NativeSandbox(sdkWire(id), control.sdkClient(signal));

      /** Run one finite guest command; stdout as text when it exits 0, an error otherwise. */
      const finite = async (
        id: string,
        command: string,
        ctx: ReadContext,
        stdin?: AsyncIterable<Uint8Array>,
      ): Promise<{ code: number | null; stdout: string }> => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        let handle: SandboxProcess;

        try {
          handle = await native(id, ctx.signal).run(command, {
            collectOutput: false,
            timeoutSeconds: Math.max(1, Math.ceil((ctx.deadline - Date.now()) / 1000)),
            onOutput: (output: SandboxProcessOutput) => {
              if (output.stream !== "stdout") return;
              size += output.data.byteLength;

              if (size <= 4 * 1024 * 1024) chunks.push(output.data.slice());
            },
          });
        } catch (error) {
          throw error instanceof AdapterError
            ? error
            : new AdapterError("UNAVAILABLE", "Archil guest command could not start");
        }

        const abort = () => void handle.kill().catch(() => undefined);
        ctx.signal.addEventListener("abort", abort, { once: true });

        try {
          if (stdin) for await (const chunk of stdin) await sendInput(handle, chunk, ctx.signal);
          await handle.closeStdin();
          const result = await handle.wait();

          if (size > 4 * 1024 * 1024)
            throw new AdapterError("CAPACITY", "Archil guest command output exceeds its bound");

          return { code: exitCode(result), stdout: Buffer.concat(chunks).toString("utf8") };
        } finally {
          ctx.signal.removeEventListener("abort", abort);
          await handle.disconnect().catch(() => undefined);
        }
      };

      const guest =
        (id: string): GuestRunner =>
        async (command, ctx, stdin) => {
          const result = await finite(id, command, ctx, stdin);

          if (result.code !== 0)
            throw new AdapterError(
              result.code === null ? "TIMEOUT" : "UNAVAILABLE",
              "Archil guest control command failed",
            );

          return result.stdout;
        };

      const download =
        (id: string): Downloader =>
        async (path, write, signal) => {
          await native(id, signal).files.downloadFile(path, async (chunk) => {
            signal.throwIfAborted();
            await write(chunk.slice());
            signal.throwIfAborted();
          });
        };

      const files = (id: string) => filesystem(guest(id), download(id));

      /** A failed download is classified by the helper: absent paths are NOT_FOUND. */
      const downloadFailure = async (id: string, path: string, ctx: ReadContext) => {
        const exists = await files(id)
          .helper("exists", path, "", false, ctx)
          .then((value) => Exists.parse(value).exists)
          .catch(() => true);

        return exists
          ? new AdapterError("UNAVAILABLE", "Archil file download failed")
          : new AdapterError("NOT_FOUND", "Archil file does not exist");
      };

      const processOptions = (id: string): ProcessOptions => ({
        sandbox: () => native(id, host.signal),
        held: () => held.has(id),
        signalCommand: async (script, ctx) => (await finite(id, script, ctx)).code,
      });

      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Helper throws are normalized at this boundary.
      const fileRejection = (ctx: AttemptContext, error: unknown) => {
        if (error instanceof AdapterFilesystemError && error.details.effect !== "none")
          return ctx.unknown(
            "Archil filesystem operation may have changed the requested path; do not replay",
          );

        if (error instanceof AdapterError) return ctx.reject(error.code, error.message);

        return ctx.unknown("Archil filesystem response was not confirmed; do not replay");
      };

      const disks = async (ctx: ReadContext, query: Record<string, string | number> = {}) => {
        const listed = z
          .array(z.unknown())
          .max(10_000)
          .safeParse(await read("GET", "/api/disks", ctx, { query }));

        if (!listed.success) throw new AdapterError("UNAVAILABLE", "Archil disk list is invalid");

        return listed.data.flatMap((item) => {
          const disk = Disk.safeParse(item);

          return disk.success && !disk.data.sandboxDisk ? [disk.data] : [];
        });
      };

      const findDisk = async (id: string, ctx: ReadContext): Promise<Disk | null> => {
        const found = await maybe(`/api/disks/${encodeURIComponent(Id.parse(id))}`, ctx);

        if (found === null) return null;
        const disk = Disk.safeParse(found);

        if (!disk.success || disk.data.id !== id)
          throw new AdapterError("UNAVAILABLE", "Archil disk record is invalid");

        return disk.data.status === "deleted" ? null : disk.data;
      };

      const volumeRef = (
        id: string,
        ownership: ResourceReference["ownership"] = "unknown",
      ): ResourceReference<"volume"> => ({
        version: 1,
        kind: "volume",
        provider: "archil",
        scope,
        nativeId: id,
        ownership,
      });

      const checkedVolume = (ref: ResourceReference) => {
        assertResourceScope(ref, { provider: "archil", scope });

        if (
          ref.kind !== "volume" ||
          ref.generation !== undefined ||
          !Id.safeParse(ref.nativeId).success
        )
          throw new AdapterError("CONFLICT", "Invalid Archil disk identity");

        return ref.nativeId;
      };

      const volumeInfo = (disk: Disk, ref: ResourceReference = volumeRef(disk.id)): VolumeInfo => ({
        reference: ref,
        name: disk.name,
        state:
          disk.status === "available"
            ? "ready"
            : disk.status === "creating"
              ? "creating"
              : disk.status === "deleting"
                ? "deleting"
                : "unknown",
        filesystem: "object-backed",
        visibility: "unknown",
        durability: "unknown",
        locking: "unknown",
        rename: "unknown",
        conflicts: "unknown",
      });

      const mountCheck = async (mounts: MountSpec[] | undefined, ctx: ReadContext) => {
        for (const mount of mounts ?? []) {
          const disk = await findDisk(checkedVolume(mount.volume), ctx);

          if (!disk) throw new AdapterError("NOT_FOUND", "Archil disk is unavailable");

          if (disk.status !== "available" || disk.allowSandboxMount === false)
            throw new AdapterError(
              "CONFLICT",
              "Archil disk must be available and allow sandbox mounts",
            );
        }
      };

      const nativeMounts = (mounts: MountSpec[]) =>
        mounts.map((mount) => {
          const native: NativeMount = {
            disk_id: mount.volume.nativeId,
            path: mount.path,
            read_only: mount.access === "read-only",
          };

          if (mount.subpath !== undefined) native.subdirectory = mount.subpath;

          return native;
        });

      type Identity = { operationId: string; submissionId: string };

      const partialCreate = (id: string, identity: Identity): OperationOutcome => ({
        kind: "create",
        status: "partial",
        sandbox: sandboxReference("archil", scope, id, {
          operation: identity.operationId,
          submission: identity.submissionId,
        }),
        setup: { expiry: "acknowledged", readiness: "unconfirmed" },
      });

      const partialRestore = (id: string, identity: Identity): OperationOutcome => ({
        kind: "snapshot_restore",
        status: "unknown",
        sandbox: sandboxReference("archil", scope, id, {
          operation: identity.operationId,
          submission: identity.submissionId,
        }),
        mounts: [],
      });

      type Partial = (id: string, identity: Identity) => OperationOutcome;

      /** A running sandbox with the requested egress completes the create. */
      const launched = async (
        wire: Wire | null,
        token: CreateToken,
        identity: Identity,
        ctx: ReadContext & Pick<ObserveContext<CreateToken>, "pending" | "unknown">,
        partial: Partial,
      ) => {
        if (!wire)
          return ctx.unknown(
            token.id
              ? "Archil sandbox disappeared before it was running"
              : "Archil create response was lost and no sandbox carries this attempt's name; inspect inventory without replay",
          );

        if (wire.name !== token.name || (token.id !== undefined && wire.sandbox_id !== token.id))
          return ctx.unknown("Archil sandbox identity differs from the attempt; do not replay");

        if (wire.status === "pending")
          return ctx.pending({ ...token, id: wire.sandbox_id }, { pollAfterMs: pollMs });

        if (wire.status !== "running")
          return ctx.unknown(
            `Archil sandbox is ${wire.status}${wire.exit_reason ? ` (${wire.exit_reason})` : ""} before it was running; inspect or destroy it`,
            partial(wire.sandbox_id, identity),
          );

        // A sandbox created without a policy gets open egress on paid plans and Archil's
        // managed allowlist on Free; only the one requested counts as ready.
        if (token.network !== "blocked") {
          const policy = policyOf(await network(wire.sandbox_id, ctx));

          if (policy !== token.network)
            return ctx.unknown(
              token.network === "internet"
                ? "Archil applied its managed Free-plan egress allowlist, not internet access; destroy this sandbox, use network archil-managed, or use a paid plan"
                : "Archil left egress open instead of its managed allowlist, which only Free plans apply; destroy this sandbox and use blocked or internet",
              partial(wire.sandbox_id, identity),
            );
        }

        return {
          id: wire.sandbox_id,
          reference: sandboxReference("archil", scope, wire.sandbox_id, {
            operation: identity.operationId,
            submission: identity.submissionId,
          }),
          state: "running" as const,
          mounts: token.mounts,
        };
      };

      /**
       * Exactly one create or fork request named by the attempt; a lost response is found again
       * by that name, never resent.
       */
      const launch = async (
        request: { path: string; body: CreateBody | ForkBody },
        token: CreateToken,
        ctx: AttemptContext<CreateToken>,
        partial: Partial,
      ) => {
        await ctx.checkpoint(token);
        let created: Wire;

        try {
          const wire = Wire.safeParse(
            await send("POST", request.path, request.body, ctx.signal, 120),
          );

          if (!wire.success)
            return ctx.unknown(
              "Archil create acknowledgement is invalid; observe finds it by name",
            );
          created = wire.data;
        } catch (error) {
          const native = failure(error);

          // The name is this attempt's own, so a conflict means an earlier send landed.
          if (native.code === "sandbox_name_conflict")
            return ctx.pending(token, { pollAfterMs: pollMs });

          // A lost response stays unknown here; observation finds the sandbox by its name.
          return rejection(
            ctx,
            error,
            "Archil create response was not confirmed; observe finds the sandbox by its name",
          );
        }

        if (created.name !== token.name)
          return ctx.unknown("Archil create acknowledgement does not match the attempt");
        const tracked = { ...token, id: created.sandbox_id };

        try {
          await ctx.checkpoint(tracked);
        } catch (error) {
          if (error instanceof AdapterCheckpointError)
            error.outcome = partial(created.sandbox_id, ctx);
          throw error;
        }

        try {
          const result = await settled(
            created.sandbox_id,
            ctx.signal,
            (wire) => wire.status !== "pending",
          );

          if (result)
            return await launched(
              result.wire,
              tracked,
              ctx,
              { ...readContext(ctx.signal), pending: ctx.pending, unknown: ctx.unknown },
              partial,
            );
        } catch {
          /* A failed readiness read is not evidence; continue through observation. */
        }

        return ctx.pending(tracked, { pollAfterMs: pollMs });
      };

      const observeLaunch = async (
        token: CreateToken,
        attempt: Identity,
        ctx: ObserveContext<CreateToken>,
        partial: Partial,
      ) => {
        const wire = token.id ? await find(token.id, ctx) : await findByName(token.name, ctx);

        return launched(wire, token, attempt, ctx, partial);
      };

      const listedReference = (wire: Wire): SandboxReference => ({
        version: 1,
        kind: "sandbox",
        provider: "archil",
        scope,
        nativeId: wire.sandbox_id,
        ownership: "unknown",
      });

      /** Sandboxes, without snapshot holders, in pages over Archil's single list. */
      const page = async (input: { cursor?: string; limit: number }, ctx: ReadContext) => {
        const offset = input.cursor === undefined ? 0 : Number(input.cursor);

        if (!Number.isSafeInteger(offset) || offset < 0)
          throw new AdapterError("INVALID_ARGUMENT", "Invalid Archil sandbox cursor");

        const all = (await listAll(ctx)).filter((wire) => !wire.name.startsWith(HOLDER_PREFIX));
        const items = all.slice(offset, offset + Math.min(100, input.limit));
        const next = offset + items.length;

        return { items, nextCursor: next < all.length ? String(next) : undefined };
      };

      /** Run one command once, keeping each stream's first `maxOutputBytes`. */
      const runCommand = async (
        input: ExecInput,
        ctx: AttemptContext,
      ): Promise<
        ExecValue | ReturnType<AttemptContext["unknown"]> | ReturnType<AttemptContext["reject"]>
      > => {
        const sandbox = native(input.sandbox.id, ctx.signal);
        const kept = { stdout: new Array<Uint8Array>(), stderr: new Array<Uint8Array>() };
        const sizes = { stdout: 0, stderr: 0 };
        let truncated = false;
        let cursor = 0;

        const onOutput = (output: SandboxProcessOutput) => {
          const end = output.offset + output.data.byteLength;

          if (end <= cursor) return;
          const bytes = output.data.subarray(Math.max(0, cursor - output.offset));
          cursor = end;
          const room = input.maxOutputBytes - sizes[output.stream];

          // Output past the bound is drained, not kept, so the exit code still arrives.
          if (bytes.byteLength > room) truncated = true;

          if (room > 0) kept[output.stream].push(bytes.slice(0, room));
          sizes[output.stream] += Math.min(room, bytes.byteLength);
        };

        let handle: SandboxProcess;

        try {
          handle = await sandbox.run(commandLine(input), {
            collectOutput: false,
            timeoutSeconds: Math.max(1, Math.ceil(input.deadlineSeconds)),
            onOutput,
          });
        } catch (error) {
          if (error instanceof Error && startNeverSent(error)) {
            const native = failure(error);

            return ctx.reject(
              native.error.code === "INTERNAL" ? "UNAVAILABLE" : native.error.code,
              "Archil process connection could not be opened",
            );
          }

          return ctx.unknown("Archil command start was not confirmed; do not replay");
        }

        try {
          if (input.stdin?.byteLength) await sendInput(handle, input.stdin, ctx.signal);
          await handle.closeStdin();
        } catch {
          /* A dropped connection is reattached below; the guest may still read its input. */
        }

        let result;

        for (let attempt = 0; ; attempt++) {
          try {
            result = await handle.wait();
            break;
          } catch {
            if (attempt >= 3 || ctx.signal.aborted)
              return ctx.unknown(
                "Archil command connection dropped before its exit was confirmed; do not replay",
              );
          }

          await delay(250 * (attempt + 1), ctx.signal).catch(() => undefined);

          try {
            // Reattaching at the cursor reads the rest of the output; it never starts anything.
            handle = await sandbox.attach(handle.id, {
              offset: cursor,
              collectOutput: false,
              onOutput,
            });
          } catch {
            /* Retried until the attempt bound. */
          }
        }

        await handle.disconnect().catch(() => undefined);

        return {
          exitCode: exitCode(result),
          stdout: new Uint8Array(Buffer.concat(kept.stdout)),
          stderr: new Uint8Array(Buffer.concat(kept.stderr)),
          truncated,
        };
      };

      /** Start a process; terminals keep Archil's PTY, others record a PID file for signals. */
      const startProcess = async (
        input: Parameters<NonNullable<AdapterSession["processes"]>["start"]>[0],
        ctx: ProcessStartContext,
      ) => {
        const format = input.output?.format ?? "text";

        if (format === "bytes" && !ctx.onOutputBytes)
          throw new AdapterError(
            "UNSUPPORTED",
            "Archil binary output requires a byte consumer hook",
          );

        if (input.terminal && input.stdin === "closed")
          throw new AdapterError("UNSUPPORTED", "Archil terminals always take input");

        const line = commandLine({
          ...input,
          env: input.terminal ? { TERM: "xterm-256color", ...input.env } : input.env,
        });

        await requireRunning(input.sandbox, ctx);
        const id = input.sandbox.id;
        const launch = input.terminal ? { script: line, pidFile: undefined } : launcher(line);
        const sandbox = native(id, host.signal);
        const relay = frameRelay();
        let handle: SandboxProcess;

        try {
          handle = await sandbox.run(launch.script, {
            collectOutput: false,
            onOutput: relay.push,
            terminal: input.terminal
              ? { cols: input.terminal.columns, rows: input.terminal.rows }
              : undefined,
          });
        } catch (error) {
          throw error instanceof Error && startNeverSent(error)
            ? new AdapterError("UNAVAILABLE", "Archil process connection could not be opened")
            : new AdapterError(
                "UNAVAILABLE",
                "Archil process start was not confirmed; do not replay",
              );
        }

        const stdin = input.terminal ? "pipe" : (input.stdin ?? "closed");

        if (stdin === "closed") await handle.closeStdin().catch(() => undefined);

        const reference: Omit<ProcessReference, "offset"> = {
          version: 1,
          kind: "archil-process",
          sandbox: id,
          process: handle.id,
          terminal: input.terminal !== undefined,
          stdin,
        };

        if (launch.pidFile) reference.pidFile = launch.pidFile;

        const observed = observeProcess(
          processOptions(id),
          handle,
          reference,
          { format, capture: input.capture, offset: 0 },
          ctx,
          (offset, onOutput) =>
            sandbox.attach(handle.id, { offset, collectOutput: false, onOutput }),
        );

        relay.attach(observed.onOutput);

        return observed.process;
      };

      const snapshotRef = (
        id: string,
        ownership: ResourceReference["ownership"] = "unknown",
      ): ResourceReference<"snapshot"> => ({
        version: 1,
        kind: "snapshot",
        provider: "archil",
        scope,
        nativeId: id,
        ownership,
      });

      const checkedSnapshot = (ref: ResourceReference) => {
        assertResourceScope(ref, { provider: "archil", scope });

        if (
          ref.kind !== "snapshot" ||
          ref.generation !== undefined ||
          !Id.safeParse(ref.nativeId).success
        )
          throw new AdapterError("CONFLICT", "Invalid Archil snapshot identity");

        return ref.nativeId;
      };

      /** A snapshot is a holder sandbox this adapter forked and parked. */
      const findHolder = async (id: string, ctx: ReadContext) => {
        const wire = await find(id, ctx);

        return wire && wire.name.startsWith(HOLDER_PREFIX) ? wire : null;
      };

      const requireHolder = async (ref: ResourceReference, ctx: ReadContext) => {
        const holder = await findHolder(checkedSnapshot(ref), ctx);

        if (!holder) throw new AdapterError("NOT_FOUND", "Archil snapshot is unavailable");

        return holder;
      };

      const snapshotInfo = (
        holder: Wire,
        ref: ResourceReference,
        source: { id: string; ref?: SandboxReference } | null = null,
      ): SnapshotInfo => {
        const preserve =
          holder.status === "paused"
            ? Preserve.FILESYSTEM_AND_MEMORY
            : stoppedStates.has(holder.status)
              ? Preserve.FILESYSTEM
              : null;

        return {
          reference: ref,
          preserve,
          restoreExecution:
            preserve === null ? null : preserve === Preserve.FILESYSTEM ? "fresh" : "resume",
          consistency: "crash-consistent",
          source: source ? { id: source.id, class: "archil-sandbox" } : null,
          state:
            preserve === null
              ? state(holder.status) === "destroying"
                ? "deleting"
                : "creating"
              : "ready",
          createdAt: listedTime(holder.created_at),
          expiration: "unknown",
          excludedPaths: null,
          mounts: [],
          mountHandling: "none",
          restore: restoreSupport,
          // The holder is a fork of its source: Archil refuses to delete the source while it exists.
          dependencies: source?.ref ? [source.ref] : [],
          nativeDependencies: source ? [{ kind: "archil-sandbox", id: source.id }] : null,
        };
      };

      /** Pause or stop a sandbox and wait for it; returns the settled record or a reason. */
      const park = async (
        id: string,
        action: "pause" | "stop",
        signal: AbortSignal,
      ): Promise<{ wire: Wire } | { reason: string }> => {
        try {
          await send("POST", sandboxPath(id, `/${action}`), undefined, signal, 120);
        } catch (error) {
          return { reason: failure(error).error.message };
        }

        const target =
          action === "pause"
            ? (wire: Wire) => wire.status === "paused"
            : (wire: Wire) => stoppedStates.has(wire.status);

        const result = await settled(
          id,
          signal,
          (wire) =>
            target(wire) || !["running", "pausing", "stopping", "pending"].includes(wire.status),
        ).catch(() => undefined);

        if (!result?.wire) return { reason: `Archil sandbox did not ${action} in time` };

        return target(result.wire)
          ? { wire: result.wire }
          : { reason: `Archil sandbox is ${result.wire.status} after ${action}` };
      };

      /** Resume (paused) or start (stopped) and wait for running; true when confirmed. */
      const wake = async (id: string, from: "paused" | "stopped", signal: AbortSignal) => {
        try {
          await send(
            "POST",
            sandboxPath(id, from === "paused" ? "/resume" : "/start"),
            undefined,
            signal,
            120,
          );
        } catch {
          return false;
        }

        const result = await settled(
          id,
          signal,
          (wire) =>
            wire.status !== "pending" &&
            wire.status !== "paused" &&
            !stoppedStates.has(wire.status),
        ).catch(() => undefined);

        return result?.wire?.status === "running";
      };

      /**
       * Capture: pause a running source, fork its checkpoint into an adapter-named holder, park
       * the holder (paused keeps memory, stopped keeps only the disk), then resume the source.
       */
      const capture = async (
        token: CaptureToken,
        source: SandboxReference | undefined,
        ctx: AttemptContext<CaptureToken>,
      ) => {
        await ctx.checkpoint(token);
        held.add(token.source);

        try {
          let checkpoint: string | undefined;

          if (token.sourceState === "running") {
            const paused = await park(token.source, "pause", ctx.signal);

            if ("reason" in paused) {
              const now = await find(token.source, readContext(ctx.signal)).catch(() => null);

              return now?.status === "running"
                ? ctx.reject("UNAVAILABLE", paused.reason)
                : ctx.unknown(`${paused.reason}; the source may be paused, inspect it`);
            }

            checkpoint = paused.wire.checkpoint;
          } else checkpoint = (await find(token.source, readContext(ctx.signal)))?.checkpoint;

          const restore = async () =>
            token.sourceState === "running" ? wake(token.source, "paused", ctx.signal) : true;

          if (!checkpoint) {
            const resumed = await restore();

            return resumed
              ? ctx.reject("UNAVAILABLE", "Archil reported no checkpoint for the source")
              : ctx.unknown(
                  "Archil reported no checkpoint and the source did not resume; inspect it",
                );
          }

          let holder: Wire;

          try {
            const wire = Wire.safeParse(
              await send(
                "POST",
                sandboxPath(token.source, "/fork"),
                { name: token.name, checkpoint },
                ctx.signal,
                120,
              ),
            );

            if (!wire.success || wire.data.name !== token.name) {
              await restore();

              return ctx.unknown(
                "Archil fork acknowledgement is invalid; list snapshots without replay",
              );
            }

            holder = wire.data;
          } catch (error) {
            const resumed = await restore();
            const native = failure(error);

            if (refusedBeforeEffect(native) && resumed)
              return ctx.reject(native.error.code, native.error.message);

            return ctx.unknown(
              resumed
                ? "Archil fork response was not confirmed; list snapshots without replay"
                : "Archil fork failed and the source did not resume; inspect it",
            );
          }

          const tracked = { ...token, holder: holder.sandbox_id };
          await ctx.checkpoint(tracked);

          // The fork resumes the checkpoint; it is parked as soon as it runs.
          const running = await settled(
            holder.sandbox_id,
            ctx.signal,
            (wire) => wire.status !== "pending",
          ).catch(() => undefined);

          const parkedHolder =
            running?.wire?.status === "running"
              ? await park(
                  holder.sandbox_id,
                  token.preserve === Preserve.FILESYSTEM ? "stop" : "pause",
                  ctx.signal,
                )
              : {
                  reason: `Archil snapshot holder is ${running?.wire?.status ?? "unavailable"} after fork`,
                };

          const resumed = await restore();

          if ("reason" in parkedHolder)
            return ctx.unknown(`${parkedHolder.reason}; the snapshot may be incomplete, delete it`);

          const ref = snapshotRef(holder.sandbox_id, "verified-created");

          return {
            snapshot: snapshotInfo(parkedHolder.wire, ref, { id: token.source, ref: source }),
            capture: {
              preserve: token.preserve,
              interruption: "pause" as const,
              restoreExecution:
                token.preserve === Preserve.FILESYSTEM ? ("fresh" as const) : ("resume" as const),
            },
            source: {
              state: resumed ? sourceAfter[token.sourceState] : ("suspended" as const),
              connections: "dropped" as const,
              observedAt: new Date().toISOString(),
            },
            retainedResources: [ref],
          };
        } finally {
          held.delete(token.source);
        }
      };

      const imageRef = (id: string, created = false): ResourceReference<"image"> => ({
        version: 1,
        kind: "image",
        provider: "archil",
        scope,
        nativeId: id,
        ownership: created ? "verified-created" : "unknown",
      });

      const imageInfo = (image: NativeImage, ref = imageRef(image.image_id)): ImageInfo => ({
        reference: ref,
        state:
          image.status === "ready" ? "ready" : image.status === "building" ? "creating" : "unknown",
        createdAt: listedTime(image.created_at),
        source: image.source ? { kind: "oci", value: image.source } : null,
        visibility: "private",
        nativeDependencies: null,
      });

      const findImage = async (id: string, ctx: ReadContext) => {
        const found = await maybe(`/api/images/${id}`, ctx);

        if (found === null) return null;
        const image = NativeImage.safeParse(found);

        if (!image.success || image.data.image_id !== id)
          throw new AdapterError("UNAVAILABLE", "Archil image record is invalid");

        return image.data;
      };

      const builtImage = (image: NativeImage) =>
        image.status === "ready"
          ? {
              preparedId: image.image_id,
              // Archil joins a build already running for the same source, so ownership is unproven.
              retainedResources: [
                {
                  kind: "archil-image",
                  id: image.image_id,
                  ownership: "unknown" as const,
                  cleanup: "none_known" as const,
                },
              ],
              image: imageRef(image.image_id),
            }
          : undefined;

      const imageRequest = (source: string) => {
        const body: ImageRequest = { source };

        if (credentials.registry) body.registry_auth = { ...credentials.registry };

        return body;
      };

      const createBody = (input: CreateInput, name: string) => {
        const body: CreateBody = {
          name,
          vcpu_count: vcpus,
          mem_size_mib: memoryMiB,
          max_ttl_seconds: input.lifetimeSeconds ?? config.lifecycle.lifetimeSeconds,
          idle_ttl_seconds: config.lifecycle.idleSeconds ?? 0,
        };

        if (input.image.kind === "prepared") body.image_id = input.image.value;
        else body.base_image = input.image.value;

        if (input.env && Object.keys(input.env).length) body.env = input.env;

        // Omitted, Archil leaves egress open on paid plans; Free plans refuse any policy.
        if (input.networkPolicy === "blocked") body.network = { egress: { default: "deny" } };

        if (input.mounts?.length) body.mounts = nativeMounts(input.mounts);

        return body;
      };

      const suspended = (wire: Wire, reference: SandboxReference) => ({
        reference,
        preserve: wire.status === "paused" ? Preserve.FILESYSTEM_AND_MEMORY : Preserve.FILESYSTEM,
        processes: wire.status === "paused" ? ("preserved" as const) : ("terminated" as const),
        connections: "dropped" as const,
        observation: observation(wire, reference),
      });

      const resumed = (wire: Wire, reference: SandboxReference, action: "resume" | "start") => ({
        reference,
        execution: action === "resume" ? ("resumed" as const) : ("fresh" as const),
        executionIdentity: unknownSandboxFacts().execution,
        connections: "dropped" as const,
        observation: observation(wire, reference),
      });

      const session: AdapterSession<
        CreateInput,
        DestroyPrepared,
        ExecInput,
        FileWriteInput,
        "argv" | "shell",
        CreateToken
      > = {
        scope,
        defaultImage,
        defaultNetworkPolicy: config.network,
        supports: {
          images: ["oci", "prepared"],
          network: [...NETWORK_POLICIES],
          exec: { commands: ["argv", "shell"], maxOutputBytes: MAX_OUTPUT_BYTES },
          fileWrite: { overwrite: true, noClobber: true },
          createEnv: true,
          lifetime: { minSeconds: 60, maxSeconds: MAX_SESSION_SECONDS },
        },
        create: {
          recovery: { version: 1, token: CreateToken },
          async prepare(input, ctx) {
            if (input.image.kind === "prepared" && !PreparedImageId.test(input.image.value))
              throw new AdapterError(
                "INVALID_ARGUMENT",
                "Archil prepared images are 64-hex image ids from beachside image build",
              );

            if (input.image.kind === "oci" && !OciImage.safeParse(input.image.value).success)
              throw new AdapterError("INVALID_ARGUMENT", "Invalid OCI image reference");

            networkPolicy(input.networkPolicy);

            if (input.region !== undefined && input.region !== config.region)
              throw new AdapterError(
                "UNSUPPORTED",
                `This Archil connection creates sandboxes in ${config.region}`,
              );

            if (input.labels && Object.keys(input.labels).length)
              throw new AdapterError("UNSUPPORTED", "Archil sandboxes carry no labels");

            if (input.requirements && input.mounts?.length)
              throw new AdapterError(
                "UNSUPPORTED",
                "Archil cannot snapshot sandboxes with mounted disks",
              );

            checkEnv(input.env);
            await mountCheck(input.mounts, ctx);

            return input;
          },
          submit(input, ctx) {
            const name = attemptName(ctx.submissionId);

            const token: CreateToken = {
              name,
              network: networkPolicy(input.networkPolicy),
            };

            if (input.mounts?.length) token.mounts = input.mounts;

            return launch(
              { path: "/api/sandboxes", body: createBody(input, name) },
              token,
              ctx,
              partialCreate,
            );
          },
          async observe(attempt, ctx) {
            const token = CreateToken.safeParse(attempt.token);

            if (!token.success || token.data.name !== attemptName(attempt.submissionId))
              return ctx.unknown("Archil create identity is unavailable; do not replay");

            return observeLaunch(token.data, attempt, ctx, partialCreate);
          },
        },
        async inspect(box, ctx) {
          if (box.reference) checkedRef(box.reference);
          const wire = await find(box.id, ctx);

          return wire ? { id: wire.sandbox_id, ...observation(wire, box.reference ?? null) } : null;
        },
        async reopen(ref, ctx) {
          checkedRef(ref);

          return observation(await requireWire({ id: ref.nativeId, reference: ref }, ctx), ref);
        },
        async inventory(input, ctx) {
          const listed = await page(input, ctx);

          return {
            items: listed.items.map((wire) => ({
              id: wire.sandbox_id,
              state: wire.status === "running" ? ("running" as const) : ("unknown" as const),
            })),
            nextCursor: listed.nextCursor,
          };
        },
        async sandboxList(input, ctx) {
          const listed = await page(input, ctx);

          return {
            // Archil lists every sandbox in the region; none carries creation proof.
            coverage: "provider-scope" as const,
            items: listed.items.map((wire) => ({
              id: wire.sandbox_id,
              state: state(wire.status),
              reference: listedReference(wire),
              // Archil sandboxes carry no labels.
              labels: null,
              createdAt: listedTime(wire.created_at),
            })),
            nextCursor: listed.nextCursor,
          };
        },
        destroy: {
          recovery: { version: 1, token: DestroyToken },
          async prepare(input, ctx) {
            const wire = await requireWire(input, ctx);

            const mounts = (wire.mounts ?? []).map((mount) => ({
              id: mount.disk_id,
              path: mount.path ?? "",
            }));

            if (mounts.length && input.storage !== "allow-unconfirmed")
              throw new AdapterError(
                "UNSUPPORTED",
                "Archil mount durability is unconfirmed; explicitly allow-unconfirmed to destroy compute",
              );

            return { ...input, mounts };
          },
          async submit(input, ctx) {
            const id = Id.parse(input.id);
            const { mounts } = input;
            await ctx.checkpoint({ id, stage: "stopping", mounts });

            const done = (retained: boolean) => ({
              computeStopped: true,
              retainedResources: [...(retained ? [id] : []), ...mounts.map((mount) => mount.id)],
              mountDurability: mounts.map((mount) => ({
                volume: volumeRef(mount.id),
                path: mount.path,
                status: "unconfirmed" as const,
              })),
            });

            const current = await find(id, readContext(ctx.signal));

            if (!current) return done(false);

            // Archil deletes only a stopped sandbox; a stop also checkpoints its disk.
            if (!stoppedStates.has(current.status)) {
              const stopped = await park(id, "stop", ctx.signal);

              if ("reason" in stopped) {
                const now = await find(id, readContext(ctx.signal)).catch(() => undefined);

                if (now === null) return done(false);

                if (now?.status === "stopping")
                  return ctx.pending({ id, stage: "stopping", mounts }, { pollAfterMs: pollMs });

                if (!now || !stoppedStates.has(now.status))
                  return ctx.unknown(`${stopped.reason}; destroy the sandbox again`);
              }
            }

            await ctx.checkpoint({ id, stage: "deleting", mounts });

            try {
              await send("DELETE", sandboxPath(id), undefined, ctx.signal);
            } catch (error) {
              const native = failure(error);

              // A stopped sandbox with snapshot holders or other forks stays until they are gone.
              if (native.status === 409) return done(true);

              if (native.status === 404) return done(false);

              return ctx.pending({ id, stage: "deleting", mounts }, { pollAfterMs: pollMs });
            }

            try {
              const gone = await settle(ctx.signal, async (read) =>
                (await find(id, read)) ? undefined : true,
              );

              if (gone) return done(false);
            } catch {
              /* Deletion is acknowledged; completion continues through observation. */
            }

            return ctx.pending({ id, stage: "deleting", mounts }, { pollAfterMs: pollMs });
          },
          async observe(attempt, ctx) {
            const token = DestroyToken.safeParse(attempt.token);

            if (!token.success || token.data.id !== attempt.sandbox?.id)
              return ctx.unknown("Archil deletion identity is unavailable; do not replay");

            const { id, mounts } = token.data;
            const wire = await find(id, ctx);

            const done = (retained: boolean) => ({
              computeStopped: true,
              retainedResources: [...(retained ? [id] : []), ...mounts.map((mount) => mount.id)],
              mountDurability: mounts.map((mount) => ({
                volume: volumeRef(mount.id),
                path: mount.path,
                status: "unconfirmed" as const,
              })),
            });

            if (!wire) return done(false);

            if (wire.status === "deleting" || wire.status === "stopping")
              return ctx.pending(token.data, { pollAfterMs: pollMs });

            // A stop that finished after the call returned leaves the sandbox for another destroy.
            if (stoppedStates.has(wire.status)) return done(true);

            return ctx.unknown(
              `Archil sandbox is ${wire.status} after destroy; destroy it again explicitly`,
            );
          },
        },
        processes: {
          supports: {
            sustainedOutput: true,
            binaryOutput: true,
            signals: ["SIGTERM", "SIGKILL"],
            terminal: true,
            reopen: true,
            stdin: "bytes",
            status: true,
            execCapture: "bytes",
          },
          async start(input, ctx) {
            if (
              input.capture &&
              (!Number.isSafeInteger(input.capture.maxBytes) ||
                input.capture.maxBytes < 1 ||
                input.capture.maxBytes > MAX_OUTPUT_BYTES)
            )
              throw new AdapterError("CAPACITY", "Archil process capture exceeds its byte bound");

            return startProcess(input, ctx);
          },
          async reopen(input, ctx) {
            await requireRunning(input.sandbox, ctx);
            const reference = ProcessReference.safeParse(input.reference);

            if (
              !reference.success ||
              reference.data.sandbox !== input.sandbox.id ||
              reference.data.terminal !== (input.profile === "terminal") ||
              reference.data.stdin !== input.stdin
            )
              throw new AdapterError(
                "CONFLICT",
                "Process reference does not belong to this Archil sandbox and profile",
              );

            if (input.output.format === "bytes" && !ctx.onOutputBytes)
              throw new AdapterError(
                "UNSUPPORTED",
                "Archil binary output requires a byte consumer hook",
              );

            const { offset, ...base } = reference.data;
            const sandbox = native(input.sandbox.id, host.signal);
            const relay = frameRelay();
            let handle: SandboxProcess;

            try {
              handle = await sandbox.attach(base.process, {
                offset,
                collectOutput: false,
                onOutput: relay.push,
              });
            } catch (error) {
              throw error instanceof Error && /not.?found|unknown process/i.test(error.message)
                ? new AdapterError("NOT_FOUND", "Archil process is no longer available")
                : new AdapterError("UNAVAILABLE", "Archil process could not be reattached");
            }

            const observed = observeProcess(
              processOptions(input.sandbox.id),
              handle,
              base,
              { format: input.output.format, offset },
              ctx,
              (next, onOutput) =>
                sandbox.attach(base.process, { offset: next, collectOutput: false, onOutput }),
            );

            relay.attach(observed.onOutput);

            return observed.process;
          },
        },
        exec: {
          finiteStdin: "bytes",
          async prepare(input, ctx) {
            if (input.deadlineSeconds > MAX_SESSION_SECONDS)
              throw new AdapterError(
                "INVALID_ARGUMENT",
                `Archil commands run for at most ${MAX_SESSION_SECONDS} seconds`,
              );

            if (input.stdin !== undefined && input.stdin.byteLength > MAX_STDIN_BYTES)
              throw new AdapterError(
                "CAPACITY",
                `Archil command stdin is limited to ${MAX_STDIN_BYTES} bytes`,
              );
            // Validates argv, env names and NUL bytes before any effect.
            commandLine(input);
            await requireRunning(input.sandbox, ctx);

            return input;
          },
          submit: (input, ctx) => runCommand(input, ctx),
        },
        async preview(input, ctx) {
          await requireRunning(input.sandbox, ctx);
          const id = input.sandbox.id;

          if (config.preview.access === "public") {
            const port = Port.safeParse(
              await read("PUT", sandboxPath(id, `/ports/${input.port}`), ctx),
            );

            if (!port.success)
              throw new AdapterError("UNAVAILABLE", "Archil did not publish the preview port");

            return { access: "public", url: `https://${port.data.hostname}` };
          }

          // A fresh short-lived token per call; it is never stored in a reference.
          const token = PortToken.safeParse(
            await read("POST", sandboxPath(id, "/port-tokens"), ctx, {
              body: { port: input.port, ttl: "1h" },
            }),
          );

          if (!token.success)
            throw new AdapterError("UNAVAILABLE", "Archil did not issue a preview token");

          return {
            access: "protected",
            url: `https://${token.data.hostname}`,
            headers: { "X-Archil-Token": token.data.token },
          };
        },
        files: {
          maxBytes: MAX_FILE_BYTES,
          async read(input, ctx) {
            await requireRunning(input.sandbox, ctx);
            const limit = Math.min(input.maxBytes ?? MAX_FILE_BYTES, MAX_FILE_BYTES);
            const chunks: Uint8Array[] = [];
            let size = 0;

            try {
              await download(input.sandbox.id)(
                input.path,
                async (chunk) => {
                  size += chunk.byteLength;

                  if (size > limit)
                    throw new AdapterError("CAPACITY", "Archil file exceeds the read bound");
                  chunks.push(chunk);
                },
                callSignal(ctx),
              );
            } catch (error) {
              if (error instanceof AdapterError && error.code === "CAPACITY") throw error;

              if (
                error instanceof Error &&
                error.cause instanceof AdapterError &&
                error.cause.code === "CAPACITY"
              )
                throw error.cause;
              throw await downloadFailure(input.sandbox.id, input.path, ctx);
            }

            return new Uint8Array(Buffer.concat(chunks));
          },
          write: {
            async prepare(input, ctx) {
              if (input.bytes.byteLength > MAX_FILE_BYTES)
                throw new AdapterError("CAPACITY", "Archil file exceeds the write bound");
              await requireRunning(input.sandbox, ctx);

              return input;
            },
            async submit(input, ctx) {
              try {
                return await files(input.sandbox.id).write(
                  input.path,
                  [input.bytes],
                  input.overwrite,
                  readContext(ctx.signal, 300),
                );
              } catch (error) {
                return fileRejection(ctx, error);
              }
            },
          },
          async readDirectory(input, ctx) {
            await requireRunning(input.sandbox, ctx);

            return directoryValue(
              await files(input.sandbox.id).helper("list", input.path, "", false, ctx),
            );
          },
          async stat(input, ctx) {
            await requireRunning(input.sandbox, ctx);

            return statValue(
              await files(input.sandbox.id).helper(
                "stat",
                input.path,
                "",
                input.followSymlinks,
                ctx,
              ),
            );
          },
          async exists(input, ctx) {
            await requireRunning(input.sandbox, ctx);

            return Exists.parse(
              await files(input.sandbox.id).helper("exists", input.path, "", false, ctx),
            ).exists;
          },
          async readStream(input, ctx) {
            await requireRunning(input.sandbox, ctx);

            // A missing path fails before the stream opens, as other adapters do.
            const exists = Exists.parse(
              await files(input.sandbox.id).helper("exists", input.path, "", false, ctx),
            ).exists;

            if (!exists) throw new AdapterError("NOT_FOUND", "Archil file does not exist");

            return files(input.sandbox.id).read(input.path, ctx);
          },
          async writeStream(input, ctx) {
            await requireRunning(input.sandbox, ctx);

            return files(input.sandbox.id).write(input.path, input.bytes, input.overwrite, ctx);
          },
          async copy(input, ctx) {
            await requireRunning(input.sandbox, ctx);

            return files(input.sandbox.id).transfer(
              "copy",
              input.source,
              input.destination,
              input.overwrite,
              ctx,
            );
          },
          async move(input, ctx) {
            await requireRunning(input.sandbox, ctx);

            return files(input.sandbox.id).transfer(
              "move",
              input.source,
              input.destination,
              input.overwrite,
              ctx,
            );
          },
          makeDirectory: {
            async prepare(input, ctx) {
              await requireRunning(input.sandbox, ctx);

              return input;
            },
            async submit(input, ctx) {
              try {
                await files(input.sandbox.id).helper(
                  "mkdir",
                  input.path,
                  "",
                  input.recursive,
                  readContext(ctx.signal),
                );

                return { acknowledged: true };
              } catch (error) {
                return fileRejection(ctx, error);
              }
            },
          },
          remove: {
            async prepare(input, ctx) {
              await requireRunning(input.sandbox, ctx);

              return input;
            },
            async submit(input, ctx) {
              try {
                await files(input.sandbox.id).helper(
                  "remove",
                  input.path,
                  "",
                  input.recursive,
                  readContext(ctx.signal),
                );

                return { acknowledged: true };
              } catch (error) {
                return fileRejection(ctx, error);
              }
            },
          },
          async list(input, ctx) {
            await requireRunning(input.sandbox, ctx);

            return directoryValue(
              await files(input.sandbox.id).helper("list", input.path, "", false, ctx),
            ).entries;
          },
        },
        async suspensionCapabilities() {
          return {
            status: "supported",
            value:
              suspension === Preserve.FILESYSTEM
                ? { preserve: Preserve.FILESYSTEM, processes: "terminated", connections: "dropped" }
                : {
                    preserve: Preserve.FILESYSTEM_AND_MEMORY,
                    processes: "preserved",
                    connections: "dropped",
                  },
          };
        },
        async resumeCapabilities() {
          return {
            status: "supported",
            value: { sourceStates: ["suspended", "stopped"], setsSessionTimeout: true },
          };
        },
        suspend: {
          recovery: { version: 1, token: LifecycleToken },
          async prepare(input, ctx) {
            const wire = await requireWire(input.sandbox, ctx);

            if (wire.status !== "running")
              throw new AdapterError(
                "CONFLICT",
                `Archil can suspend only a running sandbox, not ${wire.status}`,
              );

            return { ...input, intent: { action: "suspend", preserve: suspension } };
          },
          async submit(input, ctx) {
            const action =
              input.intent.action === "suspend" && input.intent.preserve === Preserve.FILESYSTEM
                ? "stop"
                : "pause";

            const token = { id: Id.parse(input.sandbox.id), action } as const;
            await ctx.checkpoint(token);
            held.add(token.id);

            try {
              await send("POST", sandboxPath(token.id, `/${action}`), undefined, ctx.signal, 120);
            } catch (error) {
              held.delete(token.id);

              return rejection(ctx, error, `Archil ${action} response was not confirmed`);
            }

            try {
              const result = await settled(token.id, ctx.signal, (wire) =>
                action === "pause" ? wire.status === "paused" : stoppedStates.has(wire.status),
              );

              if (result?.wire) return suspended(result.wire, input.sandbox.reference);
            } catch {
              /* The request is acknowledged; completion continues through observation. */
            }

            return ctx.pending(token, { pollAfterMs: pollMs });
          },
          async observe(attempt, ctx) {
            const token = LifecycleToken.safeParse(attempt.token);
            const box = attempt.sandbox;

            if (!token.success || !box?.reference || token.data.id !== box.id)
              return ctx.unknown("Archil suspend identity is unavailable; do not replay");
            const wire = await find(token.data.id, ctx);

            if (!wire) return ctx.unknown("Archil sandbox disappeared while suspending");

            if (wire.status === "paused" || stoppedStates.has(wire.status))
              return suspended(wire, box.reference);

            return wire.status === "pausing" || wire.status === "stopping"
              ? ctx.pending(token.data, { pollAfterMs: pollMs })
              : ctx.unknown(
                  `Archil sandbox is ${wire.status} after suspend; inspect without replay`,
                );
          },
        },
        resume: {
          recovery: { version: 1, token: LifecycleToken },
          async prepare(input, ctx) {
            const wire = await requireWire(input.sandbox, ctx);

            if (wire.status !== "paused" && !stoppedStates.has(wire.status))
              throw new AdapterError(
                "CONFLICT",
                `Archil can resume only a paused or stopped sandbox, not ${wire.status}`,
              );

            return { ...input, intent: { action: "resume" } };
          },
          async submit(input, ctx) {
            const wire = await find(input.sandbox.id, readContext(ctx.signal));

            if (!wire) return ctx.reject("NOT_FOUND", "Archil sandbox is unavailable");

            // A paused sandbox resumes its memory; `start` would discard it.
            const action = wire.status === "paused" ? "resume" : "start";
            const token = { id: Id.parse(input.sandbox.id), action } as const;
            await ctx.checkpoint(token);

            try {
              await send("POST", sandboxPath(token.id, `/${action}`), undefined, ctx.signal, 120);
            } catch (error) {
              return rejection(ctx, error, `Archil ${action} response was not confirmed`);
            }

            try {
              const result = await settled(
                token.id,
                ctx.signal,
                (current) => current.status === "running",
              );

              if (result?.wire) {
                held.delete(token.id);

                return resumed(result.wire, input.sandbox.reference, action);
              }
            } catch {
              /* The request is acknowledged; readiness continues through observation. */
            }

            return ctx.pending(token, { pollAfterMs: pollMs });
          },
          async observe(attempt, ctx) {
            const token = LifecycleToken.safeParse(attempt.token);
            const box = attempt.sandbox;

            if (
              !token.success ||
              !box?.reference ||
              token.data.id !== box.id ||
              (token.data.action !== "resume" && token.data.action !== "start")
            )
              return ctx.unknown("Archil resume identity is unavailable; do not replay");
            const wire = await find(token.data.id, ctx);

            if (!wire) return ctx.unknown("Archil sandbox disappeared while resuming");

            if (wire.status === "running") {
              held.delete(wire.sandbox_id);

              return resumed(wire, box.reference, token.data.action);
            }

            return wire.status === "pending" ||
              wire.status === "paused" ||
              stoppedStates.has(wire.status)
              ? ctx.pending(token.data, { pollAfterMs: pollMs })
              : ctx.unknown(
                  `Archil sandbox is ${wire.status} after resume; inspect without replay`,
                );
          },
        },
        async renewCapabilities() {
          return {
            status: "supported",
            value: {
              minSeconds: 60,
              maxSeconds: MAX_SESSION_SECONDS,
              stepSeconds: 1,
              scope: "running-session",
            },
          };
        },
        renew: {
          async prepare(input, ctx) {
            await requireWire(input.sandbox, ctx);
            const forSeconds = input.forSeconds ?? config.lifecycle.lifetimeSeconds;

            if (forSeconds < 60 || forSeconds > MAX_SESSION_SECONDS)
              throw new AdapterError(
                "INVALID_ARGUMENT",
                `Archil session lifetimes are 60 to ${MAX_SESSION_SECONDS} seconds`,
              );

            return { ...input, forSeconds };
          },
          async submit(input, ctx) {
            // `timeout` counts from now for the running session and budgets the next one.
            try {
              await send(
                "POST",
                sandboxPath(input.sandbox.id, "/timeout"),
                { timeout: input.forSeconds },
                ctx.signal,
              );
            } catch (error) {
              return rejection(ctx, error, "Archil timeout update was not confirmed");
            }

            const wire = await find(input.sandbox.id, readContext(ctx.signal)).catch(() => null);

            return {
              reference: input.sandbox.reference,
              requested: { forSeconds: input.forSeconds },
              acknowledged: true,
              observation: wire ? observation(wire, input.sandbox.reference) : null,
            };
          },
        },
        async snapshotProfiles(target, ctx) {
          if (target.create?.mounts?.length)
            return {
              status: "unsupported",
              reason: "Archil cannot snapshot sandboxes with mounted disks",
            };

          if (target.sandbox) {
            const wire = await requireWire(target.sandbox, ctx);

            if (wire.mounts?.length)
              return {
                status: "unsupported",
                reason: "Archil cannot snapshot sandboxes with mounted disks",
              };
          }

          return snapshotSupport;
        },
        snapshotCapture: {
          recovery: { version: 1, token: CaptureToken },
          async prepare(input, ctx) {
            const wire = await requireWire(input.sandbox, ctx);

            if (wire.name.startsWith(HOLDER_PREFIX))
              throw new AdapterError("UNSUPPORTED", "This Archil sandbox holds a snapshot");

            if (wire.mounts?.length)
              throw new AdapterError(
                "UNSUPPORTED",
                "Archil cannot snapshot sandboxes with mounted disks",
              );

            const plan = resolveSnapshot(snapshotSupport, input.request, state(wire.status));

            if (plan.status !== "supported") throw new AdapterError("UNSUPPORTED", plan.reason);

            return {
              ...input,
              expectation: { profile: plan.value.profile, sourceState: plan.value.sourceState },
            };
          },
          async submit(input, ctx) {
            const sourceState = input.expectation?.sourceState;

            const token: CaptureToken = {
              name: holderName(ctx.submissionId),
              source: Id.parse(input.sandbox.id),
              sourceState: capturedState(sourceState),
              preserve: input.expectation?.profile.preserve ?? snapshotPreserve,
            };

            return capture(token, input.sandbox.reference, ctx);
          },
          async observe(attempt, ctx) {
            const token = CaptureToken.safeParse(attempt.token);

            if (
              !token.success ||
              token.data.source !== attempt.sandbox?.id ||
              token.data.name !== holderName(attempt.submissionId)
            )
              return ctx.unknown("Archil capture identity is unavailable; do not replay");

            const holder = token.data.holder
              ? await find(token.data.holder, ctx)
              : await findByName(token.data.name, ctx);

            if (!holder)
              return ctx.unknown(
                "Archil snapshot holder was not found; inspect the source, which may be paused",
              );

            const parked =
              token.data.preserve === Preserve.FILESYSTEM
                ? stoppedStates.has(holder.status)
                : holder.status === "paused";

            if (!parked)
              return ctx.unknown(
                `Archil snapshot holder is ${holder.status}; delete it and capture again`,
              );

            const source = await find(token.data.source, ctx);
            const ref = snapshotRef(holder.sandbox_id, "verified-created");

            return {
              snapshot: snapshotInfo(holder, ref, {
                id: token.data.source,
                ref: attempt.sandbox?.reference,
              }),
              capture: {
                preserve: token.data.preserve,
                interruption: "pause" as const,
                restoreExecution:
                  token.data.preserve === Preserve.FILESYSTEM
                    ? ("fresh" as const)
                    : ("resume" as const),
              },
              source: {
                state: source ? state(source.status) : ("unknown" as const),
                connections: "dropped" as const,
                observedAt: new Date().toISOString(),
              },
              retainedResources: [ref],
            };
          },
        },
        snapshotRestore: {
          recovery: { version: 1, token: CreateToken },
          options: {},
          async prepare(input, ctx) {
            if (input.request.resources || input.request.mounts?.length)
              throw new AdapterError(
                "UNSUPPORTED",
                "Archil restores keep the snapshot's size and take no mounts",
              );

            const holder = await requireHolder(input.snapshot, ctx);

            if (holder.status !== "paused" && !stoppedStates.has(holder.status))
              throw new AdapterError("CONFLICT", `Archil snapshot is ${holder.status}, not ready`);

            if (policyOf(await network(holder.sandbox_id, ctx)) !== input.request.networkPolicy)
              throw new AdapterError(
                "UNSUPPORTED",
                "Archil restores keep the snapshot's network policy",
              );

            return input;
          },
          async submit(input, ctx) {
            const holder = await findHolder(input.snapshot.nativeId, readContext(ctx.signal));

            if (!holder?.checkpoint)
              return ctx.reject("NOT_FOUND", "Archil snapshot has no restorable checkpoint");

            const name = attemptName(ctx.submissionId);

            return launch(
              {
                path: sandboxPath(holder.sandbox_id, "/fork"),
                body: { name, checkpoint: holder.checkpoint },
              },
              {
                name,
                network: networkPolicy(input.request.networkPolicy),
              },
              ctx,
              partialRestore,
            );
          },
          async observe(attempt, ctx) {
            const token = CreateToken.safeParse(attempt.token);

            if (
              !attempt.resource ||
              !token.success ||
              token.data.name !== attemptName(attempt.submissionId)
            )
              return ctx.unknown("Archil restore identity is unavailable; do not replay");
            checkedSnapshot(attempt.resource);

            return observeLaunch(token.data, attempt, ctx, partialRestore);
          },
        },
        async snapshotInspect(ref, ctx) {
          return snapshotInfo(await requireHolder(ref, ctx), ref);
        },
        snapshotListCoverage: "managed",
        async snapshotList(input, ctx) {
          const offset = input.cursor === undefined ? 0 : Number(input.cursor);

          if (!Number.isSafeInteger(offset) || offset < 0)
            throw new AdapterError("INVALID_ARGUMENT", "Invalid Archil snapshot cursor");

          const holders = (await listAll(ctx)).filter((wire) =>
            wire.name.startsWith(HOLDER_PREFIX),
          );

          const items = holders.slice(offset, offset + Math.min(100, input.limit));
          const next = offset + items.length;

          return {
            // Only holders this adapter names; Archil keeps no other snapshot resource.
            items: items.map((holder) => snapshotInfo(holder, snapshotRef(holder.sandbox_id))),
            nextCursor: next < holders.length ? String(next) : undefined,
            coverage: "managed" as const,
          };
        },
        snapshotDelete: {
          recovery: { version: 1, token: DeleteToken },
          async prepare(ref, ctx) {
            await requireHolder(ref, ctx);

            return ref;
          },
          async submit(ref, ctx) {
            const token = { id: checkedSnapshot(ref) };
            await ctx.checkpoint(token);

            const remove = () => send("DELETE", sandboxPath(token.id), undefined, ctx.signal);

            try {
              // A delete is tried first: restores that still fork from the holder refuse it
              // before its memory is discarded by a stop.
              await remove();
            } catch (error) {
              const native = failure(error);

              if (native.status === 404) return { deleted: true as const, reference: ref };

              if (native.status !== 409)
                return rejection(ctx, error, "Archil snapshot delete was not confirmed");

              if (/child/i.test(native.error.message))
                return ctx.reject(
                  "CONFLICT",
                  "Sandboxes restored from this Archil snapshot still depend on it",
                );

              const stopped = await park(token.id, "stop", ctx.signal);

              if ("reason" in stopped)
                return ctx.unknown(`${stopped.reason}; delete the snapshot again`);

              try {
                await remove();
              } catch (retry) {
                const again = failure(retry);

                // The stop already happened, so this is not a clean refusal.
                if (again.status === 409)
                  return ctx.unknown(
                    "Sandboxes restored from this Archil snapshot still depend on it; it is now stopped, so later restores cold-boot its filesystem",
                  );

                return ctx.pending(token, { pollAfterMs: pollMs });
              }
            }

            try {
              const gone = await settle(ctx.signal, async (read) =>
                (await find(token.id, read)) ? undefined : true,
              );

              if (gone) return { deleted: true as const, reference: ref };
            } catch {
              /* Deletion is acknowledged; completion continues through observation. */
            }

            return ctx.pending(token, { pollAfterMs: pollMs });
          },
          async observe(attempt, ctx) {
            const token = DeleteToken.safeParse(attempt.token);
            const ref = attempt.resource;

            if (!token.success || !ref || checkedSnapshot(ref) !== token.data.id)
              return ctx.unknown("Archil snapshot deletion identity is unavailable; do not replay");

            const holder = await find(token.data.id, ctx);

            if (!holder) return { deleted: true as const, reference: ref };

            return holder.status === "deleting"
              ? ctx.pending(token.data, { pollAfterMs: pollMs })
              : ctx.unknown("Archil snapshot still exists; delete it again explicitly");
          },
        },
        imageBuild: {
          recovery: { version: 1, token: ImageToken },
          async prepare(input) {
            if (!OciImage.safeParse(input.source.value).success)
              throw new AdapterError("INVALID_ARGUMENT", "Invalid OCI image reference");

            return input;
          },
          async submit(input, ctx) {
            let image: NativeImage;

            try {
              const parsed = NativeImage.safeParse(
                await send("POST", "/api/images", imageRequest(input.source.value), ctx.signal),
              );

              if (!parsed.success)
                return ctx.unknown("Archil image build acknowledgement is invalid; do not replay");
              image = parsed.data;
            } catch (error) {
              return rejection(ctx, error, "Archil image build response was not confirmed");
            }

            const token = { id: image.image_id, source: input.source.value };
            await ctx.checkpoint(token);

            if (image.status === "failed")
              return ctx.unknown(
                `Archil image build failed${image.failure_reason ? ` (${image.failure_reason})` : ""}; request it again to rebuild`,
              );

            return builtImage(image) ?? ctx.pending(token, { pollAfterMs: pollMs });
          },
          async observe(attempt, ctx) {
            const token = ImageToken.safeParse(attempt.token);

            if (!token.success)
              return ctx.unknown("Archil image build identity is unavailable; do not replay");

            const image = await findImage(token.data.id, ctx);

            if (!image) return ctx.unknown("Archil image disappeared while building");

            if (image.status === "failed")
              return ctx.unknown(
                `Archil image build failed${image.failure_reason ? ` (${image.failure_reason})` : ""}; request it again to rebuild`,
              );

            return builtImage(image) ?? ctx.pending(token.data, { pollAfterMs: pollMs });
          },
        },
        async imageInspect(ref, ctx) {
          assertResourceScope(ref, { provider: "archil", scope });

          if (ref.kind !== "image" || !PreparedImageId.test(ref.nativeId))
            throw new AdapterError("CONFLICT", "Invalid Archil image identity");
          const image = await findImage(ref.nativeId, ctx);

          if (!image) throw new AdapterError("NOT_FOUND", "Archil image is unavailable");

          return imageInfo(image, imageRef(image.image_id));
        },
        async resourceCapabilities() {
          return {
            restore: { status: "supported", value: restoreSupport },
            volumes: {
              status: "supported",
              value: { create: true, inspect: true, list: true, delete: true },
            },
            mounts: {
              status: "supported",
              value: {
                timing: "create",
                access: ["read-only", "read-write"],
                subpaths: true,
                versions: false,
                durability: "unknown",
                compatibility: [],
              },
            },
          };
        },
        async checkMounts(input, ctx) {
          await mountCheck(input.mounts, ctx);

          return { status: "supported", value: {} };
        },
        volumeCreate: {
          recovery: { version: 1, token: VolumeToken },
          async submit(input, ctx) {
            const token = { name: input.name };
            await ctx.checkpoint(token);
            let id: string;

            try {
              // The one-time disk token in the response is discarded, never stored.
              const created = z
                .looseObject({ diskId: Id })
                .safeParse(await send("POST", "/api/disks", { name: input.name }, ctx.signal));

              if (!created.success)
                return ctx.unknown(
                  "Archil disk acknowledgement is invalid; list disks without replay",
                );
              id = created.data.diskId;
            } catch (error) {
              const native = failure(error);

              return refusedBeforeEffect(native)
                ? ctx.reject(native.error.code, native.error.message)
                : ctx.pending(token, { pollAfterMs: pollMs });
            }

            await ctx.checkpoint({ ...token, id });
            const disk = await findDisk(id, readContext(ctx.signal)).catch(() => null);

            const ref = {
              ...volumeRef(id, "verified-created"),
              receipt: JSON.stringify({ operation: ctx.operationId, submission: ctx.submissionId }),
            };

            return volumeInfo(disk ?? { id, name: input.name, status: "creating" }, ref);
          },
          async observe(attempt, ctx) {
            const token = VolumeToken.safeParse(attempt.token);

            if (!token.success)
              return ctx.unknown("Archil disk creation identity is unavailable; do not replay");

            const disk = token.data.id
              ? await findDisk(token.data.id, ctx)
              : ((await disks(ctx, { name: token.data.name })).find(
                  (candidate) => candidate.name === token.data.name,
                ) ?? null);

            return disk
              ? volumeInfo(disk)
              : ctx.unknown("Archil disk was not found; list disks without replay");
          },
        },
        async volumeInspect(ref, ctx) {
          const disk = await findDisk(checkedVolume(ref), ctx);

          if (!disk) throw new AdapterError("NOT_FOUND", "Archil disk is unavailable");

          return volumeInfo(disk, ref);
        },
        async volumeList(input, ctx) {
          const offset = input.cursor === undefined ? 0 : Number(input.cursor);

          if (!Number.isSafeInteger(offset) || offset < 0)
            throw new AdapterError("INVALID_ARGUMENT", "Invalid Archil disk cursor");

          const all = await disks(ctx);
          const items = all.slice(offset, offset + Math.min(100, input.limit));
          const next = offset + items.length;

          return {
            items: items.map((disk) => volumeInfo(disk)),
            nextCursor: next < all.length ? String(next) : undefined,
            coverage: "provider-scope" as const,
          };
        },
        volumeDelete: {
          recovery: { version: 1, token: DeleteToken },
          async prepare(ref, ctx) {
            const disk = await findDisk(checkedVolume(ref), ctx);

            if (!disk) throw new AdapterError("NOT_FOUND", "Archil disk is unavailable");

            return ref;
          },
          async submit(ref, ctx) {
            const token = { id: checkedVolume(ref) };
            await ctx.checkpoint(token);

            try {
              await send(
                "DELETE",
                `/api/disks/${encodeURIComponent(token.id)}`,
                undefined,
                ctx.signal,
              );
            } catch (error) {
              const native = failure(error);

              if (native.status === 404) return { deleted: true as const, reference: ref };

              return refusedBeforeEffect(native)
                ? ctx.reject(native.error.code, native.error.message)
                : ctx.pending(token, { pollAfterMs: pollMs });
            }

            return (await findDisk(token.id, readContext(ctx.signal)).catch(() => undefined)) ===
              null
              ? { deleted: true as const, reference: ref }
              : ctx.pending(token, { pollAfterMs: pollMs });
          },
          async observe(attempt, ctx) {
            const token = DeleteToken.safeParse(attempt.token);
            const ref = attempt.resource;

            if (!token.success || !ref || checkedVolume(ref) !== token.data.id)
              return ctx.unknown("Archil disk deletion identity is unavailable; do not replay");

            const disk = await findDisk(token.data.id, ctx);

            if (!disk) return { deleted: true as const, reference: ref };

            return disk.status === "deleting"
              ? ctx.pending(token.data, { pollAfterMs: pollMs })
              : ctx.unknown("Archil disk still exists; delete it again explicitly");
          },
        },
      };

      return session;
    },
  });
}

export const archilAdapter = createArchilAdapter();
