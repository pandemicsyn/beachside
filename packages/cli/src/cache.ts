import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ResourceReference,
  type BeachsideClient,
  type SandboxHandle,
  type SnapshotResult,
} from "beachside";
import { z } from "zod";
import { expandHome } from "./config";
import { CliError, describeError, usage } from "./output";
import type { ResolvedProfile } from "./providers";
import type { Session } from "./session";
import type { CliSetup } from "./setups";
import { listAll, type SnapshotRecord, type StateStore, type Versioned } from "./store";
import { parseDuration } from "./units";

/**
 * Setup caches: a filesystem snapshot taken right after setup, before startup and add-ons, found
 * again by a key over the provider, scope, image, setup digest and any files the setup names. A
 * cache is an ordinary snapshot record named `cache-<key>` with a `cache` field; that name is
 * also the claim, so two creates that miss at once never both capture.
 */

/** The provider label that lets a runner with an empty store find a cache. */
export const CACHE_LABEL = "beachside.setup-cache";

export const DEFAULT_MAX_AGE_SECONDS = 7 * 24 * 3600;

/** A build claimed longer ago than this is treated as abandoned and may be taken over. */
const ABANDONED_SECONDS = 2 * 3600;

const SnapshotReference = ResourceReference.extend({ kind: z.literal("snapshot") });

export type CacheFlags = {
  /** `--cache`: cache this setup even when no named setup asks for it. */
  force: boolean;
  /** `--no-cache`: neither use nor build a cache for this create. */
  skip: boolean;
  /** `--refresh-cache`: build a new cache now, replacing any current one. */
  refresh: boolean;
};

export type CacheInputs = {
  provider: string;
  scope: unknown;
  profile: string;
  image: string | null;
  digest: string;
  files: { path: string; sha256: string }[];
};

/** The cache key: 32 hex characters of a SHA-256 over every input, never env values. */
export function cacheKey(inputs: CacheInputs): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, ...inputs }))
    .digest("hex")
    .slice(0, 32);
}

export function cacheRecordName(key: string): string {
  return `cache-${key}`;
}

/** Values that come from the caller's environment or a password manager. */
const secretReference = /^(env:|op:\/\/|bws:\/\/|pass:\/\/)/;

export type CachePlan = {
  key: string;
  name: string;
  /** Named setups and paths, for `setup cache ls`. */
  setup: string;
  maxAgeSeconds: number;
  refresh: boolean;
  labels: boolean;
  /** Capture support was `unknown` before the sandbox existed; check it again on the sandbox. */
  recheck: boolean;
};

/**
 * Whether this create caches its setup, and under which key. Every refusal is a usage error
 * before anything exists: a setup that asked for a cache never runs silently uncached.
 */
