import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  BeachsideError,
  ResourceReference,
  type SandboxHandle,
  type BeachsideClient,
  type RecoveryReference,
} from "beachside";
import { loadConfig, maxSandboxes, stateDir } from "@beachside-internal/profile/config";
import { connect, resolveProfile } from "@beachside-internal/profile/providers";
import { SecretReader } from "@beachside-internal/profile/secrets";
import {
  FsStateStore,
  RecordName,
  type SnapshotRecord,
  type Versioned,
} from "@beachside-internal/profile/store";
import { claimSandbox, recordSandbox } from "@beachside-internal/profile/sandboxes";
import { describeError } from "@beachside-internal/profile/output";
import { z } from "zod";
import { workspace, push } from "./workspace";

export const sessionEntry = "beachside.pi.session";

export const forkEntry = "beachside.pi.fork";

const SnapshotReference = ResourceReference.extend({ kind: z.literal("snapshot") });

export const Saved = z.object({
  owner: z.string(),
  profile: z.string(),
  status: z.enum(["pending", "ready", "destroyed", "inactive", "retryable"]),
  workdir: z.string().optional(),
  network: z.string().optional(),
  reference: ResourceReference.extend({ kind: z.literal("sandbox") }).nullish(),
  off: z.boolean().optional(),
  recovery: z.custom<RecoveryReference>().optional(),
});

export type Saved = z.infer<typeof Saved>;

export const Fork = z.object({
  target: z.string(),
  profile: z.string(),
  workdir: z.string().optional(),
  snapshot: SnapshotReference.optional(),
  recovery: z.custom<RecoveryReference>().optional(),
  error: z.string().optional(),
});

export type Fork = z.infer<typeof Fork>;

export const keepSource = { requirements: { sourceAfter: "unchanged" } } as const;

