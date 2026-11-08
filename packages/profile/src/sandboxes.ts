import type { SandboxHandle } from "beachside";
import { CliError, describeError } from "./output";
import {
  checkName,
  generatedName,
  listAll,
  type FsStateStore,
  type SandboxRecord,
  type StateStore,
  type Versioned,
} from "./store";

export async function claimName(
  store: StateStore,
  record: Omit<SandboxRecord, "name">,
  requested?: string,
  ifNotExists = false,
): Promise<Versioned> {
  for (let attempt = 0; ; attempt++) {
    const name = requested ? checkName(requested) : generatedName();
    const full = { ...record, name };

    try {
      const { version } = await store.create("sandbox", name, full);

      return { record: full, version };
    } catch (cause) {
      if (!(cause instanceof CliError) || cause.code !== "CONFLICT" || attempt >= 8) throw cause;

      if (requested)
        throw new CliError(
          "CONFLICT",
          cause.message,
          ifNotExists
            ? "its record is not a confirmed sandbox (still creating, or outcome unknown); check `beachside inspect`, or drop it with `beachside rm --force`"
            : "pass --if-not-exists to reuse it, or choose another --name",
        );
    }
  }
}

/** Check the shared cap and reserve a store name before a provider mutation. */
export function claimSandbox(
  store: FsStateStore,
  limit: number | null,
  record: Omit<SandboxRecord, "name">,
  name?: string,
  ifNotExists = false,
): Promise<Versioned> {
  return store.withSandboxClaims(async () => {
    if (limit !== null && (await listAll(store, "sandbox")).length >= limit)
      throw new CliError(
        "LIMIT_REACHED",
        `The store already holds ${limit} sandboxes (limits.maxSandboxes)`,
        "remove some with `beachside rm`, or raise limits.maxSandboxes in beachside.json",
      );

    return claimName(store, record, name, ifNotExists);
  });
}

/** Record confirmed ownership or retain recovery for an uncertain allocation. */
export async function recordSandbox(
  store: StateStore,
  claimed: Versioned,
  allocate: () => Promise<SandboxHandle<true>>,
) {
  let box: SandboxHandle<true>;

  try {
    box = await allocate();
  } catch (cause) {
    const report = describeError(cause);

    if (report.outcome === "rejected") {
      await store.remove("sandbox", claimed.record.name, claimed.version);
      throw cause;
    }

    const reference = report.known?.reference ?? null;
    const recovery = report.known?.recovery;
    let kept = `the store keeps ${claimed.record.name} so it can be inspected or removed`;

    try {
      await store.update(
        "sandbox",
        claimed.record.name,
        { ...claimed.record, status: "unknown", reference, recovery },
        claimed.version,
      );
    } catch (storeCause) {
      kept = `the store could not record it (${describeError(storeCause).message}); keep the reference below`;
    }

    throw new CliError(
      report.outcome === "partial" ? "PARTIAL" : "OUTCOME_UNKNOWN",
      report.message,
      kept,
      { sandbox: claimed.record.name, reference, recovery },
      report.outcome,
    );
  }

  const record: SandboxRecord = { ...claimed.record, status: "created", reference: box.reference };

  try {
    const { version } = await store.update("sandbox", record.name, record, claimed.version);

    return { box, record, version };
  } catch (cause) {
    const unrecorded = cause instanceof Error ? cause : new Error(String(cause));

    return { box, record, version: claimed.version, unrecorded };
  }
}
