import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

/** Called only by the manual live/cleanup entrypoint; never by ordinary offline tests. */
export async function loadCredentials(
  filename = process.env.BEACHSIDE_CREDENTIALS_FILE ?? join(homedir(), ".config", "beachside.env"),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  let source: string;

  try {
    const file = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK);

    try {
      const info = await file.stat();

      if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))
        throw new Error(
          "Credential file must be owned by the current user with owner-only permissions",
        );

      if (!info.isFile() || info.size > 65_536)
        throw new Error("Credential file must be a regular file within the size limit");
      const buffer = Buffer.alloc(65_537);
      let used = 0;

      while (used < buffer.length) {
        const result = await file.read(buffer, used, buffer.length - used, used);

        if (result.bytesRead === 0) break;
        used += result.bytesRead;
      }

      if (used > 65_536) throw new Error("Credential file exceeds the size limit");
      source = buffer.toString("utf8", 0, used);
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") source = "";
    else throw new Error("Unable to read Beachside credential file");
  }

  const parsed = parseEnv(source);

  const daytona =
    environment.BEACHSIDE_DAYTONA_API_KEY ??
    environment.DAYTONA_API_KEY ??
    parsed.DAYTONA_API_KEY ??
    parsed.BEACHSIDE_DAYTONA_API_KEY;

  const e2b =
    environment.E2B_API_KEY ??
    environment.BEACHSIDE_E2B_API_KEY ??
    parsed.E2B_API_KEY ??
    parsed.BEACHSIDE_E2B_API_KEY;

  if (daytona !== undefined) environment.BEACHSIDE_DAYTONA_API_KEY = daytona;

  if (e2b !== undefined) environment.E2B_API_KEY = e2b;
}
