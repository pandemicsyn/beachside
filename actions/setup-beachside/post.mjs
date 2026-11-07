import { existsSync } from "node:fs";
import { join } from "node:path";
import { run } from "./lib.mjs";

const beachside = process.env.STATE_beachside;

const stateDir = process.env.STATE_stateDir;

if (process.env.STATE_cleanup !== "true" || !beachside || !stateDir)
  console.log("Beachside cleanup skipped");
else if (!existsSync(join(stateDir, "sandboxes")))
  console.log("No Beachside sandboxes recorded in this job");
else
  try {
    // The store is this job's own, so --all reaches only sandboxes this job created.
    process.env.BEACHSIDE_STATE_DIR = stateDir;
    run(beachside, ["rm", "--all"]);
  } catch (cause) {
    // Cleanup never fails the job; a later `beachside gc` or the sandbox lifetime collects leftovers.
    console.log(
      `::warning::Beachside cleanup did not finish: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
