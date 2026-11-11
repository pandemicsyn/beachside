import { createHash } from "node:crypto";
import type { ExedevClient, NewOptions, VM } from "@exedev/sdk";
import { quote as sdkQuote } from "@exedev/sdk";
import { z } from "zod";
import {
  AdapterCheckpointError,
  AdapterError,
  AdapterFilesystemError,
  assertResourceScope,
  defineAdapter,
  listedTime,
  Preserve,
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
  type OperationOutcome,
  type ReadContext,
  type Sandbox,
  type SandboxInfo,
  type SandboxReference,
  type SandboxResources,
  type SandboxState,
} from "@beachside/adapter";
import {
  checkEnv,
  commandLine,
  ENV_FILE,
  envFile,
  envMarker,
  parseWrapper,
  quote,
  wrapperScript,
} from "./exec";
import { directoryValue, Exists, filesystem, statValue } from "./filesystem";
import {
  launcherScript,
  observeJob,
  parseLauncher,
  ProcessReference,
  type GuestRunner,
} from "./process";
import { parseSigningKey, signToken, type SigningKey } from "./sshsig";
import {
  createExeClient,
  EXE_DEV_API,
  MAX_REQUEST_BYTES,
  nativeFailure,
  refusedBeforeEffect,
  type NativeFailure,
  type NativeFetch,
} from "./transport";

/** exe.dev's default image: Ubuntu with common tools, Python 3 and the setup service. */
export const DEFAULT_IMAGE = "exeuntu";

/** Longest a buffered command may run; exe.dev keeps a quiet `ssh` response alive. */
export const MAX_EXEC_SECONDS = 3600;

/** Combined stdout/stderr bound collected through the guest wrapper. */
export const MAX_OUTPUT_BYTES = 1_048_576;

/** Finite exec stdin, staged into a guest file before the command runs. */
export const MAX_STDIN_BYTES = 1_048_576;

/** Largest file read or written in one call. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** The tag every VM this adapter creates carries; tag-scoped keys can be limited to it. */
export const MARKER_TAG = "beachside";

/**
 * Prefix of the VM comment that carries Beachside labels. exe.dev refuses comments with HTML
 * metacharacters (`<`, `>`, `&`, quotes), so labels are space-separated `key=value` pairs
 * with both sides percent-encoded: `beachside: team=core run=live`.
 */
const LABEL_PREFIX = "beachside:";

/** exe.dev keeps comments up to 200 bytes. */
const MAX_COMMENT_BYTES = 200;

/** Commands the adapter's own account tokens may run, when signed from an SSH key. */
const TOKEN_COMMANDS = [
  "whoami",
  "ls",
  "new",
  "rm",
  "cp",
  "ssh",
  "stat",
  "pause",
  "resume",
  "comment",
  "share show",
  "share port",
  "share set-public",
] as const;

/** Lifetime of an adapter-signed account token; a fresh one is signed before it lapses. */
const TOKEN_SECONDS = 3600;

/** Lifetime of a signed preview token for one VM. */
const PREVIEW_SECONDS = 3600;

/** Ports exe.dev's HTTPS proxy forwards on `https://<vm>.exe.xyz:<port>/`. */
const ALTERNATE_PORTS = { min: 3000, max: 9999 };

/**
 * Sizes Beachside asks for, smallest first: whole vCPUs with 2 GiB each, the most a
 * standalone VM may have. Pooled VMs can be sized up to the pool's or plan's capacity.
 */
const SIZES = [1, 2, 4, 8, 16, 32].map((vcpus) => ({ vcpus, memoryMiB: vcpus * 2048 }));

/** An OCI image reference as `new --image` takes it. */
const Image = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/, "Use an OCI image reference such as ubuntu:24.04");

const Configuration = z
  .strictObject({
    /** exe.dev has no blocked egress this adapter can set at create; say `internet`. */
    network: z.literal("internet").optional(),
    /** Default OCI image; omitted, exe.dev's `exeuntu`. */
    image: Image.optional(),
    /** Minimum size; the smallest whole-vCPU size with 2 GiB per vCPU that meets it. */
    resources: ResourceMinimums.optional(),
    /**
     * Where new VMs go: `default` follows the account's placement (a Personal plan's shared
     * capacity, or a team's default pool); `standalone` reserves capacity per VM, billed by the
     * second; `{ pool }` names a team pool.
     */
    placement: z
      .union([
        z.enum(["default", "standalone"]),
        z.strictObject({
          pool: z
            .string()
            .min(1)
            .max(128)
            .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
        }),
      ])
      .default("default"),
    preview: z
      .strictObject({
        /**
         * `protected` (the default) signs a short-lived token for the VM's HTTPS proxy and
         * needs the `sshKey` credential; `public` makes the VM's web port public.
         */
        access: z.enum(["protected", "public"]).default("protected"),
      })
      .default({ access: "protected" }),
  })
  .superRefine((value, ctx) => {
    if (value.network === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["network"],
        message:
          'Configure network: "internet"; this exe.dev adapter cannot block egress at create yet',
      });
  })
  .transform(({ network, ...value }) => ({ ...value, networkPolicy: network ?? "internet" }));

const Credentials = z
  .strictObject({
    /** An exe.dev HTTPS API token (`exe0.` or `exe1.`). */
    token: z
      .string()
      .regex(/^exe[01]\.\S+$/, "exe.dev tokens start with exe0. or exe1.")
      .optional(),
    /**
     * An unencrypted OpenSSH Ed25519 private key added to the account (ideally with
     * `ssh-key add --tag=beachside`). The adapter signs short-lived tokens from it locally.
     */
    sshKey: z.string().min(1).optional(),
  })
  .refine((value) => value.token !== undefined || value.sshKey !== undefined, {
    message: "Supply an exe.dev token, an sshKey, or both",
  });

