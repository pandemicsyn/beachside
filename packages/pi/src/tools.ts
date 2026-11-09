import { matchesGlob, posix } from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  truncateHead,
  truncateLine,
  type BashOperations,
  type GrepToolDetails,
  type ReadOperations,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { BeachsideError, NonzeroExitError, type SandboxHandle } from "beachside";
import { shellQuote } from "@beachside-internal/profile/transfer";

type Box = SandboxHandle<true>;

const partBytes = 1_048_576;

export const findDescription =
  "Search for files by glob pattern in the sandbox. Excludes .git and node_modules and includes other paths regardless of .gitignore.";

export const grepDescription =
  "Search sandbox files for patterns. Skips .git and node_modules. Git ignore rules apply when ripgrep is installed.";

function guestPath(path: string, cwd: string): string {
  if (path === "~" || path.startsWith("~/")) {
    throw new Error("Use an absolute guest path or a path relative to the Beachside workdir");
  }

  return posix.resolve(cwd, path.replace(/^@/, ""));
}

function command(script: string) {
  return { kind: "shell" as const, script };
}

function outcome(box: Box, error: Error): Error {
  if (error instanceof BeachsideError && error.effect !== "none") {
    return new Error(
      `Sandbox ${box.id}: ${error.message} (effect: ${error.effect}; check before repeating)`,
      { cause: error },
    );
  }

  return error;
}

export function bashOperations(box: Box, workdir: string): BashOperations {
  return {
    async exec(script, _cwd, { onData, signal, timeout }) {
      const seconds = timeout && timeout > 0 ? Math.ceil(timeout) : undefined;
      const deadline = seconds ? AbortSignal.timeout(seconds * 1000) : undefined;
      const wait = AbortSignal.any([...(signal ? [signal] : []), ...(deadline ? [deadline] : [])]);
      const input = { command: command(`exec bash -c ${shellQuote(script)}`), cwd: workdir };

      try {
        if (!box.supports("processStream")) {
          const caps = await box.capabilities();

          const result = await box
            .exec(
              {
                ...input,
                deadlineSeconds: seconds,
                maxOutputBytes: Math.min(partBytes, caps.maxOutputBytes),
              },
              { signal: wait },
            )
            .catch((error: Error) => {
              if (error instanceof NonzeroExitError) return error.result;
              throw error;
            });

          onData(Buffer.from(result.stdout));
          onData(Buffer.from(result.stderr));

          if (result.truncated) onData(Buffer.from("\n[Sandbox output was truncated]\n"));

          return { exitCode: result.exitCode };
        }

        const process = box.supports("processByteStream")
          ? await box.processes.start<"bytes">(
              { ...input, output: { mode: "stream", format: "bytes" } },
              { signal: wait },
            )
          : await box.processes.start({ ...input, output: { mode: "stream" } }, { signal: wait });

        try {
          for await (const chunk of process.output({ signal: wait })) {
            onData("bytes" in chunk ? Buffer.from(chunk.bytes) : Buffer.from(chunk.text));
          }

          const exit = await process.wait({ signal: wait });

          if (!exit.outputComplete) onData(Buffer.from("\n[Sandbox output is incomplete]\n"));

          return { exitCode: exit.exitCode };
        } catch (cause) {
          if (!wait.aborted) throw cause;
          const reason = deadline?.aborted ? "Command timed out" : "Command aborted";

          const stop = await process
            .terminate({ signal: AbortSignal.timeout(5000) })
            .catch((error: Error) => {
              throw new Error(
                `${reason} in sandbox ${box.id}; command termination could not be confirmed`,
                { cause: error },
              );
            });

          throw new Error(`${reason} in sandbox ${box.id} (termination: ${stop.status})`);
        } finally {
          await process.detach();
        }
      } catch (cause) {
        if (cause instanceof Error) throw outcome(box, cause);
        throw cause;
      }
    },
  };
}

async function guestExec(box: Box, script: string, signal?: AbortSignal, cwd?: string) {
  const { maxOutputBytes } = await box.capabilities();

  try {
    return await box.exec(
      { command: command(script), cwd, maxOutputBytes: Math.min(partBytes, maxOutputBytes) },
      { signal },
    );
  } catch (cause) {
    if (cause instanceof NonzeroExitError) return cause.result;

    if (cause instanceof Error) throw outcome(box, cause);
    throw cause;
  }
}

async function guestText(box: Box, script: string, signal?: AbortSignal, cwd?: string) {
  const result = await guestExec(box, script, signal, cwd);

  if (result.exitCode !== 0)
    throw new Error(result.stderrText() || `Guest command exited ${result.exitCode}`);

  if (result.truncated) throw new Error("Guest command output exceeded the sandbox capture limit");

  return result.stdoutText({ full: true });
}