export function message(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

type Box = SandboxHandle<true>;

export class SandboxSession {
  readonly owner: string;
  readonly name: string;
  box?: Box;
  workdir?: string;
  off: boolean;
  private blocked?: string;
  private planning?: ReturnType<typeof workspace>;
  private opening?: Promise<{ box: Box; workdir: string }>;
  private settings?: Promise<Awaited<ReturnType<SandboxSession["load"]>>>;
  private client?: BeachsideClient<true>;
  private renewal?: NodeJS.Timeout;
  private renewing?: Promise<void>;
  private expires?: import("beachside").SandboxInfo["expires"];
  private usedSinceRenewal = false;
  private activeUses = 0;
  private stoppingRenewal = false;
  private allocation?: Versioned;
  private needsSuspend = false;
  private readonly lifetime = new AbortController();

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionContext,
    readonly profile: string,
    private saved?: Saved,
    private readonly fork?: Fork,
    private readonly sync?: string,
    private readonly snapshotName?: string,
  ) {
    this.owner = ctx.sessionManager.getSessionId();
    this.name = `pi-${createHash("sha256").update(this.owner).digest("hex").slice(0, 16)}`;
    this.off = saved?.off ?? false;
    this.workdir = saved?.workdir ?? fork?.workdir;
  }

  private persist(record: Omit<Saved, "owner" | "profile">) {
    this.saved = { off: this.off, ...record, owner: this.owner, profile: this.profile };
    this.pi.appendEntry(sessionEntry, this.saved);
  }

  private async load() {
    if (process.platform === "win32") throw new Error("Beachside Pi needs a POSIX host");

    if (this.blocked) throw new Error(this.blocked);

    if (this.fork?.error) throw new Error(this.fork.error);
    const env = process.env;
    const loaded = await loadConfig(undefined, env);
    const profile = resolveProfile({ profile: this.profile }, loaded, env);

    if (!profile.network)
      throw new Error(
        `Profile ${this.profile} needs an explicit network policy in its top-level network field`,
      );

    const limit = maxSandboxes(loaded, env);

    const client = await connect(
      profile,
      this.ctx.cwd,
      env,
      new SecretReader(env, this.lifetime.signal),
    );

    this.client = client;

    return {
      client,
      network: profile.network,
      limit,
      store: new FsStateStore(stateDir(undefined, loaded, env, this.ctx.cwd)),
    };
  }

  private config() {
    return (this.settings ??= this.load());
  }

  async capabilities() {
    return (await this.config()).client.capabilities();
  }

  requireSuspend() {
    this.needsSuspend = true;
  }

  block(reason: string) {
    this.blocked = reason;
  }

  private plan(network: string, restoring: boolean) {
    return (this.planning ??= workspace(this.ctx.cwd, this.sync, network, restoring));
  }

  async promptWorkdir() {
    if (this.workdir) return this.workdir;

    try {
      return (await this.plan((await this.config()).network, !!this.snapshotName)).workdir;
    } catch {
      return "/tmp/beachside-work";
    }
  }

  async use<T>(action: (sandbox: Awaited<ReturnType<SandboxSession["get"]>>) => Promise<T>) {
    const sandbox = await this.get();
    this.activeUses++;
    this.usedSinceRenewal = true;
    this.scheduleRenewal(sandbox.box);

    try {
      return await action(sandbox);
    } finally {
      this.activeUses--;
    }
  }

  async get() {
    if (this.blocked) throw new Error(this.blocked);
    this.opening ??= this.open().catch((cause: unknown) => {
      if (!this.saved || this.saved.status === "retryable") {
        this.opening = undefined;
        this.planning = undefined;
      }

      throw cause;
    });

    return this.opening;
  }

  private async open(): Promise<{ box: Box; workdir: string }> {
    const { client, network, store, limit } = await this.config();
    const signal = this.lifetime.signal;
    const labels = { "beachside.pi": "1", "beachside.pi.session": this.owner };

    if (this.saved && this.saved.status !== "retryable") {
      const { status, reference, workdir, recovery } = this.saved;

      if (this.saved.network && this.saved.network !== network) {
        throw new Error(
          `Sandbox ${reference?.nativeId ?? "session"} belongs to a different network policy. Start a new Pi session to use the changed policy.`,
        );
      }

      if (status !== "ready" || !reference || !workdir) {
        throw new Error(
          `Saved Beachside sandbox is ${status}${reference ? ` (${reference.nativeId})` : ""}${recovery ? `; recovery is recorded in the Pi session` : ""}. Inspect the record with beachside inspect ${this.name} before starting a new Pi session.`,
        );
      }

      const box = await client.sandboxes.get(reference, { signal });
      this.box = box;
      const info = await box.inspect({ signal });

      if (info.state === "suspended" || info.state === "stopped") await box.resume({ signal });
      else if (info.state !== "running") throw new Error(`Sandbox ${box.id} is ${info.state}`);

      if (this.needsSuspend) await this.checkSuspend(box);
      await this.ready(box, workdir, network);

      return { box, workdir };
    }

    let snapshot = this.fork?.snapshot;

    if (this.snapshotName && !this.fork) {
      const stored = await store.get("snapshot", RecordName.parse(this.snapshotName));

      if (!stored || stored.record.profile !== this.profile || stored.record.status !== "captured")
        throw new Error(
          `No captured snapshot named ${this.snapshotName} for profile ${this.profile}`,
        );
      snapshot = SnapshotReference.parse(stored.record.reference);
    }

    const plan =
      this.fork?.snapshot && this.fork.workdir
        ? { workdir: this.fork.workdir, script: "" }
        : await this.plan(network, !!snapshot);

    this.workdir = plan.workdir;

    const caps = await client.capabilities();
    const restore = caps.snapshots.restore;

    if (this.needsSuspend && caps.lifecycle.suspend.status !== "supported")
      throw new Error(
        `--beachside-exit suspend is unavailable for profile ${this.profile}: ${caps.lifecycle.suspend.reason}`,
      );

    const labelsSupported = snapshot
      ? restore.status === "supported" && restore.value.options?.labels
      : caps.createLabels;

    const appliedLabels = labelsSupported ? labels : undefined;

    if (snapshot && restore.status !== "supported") throw new Error(restore.reason);
    const source = snapshot ? await client.snapshots.get(snapshot) : undefined;
    const pending = { status: "pending", workdir: plan.workdir, network } as const;

    const claimed = await claimSandbox(
      store,
      limit,
      {
        format: 1,
        kind: "sandbox",
        status: "creating",
        profile: this.profile,
        provider: client.provider,
        createdAt: new Date().toISOString(),
        labels: appliedLabels ?? {},
        reference: null,
      },
      this.name,
    );

    try {
      this.persist(pending);
    } catch (cause) {
      await store.remove("sandbox", this.name, claimed.version);
      throw cause;
    }

    let created: Awaited<ReturnType<typeof recordSandbox>>;

    try {
      created = await recordSandbox(store, claimed, () =>
        source
          ? source.restore(
              { network, requireIndependentLifecycle: true, labels: appliedLabels },
              { signal },
            )
          : client.sandboxes.create({ network, labels: appliedLabels }, { signal }),
      );
    } catch (cause) {
      const report = describeError(cause);

      if (report.outcome === "rejected") this.persist({ status: "retryable", network });
      else
        this.persist({
          ...pending,
          reference: report.known?.reference,
          recovery: report.known?.recovery,
        });
      throw cause;
    }

    const { box, record, version, unrecorded } = created;
    this.box = box;
    this.allocation = { record, version };

    try {
      this.persist({ ...pending, reference: box.reference });

      if (unrecorded) throw new Error(`Could not record ${this.name}: ${unrecorded.message}`);

      if (this.needsSuspend) await this.checkSuspend(box);

      if (plan.script)
        await box.exec({ command: { kind: "shell", script: plan.script } }, { signal });

      if (plan.upload) await push(box, this.ctx.cwd, plan.workdir, signal);
      await this.ready(box, plan.workdir, network);
    } catch (cause) {
      // No tools have used the sandbox yet. Retry only after confirmed cleanup of this allocation.
      try {
        await this.destroyBox(box);
        this.persist({ status: "retryable", network });
      } catch (cleanup) {
        throw new Error(
          `Sandbox setup failed: ${message(cause)}. Cleanup needs attention for ${this.name} (${box.id}): ${message(cleanup)}`,
          { cause },
        );
      }

      throw new Error(
        `Sandbox setup failed: ${message(cause)}. The sandbox was removed. Retry after fixing setup.`,
        { cause },
      );
    }

    if (this.fork?.snapshot) {
      try {
        await (await client.snapshots.get(this.fork.snapshot)).delete({ signal });
      } catch (cause) {
        this.ctx.ui.notify(
          `Fork is ready. Snapshot ${this.fork.snapshot.nativeId} cleanup needs attention: ${message(cause)}`,
          "warning",
        );
      }
    }

    return { box, workdir: plan.workdir };
  }

  private async checkSuspend(box: Box) {
    const suspend = (await box.capabilities()).lifecycle.suspend;

    if (suspend.status !== "supported")
      throw new Error(
        `--beachside-exit suspend is unavailable for this sandbox: ${suspend.reason}`,
      );
  }

  private async ready(box: Box, workdir: string, network: string) {
    this.persist({ status: "ready", reference: box.reference, workdir, network });
    this.ctx.ui.setStatus(
      "beachside",
      `${this.client?.provider} · ${this.name} (${box.id}) · ${workdir}`,
    );

    try {
      const caps = await box.capabilities();

      if (caps.lifecycle.renew.status === "supported")
        this.expires = (await box.inspect({ signal: this.lifetime.signal })).expires;
    } catch (cause) {
      this.ctx.ui.notify(`Sandbox ${box.id} renewal unavailable: ${message(cause)}`, "warning");
    }
  }

  private scheduleRenewal(box: Box) {
    if (
      this.renewal ||
      this.renewing ||
      this.stoppingRenewal ||
      this.off ||
      this.expires?.status !== "known"
    )
      return;
    const remaining = Date.parse(this.expires.at) - Date.now();

    if (!Number.isFinite(remaining) || remaining <= 0) return;
    this.renewal = setTimeout(
      () => {
        this.renewal = undefined;

        if (!this.usedSinceRenewal && !this.activeUses) return;
        this.usedSinceRenewal = false;
        this.renewing = box
          .renew(undefined, { signal: this.lifetime.signal })
          .then(
            (result) => {
              this.expires = result.observation?.expires;
            },
            (cause: unknown) => {
              this.expires = undefined;
              this.ctx.ui.notify(`Sandbox ${box.id} renewal stopped: ${message(cause)}`, "warning");
            },
          )
          .finally(() => {
            this.renewing = undefined;
            this.scheduleRenewal(box);
          });
      },
      Math.max(1000, Math.min(remaining / 2, 2_147_483_647)),
    );
    this.renewal.unref();
  }

  private async stopRenewal() {
    this.stoppingRenewal = true;
    clearTimeout(this.renewal);
    this.renewal = undefined;
    await this.renewing;
  }

  disable() {
    this.off = true;
    void this.stopRenewal();
    // Keep a saved sandbox eligible for the configured exit action.
    this.persist({ ...(this.saved ?? { status: "inactive" }), off: true });
    this.ctx.ui.setStatus("beachside", undefined);
  }

  async capture(name: string) {
    if (this.off) throw new Error("Beachside is off");

    return this.use(({ box }) => this.captureSnapshot(box, name));
  }

  private async captureSnapshot(box: Box, name: string) {
    const plan = await box.checkSnapshot(keepSource);

    if (plan.status !== "supported") throw new Error(plan.reason);
    const { store } = await this.config();

    const record: SnapshotRecord = {
      format: 1,
      kind: "snapshot",
      name: RecordName.parse(name),
      status: "capturing",
      profile: this.profile,
      provider: this.client!.provider,
      createdAt: new Date().toISOString(),
      sandbox: this.name,
      preserve: null,
      reference: null,
    };

    const { version } = await store.create("snapshot", record.name, record);
    let result: Awaited<ReturnType<Box["snapshot"]>>;

    try {
      result = await box.snapshot(keepSource);
    } catch (cause) {
      if (cause instanceof BeachsideError && cause.effect !== "none") {
        await store.update(
          "snapshot",
          record.name,
          { ...record, status: "unknown", recovery: cause.reference },
          version,
        );
      } else {
        await store.remove("snapshot", record.name, version);
      }

      throw cause;
    }

    const reference = SnapshotReference.parse(result.snapshot.reference);

    try {
      await store.update(
        "snapshot",
        record.name,
        {
          ...record,
          reference,
          status: "captured",
          preserve: result.capture.preserve,
        },
        version,
      );
    } catch (cause) {
      throw new Error(
        `Captured snapshot ${reference.nativeId} but could not save ${record.name}: ${message(cause)}`,
        { cause },
      );
    }

    return reference;
  }

  async destroy() {
    await this.stopRenewal();
    await this.opening?.catch(() => undefined);
    let box = this.box;

    if (!box && this.saved?.reference && this.saved.status !== "destroyed")
      box = await (await this.config()).client.sandboxes.get(this.saved.reference);

    if (!box && this.saved?.status === "pending") {
      throw new Error(
        "Sandbox creation has no confirmed identity. Inspect the saved recovery entry before allocating again.",
      );
    }

    if (!box) {
      if (this.saved?.status === "ready")
        throw new Error(`No reopenable reference for ${this.name}`);

      return;
    }

    await this.destroyBox(box);
    this.persist({
      status: "destroyed",
      reference: box.reference,
      workdir: this.workdir,
      off: this.off,
    });
    this.box = undefined;
    this.opening = undefined;
    this.ctx.ui.setStatus("beachside", undefined);
  }

  private async destroyBox(box: Box) {
    const { store } = await this.config();
    await box.destroy();
    this.box = undefined;
    const current = await store.get("sandbox", this.name);

    if (
      current &&
      (current.version === this.allocation?.version ||
        (box.reference && isDeepStrictEqual(current.record.reference, box.reference)))
    )
      await store.remove("sandbox", this.name, current.version);

    this.allocation = undefined;
  }

  async shutdown(reason: string, exit: string, target?: string) {
    try {
      await this.stopRenewal();
      await this.opening?.catch(() => undefined);
      const box = this.box;

      if (reason === "fork" && target && !this.off) {
        const entry: Fork = { target, profile: this.profile };

        try {
          if (this.saved?.status === "ready") {
            const parent = box ?? (await this.get()).box;
            const plan = await parent.checkSnapshot(keepSource);

            if (plan.status === "supported") {
              const result = await parent.snapshot(keepSource);
              entry.snapshot = SnapshotReference.parse(result.snapshot.reference);
              entry.workdir = this.workdir;
            } else if (plan.status !== "unsupported") {
              throw new Error(plan.reason);
            }
          }
        } catch (cause) {
          entry.error = `Fork snapshot failed: ${message(cause)}`;

          if (cause instanceof BeachsideError && cause.reference) {
            entry.recovery = cause.reference;
            entry.error += `. Recovery reference for operation ${cause.reference.operationId} is in the parent Pi session's ${forkEntry} entry.`;
          }
        }

        this.pi.appendEntry(forkEntry, entry);

        if (entry.error) this.ctx.ui.notify(entry.error, "error");
      }

      if (reason === "quit" && !this.blocked && this.saved?.status === "ready") {
        if (exit === "destroy") await this.destroy();

        if (exit === "suspend") {
          const signal = this.lifetime.signal;
          const reference = this.saved.reference;

          const current =
            box ??
            (reference
              ? await (await this.config()).client.sandboxes.get(reference, { signal })
              : undefined);

          if (!current) throw new Error(`No reopenable reference for ${this.name}`);
          const info = await current.inspect({ signal });

          if (info.state !== "suspended" && info.state !== "stopped")
            await current.suspend({ signal });
        }
      }
    } finally {
      this.lifetime.abort();
      clearTimeout(this.renewal);
      await this.settings?.catch(() => undefined);
      await this.client?.close();
    }
  }
}