/** VM names this adapter mints: one per create attempt, derived from its submission id. */
const AttemptName = z.string().regex(/^bs-[0-9a-f]{24}$/);

const VmName = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/);

/** The name is saved before dispatch, so a lost create can still be found by it. */
const CreateToken = z.strictObject({
  name: AttemptName,
  /** The create also writes a sandbox-wide env file; the values themselves are never saved. */
  env: z.literal(true).optional(),
  /** exe.dev acknowledged the create. */
  acknowledged: z.literal(true).optional(),
});

type CreateToken = z.infer<typeof CreateToken>;

const DestroyToken = z.strictObject({ name: VmName });

const LifecycleToken = z.strictObject({
  name: VmName,
  /** When the request was submitted, epoch milliseconds. */
  since: z.number().int().nonnegative(),
});

/** Beachside label limits, kept inside the 200-byte VM comment as compact JSON. */
const Labels = z.record(z.string().min(1).max(64), z.string().max(256));

/** Percent-encode everything but unreserved characters, so no comment metacharacter remains. */
function labelWord(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function attemptName(submissionId: string): string {
  return `bs-${createHash("sha256").update(submissionId).digest("hex").slice(0, 24)}`;
}

/** The comment that carries labels, or undefined when there are none. */
function labelComment(labels: Record<string, string> | undefined): string | undefined {
  if (!labels || !Object.keys(labels).length) return undefined;

  if (!Labels.safeParse(labels).success)
    throw new AdapterError("INVALID_ARGUMENT", "exe.dev labels need keys of 1-64 characters");

  const pairs = Object.entries(labels).map(
    ([key, value]) => `${labelWord(key)}=${labelWord(value)}`,
  );

  const comment = `${LABEL_PREFIX} ${pairs.join(" ")}`;

  if (Buffer.byteLength(comment) > MAX_COMMENT_BYTES)
    throw new AdapterError(
      "INVALID_ARGUMENT",
      `exe.dev keeps labels in the VM comment, which holds ${MAX_COMMENT_BYTES} bytes; use fewer or shorter labels`,
    );

  return comment;
}

/** Labels read back from a VM comment; anything else is no labels. */
function commentLabels(comment: string | undefined): Record<string, string> {
  if (!comment?.startsWith(`${LABEL_PREFIX} `)) return {};
  const labels: Record<string, string> = {};

  try {
    for (const pair of comment.slice(LABEL_PREFIX.length + 1).split(" ")) {
      const [key, value, extra] = pair.split("=");

      if (!key || value === undefined || extra !== undefined) return {};
      labels[decodeURIComponent(key)] = decodeURIComponent(value);
    }
  } catch {
    return {};
  }

  return Labels.safeParse(labels).success ? labels : {};
}

function state(native: string | undefined): SandboxState {
  switch (native) {
    case "starting":
    case "creating":
      return "creating";
    case "running":
      return "running";
    case "paused":
      return "suspended";
    case "stopped":
      return "stopped";
    case "stopping":
    case "deleting":
      return "destroying";
    default:
      return "unknown";
  }
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

/** The `POST /exec` body the SDK sends for `ssh <vm> <command>`. */
function sshBodyBytes(vm: string, command: string): number {
  return Buffer.byteLength(`ssh ${sdkQuote(vm)} ${sdkQuote(command)}`);
}

export type ExeDevAdapterOptions = {
  /** Native fetch handed to the official SDK; tests inject a deterministic fixture. */
  fetch?: NativeFetch;
  /** Poll interval while waiting for boot, pause, resume or deletion. */
  pollIntervalMs?: number;
  /** Longest a mutation waits in-call before returning a pending result. */
  settleSeconds?: number;
  /** Delay between output reads while a process is quiet (default 250 ms). */
  processPollMs?: number;
  /** Clock for signed token expiry, in epoch milliseconds. */
  now?: () => number;
};

/** Constructing a definition performs no provider IO. */
export function createExeDevAdapter(options: ExeDevAdapterOptions = {}) {
  const pollMs = options.pollIntervalMs ?? 1000;
  const settleSeconds = options.settleSeconds ?? 120;
  const now = options.now ?? Date.now;

  return defineAdapter({
    name: "exe-dev",
    displayName: "exe.dev",
    config: Configuration,
    credentials: Credentials,
    async connect({ config, credentials, host }) {
      // Choices exe.dev cannot honor reject before any provider IO.
      const key: SigningKey | undefined = credentials.sshKey
        ? parseSigningKey(credentials.sshKey)
        : undefined;

      const size = config.resources ? smallestSize("exe.dev", SIZES, config.resources) : undefined;
      const image = config.image ?? DEFAULT_IMAGE;
      const base = options.fetch ?? globalThis.fetch;
      let signed: { token: string; until: number } | undefined;

      /** The caller's token, or a short-lived one signed from the SSH key. */
      const apiToken = () => {
        if (credentials.token) return credentials.token;

        if (!key) throw new AdapterError("UNAUTHENTICATED", "exe.dev credentials are missing");
        const at = Math.floor(now() / 1000);

        if (!signed || signed.until - 60 < at) {
          const exp = at + TOKEN_SECONDS;
          signed = { token: signToken(key, { exp, cmds: TOKEN_COMMANDS }), until: exp };
        }

        return signed.token;
      };

      const secrets = () =>
        [credentials.token ?? "", signed?.token ?? "", credentials.sshKey ?? ""].filter(Boolean);

      const api = (signal: AbortSignal): ExedevClient => createExeClient(apiToken(), base, signal);

      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native SDK throws are normalized at this boundary.
      const failure = (error: unknown): NativeFailure => nativeFailure(error, secrets());

      const read = async <T>(ctx: ReadContext, run: (native: ExedevClient) => Promise<T>) => {
        try {
          return await run(api(callSignal(ctx)));
        } catch (error) {
          throw failure(error).error;
        }
      };

      // One authenticated read proves the credential and names the account.
      const whoami = z
        .object({ email: z.string().min(3).max(320) })
        .safeParse(await read(readContext(host.signal), (native) => native.whoami()));

      if (!whoami.success)
        throw new AdapterError(
          "UNAVAILABLE",
          "exe.dev did not report the account for this credential",
        );

      // The account is the email exe.dev reports for the credential; scope keeps only a digest.
      const scope = {
        authority: {
          kind: "account",
          id: createHash("sha256")
            .update("beachside:exe-dev:account-scope:v1\0")
            .update(whoami.data.email.toLowerCase())
            .digest("hex"),
        },
        partition: { endpoint: EXE_DEV_API },
      };

      const checkedRef = (ref: SandboxReference) => {
        assertResourceScope(ref, { provider: "exe-dev", scope });

        if (
          ref.kind !== "sandbox" ||
          ref.generation !== undefined ||
          !VmName.safeParse(ref.nativeId).success
        )
          throw new AdapterError("CONFLICT", "Invalid exe.dev VM identity");
      };

      /** The VM with exactly this name, or null when this credential sees none. */
      const find = async (name: string, ctx: ReadContext): Promise<VM | null> => {
        VmName.parse(name);

        try {
          const vms = await api(callSignal(ctx)).ls(name);
          const matches = vms.filter((vm) => vm.name === name);

          if (matches.length > 1)
            throw new AdapterError("CONFLICT", "exe.dev returned several VMs for one name");

          return matches[0] ?? null;
        } catch (error) {
          const native = failure(error);

          if (native.status === 404) return null;
          throw native.error;
        }
      };

      const requireVm = async (box: Sandbox, ctx: ReadContext) => {
        if (box.reference) checkedRef(box.reference);
        const vm = await find(box.id, ctx);

        if (!vm)
          throw new AdapterError("NOT_FOUND", "exe.dev VM is unavailable to this credential");

        return vm;
      };

      const requireRunning = async (box: Sandbox, ctx: ReadContext) => {
        const vm = await requireVm(box, ctx);

        if (vm.info.status !== "running")
          throw new AdapterError(
            "CONFLICT",
            `exe.dev VM is ${vm.info.status ?? "in an unknown state"}; commands and files need a running VM`,
          );

        return vm;
      };

      /** The VM's size from its latest `stat` sample, when exe.dev has one. */
      const vmSize = async (vm: VM, ctx: ReadContext): Promise<Fact<SandboxResources>> => {
        try {
          const stat = await api(callSignal(ctx)).vm(vm.name).stat();
          const point = stat.points?.at(-1);
          const vcpus = point?.cpu_cores ?? 0;
          const memoryMiB = Math.floor((point?.mem_total_bytes ?? 0) / 1_048_576);

          if (Number.isFinite(vcpus) && vcpus > 0 && memoryMiB > 0)
            return { status: "known", value: { vcpus, memoryMiB } };
        } catch {
          /* Size is a best-effort fact; the VM itself was observed. */
        }

        return { status: "unknown", reason: "exe.dev has not reported the VM size yet" };
      };

      const observation = async (
        vm: VM,
        ref: SandboxReference | null,
        ctx: ReadContext,
      ): Promise<SandboxInfo> => ({
        reference: ref,
        state: state(vm.info.status),
        nativeState: vm.info.status ?? "unknown",
        observedAt: new Date().toISOString(),
        ...unknownSandboxFacts(),
        // exe.dev VMs persist until deleted and never stop on their own.
        expires: { status: "none" },
        idleStop: { status: "known", value: null },
        resources: await vmSize(vm, ctx),
      });

      const partialCreate = (
        name: string,
        identity: { operationId: string; submissionId: string },
      ): OperationOutcome => ({
        kind: "create" as const,
        status: "partial" as const,
        sandbox: sandboxReference("exe-dev", scope, name, {
          operation: identity.operationId,
          submission: identity.submissionId,
        }),
        setup: { expiry: "acknowledged" as const, readiness: "unconfirmed" as const },
      });

      /** A fork's VM exists but is not confirmed ready; the caller gets its reference to clean up. */
      const partialFork = (
        name: string,
        identity: { operationId: string; submissionId: string },
      ): OperationOutcome => ({
        kind: "sandbox_fork" as const,
        status: "unknown" as const,
        sandbox: sandboxReference("exe-dev", scope, name, {
          operation: identity.operationId,
          submission: identity.submissionId,
        }),
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

      /** One guest control command; anything but a clean exit is an error. */
      const guest =
        (name: string): GuestRunner =>
        async (command, ctx, maxBytes = 1_048_576) => {
          if (sshBodyBytes(name, command) > MAX_REQUEST_BYTES)
            throw new AdapterError("CAPACITY", "exe.dev command exceeds the 64 KB request bound");
          let result;

          try {
            result = await api(callSignal(ctx))
              .vm(name)
              .ssh(command, { maxOutputBytes: maxBytes + 65_536, signal: callSignal(ctx) });
          } catch (error) {
            throw failure(error).error;
          }

          if (result.exitCode !== 0)
            throw new AdapterError("UNAVAILABLE", "exe.dev guest control command failed");

          return { stdout: result.stdoutBytes, stderr: result.stderrBytes };
        };

      /** True when a probe command runs: exe.dev routes SSH to the VM. */
      const reachable = async (name: string, ctx: ReadContext) => {
        try {
          const result = await api(callSignal(ctx))
            .vm(name)
            .ssh("true", { signal: callSignal(ctx) });

          return result.exitCode === 0;
        } catch {
          return false;
        }
      };

      /**
       * Create-time env values by attempt name, kept in memory only until this process's own
       * create or observation writes them. A fresh process never has them.
       */
      const launchEnv = new Map<string, Record<string, string>>();

      /** Write the env file (mode 0600) in the login user's home; true once confirmed. */
      const writeEnv = async (name: string, env: Record<string, string>, signal: AbortSignal) => {
        const encoded = Buffer.from(envFile(env, name)).toString("base64");

        try {
          await guest(name)(
            `umask 077 && printf %s ${quote(encoded)} | base64 -d >"${ENV_FILE}.tmp" && mv -f "${ENV_FILE}.tmp" "${ENV_FILE}" && echo ok`,
            readContext(signal, 60),
          );

          return true;
        } catch {
          return false;
        }
      };

      const envWritten = async (name: string, signal: AbortSignal) => {
        try {
          const { stdout } = await guest(name)(
            `head -n 1 "${ENV_FILE}" 2>/dev/null || true`,
            readContext(signal, 30),
          );

          return new TextDecoder().decode(stdout).startsWith(envMarker(name));
        } catch {
          return false;
        }
      };

      type Settle = Pick<ObserveContext<CreateToken>, "pending" | "unknown">;

      /** A running, reachable VM completes the create; anything else stays pending or unknown. */
      const launched = async (
        vm: VM | null,
        token: CreateToken,
        identity: { operationId: string; submissionId: string },
        signal: AbortSignal,
        outcome: Settle,
        partial: typeof partialCreate = partialCreate,
      ) => {
        if (!vm)
          return outcome.unknown(
            token.acknowledged
              ? "exe.dev VM disappeared before it was running; nothing remains to clean up"
              : "exe.dev create response was lost and no VM carries this attempt's name; inspect inventory without replay",
          );

        if (vm.name !== token.name)
          return outcome.unknown("exe.dev VM identity differs from the attempt; do not replay");
        const status = vm.info.status;

        if (status === "running" && (await reachable(vm.name, readContext(signal)))) {
          if (token.env) {
            const env = launchEnv.get(token.name);
            launchEnv.delete(token.name);

            const written = env
              ? await writeEnv(vm.name, env, signal)
              : await envWritten(vm.name, signal);

            if (!written)
              return outcome.unknown(
                env
                  ? "exe.dev VM is running but its sandbox environment was not confirmed; destroy it"
                  : "exe.dev VM is running but its sandbox environment was never written; destroy it",
                partial(vm.name, identity),
              );
          }

          return {
            id: vm.name,
            reference: sandboxReference("exe-dev", scope, vm.name, {
              operation: identity.operationId,
              submission: identity.submissionId,
            }),
            state: "running" as const,
          };
        }

        if (status === "starting" || status === "creating" || status === "running" || !status)
          return outcome.pending({ ...token, acknowledged: true }, { pollAfterMs: pollMs });

        launchEnv.delete(token.name);

        return outcome.unknown(
          `exe.dev VM is ${status} before it was running; inspect or destroy it`,
          partial(vm.name, identity),
        );
      };

      const placement = (): Pick<NewOptions, "standalone" | "pool"> =>
        config.placement === "standalone"
          ? { standalone: true }
          : config.placement === "default"
            ? {}
            : { pool: config.placement.pool };

      /** Exactly one `new`; a lost response is found again by the attempt's name. */
      const launch = async (input: CreateInput, ctx: AttemptContext<CreateToken>) => {
        const name = attemptName(ctx.submissionId);
        const env = input.env && Object.keys(input.env).length ? input.env : undefined;
        const comment = labelComment(input.labels);

        const request: NewOptions = {
          name,
          tag: [MARKER_TAG],
          "no-email": true,
          waitUntil: "created",
          ...placement(),
        };

        if (input.image.value !== DEFAULT_IMAGE) request.image = input.image.value;

        if (comment) request.comment = comment;

        if (size) {
          request.cpu = size.vcpus;
          request.memory = `${size.memoryMiB / 1024}GB`;
        }

        // The env requirement is saved before dispatch, so a recovered attempt still demands
        // the env file's marker before it reports the VM as ready. The values stay in this
        // process only, so its own observation can still write them.
        const token: CreateToken = env ? { name, env: true } : { name };
        await ctx.checkpoint(token);

        if (env) launchEnv.set(name, env);
        let created: VM;

        try {
          created = await api(ctx.signal).new(request);
        } catch (error) {
          if (refusedBeforeEffect(failure(error))) launchEnv.delete(name);

          return rejection(
            ctx,
            error,
            "exe.dev create response was not confirmed; observe finds the VM by its name",
          );
        }

        if (created.name !== name)
          return ctx.unknown("exe.dev create acknowledgement does not match the attempt");
        const acknowledged: CreateToken = { ...token, acknowledged: true };

        try {
          await ctx.checkpoint(acknowledged);
        } catch (error) {
          if (error instanceof AdapterCheckpointError) error.outcome = partialCreate(name, ctx);
          throw error;
        }

        try {
          const result = await settle(ctx.signal, async (read) => {
            const current = await find(name, read);

            return current?.info.status === "running" &&
              (await reachable(name, readContext(ctx.signal)))
              ? { current }
              : current && current.info.status !== "starting" && current.info.status !== "running"
                ? { current }
                : current === null
                  ? { current }
                  : undefined;
          });

          if (result) return launched(result.current, acknowledged, ctx, ctx.signal, ctx);
        } catch {
          /* A failed readiness read is not evidence; continue through observation. */
        }

        return ctx.pending(acknowledged, { pollAfterMs: pollMs });
      };

      /** Run one command once and collect its result, or explain why the outcome is unknown. */
      const runCommand = async (input: ExecInput, ctx: AttemptContext) => {
        const files = filesystem(guest(input.sandbox.id));
        let stdinPath: string | undefined;

        if (input.stdin !== undefined)
          try {
            stdinPath = await files.stage(input.stdin, readContext(ctx.signal, 120));
          } catch (error) {
            if (error instanceof AdapterFilesystemError && error.details.effect === "none")
              return ctx.reject(error.code, "exe.dev could not stage the command's stdin");

            return ctx.unknown("exe.dev stdin staging was not confirmed; the command did not run");
          }

        const script = wrapperScript({ ...input, stdinPath, maxBytes: input.maxOutputBytes });
        const deadline = AbortSignal.timeout(Math.max(1, Math.ceil(input.deadlineSeconds)) * 1000);
        const signal = AbortSignal.any([ctx.signal, deadline]);
        let result;

        try {
          result = await api(signal)
            .vm(input.sandbox.id)
            .ssh(script, {
              signal,
              maxOutputBytes: Math.ceil((input.maxOutputBytes * 4) / 3) + 65_536,
            });
        } catch (error) {
          if (deadline.aborted)
            return ctx.unknown(
              `exe.dev command passed its ${input.deadlineSeconds}s deadline; it may still be running in the VM`,
            );

          return rejection(ctx, error, "exe.dev command response was not confirmed");
        }

        const record = result.exitCode === 0 ? parseWrapper(result.stdout) : null;

        if (!record)
          return ctx.unknown("exe.dev ran the command but its result record could not be decoded");

        return record;
      };

      const files = (name: string) => filesystem(guest(name));

      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Helper throws are normalized at this boundary.
      const fileRejection = (ctx: AttemptContext, error: unknown) => {
        if (error instanceof AdapterFilesystemError && error.details.effect !== "none")
          return ctx.unknown(
            "exe.dev filesystem operation may have changed the requested path; do not replay",
          );

        if (error instanceof AdapterError) return ctx.reject(error.code, error.message);

        return ctx.unknown("exe.dev filesystem response was not confirmed; do not replay");
      };

      /** VMs this client is pausing or holds paused; their process observers stop polling. */
      const held = new Set<string>();

      const jobOptions = (name: string) => ({
        held: async () => held.has(name),
        run: guest(name),
        pollMs: options.processPollMs ?? 250,
        requestSeconds: 60,
      });

      const listedReference = (name: string): SandboxReference | null =>
        VmName.safeParse(name).success
          ? {
              version: 1,
              kind: "sandbox",
              provider: "exe-dev",
              scope,
              nativeId: name,
              ownership: "unknown",
            }
          : null;

      /** exe.dev lists every VM in one response; the cursor is an offset into it. */
      const page = async (input: { cursor?: string; limit: number }, ctx: ReadContext) => {
        const offset = input.cursor === undefined ? 0 : Number(input.cursor);

        if (!Number.isSafeInteger(offset) || offset < 0)
          throw new AdapterError("INVALID_ARGUMENT", "Invalid exe.dev VM cursor");

        const all = (await read(ctx, (native) => native.ls())).filter(
          (vm) => VmName.safeParse(vm.name).success,
        );

        const vms = all.slice(offset, offset + input.limit);
        const next = offset + vms.length;

        return { vms, nextCursor: next < all.length ? String(next) : undefined };
      };

      const suspended = async (vm: VM, reference: SandboxReference, ctx: ReadContext) => ({
        reference,
        preserve: Preserve.FILESYSTEM_AND_MEMORY,
        processes: "preserved" as const,
        connections: "dropped" as const,
        observation: await observation(vm, reference, ctx),
      });

      const resumed = async (vm: VM, reference: SandboxReference, ctx: ReadContext) => ({
        reference,
        // exe.dev reports whether RAM was restored (`cold_booted`), but SDK 0.4.1 drops it.
        execution: "unknown" as const,
        executionIdentity: unknownSandboxFacts().execution,
        connections: "dropped" as const,
        observation: await observation(vm, reference, ctx),
      });

      const session: AdapterSession<
        CreateInput,
        Sandbox,
        ExecInput,
        FileWriteInput,
        "argv" | "shell",
        CreateToken
      > = {
        scope,
        defaultImage: { kind: "oci", value: image },
        defaultNetworkPolicy: config.networkPolicy,
        supports: {
          images: ["oci"],
          network: ["internet"],
          exec: { commands: ["argv", "shell"], maxOutputBytes: MAX_OUTPUT_BYTES },
          fileWrite: { overwrite: true, noClobber: true },
          createEnv: true,
        },
        create: {
          recovery: { version: 1, token: CreateToken },
          async prepare(input) {
            if (input.image.kind !== "oci")
              throw new AdapterError("UNSUPPORTED", "exe.dev creates VMs from OCI images only");

            if (!Image.safeParse(input.image.value).success)
              throw new AdapterError("INVALID_ARGUMENT", "exe.dev images are OCI references");

            if (input.networkPolicy !== "internet")
              throw new AdapterError(
                "UNSUPPORTED",
                "This exe.dev adapter creates VMs with internet egress only",
              );

            if (input.region !== undefined || input.mounts?.length || input.requirements)
              throw new AdapterError(
                "UNSUPPORTED",
                "exe.dev has no per-VM region selection, volume mounts or snapshot requirements",
              );
            labelComment(input.labels);
            checkEnv(input.env);

            if (
              input.env &&
              Buffer.byteLength(Buffer.from(envFile(input.env, "x")).toString("base64")) > 48_000
            )
              throw new AdapterError("CAPACITY", "exe.dev sandbox environment exceeds 36 KB");

            return input;
          },
          submit: (input, ctx) => launch(input, ctx),
          async observe(attempt, ctx) {
            const token = CreateToken.safeParse(attempt.token);

            if (!token.success || token.data.name !== attemptName(attempt.submissionId))
              return ctx.unknown("exe.dev create identity is unavailable; do not replay");

            return launched(await find(token.data.name, ctx), token.data, attempt, ctx.signal, ctx);
          },
        },
        async inspect(box, ctx) {
          if (box.reference) checkedRef(box.reference);
          const vm = await find(box.id, ctx);

          return vm
            ? { id: vm.name, ...(await observation(vm, box.reference ?? null, ctx)) }
            : null;
        },
        async reopen(ref, ctx) {
          checkedRef(ref);

          return observation(await requireVm({ id: ref.nativeId, reference: ref }, ctx), ref, ctx);
        },
        async inventory(input, ctx) {
          const listed = await page(input, ctx);

          return {
            items: listed.vms.map((vm) => ({
              id: vm.name,
              state: vm.info.status === "running" ? ("running" as const) : ("unknown" as const),
            })),
            nextCursor: listed.nextCursor,
          };
        },
        async sandboxList(input, ctx) {
          const listed = await page(input, ctx);

          return {
            // exe.dev lists every VM this credential sees; none carries creation proof.
            coverage: "provider-scope" as const,
            items: listed.vms.map((vm) => ({
              id: vm.name,
              state: state(vm.info.status),
              reference: listedReference(vm.name),
              labels: commentLabels(vm.info.comment),
              createdAt: listedTime(vm.info.createdAt),
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
            const token = { name: VmName.parse(input.id) };
            await ctx.checkpoint(token);
            let result;

            try {
              result = await api(callSignal(readContext(ctx.signal, 120))).rm([token.name]);
            } catch (error) {
              const native = failure(error);

              if (refusedBeforeEffect(native))
                return ctx.reject(native.error.code, native.error.message);

              return ctx.pending(token, { pollAfterMs: pollMs });
            }

            if (result.deleted.includes(token.name) || result.not_found?.includes(token.name)) {
              held.delete(token.name);

              return { computeStopped: true, retainedResources: [] };
            }

            return ctx.reject(
              "CONFLICT",
              `exe.dev did not delete the VM${result.errors?.[token.name] ? `: ${result.errors[token.name]}` : ""}`.slice(
                0,
                300,
              ),
            );
          },
          async observe(attempt, ctx) {
            const token = DestroyToken.safeParse(attempt.token);

            if (!token.success || token.data.name !== attempt.sandbox?.id)
              return ctx.unknown("exe.dev deletion identity is unavailable; do not replay");

            if (!(await find(token.data.name, ctx))) {
              held.delete(token.data.name);

              return { computeStopped: true, retainedResources: [] };
            }

            return ctx.unknown(
              "exe.dev delete response was lost and the VM still exists; destroy it again explicitly",
            );
          },
        },
        processes: {
          supports: {
            sustainedOutput: true,
            binaryOutput: true,
            signals: ["SIGTERM", "SIGKILL"],
            reopen: true,
            stdin: "bytes",
            status: true,
            execCapture: "bytes",
          },
          async start(input, ctx) {
            if (input.terminal)
              throw new AdapterError(
                "UNSUPPORTED",
                "exe.dev's HTTPS API has no terminal; this adapter cannot open a PTY",
              );

            if (
              input.capture &&
              (!Number.isSafeInteger(input.capture.maxBytes) ||
                input.capture.maxBytes < 1 ||
                input.capture.maxBytes > MAX_OUTPUT_BYTES)
            )
              throw new AdapterError("CAPACITY", "exe.dev process capture exceeds its byte bound");
            // Validates argv, env names and NUL bytes before any effect.
            commandLine(input);
            await requireRunning(input.sandbox, ctx);
            const format = input.output?.format ?? "text";

            const directory = parseLauncher(
              new TextDecoder().decode(
                (await guest(input.sandbox.id)(launcherScript(input), ctx)).stdout,
              ),
            );

            if (!directory)
              throw new AdapterError("UNAVAILABLE", "exe.dev process start was not acknowledged");

            return observeJob(
              jobOptions(input.sandbox.id),
              {
                version: 1,
                kind: "exe-dev-job",
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
            const job = ProcessReference.safeParse(input.reference);

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

            throw new AdapterError(
              "CONFLICT",
              "Process reference does not belong to this exe.dev VM and profile",
            );
          },
        },
        exec: {
          finiteStdin: "bytes",
          async prepare(input, ctx) {
            if (input.deadlineSeconds > MAX_EXEC_SECONDS)
              throw new AdapterError(
                "INVALID_ARGUMENT",
                `exe.dev commands run for at most ${MAX_EXEC_SECONDS} seconds`,
              );

            if (input.stdin !== undefined && input.stdin.byteLength > MAX_STDIN_BYTES)
              throw new AdapterError(
                "CAPACITY",
                `exe.dev command stdin is limited to ${MAX_STDIN_BYTES} bytes`,
              );

            // Validates argv, env names and NUL bytes before any effect, and the request bound.
            const script = wrapperScript({
              ...input,
              stdinPath: input.stdin === undefined ? undefined : "/tmp/.beachside-stdin-x",
              maxBytes: input.maxOutputBytes,
            });

            if (sshBodyBytes(input.sandbox.id, script) > MAX_REQUEST_BYTES)
              throw new AdapterError(
                "CAPACITY",
                "exe.dev commands must fit one 64 KB request; upload long scripts as files first",
              );
            await requireRunning(input.sandbox, ctx);

            return input;
          },
          submit: (input, ctx) => runCommand(input, ctx),
        },
        async preview(input, ctx) {
          const vm = await requireRunning(input.sandbox, ctx);
          const url = new URL(vm.httpsUrl ?? `https://${vm.name}.exe.xyz/`);

          if (url.protocol !== "https:" || !/^[a-z0-9-]+\.[a-z0-9.-]+$/i.test(url.hostname))
            throw new AdapterError("UNAVAILABLE", "exe.dev reported an invalid VM URL");

          if (config.preview.access === "public") {
            // exe.dev makes one port per VM public: the one its main URL forwards to.
            const route = await read(ctx, (native) => native.vm(vm.name).shareShow());

            if (route.status !== "public" || route.port !== input.port) {
              await read(ctx, (native) => native.vm(vm.name).sharePort(String(input.port)));
              await read(ctx, (native) => native.vm(vm.name).shareSetPublic());
            }

            return { access: "public", url: `https://${url.hostname}/` };
          }

          if (!key)
            throw new AdapterError(
              "UNSUPPORTED",
              "exe.dev protected previews sign a VM token and need the sshKey credential; or set preview.access public",
            );

          // Ports 3000-9999 have their own URL and need no share call; any other port must be
          // the one the VM's main URL forwards to.
          let port: string;

          if (input.port >= ALTERNATE_PORTS.min && input.port <= ALTERNATE_PORTS.max)
            port = `:${input.port}`;
          else {
            const route = await read(ctx, (native) => native.vm(vm.name).shareShow());

            if (input.port !== route.port)
              throw new AdapterError(
                "UNSUPPORTED",
                `exe.dev forwards ports ${ALTERNATE_PORTS.min}-${ALTERNATE_PORTS.max} and the VM's web port (${route.port})`,
              );
            port = "";
          }

          const exp = Math.floor(now() / 1000) + PREVIEW_SECONDS;

          return {
            access: "protected",
            url: `https://${url.hostname}${port}/`,
            headers: { "X-Exedev-Authorization": `Bearer ${signToken(key, { exp }, vm.name)}` },
            expiresAt: new Date(exp * 1000).toISOString(),
          };
        },
        files: {
          maxBytes: MAX_FILE_BYTES,
          async read(input, ctx) {
            await requireRunning(input.sandbox, ctx);
            const limit = Math.min(input.maxBytes ?? MAX_FILE_BYTES, MAX_FILE_BYTES);

            return files(input.sandbox.id).readAll(input.path, limit, ctx);
          },
          write: {
            async prepare(input, ctx) {
              if (input.bytes.byteLength > MAX_FILE_BYTES)
                throw new AdapterError("CAPACITY", "exe.dev file exceeds the write bound");
              await requireRunning(input.sandbox, ctx);

              return input;
            },
            async submit(input, ctx) {
              try {
                return await files(input.sandbox.id).write(
                  input.path,
                  [input.bytes],
                  input.overwrite,
                  readContext(ctx.signal, 600),
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

            if (vm.info.status !== "running")
              throw new AdapterError(
                "CONFLICT",
                `exe.dev can pause only a running VM, not ${vm.info.status ?? "unknown"}`,
              );

            return {
              ...input,
              intent: { action: "suspend", preserve: Preserve.FILESYSTEM_AND_MEMORY },
            };
          },
          async submit(input, ctx) {
            const token = { name: VmName.parse(input.sandbox.id), since: Date.now() };
            await ctx.checkpoint(token);
            // Process observers stop polling first: their guest commands keep the VM busy.
            held.add(token.name);

            try {
              await api(callSignal(readContext(ctx.signal, 120)))
                .vm(token.name)
                .pause();
            } catch (error) {
              if (refusedBeforeEffect(failure(error))) held.delete(token.name);

              return rejection(ctx, error, "exe.dev pause response was not confirmed");
            }

            try {
              const paused = await settle(ctx.signal, async (read) => {
                const vm = await find(token.name, read);

                return vm?.info.status === "paused" ? vm : undefined;
              });

              if (paused)
                return suspended(paused, input.sandbox.reference, readContext(ctx.signal));
            } catch {
              /* Pause is acknowledged; completion continues through observation. */
            }

            return ctx.pending(token, { pollAfterMs: pollMs });
          },
          async observe(attempt, ctx) {
            const token = LifecycleToken.safeParse(attempt.token);
            const box = attempt.sandbox;

            if (!token.success || !box?.reference || token.data.name !== box.id)
              return ctx.unknown("exe.dev pause identity is unavailable; do not replay");
            const vm = await find(token.data.name, ctx);

            if (!vm) {
              held.delete(token.data.name);

              return ctx.unknown("exe.dev VM disappeared while pausing");
            }

            if (vm.info.status === "paused") {
              held.add(vm.name);

              return suspended(vm, box.reference, ctx);
            }

            const waiting =
              vm.info.status === "pausing" ||
              (vm.info.status === "running" &&
                Date.now() - token.data.since < settleSeconds * 1000);

            if (waiting) return ctx.pending(token.data, { pollAfterMs: pollMs });
            held.delete(token.data.name);

            return ctx.unknown(
              `exe.dev VM is ${vm.info.status ?? "unknown"} after pause; inspect it before retrying`,
            );
          },
        },
        resume: {
          recovery: { version: 1, token: LifecycleToken },
          async prepare(input, ctx) {
            const vm = await requireVm(input.sandbox, ctx);

            if (vm.info.status !== "paused")
              throw new AdapterError(
                "CONFLICT",
                `exe.dev can resume only a paused VM, not ${vm.info.status ?? "unknown"}`,
              );

            return { ...input, intent: { action: "resume" } };
          },
          async submit(input, ctx) {
            const token = { name: VmName.parse(input.sandbox.id), since: Date.now() };
            await ctx.checkpoint(token);

            try {
              await api(callSignal(readContext(ctx.signal, 120)))
                .vm(token.name)
                .resume({ waitUntil: "created" });
            } catch (error) {
              return rejection(ctx, error, "exe.dev resume response was not confirmed");
            }

            try {
              const ready = await settle(ctx.signal, async (read) => {
                const vm = await find(token.name, read);

                return vm?.info.status === "running" && (await reachable(token.name, read))
                  ? vm
                  : undefined;
              });

              if (ready) {
                held.delete(token.name);

                return resumed(ready, input.sandbox.reference, readContext(ctx.signal));
              }
            } catch {
              /* Resume is acknowledged; readiness continues through observation. */
            }

            return ctx.pending(token, { pollAfterMs: pollMs });
          },
          async observe(attempt, ctx) {
            const token = LifecycleToken.safeParse(attempt.token);
            const box = attempt.sandbox;

            if (!token.success || !box?.reference || token.data.name !== box.id)
              return ctx.unknown("exe.dev resume identity is unavailable; do not replay");
            const vm = await find(token.data.name, ctx);

            if (!vm) return ctx.unknown("exe.dev VM disappeared while resuming");

            if (vm.info.status === "running") {
              held.delete(vm.name);

              return resumed(vm, box.reference, ctx);
            }

            return vm.info.status === "paused" || vm.info.status === "starting"
              ? ctx.pending(token.data, { pollAfterMs: pollMs })
              : ctx.unknown(
                  `exe.dev VM is ${vm.info.status ?? "unknown"} after resume; inspect without replay`,
                );
          },
        },
        sandboxFork: {
          recovery: { version: 1, token: CreateToken },
          // `cp` copies the disk and configuration into a new VM, which boots fresh from it.
          capabilities: {
            preserve: Preserve.FILESYSTEM,
            // exe.dev does not document whether copying a running VM pauses it; claim no less.
            interruption: "pause",
            execution: "fresh",
            independentLifecycle: true,
            options: { labels: true },
          },
          async prepare(input, ctx) {
            labelComment(input.request.labels);
            const source = await requireVm(input.sandbox, readContext(ctx.signal));

            if (source.info.status !== "running" && source.info.status !== "paused")
              throw new AdapterError(
                "CONFLICT",
                `exe.dev copies a running or paused VM, not ${source.info.status ?? "unknown"}`,
              );

            return input;
          },
          async submit(input, ctx) {
            const name = attemptName(ctx.submissionId);
            const token: CreateToken = { name };
            const source = await find(input.sandbox.id, readContext(ctx.signal));

            if (!source) return ctx.reject("NOT_FOUND", "exe.dev source VM is unavailable");
            await ctx.checkpoint(token);
            let copy: VM;

            try {
              // Tags are copied, so the fork keeps the marker tag; labels are set below.
              copy = await api(ctx.signal).vm(input.sandbox.id).cp({ name, waitUntil: "created" });
            } catch (error) {
              return rejection(ctx, error, "exe.dev copy response was not confirmed");
            }

            if (copy.name !== name)
              return ctx.unknown("exe.dev copy acknowledgement does not match the attempt");
            const acknowledged: CreateToken = { name, acknowledged: true };

            try {
              await ctx.checkpoint(acknowledged);
            } catch (error) {
              if (error instanceof AdapterCheckpointError) error.outcome = partialFork(name, ctx);
              throw error;
            }

            // A copy keeps its source's comment; the fork's own labels replace it. An unlabelled
            // fork of a commented source gets the bare prefix (no labels) rather than an empty
            // comment, and a fork that already matches needs no call.
            const comment =
              labelComment(input.request.labels) ?? (source.info.comment ? LABEL_PREFIX : "");

            if (comment !== (source.info.comment ?? ""))
              try {
                await api(callSignal(readContext(ctx.signal)))
                  .vm(name)
                  .comment(comment);
              } catch {
                return ctx.unknown(
                  "exe.dev copied the VM but its labels were not confirmed; destroy it with the returned reference",
                  partialFork(name, ctx),
                );
              }

            try {
              const result = await settle(ctx.signal, async (read) => {
                const current = await find(name, read);

                return current?.info.status === "running" && (await reachable(name, read))
                  ? { current }
                  : current === null
                    ? { current }
                    : undefined;
              });

              if (result)
                return launched(result.current, acknowledged, ctx, ctx.signal, ctx, partialFork);
            } catch {
              /* A failed readiness read is not evidence; continue through observation. */
            }

            return ctx.pending(acknowledged, { pollAfterMs: pollMs });
          },
          async observe(attempt, ctx) {
            const token = CreateToken.safeParse(attempt.token);

            if (!token.success || token.data.name !== attemptName(attempt.submissionId))
              return ctx.unknown("exe.dev fork identity is unavailable; do not replay");

            return launched(
              await find(token.data.name, ctx),
              token.data,
              attempt,
              ctx.signal,
              ctx,
              partialFork,
            );
          },
        },
        async resourceCapabilities() {
          return {
            restore: { status: "unsupported", reason: "exe.dev snapshots are not supported" },
            volumes: { status: "unsupported", reason: "exe.dev has no volumes" },
            mounts: { status: "unsupported", reason: "exe.dev has no volume mounts" },
          };
        },
      };

      return session;
    },
  });
}

export const exeDevAdapter = createExeDevAdapter();