export async function planCache(
  session: Session,
  client: BeachsideClient<true>,
  profile: ResolvedProfile,
  setup: CliSetup | null,
  flags: CacheFlags,
  request: {
    image: string | null;
    env: Record<string, string>;
    labels: Record<string, string>;
    lifetimeSeconds?: number;
    snapshot?: string;
  },
): Promise<CachePlan | null> {
  if (flags.skip) {
    if (flags.force || flags.refresh)
      throw usage("--no-cache cannot be combined with --cache or --refresh-cache");

    return null;
  }

  const config = setup?.cache?.config ?? (flags.force || flags.refresh ? true : undefined);

  if (config === undefined || config === false) return null;

  if (!setup?.digest)
    throw usage("A setup cache needs setup steps", "pass --setup or --setup-cmd, or drop --cache");

  if (request.snapshot)
    throw usage(
      "--snapshot already starts from saved state; a setup cache cannot apply",
      "drop --cache, or pass --no-cache",
    );
  const from = setup.cache?.from ?? "--cache";
  const options = config === true ? {} : config;

  if (options.secrets !== "allow") {
    const secret = Object.entries(setup.env).find(([, value]) => secretReference.test(value));

    if (secret)
      throw usage(
        `Setup ${from} would be cached with ${secret[0]} from ${secret[1].split(":")[0]}; a step could write it to disk and the snapshot would keep it`,
        `set "cache": { "secrets": "allow" } on setup ${from} if that is safe, or pass --no-cache`,
      );
  }

  const capabilities = await client.capabilities();
  const { capture, restore } = capabilities.snapshots;

  // Some providers judge capture only on an actual sandbox: `unknown` is checked again after setup.
  const refused = [
    ["capture", capture],
    ["restore", restore],
  ] as const;

  for (const [what, support] of refused)
    if (support.status === "unsupported" || support.status === "unavailable")
      throw new CliError(
        "UNSUPPORTED",
        `${profile.provider} cannot cache setups: snapshot ${what} is ${support.status} (${support.reason})`,
        `pass --no-cache, or remove "cache" from setup ${from}`,
      );
  const restoreOptions = restore.status === "supported" ? (restore.value.options ?? {}) : {};

  const missing = [
    Object.keys(request.env).length && !restoreOptions.env ? "--env" : null,
    Object.keys(request.labels).length && !restoreOptions.labels ? "--label" : null,
    request.lifetimeSeconds !== undefined && !restoreOptions.lifetime ? "--ttl" : null,
  ].filter((value): value is string => value !== null);

  if (missing.length)
    throw new CliError(
      "UNSUPPORTED",
      `${profile.provider} cannot apply ${missing.join(", ")} when restoring a setup cache`,
      `drop ${missing.join(", ")}, or pass --no-cache`,
    );

  const files: CacheInputs["files"] = [];
  const dir = setup.cache?.dir ?? session.ctx.cwd;

  for (const file of options.files ?? []) {
    const path = resolve(dir, expandHome(file, session.ctx.env));
    let content: Buffer;

    try {
      content = await readFile(path);
    } catch (cause) {
      throw usage(
        `Cannot read ${file}, which setup ${from} names in cache.files: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    files.push({ path: file, sha256: createHash("sha256").update(content).digest("hex") });
  }

  const key = cacheKey({
    provider: profile.provider,
    scope: client.scope,
    profile: profile.name,
    image: request.image,
    digest: setup.digest,
    files,
  });

  return {
    key,
    name: cacheRecordName(key),
    setup: setup.sources.join(", ") || from,
    maxAgeSeconds: options.maxAge
      ? parseDuration(options.maxAge, `setup ${from} cache.maxAge`)
      : DEFAULT_MAX_AGE_SECONDS,
    refresh: flags.refresh,
    labels: capture.status === "supported" && capture.value.labels === true,
    recheck: capture.status !== "supported",
  };
}

export type CacheLookup =
  /** Restore this record. */
  | { kind: "hit"; entry: Versioned<SnapshotRecord> }
  /** Build and capture into this claimed record; `previous` is the snapshot it replaces. */
  | {
      kind: "build";
      entry: Versioned<SnapshotRecord>;
      previous: z.infer<typeof SnapshotReference> | null;
    }
  /** Run setup without the cache, because another create holds the claim. */
  | { kind: "uncached"; reason: string };

function age(record: SnapshotRecord): number {
  const built = record.cache?.builtAt ?? record.createdAt;

  return (Date.now() - Date.parse(built)) / 1000;
}

/** A snapshot this store does not know yet, found on the provider by its cache label. */
async function discover(
  client: BeachsideClient<true>,
  plan: CachePlan,
): Promise<{ reference: z.infer<typeof SnapshotReference>; createdAt: string | null } | null> {
  const capabilities = await client.capabilities();

  if (!plan.labels || capabilities.snapshots.list.status !== "supported") return null;
  let cursor: string | undefined;

  // A bounded walk, so a huge account cannot stall a create.
  for (let page = 0; page < 10; page++) {
    const result = await client.snapshots.list({
      limit: 100,
      cursor,
      labels: { [CACHE_LABEL]: plan.key },
    });

    const found = result.items.find((info) => info.state === "ready");

    if (found)
      return { reference: SnapshotReference.parse(found.reference), createdAt: found.createdAt };
    cursor = result.nextCursor;

    if (!cursor) return null;
  }

  return null;
}

function claimed(plan: CachePlan, profile: ResolvedProfile, sandbox: string): SnapshotRecord {
  const now = new Date().toISOString();

  return {
    format: 1,
    kind: "snapshot",
    name: plan.name,
    status: "capturing",
    profile: profile.name,
    provider: profile.provider,
    createdAt: now,
    sandbox,
    preserve: null,
    reference: null,
    cache: {
      key: plan.key,
      setup: plan.setup,
      builtAt: now,
      buildSeconds: null,
      maxAgeSeconds: plan.maxAgeSeconds,
      claimedAt: now,
    },
  };
}

/**
 * Find the cache for a plan, or claim the right to build it. A store record wins; without one,
 * a labelled snapshot on the provider is recorded and used. Only one create claims a build.
 */
export async function lookupCache(
  session: Session,
  client: BeachsideClient<true>,
  profile: ResolvedProfile,
  plan: CachePlan,
  sandbox: string,
): Promise<CacheLookup> {
  const store = await session.store();
  let entry = await store.get("snapshot", plan.name);

  if (!entry) {
    const found = await discover(client, plan).catch(() => null);

    if (found) {
      const record: SnapshotRecord = {
        ...claimed(plan, profile, sandbox),
        status: "captured",
        sandbox: "provider",
        preserve: "filesystem",
        reference: found.reference,
      };

      record.cache!.builtAt = found.createdAt ?? record.createdAt;
      delete record.cache!.claimedAt;

      try {
        const { version } = await store.create("snapshot", plan.name, record);

        session.ctx.out.note(
          `setup cache: found ${found.reference.nativeId} on ${profile.provider}`,
        );
        entry = { record, version };
      } catch (cause) {
        if (!(cause instanceof CliError) || cause.code !== "CONFLICT") throw cause;
        entry = await store.get("snapshot", plan.name);
      }
    }
  }

  if (!entry) {
    try {
      const record = claimed(plan, profile, sandbox);
      const { version } = await store.create("snapshot", plan.name, record);

      return { kind: "build", entry: { record, version }, previous: null };
    } catch (cause) {
      if (!(cause instanceof CliError) || cause.code !== "CONFLICT") throw cause;

      return { kind: "uncached", reason: "another create is building this cache" };
    }
  }

  const { record } = entry;

  if (record.status === "capturing") {
    const since = record.cache?.claimedAt ?? record.createdAt;

    if ((Date.now() - Date.parse(since)) / 1000 < ABANDONED_SECONDS)
      return { kind: "uncached", reason: "another create is building this cache" };

    // An abandoned build: take the claim over, unless someone else just did.
    return takeOver(store, entry, plan, profile, sandbox, null);
  }

  if (record.status !== "captured" || !record.reference)
    return {
      kind: "uncached",
      reason: `the cache record ${record.name} is ${record.status}; \`beachside snapshot inspect ${record.name}\` checks it`,
    };

  const stale = age(record) > (record.cache?.maxAgeSeconds ?? plan.maxAgeSeconds);

  if (!stale && !plan.refresh) return { kind: "hit", entry };

  const rebuild = await takeOver(store, entry, plan, profile, sandbox, record.reference);

  // Someone else is rebuilding a stale cache: the old one is still good to start from.
  if (rebuild.kind === "uncached" && !plan.refresh) return { kind: "hit", entry };

  return rebuild;
}

/** Mark a record as being rebuilt, keeping its current snapshot until the new one exists. */
async function takeOver(
  store: StateStore,
  entry: Versioned<SnapshotRecord>,
  plan: CachePlan,
  profile: ResolvedProfile,
  sandbox: string,
  previous: z.infer<typeof SnapshotReference> | null,
): Promise<CacheLookup> {
  const now = new Date().toISOString();

  const record: SnapshotRecord = {
    ...entry.record,
    profile: profile.name,
    provider: profile.provider,
    cache: {
      ...(entry.record.cache ?? claimed(plan, profile, sandbox).cache!),
      claimedAt: now,
    },
  };

  try {
    const { version } = await store.update("snapshot", plan.name, record, entry.version);

    return { kind: "build", entry: { record, version }, previous };
  } catch (cause) {
    if (!(cause instanceof CliError) || cause.code !== "CONFLICT") throw cause;

    return { kind: "uncached", reason: "another create is building this cache" };
  }
}

/** Forget a cache record whose snapshot the provider no longer has. */
export async function forgetCache(session: Session, name: string): Promise<void> {
  const store = await session.store();
  const current = await store.get("snapshot", name);

  if (current) await store.remove("snapshot", name, current.version);
}

/** Capture the box that just ran setup into the claimed cache record. */
export async function captureCache(
  session: Session,
  client: BeachsideClient<true>,
  box: SandboxHandle<true>,
  plan: CachePlan,
  lookup: Extract<CacheLookup, { kind: "build" }>,
  sandbox: string,
  buildSeconds: number,
): Promise<{ record: SnapshotRecord; result: SnapshotResult; seconds: number }> {
  const store = await session.store();
  const started = Date.now();
  const { entry, previous } = lookup;
  let result: SnapshotResult;

  // Refused before any effect: give the claim back, keeping a previous cache as it was.
  const release = async () => {
    if (previous) {
      const { claimedAt: _claimedAt, ...cache } = entry.record.cache!;

      await store
        .update("snapshot", plan.name, { ...entry.record, cache }, entry.version)
        .catch(() => undefined);
    } else await store.remove("snapshot", plan.name, entry.version).catch(() => undefined);
  };

  let labels = plan.labels;

  if (plan.recheck) {
    const capture = await box
      .capabilities()
      .then((capabilities) => capabilities.snapshots.capture)
      .catch(async (cause: unknown) => {
        await release();
        throw cause;
      });

    if (capture.status !== "supported") {
      await release();
      throw new CliError(
        "UNSUPPORTED",
        `snapshot capture is ${capture.status} (${capture.reason})`,
      );
    }

    labels = capture.value.labels === true;
  }

  try {
    result = await box.snapshot(labels ? { labels: { [CACHE_LABEL]: plan.key } } : {}, {
      signal: session.ctx.signal,
    });
  } catch (cause) {
    const report = describeError(cause);

    if (report.outcome === "rejected") {
      await release();

      throw cause;
    }

    // Uncertain: keep the record as the claim, so `snapshot inspect` can recover it.
    if (!previous)
      await store
        .update(
          "snapshot",
          plan.name,
          { ...entry.record, status: "unknown", recovery: report.known?.recovery },
          entry.version,
        )
        .catch(() => undefined);

    throw cause;
  }

  const reference = SnapshotReference.parse(result.snapshot.reference);
  const { recovery: _recovery, ...rest } = entry.record;
  const now = new Date().toISOString();

  const record: SnapshotRecord = {
    ...rest,
    status: "captured",
    createdAt: now,
    sandbox,
    preserve: result.capture.preserve,
    reference,
    cache: {
      key: plan.key,
      setup: plan.setup,
      builtAt: now,
      buildSeconds,
      maxAgeSeconds: plan.maxAgeSeconds,
    },
  };

  await store.update("snapshot", plan.name, record, entry.version);

  // The replacement exists: delete the snapshot it replaces, if this CLI created it.
  if (previous && previous.nativeId !== reference.nativeId) {
    if (previous.ownership === "verified-created")
      try {
        await client.snapshots.delete(previous, { signal: session.ctx.signal });
      } catch (cause) {
        const report = describeError(cause);

        if (report.code !== "NOT_FOUND")
          session.ctx.out.note(
            `the previous cache snapshot ${previous.nativeId} is still on ${record.provider} (${report.message})`,
          );
      }
    else
      session.ctx.out.note(
        `the previous cache snapshot ${previous.nativeId} was not captured by this store; it stays on ${record.provider}`,
      );
  }

  return { record, result, seconds: (Date.now() - started) / 1000 };
}

/** `3m12s`, `45s`, `2d`: a short human duration. */
export function shortDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;

  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds % 60);

    return rest ? `${minutes}m${rest}s` : `${minutes}m`;
  }

  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;

  return `${Math.round(seconds / 86400)}d`;
}

