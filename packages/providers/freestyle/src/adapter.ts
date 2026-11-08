import { createHash } from "node:crypto";
import type {
  CreateSnapshotOptions,
  CreateVmOptions,
  ExecOptions,
  Freestyle,
  FirewallSpec,
  SnapshotData,
  TlsSpec,
  VmData,
} from "freestyle";
import { FreestyleApiError } from "freestyle";
import { z } from "zod";
import {
  AdapterCheckpointError,
  AdapterError,
  AdapterFilesystemError,
  assertResourceScope,
  DEFAULT_LIFETIME_SECONDS,
  defineAdapter,
  listedLabels,
  listedTime,
  MAX_DIRECTORY_ENTRIES,
  Preserve,
  PreserveSchema,
  PreviewPort,
  resolveSnapshot,
  ResourceMinimums,
  sandboxReference,
  smallestSize,
  unknownSandboxFacts,
  type AdapterSession,
  type AttemptContext,
  type CreateInput,
  type ExecInput,
  type Fact,
  type FileWriteInput,
  type ImageInfo,
  type ObserveContext,
  type OperationOutcome,
  type ReadContext,
  type ResourceReference,
  type Sandbox,
  type SandboxInfo,
  type SandboxReference,
  type SandboxResources,
  type SandboxState,
  type SnapshotInfo,
  type SnapshotProfile,
} from "@beachside/adapter";
import {
  checkEnv,
  commandLine,
  ENV_FILE,
  envFile,
  envMarker,
  filesResult,
  parseWrapper,
  quote,
  wrapperScript,
  type WrapperResult,
} from "./exec";
import { directoryValue, Exists, filesystem, rangeResult, statValue } from "./filesystem";
import {
  launcherScript,
  observeJob,
  parseLauncher,
  ProcessReference,
  type GuestRunner,
} from "./process";
import { openTerminal, TerminalReference, terminalSlug, type PtyDriver } from "./terminal";
import {
  createFreestyleClient,
  FREESTYLE_API,
  nativeFailure,
  refusedBeforeEffect,
  type NativeFailure,
  type NativeFetch,
} from "./transport";

/** Freestyle's platform default base snapshot: Ubuntu 24.04 with 4 vCPU and 8 GiB. */
export const BASE_IMAGE = "freestyle/ubuntu";

/**
 * Exec deadlines run up to 24 hours on guest agents with native resumable exec; older agents
 * refuse anything over five minutes with `AGENT_UNSUPPORTED`.
 */
export const MAX_EXEC_SECONDS = 86_400;

/** Per-stream output bound collected through the guest wrapper. */
export const MAX_OUTPUT_BYTES = 1_048_576;

/** Native exec stdin limit (1 MiB after decoding). */
export const MAX_STDIN_BYTES = 1_048_576;

/**
 * Largest file sent or read in one request. The SDK switches to a chunked upload above this
 * size, and that upload replays chunks on its own, so the adapter stays below it.
 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** Freestyle documents no upper bound on `ttlSeconds`; Beachside caps lifetimes at 30 days. */
const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Freestyle's Ubuntu 24.04 base snapshots, smallest first. Hardware is baked into each
 * snapshot, so a size is chosen by booting the matching base. `freestyle/ubuntu-3xl` is above
 * every plan's per-VM cap and is left out.
 */
const UBUNTU_SIZES = [
  { image: "freestyle/ubuntu-sm", vcpus: 2, memoryMiB: 4096 },
  { image: "freestyle/ubuntu", vcpus: 4, memoryMiB: 8192 },
  { image: "freestyle/ubuntu-lg", vcpus: 8, memoryMiB: 16_384 },
  { image: "freestyle/ubuntu-xl", vcpus: 16, memoryMiB: 32_768 },
  { image: "freestyle/ubuntu-2xl", vcpus: 32, memoryMiB: 65_536 },
] as const;

/** A `sh-…` snapshot id, an account slug, or a public `{owner}/{slug}`. */
const Image = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)?$/,
    "Use a Freestyle snapshot id, your snapshot slug or a public owner/slug",
  );

const Lifetime = z.number().int().min(60).max(MAX_TTL_SECONDS);

const Configuration = z
  .strictObject({
    /** `blocked` sends an empty firewall; `internet` allows every public destination. */
    network: z.enum(["blocked", "internet"]).default("blocked"),
    /** Default snapshot to boot; omitted, the base Ubuntu that fits `resources`. */
    image: Image.optional(),
    /** Minimum size; the smallest Freestyle Ubuntu base snapshot that meets it is used. */
    resources: ResourceMinimums.optional(),
    lifecycle: z
      .strictObject({
        /** Delete the VM this long after creation (`ttlSeconds`); renew extends it. */
        lifetimeSeconds: Lifetime.default(DEFAULT_LIFETIME_SECONDS),
        /** Pause the VM after this long without network activity (`idleTimeoutSeconds`). */
        idleSeconds: Lifetime.optional(),
      })
      .default({ lifetimeSeconds: DEFAULT_LIFETIME_SECONDS }),
    preview: z
      .strictObject({
        /** Freestyle publishes ports on public `*.style.dev` names. */
        access: z.enum(["public", "protected"]).default("public"),
        /** Ports published at create; each claims one `style.dev` name for the account. */
        ports: z
          .array(PreviewPort)
          .max(16)
          .refine((ports) => new Set(ports).size === ports.length, "Preview ports must be unique")
          .default([]),
      })
      .default({ access: "public", ports: [] }),
    snapshots: z
      .strictObject({
        /** Freestyle snapshots always keep memory and disk; `filesystem` rejects at connect. */
        preserve: PreserveSchema.optional(),
        /** Seconds Freestyle keeps each snapshot after capture (`ttlSeconds`); `0` keeps it until deleted. */
        retentionSeconds: z.number().int().nonnegative().safe().optional(),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.image !== undefined && value.resources !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["resources"],
        message:
          "Supply image or resources, not both; Freestyle snapshots keep the size they were built with",
      });
  });

const Credentials = z.strictObject({ apiKey: z.string().min(1) });

const Id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

/** Slugs this adapter mints: one per create attempt, derived from its submission id. */
const AttemptSlug = z.string().regex(/^beachside-[0-9a-f]{24}$/);

/** The slug is saved before dispatch, so a lost create can still be found by it. */
const CreateToken = z.strictObject({
  slug: AttemptSlug,
  id: Id.optional(),
  /** The create wrote a sandbox-wide env file; the values themselves are never saved. */
  env: z.literal(true).optional(),
});

const DestroyToken = z.strictObject({ id: Id, acknowledged: z.boolean() });

/** The error body Freestyle's API returns; anything else gets a known fallback. */
const ApiErrorBody = z.object({ code: z.string().max(256), message: z.string().max(4096) });

const LifecycleToken = z.strictObject({
  id: Id,
  /** When a pause was submitted, in epoch milliseconds. */
  since: z.number().int().nonnegative().optional(),
});

/** Snapshot slugs this adapter mints: one per capture attempt, derived from its submission id. */
const SnapshotSlug = z.string().regex(/^beachside-snapshot-[0-9a-f]{24}$/);

/** The slug is saved before the capture request, so a lost response can be found by it. */
const CaptureToken = z.strictObject({
  slug: SnapshotSlug,
  source: Id,
  sourceState: z.enum(["running", "suspended"]),
  id: Id.optional(),
});

const SnapshotDeleteToken = z.strictObject({ id: Id });

/**
 * Freestyle captures the VM's exact state, memory and disk, from a running or paused VM; a
 * VM created from the snapshot continues from that state.
 */
const snapshotProfile: SnapshotProfile = {
  id: "freestyle-vm",
  preserve: Preserve.FILESYSTEM_AND_MEMORY,
  sourceStates: ["running", "suspended"],
  // Freestyle does not document whether a capture briefly pauses the VM; claim no less.
  interruption: "pause",
  sourceAfter: "unchanged",
  connections: "unknown",
  consistency: "unknown",
  restoreExecution: "resume",
  mountHandling: "none",
};

const snapshotSupport = {
  status: "supported" as const,
  value: { profiles: [snapshotProfile], defaultProfileId: snapshotProfile.id },
};

/** A restore is an ordinary create from the snapshot id; the snapshot keeps its VM size. */
const restoreSupport = {
  networkPolicies: ["blocked", "internet"],
  resources: false,
  mounts: false,
  independentLifecycle: true,
};

function snapshotSlug(submissionId: string): string {
  return `beachside-snapshot-${createHash("sha256").update(submissionId).digest("hex").slice(0, 24)}`;
}