function imageMime(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";

  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";

  if (/^GIF8[79]a/.test(bytes.toString("ascii", 0, 6))) return "image/gif";

  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP")
    return "image/webp";

  return null;
}

export type BeachsideTools = {
  bash: ReturnType<typeof createBashToolDefinition>;
  edit: ReturnType<typeof createEditToolDefinition>;
  find: ReturnType<typeof createFindToolDefinition>;
  grep: ReturnType<typeof createGrepToolDefinition>;
  ls: ReturnType<typeof createLsToolDefinition>;
  read: ReturnType<typeof createReadToolDefinition>;
  write: ReturnType<typeof createWriteToolDefinition>;
};

/** Pi factories prefer the tool context's cwd over the constructor cwd. */
function inGuest<P extends TSchema, D>(
  workdir: string,
  tool: ToolDefinition<P, D>,
): ToolDefinition<P, D> {
  return {
    ...tool,
    execute: (id, args, signal, update, ctx) =>
      tool.execute(id, args, signal, update, { ...ctx, cwd: workdir }),
  };
}

/** Pi tool definitions for an existing sandbox. Callers own the sandbox and its lifetime. */
export function createBeachsideTools(
  box: Box,
  workdir = "/",
  signal?: AbortSignal,
): BeachsideTools {
  const readFile = async (path: string) => Buffer.from(await box.readFile(path, { signal }));

  const exists = async (path: string): Promise<boolean> => {
    if (!box.supports("statFile")) {
      const quoted = shellQuote(path);
      const result = await guestExec(box, `test -e ${quoted} || test -L ${quoted}`, signal);

      if (result.exitCode !== null && result.exitCode <= 1) return result.exitCode === 0;
      throw new Error(result.stderrText() || "Guest file existence check failed");
    }

    try {
      await box.statFile(path, { signal });

      return true;
    } catch (cause) {
      if (cause instanceof BeachsideError && cause.code === "NOT_FOUND") return false;
      throw cause;
    }
  };

  const access = async (path: string) => {
    if (!(await exists(path))) throw new Error(`Guest path does not exist: ${path}`);
  };

  const writeFile = async (path: string, content: string) => {
    const bytes = Buffer.from(content);
    const options = { overwrite: true, signal };

    try {
      if (bytes.byteLength > partBytes && box.supports("writeFileStream")) {
        async function* chunks() {
          for (let offset = 0; offset < bytes.length; offset += partBytes)
            yield bytes.subarray(offset, offset + partBytes);
        }

        await box.writeFileStream(path, chunks(), options);
      } else {
        await box.writeFile(path, bytes, options);
      }
    } catch (cause) {
      if (cause instanceof Error) throw outcome(box, cause);
      throw cause;
    }
  };

  // Pi 1.5 ignores createReadStream. Supply it for hosts that support the newer operations interface.
  const read: ReadOperations & { createReadStream?: Box["readFileStream"] } = {
    readFile,
    access,
    detectImageMimeType: async (path) => {
      if (!/\.(png|jpe?g|gif|webp)$/i.test(path)) return null;

      if (!box.supports("readFileStream")) return imageMime(await readFile(path));
      const prefix = Buffer.alloc(12);
      let size = 0;

      for await (const chunk of box.readFileStream(path, { signal })) {
        const count = Math.min(chunk.length, prefix.length - size);
        prefix.set(chunk.subarray(0, count), size);
        size += count;

        if (size === prefix.length) break;
      }

      return imageMime(prefix.subarray(0, size));
    },
  };

  if (box.supports("readFileStream")) {
    read.createReadStream = (path, options) => box.readFileStream(path, options);
  }

  const grep = createGrepToolDefinition(workdir);

  return {
    bash: createBashToolDefinition(workdir, {
      operations: bashOperations(box, workdir),
      exposeSessionEnvironment: false,
    }),
    read: inGuest(workdir, createReadToolDefinition(workdir, { operations: read })),
    write: inGuest(
      workdir,
      createWriteToolDefinition(workdir, {
        operations: {
          writeFile,
          async mkdir(path) {
            if (box.supports("makeDirectory"))
              await box.makeDirectory(path, { recursive: true, signal });
            else await guestText(box, `mkdir -p -- ${shellQuote(path)}`, signal);
          },
        },
      }),
    ),
    edit: inGuest(
      workdir,
      createEditToolDefinition(workdir, { operations: { readFile, writeFile, access } }),
    ),
    ls: inGuest(
      workdir,
      createLsToolDefinition(workdir, {
        operations: {
          exists,
          async stat(path) {
            const directory = box.supports("statFile")
              ? (await box.statFile(path, { followSymlinks: true, signal })).type === "directory"
              : (await guestText(
                  box,
                  `if test -d ${shellQuote(path)}; then printf yes; fi`,
                  signal,
                )) === "yes";

            return { isDirectory: () => directory };
          },
          async readdir(path) {
            if (box.supports("readDirectory")) {
              const result = await box.readDirectory(path, { signal });

              if (result.completeness !== "complete")
                throw new Error("Sandbox directory listing is incomplete");

              return result.entries.map((entry) => entry.name);
            }

            const names = await guestText(
              box,
              "find . -mindepth 1 -maxdepth 1 -print0",
              signal,
              path,
            );

            return names
              .split("\0")
              .filter(Boolean)
              .map((name) => name.slice(2));
          },
        },
      }),
    ),
    find: inGuest(workdir, {
      ...createFindToolDefinition(workdir, {
        operations: {
          exists,
          async glob(pattern, cwd, { ignore, limit }) {
            const filter = (name: string) => {
              const candidate = pattern.includes("/") ? name : posix.basename(name);

              return (
                matchesGlob(candidate, pattern) && !ignore.some((glob) => matchesGlob(name, glob))
              );
            };

            const paths: string[] = [];

            if (box.supports("walkFiles")) {
              for await (const entry of box.walkFiles(cwd, {
                signal,
                excludeNames: [".git", "node_modules"],
              })) {
                const name = entry.relativePath;

                if (entry.type !== "directory" && filter(name)) paths.push(name);

                if (paths.length >= limit) break;
              }
            } else {
              const raw = await guestText(
                box,
                "find . \\( -name .git -o -name node_modules \\) -prune -o -type f -print0",
                signal,
                cwd,
              );

              return raw
                .split("\0")
                .filter(Boolean)
                .map((name) => name.slice(2))
                .filter(filter)
                .slice(0, limit);
            }

            return paths;
          },
        },
      }),
      description: findDescription,
    }),
    grep: {
      ...grep,
      description: grepDescription,
      promptSnippet: "Search sandbox files for patterns",
      async execute(_id, args, wait) {
        const path = guestPath(args.path ?? ".", workdir);

        const flags = [
          ...(args.ignoreCase ? ["-i"] : []),
          ...(args.context && args.context > 0 ? ["-C", String(Math.floor(args.context))] : []),
        ];

        const tail = ["--", args.pattern, path];
        const argv = (parts: string[]) => parts.map(shellQuote).join(" ");

        const search = [
          "if command -v rg >/dev/null 2>&1; then",
          argv([
            "rg",
            "--no-config",
            "--hidden",
            "--color=never",
            "-nH",
            ...(args.literal ? ["-F"] : []),
            ...flags,
            ...(args.glob ? ["-g", args.glob] : []),
            "-g",
            "!.git",
            "-g",
            "!node_modules",
            ...tail,
          ]),
          "else",
          argv([
            "grep",
            args.literal ? "-rFnH" : "-rEnH",
            "--exclude-dir=.git",
            "--exclude-dir=node_modules",
            ...flags,
            ...(args.glob ? [`--include=${args.glob}`] : []),
            ...tail,
          ]),
          "fi",
        ].join("\n");

        const result = await guestExec(box, search, wait ?? signal, workdir);

        if (result.exitCode === null || result.exitCode > 1)
          throw new Error(result.stderrText() || `Guest search exited ${result.exitCode}`);

        if (result.exitCode === 1)
          return { content: [{ type: "text", text: "No matches found" }], details: undefined };

        const limit = Math.max(1, Math.floor(args.limit ?? 100));
        const details: GrepToolDetails = {};

        const lines = result
          .stdoutText({ full: true })
          .replace(/\r?\n$/, "")
          .split("\n");

        const prefix = path === "/" ? "/" : `${path}/`;
        const formatted: string[] = [];
        let matches = 0;

        for (const line of lines) {
          const relative = line.startsWith(prefix)
            ? line.slice(prefix.length)
            : line.replace(path, posix.basename(path));

          const location = /^(.*?)([:-])(\d+)\2/.exec(relative);

          if (location?.[2] === ":" && ++matches > limit) {
            details.matchLimitReached = limit;
            break;
          }

          const short = truncateLine(relative);

          if (short.wasTruncated) details.linesTruncated = true;
          formatted.push(short.text);
        }

        const truncation = truncateHead(formatted.join("\n"));

        if (truncation.truncated) details.truncation = truncation;
        const partial = result.truncated || truncation.truncated || details.matchLimitReached;

        return {
          content: [
            {
              type: "text",
              text: truncation.content + (partial ? "\n[Search output truncated]" : ""),
            },
          ],
          details,
        };
      },
    } satisfies typeof grep,
  };
}
