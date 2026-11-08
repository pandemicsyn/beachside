import type { BeachsideClient, SandboxHandle } from "beachside";
import { loadConfig, maxSandboxes, stateDir, type Env, type LoadedConfig } from "./config";
import { CliError, type Output } from "./output";
import { connect, descriptor, resolveProfile, type ResolvedProfile } from "./providers";
import { SecretReader } from "./secrets";
import { FsStateStore, type SandboxRecord, type StateStore } from "./store";

export type GlobalFlags = {
  json: boolean;
  profile?: string;
  provider?: string;
  config?: string;
  stateDir?: string;
};

export type Context = {
  env: Env;
  cwd: string;
  out: Output;
  flags: GlobalFlags;
  signal: AbortSignal;
  /** The CLI's own stdin, read as it arrives. */
  stdin: () => AsyncIterable<Uint8Array>;
};

/** Lazily loaded configuration, store and provider connections for one invocation. */
export class Session {
  private loaded?: LoadedConfig;
  private opened: BeachsideClient<true>[] = [];
  private readonly secrets: SecretReader;

  constructor(readonly ctx: Context) {
    this.secrets = new SecretReader(ctx.env, ctx.signal);
  }

  async config(): Promise<LoadedConfig> {
    this.loaded ??= await loadConfig(this.ctx.flags.config, this.ctx.env);

    return this.loaded;
  }

  async store(): Promise<StateStore> {
    const { flags, env, cwd } = this.ctx;

    return new FsStateStore(stateDir(flags.stateDir, await this.config(), env, cwd));
  }

  async limit(): Promise<number | null> {
    return maxSandboxes(await this.config(), this.ctx.env);
  }

  /** The profile selected by flags, environment or the config default. */
  async profile(): Promise<ResolvedProfile> {
    return resolveProfile(this.ctx.flags, await this.config(), this.ctx.env);
  }

  /** The profile a stored sandbox was created with: a configured profile, else an env-only provider. */
  async profileNamed(name: string): Promise<ResolvedProfile> {
    const loaded = await this.config();

    if (loaded.value.profiles?.[name])
      return resolveProfile({ profile: name }, loaded, this.ctx.env);

    if (descriptor(name)) return resolveProfile({ provider: name }, loaded, this.ctx.env);

    throw new CliError(
      "USAGE",
      `Profile ${name} is no longer defined`,
      `restore it in ${loaded.path}; the sandbox was created with it`,
    );
  }

  async connect(profile: ResolvedProfile): Promise<BeachsideClient<true>> {
    const client = await connect(profile, this.ctx.cwd, this.ctx.env, this.secrets);
    this.opened.push(client);

    return client;
  }

  async reopen(
    record: SandboxRecord,
    client?: BeachsideClient<true>,
  ): Promise<SandboxHandle<true>> {
    if (!record.reference)
      throw new CliError(
        "UNSUPPORTED",
        `Sandbox ${record.name} has no reopenable reference (status ${record.status})`,
        "inspect it with the provider's own tools; `beachside rm --force` drops the record",
      );
    const connected = client ?? (await this.connect(await this.profileNamed(record.profile)));

    return connected.sandboxes.get(record.reference, { signal: this.ctx.signal });
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.opened.splice(0).map((client) => client.close()));
  }
}
