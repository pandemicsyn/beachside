import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildAndLoad } from "../provider-qualification/build";

declare global {
  var beachsideLiveBuild: { revision: string; dirty: boolean } | undefined;
}

if (process.env.BEACHSIDE_LIVE === "1") {
  if (process.env.CI || process.env.BEACHSIDE_QUAL_LIVE_AUTHORIZED !== "yes")
    throw new Error(
      "Live integration tests require explicit authorization and cannot run in ordinary CI",
    );
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  await buildAndLoad(root, async () => {
    globalThis.beachsideLiveBuild = {
      revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      dirty: !!execFileSync("git", ["status", "--porcelain"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
    };
  });
}