/** Freestyle metadata limits: up to 64 entries, keys and values at most 63 characters. */
const Labels = z
  .record(z.string().min(1).max(63), z.string().max(63))
  .refine((labels) => Object.keys(labels).length <= 64, "At most 64 labels");

function attemptSlug(submissionId: string): string {
  return `beachside-${createHash("sha256").update(submissionId).digest("hex").slice(0, 24)}`;
}

/** The `style.dev` name a create publishes one preview port on. */
function previewDomain(slug: string, port: number): string {
  return `${slug}-${port}.style.dev`;
}

function state(native: string): SandboxState {
  switch (native) {
    case "starting":
      return "creating";
    case "running":
      return "running";
    case "paused":
      return "suspended";
    case "stopped":
      return "stopped";
    default:
      return "unknown";
  }
}

function vmSize(vm: VmData): Fact<SandboxResources> {
  const vcpus = vm.resources?.cpu ?? 0;
  const memoryMiB = vm.resources?.memory ?? 0;

  return Number.isFinite(vcpus) && vcpus > 0 && Number.isSafeInteger(memoryMiB) && memoryMiB > 0
    ? { status: "known", value: { vcpus, memoryMiB } }
    : { status: "unknown", reason: "Freestyle did not report the VM size" };
}

function expiry(vm: VmData): SandboxInfo["expires"] {
  if (vm.ttlSeconds === null || vm.ttlSeconds === undefined || vm.ttlSeconds < 0)
    return { status: "none" };
  const created = Date.parse(vm.createdAt);

  return Number.isNaN(created)
    ? { status: "unknown", reason: "Freestyle reported no usable creation time" }
    : {
        status: "known",
        at: new Date(created + vm.ttlSeconds * 1000).toISOString(),
        action: "destroy",
        scope: "sandbox",
      };
}

/**
 * Root ownership helper for overwrites. `owner PATH` prints `uid:gid` of a regular file (never
 * through a symlink) or nothing. `restore PATH UID GID SIZE SHA256 REPLACER` opens PATH with
 * O_NOFOLLOW and `fchown`s that open inode only when it is a regular file owned by REPLACER
 * (root, which replaced it), with one link and exactly the written bytes; it prints `ok` or
 * `skip`.
 */
const OWNER_HELPER = `import hashlib,os,stat,sys
m,p=sys.argv[1],sys.argv[2]
if m=='owner':
 try:st=os.lstat(p)
 except FileNotFoundError:sys.exit(0)
 if stat.S_ISREG(st.st_mode):print('%d:%d'%(st.st_uid,st.st_gid))
 sys.exit(0)
u,g,n,h,r=int(sys.argv[3]),int(sys.argv[4]),int(sys.argv[5]),sys.argv[6],int(sys.argv[7])
fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
try:
 st=os.fstat(fd)
 if not stat.S_ISREG(st.st_mode) or st.st_uid!=r or st.st_nlink!=1 or st.st_size!=n:print('skip');sys.exit(0)
 d=hashlib.sha256()
 while True:
  b=os.read(fd,1048576)
  if not b:break
  d.update(b)
 if d.hexdigest()!=h:print('skip');sys.exit(0)
 os.fchown(fd,u,g);print('ok')
finally:os.close(fd)
`;

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

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

export type FreestyleAdapterOptions = {
  /** Native fetch handed to the official SDK; tests inject a deterministic fixture. */
  fetch?: NativeFetch;
  /** Poll interval while waiting for boot, pause, resume or deletion. */
  pollIntervalMs?: number;
  /** Longest a mutation waits in-call before returning a pending result. */
  settleSeconds?: number;
  /** Delay between output reads while a process is quiet (default 250 ms). */
  processPollMs?: number;
  /** Terminal sessions; defaults to the SDK's `vm.pty` WebSockets. Tests inject a stand-in. */
  pty?: PtyDriver;
};