/** The hit line: what was restored, how fast, and how old the cache is. */
export function hitLine(plan: CachePlan, record: SnapshotRecord, restoreSeconds: number): string {
  const built = record.cache?.buildSeconds;

  return `setup ${plan.setup}: cache hit (restored in ${shortDuration(restoreSeconds)}; built ${shortDuration(age(record))} ago${built ? ` in ${shortDuration(built)}` : ""})`;
}

export type CacheRow = {
  name: string;
  key: string;
  setup: string;
  profile: string;
  provider: string;
  status: SnapshotRecord["status"];
  builtAt: string;
  ageSeconds: number;
  buildSeconds: number | null;
  stale: boolean;
  id: string | null;
};

/** The setup caches in the store, newest first. */
export async function cacheRows(store: StateStore, onInvalid?: (message: string) => void) {
  const entries = (await listAll(store, "snapshot", onInvalid)).filter(
    ({ record }) => record.cache,
  );

  const rows = entries.map(({ record, version }) => {
    const cache = record.cache!;
    const seconds = age(record);

    const row: CacheRow = {
      name: record.name,
      key: cache.key,
      setup: cache.setup,
      profile: record.profile,
      provider: record.provider,
      status: record.status,
      builtAt: cache.builtAt,
      ageSeconds: Math.round(seconds),
      buildSeconds: cache.buildSeconds ?? null,
      stale: seconds > cache.maxAgeSeconds,
      id: record.reference?.nativeId ?? null,
    };

    return { row, entry: { record, version } };
  });

  return rows.sort((a, b) => b.row.builtAt.localeCompare(a.row.builtAt));
}

