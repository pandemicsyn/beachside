import {
  BeachsideError,
  type BeachsideClient,
  type RecoveryReference,
  type SnapshotResult,
} from "beachside";
import type { Session } from "./session";

/**
 * The recovery reference of a capture whose snapshot exists but whose source restart was never
 * sent. Daytona leaves a capture this way when it outlives the adapter's own wait; only an
 * explicit continuation sends the restart.
 */
export function awaitingRestart(cause: unknown): RecoveryReference | null {
  if (!(cause instanceof BeachsideError) || !cause.reference) return null;

  const { outcome } = cause;

  return outcome?.kind === "snapshot_capture" && outcome.restart?.status === "not-submitted"
    ? cause.reference
    : null;
}

/** Send the pending restart of such a capture once, then wait for the capture's result. */
export async function continueCapture(
  session: Session,
  client: BeachsideClient<true>,
  reference: RecoveryReference,
): Promise<SnapshotResult> {
  const handle = await client.recover(reference);

  if (handle.kind !== "snapshot_capture")
    throw new Error(`Recovered ${handle.kind}, not a capture`);
  session.ctx.out.note("the snapshot is ready; restarting the source sandbox");
  await handle.continue({ signal: session.ctx.signal });

  return handle.wait({ signal: session.ctx.signal });
}
