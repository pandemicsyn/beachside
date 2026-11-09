import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { relative, sep } from "node:path";
import { posix } from "node:path";
import {
  localTree,
  upload,
  download,
  Excludes,
  shellQuote,
} from "@beachside-internal/profile/transfer";
import type { SandboxHandle } from "beachside";

const run = promisify(execFile);

const guestRoot = "/tmp/beachside-work";

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, timeout: 5000 });

  return stdout.trim();
}

export async function workspace(
  cwd: string,
  mode: string | undefined,
  network: string,
  restoring: boolean,
) {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
  const sync = mode ?? (root && !restoring ? "git" : "none");

  switch (sync) {
    case "git": {
      if (!root) throw new Error("Git sync requires a host Git worktree");

      if (network === "blocked")
        throw new Error(
          "Git sync requires guest network access. Use --beachside-sync upload or none.",
        );
      const branch = await git(cwd, ["symbolic-ref", "--short", "HEAD"]).catch(() => undefined);

      if (!branch)
        throw new Error(
          "Git sync requires a checked-out branch. Use --beachside-sync upload for a detached HEAD.",
        );
      const origin = await git(cwd, ["remote", "get-url", "origin"]).catch(() => undefined);

      if (!origin) throw new Error("Git sync requires an origin remote");
      const url = URL.parse(origin);

      if (
        !url ||
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new Error(
          "Git sync requires a credential-free HTTPS origin. Use --beachside-sync upload for private repositories.",
        );
      }

      const workdir = posix.join(guestRoot, ...relative(root, cwd).split(sep));

      return {
        workdir,
        script: `GIT_TERMINAL_PROMPT=0 git clone --single-branch --branch ${shellQuote(branch)} -- ${shellQuote(origin)} ${shellQuote(guestRoot)} && test -d ${shellQuote(workdir)}`,
      };
    }

    case "upload":
    case "none":
      return {
        workdir: guestRoot,
        script: `mkdir -p -- ${shellQuote(guestRoot)}`,
        upload: sync === "upload",
      };
    default:
      throw new Error("Expected --beachside-sync git, upload, or none");
  }
}

export async function push(
  box: SandboxHandle<true>,
  cwd: string,
  workdir: string,
  signal: AbortSignal,
) {
  const tree = await localTree(cwd, new Excludes([".git", ".git/**"]), true, () => {});

  return upload(box, box.id, tree, shellQuote(workdir), null, signal);
}

export async function pull(
  box: SandboxHandle<true>,
  workdir: string,
  destination: string,
  signal: AbortSignal,
) {
  await mkdir(destination);

  return download(
    box,
    box.id,
    workdir,
    destination,
    new Excludes([".git", ".git/**"]),
    true,
    signal,
  );
}