/** Constructing a definition performs no provider IO. */
export function createFreestyleAdapter(options: FreestyleAdapterOptions = {}) {
  const pollMs = options.pollIntervalMs ?? 1000;
  const settleSeconds = options.settleSeconds ?? 120;

  return defineAdapter({
    name: "freestyle",
    displayName: "Freestyle",
    config: Configuration,
    credentials: Credentials,
    async connect({ config, credentials, host }) {
      // Choices Freestyle cannot honor reject before any provider IO.
      if (config.preview.access !== "public")
        throw new AdapterError(
          "UNSUPPORTED",
          "Freestyle previews are public style.dev names; use preview.access public",
        );

      if (config.snapshots?.preserve === Preserve.FILESYSTEM)
        throw new AdapterError(
          "UNSUPPORTED",
          "Freestyle snapshots always keep memory and disk; filesystem-only snapshots are not supported",
        );

      const image =
        config.image ??
        (config.resources
          ? smallestSize("Freestyle", UBUNTU_SIZES, config.resources).image
          : BASE_IMAGE);

      const base = options.fetch ?? globalThis.fetch;
      const secrets = [credentials.apiKey];

      const api = (signal: AbortSignal, limit?: number): Freestyle =>
        createFreestyleClient(credentials.apiKey, base, signal, limit);

      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native SDK throws are normalized at this boundary.
      const failure = (error: unknown): NativeFailure => nativeFailure(error, secrets);

      const read = async <T>(ctx: ReadContext, run: (native: Freestyle) => Promise<T>) => {
        try {
          return await run(api(callSignal(ctx)));
        } catch (error) {
          throw failure(error).error;
        }
      };

      // Freestyle exposes no account id to an API key; one authenticated read proves the key.
      await read(readContext(host.signal), (native) => native.vms.list({ limit: 1 }));

      // The authenticated read proves this credential works, not its native team identity.
      const scope = {
        authority: {
          kind: "api-key",
          id: createHash("sha256")
            .update("beachside:freestyle:api-key-scope:v1\0")
            .update(credentials.apiKey)
            .digest("hex"),
        },
        partition: { endpoint: FREESTYLE_API },
      };

      const checkedRef = (ref: SandboxReference) => {
        assertResourceScope(ref, { provider: "freestyle", scope });

        if (
          ref.kind !== "sandbox" ||
          ref.generation !== undefined ||
          !Id.safeParse(ref.nativeId).success
        )
          throw new AdapterError("CONFLICT", "Invalid Freestyle VM identity");
      };

      const find = async (id: string, ctx: ReadContext): Promise<VmData | null> => {
        Id.parse(id);

        try {
          const vm = await api(callSignal(ctx)).vms.get(id);

          if (vm.id !== id)
            throw new AdapterError("CONFLICT", "Freestyle returned a different VM identity");

          return vm;
        } catch (error) {
          const native = failure(error);

          if (native.status === 404) return null;
          throw native.error;
        }
      };

      const findBySlug = async (slug: string, ctx: ReadContext): Promise<VmData | null> => {
        const page = await read(ctx, (native) => native.vms.list({ slug, limit: 2 }));
        const matches = page.vms.filter((vm) => vm.slug === slug);

        if (matches.length > 1)
          throw new AdapterError("CONFLICT", "Freestyle returned several VMs for one slug");

        return matches[0] ?? null;
      };

      const requireVm = async (box: Sandbox, ctx: ReadContext) => {
        if (box.reference) checkedRef(box.reference);
        const vm = await find(box.id, ctx);

        if (!vm)
          throw new AdapterError(
            "NOT_FOUND",
            "Freestyle VM is unavailable in the verified account",
          );

        return vm;
      };

      const requireRunning = async (box: Sandbox, ctx: ReadContext) => {
        const vm = await requireVm(box, ctx);

        if (vm.state !== "running")
          throw new AdapterError(
            "CONFLICT",
            `Freestyle VM is ${vm.state}; commands and files need a running VM`,
          );

        return vm;
      };

      const observation = (vm: VmData, ref: SandboxReference | null): SandboxInfo => ({
        reference: ref,
        state: state(vm.state),
        nativeState: vm.state,
        observedAt: new Date().toISOString(),
        ...unknownSandboxFacts(),
        expires: expiry(vm),
        idleStop: {
          status: "known",
          value:
            vm.idleTimeoutSeconds !== null &&
            vm.idleTimeoutSeconds !== undefined &&
            vm.idleTimeoutSeconds > 0
              ? { seconds: vm.idleTimeoutSeconds, action: "suspend" }
              : null,
        },
        resources: vmSize(vm),
      });

      const partialCreate = (
        id: string,
        identity: { operationId: string; submissionId: string },
      ) => ({
        kind: "create" as const,
        status: "partial" as const,
        sandbox: sandboxReference("freestyle", scope, id, {
          operation: identity.operationId,
          submission: identity.submissionId,
        }),
        setup: { expiry: "acknowledged" as const, readiness: "unconfirmed" as const },
      });

      /** Poll a read until it settles, the local wait ends, or the caller aborts. */
      const settle = async <T>(
        signal: AbortSignal,
        check: (ctx: ReadContext) => Promise<T | undefined>,
      ): Promise<T | undefined> => {
        const until = Date.now() + settleSeconds * 1000;

        for (;;) {
          const value = await check(readContext(signal));

          if (value !== undefined || Date.now() + pollMs > until) return value;
          await delay(pollMs, signal);
        }
      };

      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native SDK throws are normalized at this boundary.
      const rejection = (ctx: AttemptContext, error: unknown, reason: string) => {
        const native = failure(error);

        return refusedBeforeEffect(native)
          ? ctx.reject(native.error.code, native.error.message)
          : ctx.unknown(`${reason}; do not replay`);
      };

      const partialRestore = (
        id: string,
        identity: { operationId: string; submissionId: string },
      ) => ({
        kind: "snapshot_restore" as const,
        status: "unknown" as const,
        sandbox: sandboxReference("freestyle", scope, id, {
          operation: identity.operationId,
          submission: identity.submissionId,
        }),
        mounts: [],
      });

      type PartialOutcome = (
        id: string,
        identity: { operationId: string; submissionId: string },
      ) => OperationOutcome;

      /** A running VM completes the create; anything else stays pending or unknown. */
      const launched = (
        vm: VmData | null,
        token: z.infer<typeof CreateToken>,
        identity: { operationId: string; submissionId: string },
        settle: Pick<ObserveContext<z.infer<typeof CreateToken>>, "pending" | "unknown">,
        partial: PartialOutcome = partialCreate,
      ) => {
        if (!vm)
          return settle.unknown(
            token.id
              ? "Freestyle VM disappeared before it was running; nothing remains to clean up"
              : "Freestyle create response was lost and no VM carries this attempt's slug; inspect inventory without replay",
          );

        if (vm.slug !== token.slug || (token.id !== undefined && vm.id !== token.id))
          return settle.unknown("Freestyle VM identity differs from the attempt; do not replay");

        if (vm.state === "running")
          return {
            id: vm.id,
            reference: sandboxReference("freestyle", scope, vm.id, {
              operation: identity.operationId,
              submission: identity.submissionId,
            }),
            state: "running" as const,
          };

        if (vm.state === "starting")
          return settle.pending({ ...token, id: vm.id }, { pollAfterMs: pollMs });

        return settle.unknown(
          `Freestyle VM is ${vm.state} before it was running; inspect or destroy it`,
          partial(vm.id, identity),
        );
      };

      /** Exactly one create request; a lost response is found again by the attempt's slug. */
      const launch = async (
        input: CreateInput,
        ctx: AttemptContext<z.infer<typeof CreateToken>>,
        partial: PartialOutcome = partialCreate,
      ) => {
        const slug = attemptSlug(ctx.submissionId);

        const request: CreateVmOptions = {
          snapshotId: input.image.value,
          slug,
          ttlSeconds: input.lifetimeSeconds ?? config.lifecycle.lifetimeSeconds,
          firewall: firewall(input.networkPolicy),
        };

        if (config.lifecycle.idleSeconds !== undefined)
          request.idleTimeoutSeconds = config.lifecycle.idleSeconds;

        if (input.labels && Object.keys(input.labels).length) request.metadata = input.labels;
        const tls = previews(slug);

        if (tls) request.tls = tls;

        const env = input.env && Object.keys(input.env).length ? input.env : undefined;
        // The env requirement is saved before dispatch, so a recovered attempt still demands
        // the env file's marker before it reports the VM as ready.
        await ctx.checkpoint(env ? { slug, env: true } : { slug });
        let created: VmData;

        try {
          created = (await api(ctx.signal).vms.create(request)).data;
        } catch (error) {
          return rejection(
            ctx,
            error,
            "Freestyle create response was not confirmed; observe finds the VM by its slug",
          );
        }

        const id = Id.safeParse(created.id);

        if (!id.success || created.slug !== slug)
          return ctx.unknown("Freestyle create acknowledgement does not match the attempt");
        const token: z.infer<typeof CreateToken> = { slug, id: id.data };

        if (env) token.env = true;

        try {
          await ctx.checkpoint(token);
        } catch (error) {
          if (error instanceof AdapterCheckpointError) error.outcome = partial(id.data, ctx);
          throw error;
        }

        try {
          const result = await settle(ctx.signal, async (read) => {
            const current = created.state === "running" ? created : await find(id.data, read);

            return current?.state === "starting" ? undefined : { current };
          });

          if (result?.current?.state === "running" && env) {
            try {
              await api(callSignal(readContext(ctx.signal, 60)))
                .vms.ref(id.data)
                .fs.writeFile(ENV_FILE, envFile(env, slug), { mode: 0o644 });
            } catch {
              return ctx.unknown(
                "Freestyle VM is running but its sandbox environment was not confirmed; destroy it",
                partial(id.data, ctx),
              );
            }
          }

          if (result) return launched(result.current, token, ctx, ctx, partial);
        } catch {
          /* A failed readiness read is not evidence; continue through observation. */
        }

        return ctx.pending(token, { pollAfterMs: pollMs });
      };

      /**
       * Observation of a create or restore. A recovered attempt cannot rewrite the environment
       * (values are never saved), so a running VM completes only when the attempt's env file
       * is in place.
       */
      const observeLaunch = async (
        token: z.infer<typeof CreateToken>,
        attempt: { operationId: string; submissionId: string },
        ctx: ObserveContext<z.infer<typeof CreateToken>>,
        partial: PartialOutcome,
      ) => {
        const vm = token.id ? await find(token.id, ctx) : await findBySlug(token.slug, ctx);

        if (vm?.state === "running" && token.env) {
          const written = await api(callSignal(ctx))
            .vms.ref(vm.id)
            .fs.readTextFile(ENV_FILE)
            .then(
              (text) => text.startsWith(`${envMarker(token.slug)}\n`),
              () => false,
            );

          if (!written)
            return ctx.unknown(
              "Freestyle VM is running but its sandbox environment was never written; destroy it",
              partial(vm.id, attempt),
            );
        }

        return launched(vm, token, attempt, ctx, partial);
      };

      const firewall = (policy: string): FirewallSpec =>
        policy === "internet"
          ? { rules: [{ action: "allow", source: {}, destination: { public: true } }] }
          : { rules: [] };

      /** Create-time TLS rules publish each configured port and are deleted with the VM. */
      const previews = (slug: string): TlsSpec | undefined =>
        config.preview.ports.length
          ? {
              rules: config.preview.ports.map((port) => ({
                action: "allow" as const,
                domain: previewDomain(slug, port),
                source: { public: true as const },
                destination: { port },
              })),
            }
          : undefined;

      /** Run one command once and collect its result, or explain why the outcome is unknown. */
      const runCommand = async (
        input: ExecInput,
        ctx: AttemptContext,
      ): Promise<
        WrapperResult | ReturnType<AttemptContext["unknown"]> | ReturnType<AttemptContext["reject"]>
      > => {
        const vm = api(callSignal(readContext(ctx.signal, input.deadlineSeconds + 60))).vms.ref(
          input.sandbox.id,
        );

        const request: ExecOptions = {
          command: wrapperScript({
            ...input,
            stdin: input.stdin !== undefined,
            maxBytes: input.maxOutputBytes,
          }),
          timeoutMs: Math.max(1, Math.ceil(input.deadlineSeconds)) * 1000,
        };

        if (input.stdin !== undefined) request.stdin = base64(input.stdin);
        let response;

        try {
          response = await vm.exec(request);
        } catch (error) {
          return rejection(ctx, error, "Freestyle command response was not confirmed");
        }

        if (response.statusCode === null || response.statusCode === undefined)
          return ctx.unknown(
            `Freestyle stopped the command at its ${input.deadlineSeconds}s deadline; output is unavailable`,
          );

        const record = parseWrapper(response.stdout ?? "");

        if (!record)
          return ctx.unknown(
            "Freestyle ran the command but its result record could not be decoded",
          );

        if ("stdout" in record) return record;

        const files = api(
          callSignal(readContext(ctx.signal, 120)),
          input.maxOutputBytes + 1024,
        ).vms.ref(input.sandbox.id).fs;

        // The exit code is already confirmed; a stream that cannot be downloaded is reported as
        // truncated, never by discarding the result.
        const download = (stream: "stdout" | "stderr") =>
          files.readFile(`${record.directory}/${stream}`).catch(() => null);

        const stdout = await download("stdout");
        const stderr = await download("stderr");

        if (!stdout || !stderr)
          // The directory is left in /tmp so its output can still be read from the guest.
          return {
            exitCode: record.exitCode,
            stdout: stdout ?? new Uint8Array(),
            stderr: stderr ?? new Uint8Array(),
            truncated: true,
          };

        const assembled = filesResult(record, stdout, stderr, input.maxOutputBytes);

        if (!assembled)
          return ctx.unknown("Freestyle command output is longer than its recorded length");

        // Best effort, and only once every byte arrived: a short download leaves the directory
        // in /tmp so the rest of the output can still be read from the guest.
        if (assembled.complete)
          await api(callSignal(readContext(ctx.signal, 15)))
            .vms.ref(input.sandbox.id)
            .exec({ command: `rm -rf -- ${quote(record.directory)}`, timeoutMs: 10_000 })
            .catch(() => undefined);

        return assembled.result;
      };

      /**
       * One verified native PUT. Freestyle creates new files as the default user but replaces an
       * existing one as root, so the previous numeric owner is read first and restored as root;
       * commands then keep the access they had. The repair opens the path without following
       * symlinks and changes the owner only of the inode it verified (regular, root-owned, one
       * link, exactly the bytes written), so a concurrent swap cannot redirect it. Returns false
       * when the bytes were written but the owner could not be restored.
       */
      const putFile = async (
        vmId: string,
        path: string,
        bytes: Uint8Array,
        signal: AbortSignal,
      ): Promise<boolean> => {
        const vm = api(callSignal(readContext(signal, 120))).vms.ref(vmId);

        const asRoot = async (args: string[]) => {
          const result = await vm.exec({
            command: `python3 -c ${quote(OWNER_HELPER)} ${args.map(quote).join(" ")}`,
            linuxUser: "root",
            timeoutMs: 10_000,
          });

          if (result.statusCode !== 0)
            throw new AdapterError("UNAVAILABLE", "Freestyle file owner command failed");

          return (result.stdout ?? "").trim();
        };

        let owner: string;

        try {
          owner = await asRoot(["owner", path]);
        } catch (error) {
          throw error instanceof AdapterError ? error : failure(error).error;
        }

        const parsed = /^(\d{1,10}):(\d{1,10})$/.exec(owner);

        if (owner && !parsed)
          throw new AdapterError("UNAVAILABLE", "Freestyle file owner is malformed");

        await vm.fs.writeFile(path, bytes);

        if (!parsed || owner === "0:0") return true;
        const digest = createHash("sha256").update(bytes).digest("hex");

        return asRoot([
          "restore",
          path,
          parsed[1] ?? "",
          parsed[2] ?? "",
          String(bytes.byteLength),
          digest,
          "0",
        ]).then(
          (result) => result === "ok",
          () => false,
        );
      };

      /** One guest control command; anything but a clean exit is an error. */
      const guest =
        (vmId: string): GuestRunner =>
        async (command, ctx, stdin) => {
          const request: ExecOptions = {
            command,
            timeoutMs: Math.max(1000, Math.min(300_000, ctx.deadline - Date.now())),
          };

          if (stdin) request.stdin = base64(stdin);
          let response;

          try {
            response = await api(callSignal(ctx)).vms.ref(vmId).exec(request);
          } catch (error) {
            throw failure(error).error;
          }

          if (response.statusCode !== 0)
            throw new AdapterError(
              response.statusCode === null || response.statusCode === undefined
                ? "TIMEOUT"
                : "UNAVAILABLE",
              "Freestyle guest control command failed",
            );

          return response.stdout ?? "";
        };

      /** VMs this client is pausing or holds paused; their process observers stop polling. */
      const held = new Map<string, { inFlight: boolean; checkedAt: number }>();

      /** A confirmed running VM ends a hold that no suspend of this client still owns. */
      const release = (vmId: string) => {
        if (!held.get(vmId)?.inFlight) held.delete(vmId);
      };

      /**
       * Whether observers should skip a poll. Outside an in-flight suspend the hold is checked
       * against native state (an API read, which never wakes the VM) every two seconds, so a
       * VM started elsewhere or woken by traffic resumes observation.
       */
      const holding = async (vmId: string) => {
        const hold = held.get(vmId);

        if (!hold) return false;

        if (hold.inFlight || Date.now() - hold.checkedAt < 2000) return true;
        hold.checkedAt = Date.now();

        const vm = await find(vmId, readContext(AbortSignal.timeout(10_000), 10)).catch(
          () => undefined,
        );

        if (vm?.state !== "running") return true;
        release(vmId);

        return held.has(vmId);
      };

      const jobOptions = (vmId: string) => ({
        held: () => holding(vmId),
        run: guest(vmId),
        pollMs: options.processPollMs ?? 250,
        requestSeconds: 60,
      });

      const files = (vmId: string) =>
        filesystem(guest(vmId), async (path, offset, length, ctx) => {
          const route = `/v5/vms/${encodeURIComponent(vmId)}/fs/read?${new URLSearchParams({ path })}`;
          let response: Response;

          try {
            // The raw route, because EOF evidence is in the `Content-Range` header.
            response = await api(callSignal(ctx), length + 1024).fetch(route, {
              method: "GET",
              headers: { range: `bytes=${offset}-${offset + length - 1}` },
            });
          } catch (error) {
            throw failure(error).error;
          }

          if (!response.ok && response.status !== 416) {
            // A proxy can answer with plain text; the error keeps its status with a known code.
            const parsed = ApiErrorBody.safeParse(await response.json().catch(() => undefined));

            const body = parsed.success
              ? parsed.data
              : { code: "UNKNOWN_ERROR", message: `HTTP ${response.status}` };

            throw failure(new FreestyleApiError(response.status, body, route)).error;
          }

          const result = await rangeResult(response, offset, length);

          if (!result) throw new AdapterError("UNAVAILABLE", "Freestyle file range is malformed");

          return result;
        });

      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Helper throws are normalized at this boundary.
      const fileRejection = (ctx: AttemptContext, error: unknown) => {
        if (error instanceof AdapterFilesystemError && error.details.effect !== "none")
          return ctx.unknown(
            "Freestyle filesystem operation may have changed the requested path; do not replay",
          );

        if (error instanceof AdapterError) return ctx.reject(error.code, error.message);

        return ctx.unknown("Freestyle filesystem response was not confirmed; do not replay");
      };

      const pty: PtyDriver = options.pty ?? {
        open: (vmId, request) => api(host.signal).vms.ref(vmId).pty.open(request),
        attach: (vmId, request) => api(host.signal).vms.ref(vmId).pty.attach(request),
        list: async (vmId, ctx) =>
          (await read(ctx, (native) => native.vms.ref(vmId).pty.list())).sessions,
      };

      const listedReference = (vm: VmData): SandboxReference | null =>
        Id.safeParse(vm.id).success
          ? {
              version: 1,
              kind: "sandbox",
              provider: "freestyle",
              scope,
              nativeId: vm.id,
              ownership: "unknown",
            }
          : null;

      const page = async (input: { cursor?: string; limit: number }, ctx: ReadContext) => {
        const offset = input.cursor === undefined ? 0 : Number(input.cursor);

        if (!Number.isSafeInteger(offset) || offset < 0)
          throw new AdapterError("INVALID_ARGUMENT", "Invalid Freestyle VM cursor");
        const limit = Math.min(100, input.limit);
        const listed = await read(ctx, (native) => native.vms.list({ limit, offset }));
        const next = offset + listed.vms.length;

        return {
          vms: listed.vms.filter((vm) => Id.safeParse(vm.id).success),
          nextCursor:
            listed.vms.length === limit && next < listed.totalCount ? String(next) : undefined,
        };
      };

      const snapshotRef = (
        id: string,
        ownership: ResourceReference["ownership"] = "unknown",
      ): ResourceReference<"snapshot"> => ({
        version: 1,
        kind: "snapshot",
        provider: "freestyle",
        scope,
        nativeId: id,
        ownership,
      });

      const checkedSnapshot = (ref: ResourceReference) => {
        assertResourceScope(ref, { provider: "freestyle", scope });

        if (
          ref.kind !== "snapshot" ||
          ref.generation !== undefined ||
          !Id.safeParse(ref.nativeId).success
        )
          throw new AdapterError("CONFLICT", "Invalid Freestyle snapshot identity");

        return ref.nativeId;
      };

      /** A snapshot, or null once Freestyle no longer has it. */
      const findSnapshot = async (id: string, ctx: ReadContext): Promise<SnapshotData | null> => {
        try {
          const snapshot = await api(callSignal(ctx)).vms.snapshots.get(id);

          if (snapshot.id !== id)
            throw new AdapterError("CONFLICT", "Freestyle returned a different snapshot identity");

          return snapshot;
        } catch (error) {
          const native = failure(error);

          if (native.status === 404) return null;
          throw native.error;
        }
      };

      const requireSnapshot = async (ref: ResourceReference, ctx: ReadContext) => {
        const snapshot = await findSnapshot(checkedSnapshot(ref), ctx);

        if (!snapshot) throw new AdapterError("NOT_FOUND", "Freestyle snapshot is unavailable");

        return snapshot;
      };

      /** Finds an attempt's snapshot by its slug among the source VM's snapshots. */
      const findSnapshotBySlug = async (
        slug: string,
        source: string,
        ctx: ReadContext,
      ): Promise<SnapshotData | null> => {
        const matches: SnapshotData[] = [];

        for (let offset = 0; ;) {
          const listed = await read(ctx, (native) =>
            native.vms.snapshots.list({ sourceVmId: source, limit: 100, offset }),
          );

          matches.push(...listed.snapshots.filter((snapshot) => snapshot.slug === slug));
          offset += listed.snapshots.length;

          if (!listed.snapshots.length || offset >= listed.totalCount) break;
        }

        if (matches.length > 1)
          throw new AdapterError("CONFLICT", "Freestyle returned several snapshots for one slug");

        return matches[0] ?? null;
      };

      const snapshotInfo = (snapshot: SnapshotData, ref: ResourceReference): SnapshotInfo => ({
        reference: ref,
        preserve: Preserve.FILESYSTEM_AND_MEMORY,
        restoreExecution: "resume",
        consistency: "unknown",
        source:
          snapshot.sourceVmId && Id.safeParse(snapshot.sourceVmId).success
            ? { id: snapshot.sourceVmId, class: "freestyle-vm" }
            : null,
        // Freestyle returns a snapshot only once VMs can be created from it.
        state: "ready",
        createdAt: listedTime(snapshot.createdAt),
        expiration: "unknown",
        excludedPaths: null,
        mounts: [],
        mountHandling: "none",
        restore: restoreSupport,
        dependencies: [],
        nativeDependencies: null,
      });

      const imageInfo = (snapshot: SnapshotData): ImageInfo => ({
        reference: {
          version: 1,
          kind: "image",
          provider: "freestyle",
          scope,
          nativeId: snapshot.id,
          ownership: "unknown",
        },
        state: "ready",
        createdAt: listedTime(snapshot.createdAt),
        source: null,
        visibility: snapshot.public ? "public" : "private",
        nativeDependencies: null,
      });

      const snapshotPage = async (input: { cursor?: string; limit: number }, ctx: ReadContext) => {
        const offset = input.cursor === undefined ? 0 : Number(input.cursor);

        if (!Number.isSafeInteger(offset) || offset < 0)
          throw new AdapterError("INVALID_ARGUMENT", "Invalid Freestyle snapshot cursor");
        const limit = Math.min(100, input.limit);
        const listed = await read(ctx, (native) => native.vms.snapshots.list({ limit, offset }));
        const next = offset + listed.snapshots.length;

        return {
          snapshots: listed.snapshots.filter((snapshot) => Id.safeParse(snapshot.id).success),
          nextCursor:
            listed.snapshots.length === limit && next < listed.totalCount
              ? String(next)
              : undefined,
        };
      };

      const captureResult = (
        token: z.infer<typeof CaptureToken>,
        snapshot: SnapshotData | null,
        settle: Pick<ObserveContext<z.infer<typeof CaptureToken>>, "unknown">,
      ) => {
        if (!snapshot)
          return settle.unknown(
            "Freestyle snapshot response was lost and no snapshot carries this attempt's slug; list snapshots without replay",
          );

        if (
          snapshot.slug !== token.slug ||
          snapshot.sourceVmId !== token.source ||
          (token.id !== undefined && snapshot.id !== token.id) ||
          !Id.safeParse(snapshot.id).success
        )
          return settle.unknown(
            "Freestyle snapshot identity differs from the attempt; do not replay",
          );
        const ref = snapshotRef(snapshot.id, "verified-created");

        return {
          snapshot: snapshotInfo(snapshot, ref),
          capture: {
            preserve: snapshotProfile.preserve,
            interruption: snapshotProfile.interruption,
            restoreExecution: snapshotProfile.restoreExecution,
          },
          source: { state: token.sourceState, connections: snapshotProfile.connections },
          retainedResources: [ref],
        };
      };

      const session: AdapterSession<
        CreateInput,
        Sandbox,
        ExecInput,
        FileWriteInput,
        "argv" | "shell",
        z.infer<typeof CreateToken>
      > = {
        scope,
        defaultImage: { kind: "prepared", value: image },
        defaultNetworkPolicy: config.network,
        supports: {
          images: ["prepared"],
          network: ["blocked", "internet"],
          exec: { commands: ["argv", "shell"], maxOutputBytes: MAX_OUTPUT_BYTES },
          fileWrite: { overwrite: true, noClobber: true },
          createEnv: true,
          lifetime: { minSeconds: 60, maxSeconds: MAX_TTL_SECONDS },
        },
        create: {
          recovery: { version: 1, token: CreateToken },
          async prepare(input) {
            if (input.image.kind !== "prepared")
              throw new AdapterError(
                "UNSUPPORTED",
                "Freestyle boots snapshots only; OCI images are unavailable",
              );

            if (!Image.safeParse(input.image.value).success)
              throw new AdapterError(
                "INVALID_ARGUMENT",
                "Freestyle images are a snapshot id, your snapshot slug or a public owner/slug",
              );

            if (input.networkPolicy !== "blocked" && input.networkPolicy !== "internet")
              throw new AdapterError(
                "UNSUPPORTED",
                "Freestyle network policies are blocked and internet; allowlists are unavailable",
              );

            if (config.resources && input.image.value !== image) {
              const size = UBUNTU_SIZES.find((candidate) => candidate.image === input.image.value);

              if (
                !size ||
                (config.resources.vcpus !== undefined && size.vcpus < config.resources.vcpus) ||
                (config.resources.memoryMiB !== undefined &&
                  size.memoryMiB < config.resources.memoryMiB)
              )
                throw new AdapterError(
                  "UNSUPPORTED",
                  "This image may not meet the configured resources; Freestyle snapshots keep the size they were built with",
                );
            }

            if (input.region !== undefined || input.mounts?.length || input.requirements)
              throw new AdapterError(
                "UNSUPPORTED",
                "Freestyle has no region selection, volume mounts or snapshot requirements",
              );

            if (input.labels && !Labels.safeParse(input.labels).success)
              throw new AdapterError(
                "INVALID_ARGUMENT",
                "Freestyle labels allow at most 64 entries with keys and values up to 63 characters",
              );
            checkEnv(input.env);

            return input;
          },
          submit: (input, ctx) => launch(input, ctx),
          async observe(attempt, ctx) {
            const token = CreateToken.safeParse(attempt.token);

            if (!token.success || token.data.slug !== attemptSlug(attempt.submissionId))
              return ctx.unknown("Freestyle create identity is unavailable; do not replay");

            return observeLaunch(token.data, attempt, ctx, partialCreate);
          },
        },
        async inspect(box, ctx) {
          if (box.reference) checkedRef(box.reference);
          const vm = await find(box.id, ctx);

          return vm ? { id: vm.id, ...observation(vm, box.reference ?? null) } : null;
        },
        async reopen(ref, ctx) {
          checkedRef(ref);

          return observation(await requireVm({ id: ref.nativeId, reference: ref }, ctx), ref);
        },
        async inventory(input, ctx) {
          const listed = await page(input, ctx);

          return {
            items: listed.vms.map((vm) => ({
              id: vm.id,
              state: vm.state === "running" ? ("running" as const) : ("unknown" as const),
            })),
            nextCursor: listed.nextCursor,
          };
        },
        async sandboxList(input, ctx) {
          const listed = await page(input, ctx);

          return {
            // Freestyle lists every VM the API key's account owns; none carries creation proof.
            coverage: "provider-scope" as const,
            items: listed.vms.map((vm) => ({
              id: vm.id,
              state: state(vm.state),
              reference: listedReference(vm),
              labels: listedLabels(vm.metadata, () => false),
              createdAt: listedTime(vm.createdAt),
            })),
            nextCursor: listed.nextCursor,
          };
        },
        destroy: {
          recovery: { version: 1, token: DestroyToken },
          async prepare(input, ctx) {
            await requireVm(input, ctx);

            return input;
          },
          async submit(input, ctx) {
            const token = { id: Id.parse(input.id), acknowledged: false };
            await ctx.checkpoint(token);

            try {
              await api(callSignal(readContext(ctx.signal))).vms.delete(token.id);
            } catch (error) {
              const native = failure(error);

              if (refusedBeforeEffect(native))
                return ctx.reject(native.error.code, native.error.message);

              return ctx.pending(token, { pollAfterMs: pollMs });
            }

            const acknowledged = { ...token, acknowledged: true };
            await ctx.checkpoint(acknowledged);

            try {
              const gone = await settle(ctx.signal, async (read) =>
                (await find(token.id, read)) ? undefined : true,
              );

              if (gone) return { computeStopped: true, retainedResources: [] };
            } catch {
              /* Deletion is acknowledged; completion continues through observation. */
            }

            return ctx.pending(acknowledged, { pollAfterMs: pollMs });
          },
          async observe(attempt, ctx) {
            const token = DestroyToken.safeParse(attempt.token);

            if (!token.success || token.data.id !== attempt.sandbox?.id)
              return ctx.unknown("Freestyle deletion identity is unavailable; do not replay");

            if (!(await find(token.data.id, ctx)))
              return { computeStopped: true, retainedResources: [] };

            return token.data.acknowledged
              ? ctx.pending(token.data, { pollAfterMs: pollMs })
              : ctx.unknown(
                  "Freestyle delete response was lost and the VM still exists; destroy it again explicitly",
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
              throw new AdapterError(
                "CAPACITY",
                "Freestyle process capture exceeds its byte bound",
              );
            // Validates argv, env names and NUL bytes before any effect.
            commandLine(input);
            await requireRunning(input.sandbox, ctx);
            const format = input.output?.format ?? "text";

            if (input.terminal) {
              if (input.stdin === "closed")
                throw new AdapterError("UNSUPPORTED", "Freestyle terminals always take input");

              return openTerminal(
                pty,
                {
                  vmId: input.sandbox.id,
                  command: commandLine({ ...input, env: { TERM: "xterm-256color", ...input.env } }),
                  terminal: input.terminal,
                  reference: {
                    version: 1,
                    kind: "freestyle-pty",
                    sandbox: input.sandbox.id,
                    session: terminalSlug(),
                  },
                  format,
                  capture: input.capture,
                },
                ctx,
              );
            }

            const directory = parseLauncher(
              await guest(input.sandbox.id)(launcherScript(input), ctx),
            );

            if (!directory)
              throw new AdapterError("UNAVAILABLE", "Freestyle process start was not acknowledged");

            return observeJob(
              jobOptions(input.sandbox.id),
              {
                version: 1,
                kind: "freestyle-job",
                sandbox: input.sandbox.id,
                directory,
                stdin: input.stdin ?? "closed",
              },
              { format, capture: input.capture, fromEnd: false },
              ctx,
            );
          },
          async reopen(input, ctx) {
            await requireRunning(input.sandbox, ctx);
            release(input.sandbox.id);
            const job = ProcessReference.safeParse(input.reference);
            const terminal = TerminalReference.safeParse(input.reference);

            if (
              job.success &&
              job.data.sandbox === input.sandbox.id &&
              input.profile === "process" &&
              job.data.stdin === input.stdin
            )
              return observeJob(
                jobOptions(input.sandbox.id),
                job.data,
                { format: input.output.format, fromEnd: true },
                ctx,
              );

            if (
              terminal.success &&
              terminal.data.sandbox === input.sandbox.id &&
              input.profile === "terminal"
            )
              return openTerminal(
                pty,
                {
                  vmId: input.sandbox.id,
                  reference: terminal.data,
                  format: input.output.format,
                },
                ctx,
              );

            throw new AdapterError(
              "CONFLICT",
              "Process reference does not belong to this Freestyle VM and profile",
            );
          },
        },
        exec: {
          finiteStdin: "bytes",
          async prepare(input, ctx) {
            if (input.deadlineSeconds > MAX_EXEC_SECONDS)
              throw new AdapterError(
                "INVALID_ARGUMENT",
                `Freestyle commands run for at most ${MAX_EXEC_SECONDS} seconds`,
              );

            if (input.stdin !== undefined && input.stdin.byteLength > MAX_STDIN_BYTES)
              throw new AdapterError(
                "CAPACITY",
                `Freestyle command stdin is limited to ${MAX_STDIN_BYTES} bytes`,
              );
            // Validates argv, env names and NUL bytes before any effect.
            wrapperScript({ ...input, stdin: false, maxBytes: input.maxOutputBytes });
            await requireRunning(input.sandbox, ctx);

            return input;
          },
          submit: (input, ctx) => runCommand(input, ctx),
        },
        async preview(input, ctx) {
          // Inbound traffic can wake an idle-paused VM, so only running compute gets access.
          const vm = await requireRunning(input.sandbox, ctx);

          const published = async () =>
            (await read(ctx, (native) => native.tls.rules.list({ vmId: vm.id }))).rules.find(
              (candidate) =>
                candidate.action === "allow" &&
                candidate.source.public === true &&
                candidate.destination.vmId === vm.id &&
                candidate.destination.port === input.port &&
                /^[a-z0-9-]{1,63}\.style\.dev$/.test(candidate.domain),
            );

          let rule = await published();

          // A port not published at create gets its style.dev rule now. The rule names the VM,
          // so Freestyle deletes it with the VM; a concurrent publish is found by listing again.
          if (!rule) {
            if (!vm.slug || !AttemptSlug.safeParse(vm.slug).success)
              throw new AdapterError(
                "UNSUPPORTED",
                "Only VMs created by Beachside get style.dev preview names",
              );

            try {
              await api(callSignal(ctx)).tls.rules.create({
                action: "allow",
                domain: previewDomain(vm.slug, input.port),
                source: { public: true },
                destination: { vmId: vm.id, port: input.port },
              });
            } catch (error) {
              const native = failure(error);

              if (native.status !== 409) throw native.error;
            }

            rule = await published();
          }

          if (!rule)
            throw new AdapterError("UNAVAILABLE", "Freestyle did not publish the preview port");

          return { access: "public", url: `https://${rule.domain}` };
        },
        files: {
          maxBytes: MAX_FILE_BYTES,
          async read(input, ctx) {
            await requireRunning(input.sandbox, ctx);
            const limit = Math.min(input.maxBytes ?? MAX_FILE_BYTES, MAX_FILE_BYTES);

            try {
              const bytes = await api(callSignal(ctx), limit + 1)
                .vms.ref(input.sandbox.id)
                .fs.readFile(input.path);

              if (bytes.byteLength > limit)
                throw new AdapterError("CAPACITY", "Freestyle file exceeds the read bound");

              return bytes;
            } catch (error) {
              throw failure(error).error;
            }
          },
          write: {
            async prepare(input, ctx) {
              if (input.bytes.byteLength > MAX_FILE_BYTES)
                throw new AdapterError("CAPACITY", "Freestyle file exceeds the write bound");
              await requireRunning(input.sandbox, ctx);

              return input;
            },
            async submit(input, ctx) {
              // A no-clobber write stages the bytes and publishes them with a hard link.
              if (!input.overwrite)
                try {
                  return await files(input.sandbox.id).write(
                    input.path,
                    [input.bytes],
                    false,
                    readContext(ctx.signal, 120),
                  );
                } catch (error) {
                  return fileRejection(ctx, error);
                }

              try {
                // One request, verified by sha256 and replaced atomically in the guest.
                if (!(await putFile(input.sandbox.id, input.path, input.bytes, ctx.signal)))
                  return ctx.unknown(
                    "Freestyle wrote the file but could not restore its owner; inspect it",
                  );
              } catch (error) {
                if (error instanceof AdapterError) return ctx.reject(error.code, error.message);

                return rejection(ctx, error, "Freestyle file write was not confirmed");
              }

              return { bytesWritten: input.bytes.byteLength };
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

            return files(input.sandbox.id).read(input.path, ctx);
          },
          async writeStream(input, ctx) {
            await requireRunning(input.sandbox, ctx);
            const iterator = input.bytes[Symbol.asyncIterator]();
            const head: Uint8Array[] = [];
            let size = 0;
            let ended = false;

            // An overwrite that ends within one native request goes as one sha256-verified PUT;
            // anything larger, or a no-clobber write, is staged and published in the guest.
            while (input.overwrite && size <= MAX_FILE_BYTES) {
              const next = await iterator.next();

              if (next.done) {
                ended = true;
                break;
              }

              head.push(next.value);
              size += next.value.length;
            }

            if (ended) {
              try {
                const restored = await putFile(
                  input.sandbox.id,
                  input.path,
                  new Uint8Array(Buffer.concat(head)),
                  ctx.signal,
                );

                if (!restored)
                  throw new AdapterFilesystemError(
                    "UNAVAILABLE",
                    "Freestyle wrote the file but could not restore its owner; inspect it",
                    {
                      effect: "applied",
                      source: input.path,
                      destination: input.path,
                      temporaryPaths: [],
                    },
                  );
              } catch (error) {
                if (error instanceof AdapterError) throw error;

                const native = failure(error);

                if (refusedBeforeEffect(native)) throw native.error;

                throw new AdapterFilesystemError(
                  "UNAVAILABLE",
                  "Freestyle file write was not confirmed; do not replay",
                  {
                    effect: "possible",
                    source: input.path,
                    destination: input.path,
                    temporaryPaths: [],
                  },
                );
              }

              ctx.retain?.({ effect: "applied", temporaryPaths: [], bytesTransferred: size });

              return { bytesWritten: size };
            }

            async function* rest() {
              yield* head;

              for (let next = await iterator.next(); !next.done; next = await iterator.next())
                yield next.value;
            }

            return files(input.sandbox.id).write(input.path, rest(), input.overwrite, ctx);
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

            const entries = await read(ctx, (native) =>
              native.vms.ref(input.sandbox.id).fs.readDir(input.path),
            );

            if (entries.length > MAX_DIRECTORY_ENTRIES)
              throw new AdapterError("CAPACITY", "Freestyle directory exceeds the listing bound");

            return entries.map((entry) => ({
              name: entry.name,
              type:
                entry.kind === "file" || entry.kind === "directory" || entry.kind === "symlink"
                  ? entry.kind
                  : "unknown",
            }));
          },
        },
        async suspensionCapabilities() {
          return {
            status: "supported",
            value: {
              preserve: Preserve.FILESYSTEM_AND_MEMORY,
              processes: "preserved",
              connections: "dropped",
            },
          };
        },
        async resumeCapabilities() {
          return {
            status: "supported",
            value: { sourceStates: ["suspended"], setsSessionTimeout: false },
          };
        },
        suspend: {
          recovery: { version: 1, token: LifecycleToken },
          async prepare(input, ctx) {
            const vm = await requireVm(input.sandbox, ctx);

            if (vm.state !== "running")
              throw new AdapterError(
                "CONFLICT",
                `Freestyle can pause only a running VM, not ${vm.state}`,
              );

            return {
              ...input,
              intent: { action: "suspend", preserve: Preserve.FILESYSTEM_AND_MEMORY },
            };
          },
          async submit(input, ctx) {
            const token = { id: Id.parse(input.sandbox.id), since: Date.now() };
            await ctx.checkpoint(token);
            // Process observers stop polling first: their guest commands keep the VM running.
            held.set(token.id, { inFlight: true, checkedAt: 0 });

            try {
              await api(callSignal(readContext(ctx.signal, 120)))
                .vms.ref(token.id)
                .pause();
            } catch (error) {
              held.delete(token.id);

              return rejection(ctx, error, "Freestyle pause response was not confirmed");
            }

            try {
              const paused = await settle(ctx.signal, async (read) => {
                const vm = await find(token.id, read);

                return vm?.state === "paused" ? vm : undefined;
              });

              if (paused) {
                held.set(token.id, { inFlight: false, checkedAt: Date.now() });

                return suspended(paused, input.sandbox.reference);
              }
            } catch {
              /* Pause is acknowledged; completion continues through observation. */
            }

            return ctx.pending(token, { pollAfterMs: pollMs });
          },
          async observe(attempt, ctx) {
            const token = LifecycleToken.safeParse(attempt.token);
            const box = attempt.sandbox;

            if (!token.success || !box?.reference || token.data.id !== box.id)
              return ctx.unknown("Freestyle pause identity is unavailable; do not replay");
            const vm = await find(token.data.id, ctx);

            if (!vm) {
              held.delete(token.data.id);

              return ctx.unknown("Freestyle VM disappeared while pausing");
            }

            if (vm.state === "paused") {
              held.set(vm.id, { inFlight: false, checkedAt: Date.now() });

              return suspended(vm, box.reference);
            }

            // An acknowledged pause that leaves the VM running is not waited on forever.
            const waiting =
              vm.state === "pausing" ||
              (vm.state === "running" &&
                Date.now() - (token.data.since ?? 0) < settleSeconds * 1000);

            if (waiting) return ctx.pending(token.data, { pollAfterMs: pollMs });
            held.delete(token.data.id);

            return ctx.unknown(
              vm.state === "running"
                ? "Freestyle acknowledged the pause but the VM kept running; inspect it before retrying"
                : `Freestyle VM is ${vm.state} after pause; inspect without replay`,
            );
          },
        },
        resume: {
          recovery: { version: 1, token: LifecycleToken },
          async prepare(input, ctx) {
            const vm = await requireVm(input.sandbox, ctx);

            if (vm.state !== "paused")
              throw new AdapterError(
                "CONFLICT",
                `Freestyle can resume only a paused VM, not ${vm.state}`,
              );

            return { ...input, intent: { action: "resume" } };
          },
          async submit(input, ctx) {
            const token = { id: Id.parse(input.sandbox.id) };
            await ctx.checkpoint(token);
            // Process observers resume polling once the VM is asked to run again.
            held.delete(token.id);

            try {
              await api(callSignal(readContext(ctx.signal, 120)))
                .vms.ref(token.id)
                .start();
            } catch (error) {
              return rejection(ctx, error, "Freestyle start response was not confirmed");
            }

            try {
              const ready = await settle(ctx.signal, async (read) => {
                const vm = await find(token.id, read);

                return vm?.state === "running" ? vm : undefined;
              });

              if (ready) return resumed(ready, input.sandbox.reference);
            } catch {
              /* Start is acknowledged; readiness continues through observation. */
            }

            return ctx.pending(token, { pollAfterMs: pollMs });
          },
          async observe(attempt, ctx) {
            const token = LifecycleToken.safeParse(attempt.token);
            const box = attempt.sandbox;

            if (!token.success || !box?.reference || token.data.id !== box.id)
              return ctx.unknown("Freestyle resume identity is unavailable; do not replay");
            const vm = await find(token.data.id, ctx);

            if (!vm) return ctx.unknown("Freestyle VM disappeared while resuming");

            if (vm.state === "running") return resumed(vm, box.reference);

            return vm.state === "paused" || vm.state === "starting"
              ? ctx.pending(token.data, { pollAfterMs: pollMs })
              : ctx.unknown(`Freestyle VM is ${vm.state} after resume; inspect without replay`);
          },
        },
        async renewCapabilities() {
          return {
            status: "supported",
            value: {
              minSeconds: 60,
              maxSeconds: MAX_TTL_SECONDS,
              stepSeconds: 1,
              scope: "sandbox",
            },
          };
        },
        renew: {
          async prepare(input, ctx) {
            await requireVm(input.sandbox, ctx);
            const forSeconds = input.forSeconds ?? config.lifecycle.lifetimeSeconds;

            if (forSeconds < 60 || forSeconds > MAX_TTL_SECONDS)
              throw new AdapterError(
                "INVALID_ARGUMENT",
                `Freestyle lifetimes are 60 to ${MAX_TTL_SECONDS} seconds`,
              );

            return { ...input, forSeconds };
          },
          async submit(input, ctx) {
            // `ttlSeconds` counts from creation, so the new deadline is the VM's age plus the window.
            const current = await find(input.sandbox.id, readContext(ctx.signal));

            if (!current)
              return ctx.reject("NOT_FOUND", "Freestyle VM is unavailable in the verified account");
            const created = Date.parse(current.createdAt);

            if (Number.isNaN(created))
              return ctx.reject("UNSUPPORTED", "Freestyle reported no usable creation time");

            const ttlSeconds =
              Math.ceil(Math.max(0, Date.now() - created) / 1000) + input.forSeconds;

            let vm: VmData;

            try {
              vm = await api(callSignal(readContext(ctx.signal)))
                .vms.ref(input.sandbox.id)
                .update({ ttlSeconds });
            } catch (error) {
              return rejection(ctx, error, "Freestyle lifetime update was not confirmed");
            }

            return {
              reference: input.sandbox.reference,
              requested: { forSeconds: input.forSeconds },
              acknowledged: true,
              observation:
                vm.id === input.sandbox.id ? observation(vm, input.sandbox.reference) : null,
            };
          },
        },
        snapshotProfiles: async () => snapshotSupport,
        snapshotCapture: {
          recovery: { version: 1, token: CaptureToken },
          async prepare(input, ctx) {
            const vm = await requireVm(input.sandbox, ctx);
            const plan = resolveSnapshot(snapshotSupport, input.request, state(vm.state));

            if (plan.status !== "supported") throw new AdapterError("UNSUPPORTED", plan.reason);

            return {
              ...input,
              expectation: { profile: plan.value.profile, sourceState: plan.value.sourceState },
            };
          },
          async submit(input, ctx) {
            const token: z.infer<typeof CaptureToken> = {
              slug: snapshotSlug(ctx.submissionId),
              source: Id.parse(input.sandbox.id),
              sourceState: input.expectation?.sourceState === "suspended" ? "suspended" : "running",
            };

            const request: CreateSnapshotOptions = { slug: token.slug };

            const ttlSeconds =
              input.request.retention?.cleanupAfterSeconds ?? config.snapshots?.retentionSeconds;

            if (ttlSeconds) request.ttlSeconds = ttlSeconds;

            await ctx.checkpoint(token);
            let created;

            try {
              created = await api(callSignal(readContext(ctx.signal, 600)))
                .vms.ref(token.source)
                .snapshot(request);
            } catch (error) {
              const native = failure(error);

              // A lost capture is found again by its attempt slug; it is never resent.
              return refusedBeforeEffect(native)
                ? ctx.reject(native.error.code, native.error.message)
                : ctx.pending(token, { pollAfterMs: pollMs });
            }

            const id = Id.safeParse(created.snapshotId);

            if (!id.success)
              return ctx.unknown(
                "Freestyle snapshot acknowledgement has no usable id; do not replay",
              );

            const tracked = { ...token, id: id.data };
            await ctx.checkpoint(tracked);

            return captureResult(tracked, { ...created.snapshot, id: id.data }, ctx);
          },
          async observe(attempt, ctx) {
            const token = CaptureToken.safeParse(attempt.token);

            if (
              !token.success ||
              token.data.source !== attempt.sandbox?.id ||
              token.data.slug !== snapshotSlug(attempt.submissionId)
            )
              return ctx.unknown("Freestyle capture identity is unavailable; do not replay");

            const snapshot = token.data.id
              ? await findSnapshot(token.data.id, ctx)
              : await findSnapshotBySlug(token.data.slug, token.data.source, ctx);

            return captureResult(token.data, snapshot, ctx);
          },
        },
        snapshotRestore: {
          recovery: { version: 1, token: CreateToken },
          options: {
            env: true,
            labels: true,
            lifetime: { minSeconds: 60, maxSeconds: MAX_TTL_SECONDS },
          },
          async prepare(input, ctx) {
            if (input.request.resources || input.request.mounts?.length)
              throw new AdapterError(
                "UNSUPPORTED",
                "Freestyle restores keep the snapshot's VM size and take no mounts",
              );

            if (!restoreSupport.networkPolicies.includes(input.request.networkPolicy))
              throw new AdapterError(
                "UNSUPPORTED",
                "Freestyle network policies are blocked and internet",
              );

            checkEnv(input.request.env);

            if (input.request.labels && !Labels.safeParse(input.request.labels).success)
              throw new AdapterError(
                "INVALID_ARGUMENT",
                "Freestyle labels allow at most 64 entries with keys and values up to 63 characters",
              );
            await requireSnapshot(input.snapshot, ctx);

            return input;
          },
          submit: (input, ctx) =>
            launch(
              {
                image: { kind: "prepared", value: input.snapshot.nativeId },
                networkPolicy: input.request.networkPolicy,
                labels: input.request.labels,
                env: input.request.env,
                lifetimeSeconds: input.request.lifetimeSeconds,
              },
              ctx,
              partialRestore,
            ),
          async observe(attempt, ctx) {
            const token = CreateToken.safeParse(attempt.token);

            if (
              !attempt.resource ||
              !token.success ||
              token.data.slug !== attemptSlug(attempt.submissionId)
            )
              return ctx.unknown("Freestyle restore identity is unavailable; do not replay");
            checkedSnapshot(attempt.resource);

            return observeLaunch(token.data, attempt, ctx, partialRestore);
          },
        },
        async snapshotInspect(ref, ctx) {
          return snapshotInfo(await requireSnapshot(ref, ctx), ref);
        },
        snapshotListCoverage: "provider-scope",
        async snapshotList(input, ctx) {
          const listed = await snapshotPage(input, ctx);

          return {
            // Freestyle lists every snapshot the account owns; none carries creation proof.
            items: listed.snapshots.map((snapshot) =>
              snapshotInfo(snapshot, snapshotRef(snapshot.id)),
            ),
            nextCursor: listed.nextCursor,
            coverage: "provider-scope" as const,
          };
        },
        snapshotDelete: {
          recovery: { version: 1, token: SnapshotDeleteToken },
          async prepare(ref, ctx) {
            await requireSnapshot(ref, ctx);

            return ref;
          },
          async submit(ref, ctx) {
            const token = { id: checkedSnapshot(ref) };
            await ctx.checkpoint(token);

            try {
              await api(callSignal(readContext(ctx.signal))).vms.snapshots.delete(token.id);
            } catch (error) {
              const native = failure(error);

              if (refusedBeforeEffect(native))
                return ctx.reject(native.error.code, native.error.message);

              return ctx.pending(token, { pollAfterMs: pollMs });
            }

            return { deleted: true as const, reference: ref };
          },
          async observe(attempt, ctx) {
            const token = SnapshotDeleteToken.safeParse(attempt.token);
            const ref = attempt.resource;

            if (!token.success || !ref || checkedSnapshot(ref) !== token.data.id)
              return ctx.unknown(
                "Freestyle snapshot deletion identity is unavailable; do not replay",
              );

            return (await findSnapshot(token.data.id, ctx))
              ? ctx.unknown(
                  "Freestyle snapshot still exists; deletion was not confirmed, so delete it again explicitly",
                )
              : { deleted: true as const, reference: ref };
          },
        },
        async imageInspect(ref, ctx) {
          assertResourceScope(ref, { provider: "freestyle", scope });

          if (ref.kind !== "image" || !Id.safeParse(ref.nativeId).success)
            throw new AdapterError("CONFLICT", "Invalid Freestyle image identity");
          const snapshot = await findSnapshot(ref.nativeId, ctx);

          if (!snapshot) throw new AdapterError("NOT_FOUND", "Freestyle snapshot is unavailable");

          return imageInfo(snapshot);
        },
        imageListCoverage: "provider-scope",
        async imageList(input, ctx) {
          const listed = await snapshotPage(input, ctx);

          return {
            // Every Freestyle snapshot the account owns boots as a prepared image.
            items: listed.snapshots.map(imageInfo),
            nextCursor: listed.nextCursor,
            coverage: "provider-scope" as const,
          };
        },
        async resourceCapabilities() {
          return {
            restore: { status: "supported", value: restoreSupport },
            volumes: { status: "unsupported", reason: "Freestyle has no volumes" },
            mounts: { status: "unsupported", reason: "Freestyle has no volume mounts" },
          };
        },
      };

      const suspended = (vm: VmData, reference: SandboxReference) => ({
        reference,
        preserve: Preserve.FILESYSTEM_AND_MEMORY,
        processes: "preserved" as const,
        connections: "dropped" as const,
        observation: observation(vm, reference),
      });

      const resumed = (vm: VmData, reference: SandboxReference) => ({
        reference,
        execution: "resumed" as const,
        executionIdentity: unknownSandboxFacts().execution,
        connections: "dropped" as const,
        observation: observation(vm, reference),
      });

      return session;
    },
  });
}

export const freestyleAdapter = createFreestyleAdapter();
