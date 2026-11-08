import { createHash } from "node:crypto";
import type {
  CreateVmOptions,
  ExecOptions,
  Freestyle,
  FirewallSpec,
  TlsSpec,
  VmData,
} from "freestyle";
import { z } from "zod";
import {
  AdapterCheckpointError,
  AdapterError,
  assertResourceScope,
  DEFAULT_LIFETIME_SECONDS,
  defineAdapter,
  listedLabels,
  listedTime,
  MAX_DIRECTORY_ENTRIES,
  Preserve,
  PreviewPort,
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
  type ObserveContext,
  type ReadContext,
  type Sandbox,
  type SandboxInfo,
  type SandboxReference,
  type SandboxResources,
  type SandboxState,
} from "@beachside/adapter";
import { filesResult, parseWrapper, quote, wrapperScript, type WrapperResult } from "./exec";
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
const CreateToken = z.strictObject({ slug: AttemptSlug, id: Id.optional() });

const DestroyToken = z.strictObject({ id: Id, acknowledged: z.boolean() });

const LifecycleToken = z.strictObject({ id: Id });

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

      /** A running VM completes the create; anything else stays pending or unknown. */
      const launched = (
        vm: VmData | null,
        token: z.infer<typeof CreateToken>,
        identity: { operationId: string; submissionId: string },
        settle: Pick<ObserveContext<z.infer<typeof CreateToken>>, "pending" | "unknown">,
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
          partialCreate(vm.id, identity),
        );
      };

      /** Exactly one create request; a lost response is found again by the attempt's slug. */
      const launch = async (
        input: CreateInput,
        ctx: AttemptContext<z.infer<typeof CreateToken>>,
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

        await ctx.checkpoint({ slug });
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
        const token = { slug, id: id.data };

        try {
          await ctx.checkpoint(token);
        } catch (error) {
          if (error instanceof AdapterCheckpointError) error.outcome = partialCreate(id.data, ctx);
          throw error;
        }

        try {
          const result = await settle(ctx.signal, async (read) => {
            const current = created.state === "running" ? created : await find(id.data, read);

            return current?.state === "starting" ? undefined : { current };
          });

          if (result) return launched(result.current, token, ctx, ctx);
        } catch {
          /* A failed readiness read is not evidence; continue through observation. */
        }

        return ctx.pending(token, { pollAfterMs: pollMs });
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

        // Best effort: the directory holds only this command's bounded output under /tmp.
        await api(callSignal(readContext(ctx.signal, 15)))
          .vms.ref(input.sandbox.id)
          .exec({ command: `rm -rf -- ${quote(record.directory)}`, timeoutMs: 10_000 })
          .catch(() => undefined);

        return (
          filesResult(record, stdout, stderr, input.maxOutputBytes) ??
          ctx.unknown("Freestyle command output does not match its recorded length")
        );
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
          fileWrite: { overwrite: true, noClobber: false },
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

            return input;
          },
          submit: (input, ctx) => launch(input, ctx),
          async observe(attempt, ctx) {
            const token = CreateToken.safeParse(attempt.token);

            if (!token.success || token.data.slug !== attemptSlug(attempt.submissionId))
              return ctx.unknown("Freestyle create identity is unavailable; do not replay");

            const vm = token.data.id
              ? await find(token.data.id, ctx)
              : await findBySlug(token.data.slug, ctx);

            return launched(vm, token.data, attempt, ctx);
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
          if (!config.preview.ports.includes(input.port))
            throw new AdapterError(
              "UNSUPPORTED",
              "This preview port was not configured at adapter setup",
            );
          const vm = await requireVm(input.sandbox, ctx);
          const rules = await read(ctx, (native) => native.tls.rules.list({ vmId: vm.id }));

          const rule = rules.rules.find(
            (candidate) =>
              candidate.action === "allow" &&
              candidate.source.public === true &&
              candidate.destination.vmId === vm.id &&
              candidate.destination.port === input.port &&
              /^[a-z0-9-]{1,63}\.style\.dev$/.test(candidate.domain),
          );

          if (!rule)
            throw new AdapterError(
              "UNSUPPORTED",
              "This VM has no style.dev rule for the port; preview ports are published at create",
            );

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
              if (!input.overwrite)
                throw new AdapterError(
                  "UNSUPPORTED",
                  "Freestyle file writes always replace the target; no-clobber creation is unavailable",
                );

              if (input.bytes.byteLength > MAX_FILE_BYTES)
                throw new AdapterError("CAPACITY", "Freestyle file exceeds the write bound");
              await requireRunning(input.sandbox, ctx);

              return input;
            },
            async submit(input, ctx) {
              try {
                // One request, verified by sha256 and replaced atomically in the guest.
                await api(callSignal(readContext(ctx.signal, 120)))
                  .vms.ref(input.sandbox.id)
                  .fs.writeFile(input.path, input.bytes);
              } catch (error) {
                return rejection(ctx, error, "Freestyle file write was not confirmed");
              }

              return { bytesWritten: input.bytes.byteLength };
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
            const token = { id: Id.parse(input.sandbox.id) };
            await ctx.checkpoint(token);

            try {
              await api(callSignal(readContext(ctx.signal, 120)))
                .vms.ref(token.id)
                .pause();
            } catch (error) {
              return rejection(ctx, error, "Freestyle pause response was not confirmed");
            }

            try {
              const paused = await settle(ctx.signal, async (read) => {
                const vm = await find(token.id, read);

                return vm?.state === "paused" ? vm : undefined;
              });

              if (paused) return suspended(paused, input.sandbox.reference);
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

            if (!vm) return ctx.unknown("Freestyle VM disappeared while pausing");

            if (vm.state === "paused") return suspended(vm, box.reference);

            return vm.state === "pausing" || vm.state === "running"
              ? ctx.pending(token.data, { pollAfterMs: pollMs })
              : ctx.unknown(`Freestyle VM is ${vm.state} after pause; inspect without replay`);
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
        async resourceCapabilities() {
          return {
            restore: { status: "unsupported", reason: "Freestyle snapshots are not supported yet" },
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