export function cacheTable(rows: CacheRow[]): string {
  if (!rows.length) return 'no setup caches; add "cache": true to a setup or pass --cache';

  return [
    `${"SETUP".padEnd(24)} ${"PROFILE".padEnd(12)} ${"AGE".padEnd(6)} ${"BUILD".padEnd(7)} ${"STATUS".padEnd(9)} NAME`,
    ...rows.map((row) =>
      [
        row.setup.slice(0, 24).padEnd(24),
        row.profile.padEnd(12),
        shortDuration(row.ageSeconds).padEnd(6),
        (row.buildSeconds === null ? "-" : shortDuration(row.buildSeconds)).padEnd(7),
        (row.stale ? "stale" : row.status).padEnd(9),
        row.name,
      ].join(" "),
    ),
  ].join("\n");
}

export type PruneItem = {
  name: string;
  setup: string;
  id: string | null;
  result: "deleted" | "gone" | "would-delete" | "skipped" | "failed";
  reason?: string;
};

/**
 * Delete cache snapshots and their records. Only snapshots this CLI captured are deleted; a
 * failed delete keeps the record so it can be tried again.
 */
export async function deleteCaches(
  session: Session,
  entries: Versioned<SnapshotRecord>[],
  dryRun: boolean,
): Promise<PruneItem[]> {
  const store = await session.store();
  const items: PruneItem[] = [];

  for (const { record, version } of entries) {
    const base = {
      name: record.name,
      setup: record.cache?.setup ?? "",
      id: record.reference?.nativeId ?? null,
    };

    if (record.status === "capturing") {
      items.push({ ...base, result: "skipped", reason: "a create is building it" });
      continue;
    }

    if (record.status !== "captured" || !record.reference) {
      items.push({
        ...base,
        result: "skipped",
        reason: `it is ${record.status}; \`beachside snapshot rm ${record.name}\` checks it`,
      });
      continue;
    }

    if (record.reference.ownership !== "verified-created") {
      items.push({
        ...base,
        result: "skipped",
        reason: `found on the provider, not captured by this store; \`beachside snapshot rm ${record.name} --force\` deletes it`,
      });
      continue;
    }

    if (dryRun) {
      items.push({ ...base, result: "would-delete" });
      continue;
    }

    try {
      const client = await session.connect(await session.profileNamed(record.profile));
      let result: PruneItem["result"] = "deleted";

      try {
        await client.snapshots.delete(record.reference, { signal: session.ctx.signal });
      } catch (cause) {
        if (describeError(cause).code !== "NOT_FOUND") throw cause;
        result = "gone";
      }

      await store.remove("snapshot", record.name, version);
      items.push({ ...base, result });
    } catch (cause) {
      items.push({ ...base, result: "failed", reason: describeError(cause).message });
    }
  }

  return items;
}

export function pruneLines(items: PruneItem[]): string[] {
  return items.map(
    (item) =>
      `${item.result.padEnd(12)} ${item.setup.slice(0, 24).padEnd(24)} ${item.name}${item.reason ? ` (${item.reason})` : ""}`,
  );
}
