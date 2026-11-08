import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  BeachsideError,
  ResourceReference,
  type SandboxHandle,
  type BeachsideClient,
  type RecoveryReference,
} from "beachside";
import { loadConfig, stateDir } from "@beachside-internal/profile/config";
import { connect, resolveProfile } from "@beachside-internal/profile/providers";
import { SecretReader } from "@beachside-internal/profile/secrets";
import { FsStateStore, RecordName, type SnapshotRecord } from "@beachside-internal/profile/store";
import { z } from "zod";
import { workspace, push } from "./workspace";
import beachsideSkill from "../../../skills/beachside/SKILL.md" with { type: "text" };
import cliSkill from "../../../skills/beachside-cli/SKILL.md" with { type: "text" };

export const sessionEntry = "beachside.pi.session";

export const forkEntry = "beachside.pi.fork";

const SnapshotReference = ResourceReference.extend({ kind: z.literal("snapshot") });

export const Saved = z.object({
  owner: z.string(),
  profile: z.string(),
  status: z.enum(["pending", "ready", "destroyed", "inactive"]),
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
    const raw = loaded.value.profiles?.[this.profile]?.config;

    let policy = profile.network;

    if (policy === undefined && (raw?.network !== undefined || raw?.networkPolicy !== undefined)) {
      const configured =
        raw.network !== undefined ? profile.config.network : profile.config.networkPolicy;

      policy = z.string().min(1).safeParse(configured).data;
    }

    const network = z.string().min(1).safeParse(policy);

    if (!network.success)
      throw new Error(`Profile ${this.profile} needs an explicit network policy`);

    const client = await connect(
      profile,
      this.ctx.cwd,
      env,
      new SecretReader(env, this.lifetime.signal),
    );

    this.client = client;

    return {
      client,
      network: network.data,
      store: new FsStateStore(stateDir(undefined, loaded, env, this.ctx.cwd)),
    };
  }

  private config() {
    return (this.settings ??= this.load());
  }

  async capabilities() {
    return (await this.config()).client.capabilities();
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

  get() {
    return (this.opening ??= this.open());
  }

  private async open(): Promise<{ box: Box; workdir: string }> {
    const { client, network, store } = await this.config();
    const signal = this.lifetime.signal;
    const labels = { "beachside.pi": "1", "beachside.pi.session": this.owner };

    if (this.saved) {
      const { status, reference, workdir, recovery } = this.saved;

      if (this.saved.network && this.saved.network !== network) {
        throw new Error(
          `Sandbox ${reference?.nativeId ?? "session"} belongs to a different network policy. Start a new Pi session to use the changed policy.`,
        );
      }

      if (status !== "ready" || !reference || !workdir) {
        throw new Error(
          `Saved Beachside sandbox is ${status}${reference ? ` (${reference.nativeId})` : ""}${recovery ? `; recovery is recorded in the Pi session` : ""}. Start a new Pi session to allocate another sandbox.`,
        );
      }

      const box = await client.sandboxes.get(reference, { signal });
      this.box = box;
      const info = await box.inspect({ signal });

      if (info.state === "suspended") await box.resume({ signal });
      else if (info.state !== "running") throw new Error(`Sandbox ${box.id} is ${info.state}`);
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

    // Persist before submission so an interrupted run cannot silently allocate another sandbox.
    const pending = { status: "pending", workdir: plan.workdir, network } as const;
    this.persist(pending);
    let box: Box;

    try {
      if (snapshot) {
        const { snapshots } = await client.capabilities();
        const restore = snapshots.restore;

        if (restore.status !== "supported") throw new Error(restore.reason);
        const source = await client.snapshots.get(snapshot);

        const operation = await source.submitRestore(
          {
            network,
            requireIndependentLifecycle: true,
            labels:
              restore.value.options?.labels && client.provider !== "vercel" ? labels : undefined,
          },
          { signal },
        );

        this.persist({ ...pending, recovery: operation.reference });
        box = await operation.wait({ signal });
      } else {
        const caps = await client.capabilities();

        const operation = await client.sandboxes.submitCreate(
          {
            network,
            labels: caps.createLabels ? labels : undefined,
          },
          { signal },
        );

        this.persist({ ...pending, recovery: operation.reference });
        box = await operation.wait({ signal });
      }
    } catch (cause) {
      if (cause instanceof BeachsideError) {
        const reference =
          cause.outcome && "sandbox" in cause.outcome ? cause.outcome.sandbox : undefined;

        if (reference || cause.reference) {
          this.persist({ ...pending, reference, recovery: cause.reference });
        }
      }

      throw cause;
    }

    this.box = box;
    this.persist({ ...pending, reference: box.reference });

    if (plan.script)
      await box.exec({ command: { kind: "shell", script: plan.script } }, { signal });

    if (plan.upload) await push(box, this.ctx.cwd, plan.workdir, signal);
    await box.exec(
      {
        command: {
          kind: "shell",
          script:
            "mkdir -p /tmp/beachside-pi-skills/beachside /tmp/beachside-pi-skills/beachside-cli",
        },
      },
      { signal },
    );
    await box.writeTextFile("/tmp/beachside-pi-skills/beachside/SKILL.md", beachsideSkill, {
      overwrite: true,
      signal,
    });
    await box.writeTextFile("/tmp/beachside-pi-skills/beachside-cli/SKILL.md", cliSkill, {
      overwrite: true,
      signal,
    });
    await this.ready(box, plan.workdir, network);

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

  private async ready(box: Box, workdir: string, network: string) {
    this.persist({ status: "ready", reference: box.reference, workdir, network });
    this.ctx.ui.setStatus("beachside", `${this.client?.provider} · ${box.id} · ${workdir}`);

    try {
      const caps = await box.capabilities();

      if (caps.lifecycle.renew.status !== "supported") return;
      await this.scheduleRenewal(box, (await box.inspect()).expires);
    } catch (cause) {
      this.ctx.ui.notify(`Sandbox ${box.id} renewal unavailable: ${message(cause)}`, "warning");
    }
  }

  private async scheduleRenewal(
    box: Box,
    expires: import("beachside").SandboxInfo["expires"] | undefined,
  ) {
    if (expires?.status !== "known" || this.lifetime.signal.aborted) return;
    const remaining = Date.parse(expires.at) - Date.now();

    if (!Number.isFinite(remaining) || remaining <= 0) return;
    this.renewal = setTimeout(
      () => {
        this.renewing = box.renew(undefined, { signal: this.lifetime.signal }).then(
          async (result) => this.scheduleRenewal(box, result.observation?.expires),
          (cause: unknown) => {
            this.ctx.ui.notify(`Sandbox ${box.id} renewal stopped: ${message(cause)}`, "warning");
          },
        );
      },
      Math.max(1000, Math.min(remaining / 2, 2_147_483_647)),
    );
    this.renewal.unref();
  }

  disable() {
    this.off = true;
    this.persist({ status: "inactive", ...this.saved, off: true });
    this.ctx.ui.setStatus("beachside", undefined);
  }

  async capture(name: string) {
    const { box } = await this.get();
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
      sandbox: box.id,
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
    clearTimeout(this.renewal);
    await this.renewing;
    await this.opening?.catch(() => undefined);
    let box = this.box;

    if (!box && this.saved?.reference && this.saved.status !== "destroyed")
      box = await (await this.config()).client.sandboxes.get(this.saved.reference);

    if (!box && this.saved?.status === "pending") {
      throw new Error(
        "Sandbox creation has no confirmed identity. Inspect the saved recovery entry before allocating again.",
      );
    }

    if (!box) return;
    await box.destroy();
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

  async shutdown(reason: string, exit: string, target?: string) {
    clearTimeout(this.renewal);

    try {
      await this.renewing;
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

      if (reason === "quit") {
        if (exit === "destroy" && (box || (this.opening && this.saved?.reference)))
          await this.destroy();

        if (exit === "suspend" && box) await box.suspend();
      }
    } finally {
      this.lifetime.abort();
      clearTimeout(this.renewal);
      await this.settings?.catch(() => undefined);
      await this.client?.close();
    }
  }
}
