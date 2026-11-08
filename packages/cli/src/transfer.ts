import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { BeachsideError, NonzeroExitError, type ExecOutput, type SandboxHandle } from "beachside";
import { CliError } from "./output";
import {
  archivePath,
  Extractor,
  readTar,
  tarStream,
  type ExtractSummary,
  type TarEntry,
} from "./tar";

/**
 * Directory transfer moves one tar archive and unpacks it with one command in the sandbox, so
 * it works on every provider with exec and file read/write, keeps modes and symlinks, and needs
 * `tar` in the image. The archive travels in parts no larger than the SDK's default buffered
 * file size, or as one stream where the provider streams files.
 */
export const PartBytes = 1_048_576;

/** Buffered parts in flight at once. */
const Concurrency = 4;

/** Exit code the transfer scripts use when `tar` is missing. */
const NoTar = 127;

/** Exit code the pack script uses when the source path does not exist. */
const NoSource = 66;

/** Exit code the join script uses when --no-clobber finds the destination. */
const Exists = 73;

/** Quote one word for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** `push` without a path unpacks into `work` under the sandbox user's home. */
export const defaultPushDir = '"${HOME:-}/work"';

const requireTar = `command -v tar >/dev/null 2>&1 || { echo "tar is not installed in this sandbox" >&2; exit ${NoTar}; }`;

const makeTemp = 'tmp=$(mktemp -d "${TMPDIR:-/tmp}/beachside.XXXXXX")';

/** Shell scripts for each transfer step; exported so fixture tests can seed their results. */
export const scripts = {
  /** Check for tar, make a staging folder, and say whether the destination is a directory. */
  prepare(dest: string): string {
    return [
      "set -e",
      requireTar,
      makeTemp,
      'echo "$tmp"',
      `if [ -d ${dest} ]; then echo directory; else echo none; fi`,
    ].join("\n");
  },
  /** Unpack the staged parts into `dest`, remove the staging folder, and print `dest`. */
  unpack(tmp: string, dest: string): string {
    return [
      "set -e",
      `tmp=${shellQuote(tmp)}`,
      `trap 'rm -rf "$tmp"' EXIT`,
      `mkdir -p ${dest}`,
      `cat "$tmp"/part.* | tar -x -o -f - -C ${dest}`,
      `cd ${dest}`,
      "pwd",
    ].join("\n");
  },
  /** Archive `path` into a staging folder, split into parts unless `split` is false. */
  pack(path: string, split: boolean): string {
    const parent = posix.dirname(path);
    const base = posix.basename(path);

    return [
      "set -e",
      requireTar,
      `if [ ! -e ${shellQuote(path)} ] && [ ! -L ${shellQuote(path)} ]; then echo "No such file or directory" >&2; exit ${NoSource}; fi`,
      makeTemp,
      'cd "$tmp"',
      `tar -c -f archive.tar -C ${shellQuote(parent)} ${shellQuote(base)} || { rm -rf "$tmp"; exit 1; }`,
      split
        ? `split -b ${PartBytes} -a 6 archive.tar part. && rm archive.tar`
        : "mv archive.tar part.000000",
      'echo "$tmp"',
      "LC_ALL=C ls",
    ].join("\n");
  },
  /** Make an empty staging folder for the parts of one large file. */
  stage(): string {
    return ["set -e", makeTemp, 'echo "$tmp"'].join("\n");
  },
  /**
   * Join staged parts into the file at `path`, remove the staging folder, and print `path`. The
   * file is assembled beside the destination and published in one step: `mv` to replace, or a
   * hard link when `overwrite` is false, which fails atomically if the destination appeared. A
   * destination that became a directory in between is caught afterwards and reported.
   */
  join(tmp: string, path: string, overwrite: boolean): string {
    const dest = shellQuote(path);
    const dir = shellQuote(posix.dirname(path));

    return [
      "set -e",
      `tmp=${shellQuote(tmp)}`,
      'part=""',
      `trap 'rm -rf "$tmp"; [ -z "$part" ] || rm -f "$part"' EXIT`,
      `if [ -d ${dest} ]; then echo "the destination is a directory" >&2; exit 1; fi`,
      `part=$(mktemp ${dir}/.beachside.XXXXXX)`,
      `cat "$tmp"/part.* > "$part"`,
      // mktemp makes the file private; give it the mode a new file would get.
      `chmod "$(printf '%o' $((0666 & ~0$(umask))))" "$part"`,
      'name=$(basename "$part")',
      ...(overwrite
        ? [`mv -f "$part" ${dest}`]
        : [
            `if ! ln "$part" ${dest} 2>/dev/null; then if [ -e ${dest} ] || [ -L ${dest} ]; then echo "the destination already exists" >&2; exit ${Exists}; fi; echo "could not publish the file" >&2; exit 1; fi`,
          ]),
      // A destination that became a directory meanwhile received the file inside it instead.
      `if [ -d ${dest} ]; then rm -f ${dest}/"$name"; echo "the destination is a directory" >&2; exit 1; fi`,
      `echo ${dest}`,
    ].join("\n");
  },
  /** Split the regular file at `path` into parts in a staging folder and list them. */
  split(path: string): string {
    const source = shellQuote(path);

    return [
      "set -e",
      `if [ ! -f ${source} ]; then echo "No such file" >&2; exit ${NoSource}; fi`,
      makeTemp,
      `split -b ${PartBytes} -a 6 ${source} "$tmp/part." || { rm -rf "$tmp"; exit 1; }`,
      'echo "$tmp"',
      'cd "$tmp"',
      "LC_ALL=C ls",
    ].join("\n");
  },
  cleanup(tmp: string): string {
    return `rm -rf ${shellQuote(tmp)}`;
  },
};

/** Run one transfer script, turning a missing tar or a failed step into a clear error. */
async function step(
  box: SandboxHandle<true>,
  sandbox: string,
  script: string,
  signal: AbortSignal,
  failure: (stderr: string, exitCode: number | null) => CliError,
): Promise<string[]> {
  let result: ExecOutput;

  try {
    result = await box.exec(
      { command: { kind: "shell", script }, deadlineSeconds: 600 },
      { signal },
    );
  } catch (cause) {
    if (!(cause instanceof NonzeroExitError)) throw cause;
    result = cause.result;
  }

  const stderr = result.stderrText({ full: true }).trim();

  if (result.exitCode === NoTar)
    throw new CliError(
      "UNSUPPORTED",
      `tar is not installed in sandbox ${sandbox}`,
      "directory copies need tar in the image; install it (e.g. apk add tar, apt-get install tar) or copy single files",
    );

  if (result.exitCode !== 0) throw failure(stderr, result.exitCode);

  return result
    .stdoutText({ full: true })
    .split("\n")
    .filter((line) => line !== "");
}

/** Best-effort removal of a staging folder after a failed or finished transfer. */
async function cleanup(box: SandboxHandle<true>, tmp: string, signal: AbortSignal): Promise<void> {
  try {
    await box.exec({ command: { kind: "shell", script: scripts.cleanup(tmp) } }, { signal });
  } catch {
    // A leftover staging folder under the sandbox's temp directory is harmless.
  }
}

/** Matches `--exclude` patterns: `*`, `?` and `**`; a pattern without `/` matches any name. */
export class Excludes {
  private readonly names: RegExp[] = [];
  private readonly paths: RegExp[] = [];

  constructor(patterns: readonly string[]) {
    for (const pattern of patterns) {
      const trimmed = pattern.replace(/^\/+|\/+$/g, "");

      if (!trimmed) continue;
      (pattern.slice(1, -1).includes("/") || pattern.startsWith("/")
        ? this.paths
        : this.names
      ).push(globRegExp(trimmed));
    }
  }

  /** Whether `parts` or any of its parent directories is excluded. */
  matches(parts: readonly string[]): boolean {
    for (let at = 1; at <= parts.length; at++) {
      const name = parts[at - 1]!;
      const path = parts.slice(0, at).join("/");

      if (this.names.some((pattern) => pattern.test(name))) return true;

      if (this.paths.some((pattern) => pattern.test(path))) return true;
    }

    return false;
  }
}

function globRegExp(pattern: string): RegExp {
  let source = "";

  for (let at = 0; at < pattern.length; at++) {
    const char = pattern[at]!;

    if (char === "*" && pattern[at + 1] === "*") {
      at++;

      if (pattern[at + 1] === "/") {
        at++;
        source += "(?:.*/)?";
      } else source += ".*";
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }

  return new RegExp(`^${source}$`);
}

/** Files for an upload, parents before children, with counts for the summary. */
export type LocalTree = { entries: TarEntry[]; skipped: string[] };

function compareParts(left: string, right: string): number {
  const a = left.split("/");
  const b = right.split("/");

  for (let at = 0; at < Math.min(a.length, b.length); at++)
    if (a[at] !== b[at]) return a[at]! < b[at]! ? -1 : 1;

  return a.length - b.length;
}

/** The entry for one local path, or null for sockets, devices and other special files. */
async function localEntry(root: string, relative: string): Promise<TarEntry | null> {
  const path = join(root, relative);
  const info = await lstat(path);
  const mtime = Math.floor(info.mtimeMs / 1000);

  if (info.isDirectory()) return { type: "directory", path: relative, mode: info.mode, mtime };

  if (info.isSymbolicLink())
    return { type: "symlink", path: relative, target: await readlink(path), mtime };

  if (!info.isFile()) return null;

  return {
    type: "file",
    path: relative,
    mode: info.mode,
    mtime,
    size: info.size,
    body: () => createReadStream(path),
  };
}

/** Every path below `root`, depth first, skipping excluded names before descending. */
async function walk(root: string, relative: string, excludes: Excludes, out: string[]) {
  const children = await readdir(relative ? join(root, relative) : root, { withFileTypes: true });

  for (const child of children.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = relative ? `${relative}/${child.name}` : child.name;

    if (excludes.matches(path.split("/"))) continue;
    out.push(path);

    if (child.isDirectory()) await walk(root, path, excludes, out);
  }
}

/** Git-tracked and untracked-but-not-ignored files below `root`, or null outside a work tree. */
function gitFiles(root: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => resolve(error ? null : stdout.split("\0").filter(Boolean)),
    );
  });
}

/**
 * Collect the local tree under `root`. With `gitignore`, a git work tree sends what `git
 * ls-files` lists (tracked plus untracked files that are not ignored); elsewhere every file is
 * sent. `--exclude` patterns apply either way.
 */
export async function localTree(
  root: string,
  excludes: Excludes,
  gitignore: boolean,
  note: (message: string) => void,
): Promise<LocalTree> {
  const listed = gitignore ? await gitFiles(root) : null;
  const paths: string[] = [];

  if (gitignore && !listed)
    note(`beachside: ${root} is not in a git work tree; sending every file`);

  if (listed) {
    const seen = new Set<string>();

    for (const file of listed) {
      const parts = file.split("/");

      if (excludes.matches(parts)) continue;

      for (let at = 1; at < parts.length; at++) seen.add(parts.slice(0, at).join("/"));
      seen.add(file);
    }

    for (const path of [...seen].sort(compareParts)) {
      paths.push(path);

      // A submodule is listed as one path; send its files too.
      if (listed.includes(path) && (await lstat(join(root, path)).catch(() => null))?.isDirectory())
        await walk(root, path, excludes, paths);
    }
  } else await walk(root, "", excludes, paths);

  const entries: TarEntry[] = [];
  const skipped: string[] = [];

  for (const path of paths) {
    let entry: TarEntry | null;

    try {
      entry = await localEntry(root, path);
    } catch (cause) {
      // A tracked file deleted from the work tree is simply not sent.
      if (listed && cause instanceof Error && "code" in cause && cause.code === "ENOENT") continue;
      throw cause;
    }

    if (entry) entries.push(entry);
    else skipped.push(path);
  }

  return { entries, skipped };
}

export type TransferSummary = {
  files: number;
  directories: number;
  symlinks: number;
  bytes: number;
};

function treeSummary(tree: LocalTree): TransferSummary {
  const summary = { files: 0, directories: 0, symlinks: 0, bytes: 0 };

  for (const entry of tree.entries) {
    if (entry.type === "file") {
      summary.files++;
      summary.bytes += entry.size;
    } else if (entry.type === "directory") summary.directories++;
    else summary.symlinks++;
  }

  return summary;
}

/** Regroup a byte stream into parts of exactly `size` bytes, the last one shorter. */
async function* parts(source: AsyncIterable<Uint8Array>, size: number): AsyncIterable<Uint8Array> {
  let part = new Uint8Array(size);
  let filled = 0;

  for await (const chunk of source)
    for (let at = 0; at < chunk.length;) {
      const take = Math.min(size - filled, chunk.length - at);
      part.set(chunk.subarray(at, at + take), filled);
      filled += take;
      at += take;

      if (filled === size) {
        yield part;
        part = new Uint8Array(size);
        filled = 0;
      }
    }

  if (filled) yield part.subarray(0, filled);
}

function partName(tmp: string, index: number): string {
  return `${tmp}/part.${String(index).padStart(6, "0")}`;
}

async function* entriesOf(tree: LocalTree): AsyncIterable<TarEntry> {
  yield* tree.entries;
}

/** Run `write` for each part with a few in flight; the first failure stops new writes. */
async function writeParts(
  source: AsyncIterable<Uint8Array>,
  write: (index: number, bytes: Uint8Array) => Promise<void>,
): Promise<void> {
  const running = new Set<Promise<void>>();
  let failure: Error | undefined;
  let index = 0;

  for await (const bytes of source) {
    if (failure) break;

    const pending: Promise<void> = write(index++, bytes)
      .catch((cause: Error) => {
        failure ??= cause;
      })
      .finally(() => running.delete(pending));

    running.add(pending);

    if (running.size >= Concurrency) await Promise.race(running);
  }

  await Promise.all(running);

  if (failure) throw failure;
}

export type UploadResult = TransferSummary & { path: string };

/**
 * Send a local tree into the sandbox. `dest` is a shell word: a quoted absolute path, or
 * {@link defaultPushDir}. With `nest`, an existing destination directory receives the tree as
 * a child named `nest`, like `cp -r`.
 */
export async function upload(
  box: SandboxHandle<true>,
  sandbox: string,
  tree: LocalTree,
  dest: string,
  nest: string | null,
  signal: AbortSignal,
): Promise<UploadResult> {
  const [tmp, state] = await step(
    box,
    sandbox,
    scripts.prepare(dest),
    signal,
    (stderr) => new CliError("REMOTE_FAILED", `Could not prepare the copy: ${stderr}`),
  );

  if (!tmp?.startsWith("/") || !state)
    throw new CliError("INVALID_RESPONSE", "The sandbox did not report a staging folder");
  const target = nest && state === "directory" ? `${dest}/${shellQuote(nest)}` : dest;

  try {
    const archive = tarStream(entriesOf(tree));

    if (box.supports("writeFileStream"))
      await box.writeFileStream(partName(tmp, 0), archive, { overwrite: true, signal });
    else
      await writeParts(parts(archive, PartBytes), (index, bytes) =>
        box.writeFile(partName(tmp, index), bytes, {
          overwrite: true,
          maxBytes: PartBytes,
          signal,
        }),
      );
  } catch (cause) {
    await cleanup(box, tmp, signal);
    throw cause;
  }

  const [path] = await step(
    box,
    sandbox,
    scripts.unpack(tmp, target),
    signal,
    (stderr) =>
      new CliError(
        "REMOTE_FAILED",
        `Unpacking in sandbox ${sandbox} failed: ${stderr}`,
        "some files may already be written; fix the cause and copy again",
        { sandbox },
        "partial",
      ),
  );

  return { ...treeSummary(tree), path: path ?? "" };
}

export type DownloadResult = Omit<ExtractSummary, "skipped"> & { path: string; skipped: string[] };

/**
 * Copy a sandbox file or directory to `local`, which becomes the copy (the caller resolves an
 * existing directory to a child path). Members matching `excludes` are not written.
 */
export async function download(
  box: SandboxHandle<true>,
  sandbox: string,
  remotePath: string,
  local: string,
  excludes: Excludes,
  noClobber: boolean,
  signal: AbortSignal,
): Promise<DownloadResult> {
  const streamed = box.supports("readFileStream");

  const [tmp, ...names] = await step(
    box,
    sandbox,
    scripts.pack(remotePath, !streamed),
    signal,
    (stderr, exitCode) =>
      exitCode === NoSource
        ? new CliError("NOT_FOUND", `${remotePath} does not exist in sandbox ${sandbox}`)
        : new CliError("REMOTE_FAILED", `Could not archive ${remotePath}: ${stderr}`),
  );

  if (!tmp?.startsWith("/") || names.some((name) => !/^part\.[a-z0-9]+$/.test(name)))
    throw new CliError("INVALID_RESPONSE", "The sandbox did not report the archive parts");

  async function* archive(): AsyncIterable<Uint8Array> {
    for (const name of names.sort()) {
      const path = `${tmp}/${name}`;

      if (streamed) yield* box.readFileStream(path, { signal });
      else yield await box.readFile(path, { maxBytes: PartBytes, signal });
    }
  }

  const top = posix.basename(remotePath);
  const extractor = new Extractor(local, noClobber);

  /** Archive paths start with the source's own name, which maps to `local`. */
  function mapped(path: string): string[] {
    const parts = archivePath(path);

    if (parts[0] !== top)
      throw new CliError("INVALID_RESPONSE", `The archive holds an unexpected path: ${path}`);

    return parts.slice(1);
  }

  let summary: ExtractSummary;

  try {
    await mkdir(dirname(local), { recursive: true });
    await readTar(archive(), async (entry, body) => {
      const parts = mapped(entry.path);

      if (parts.length && excludes.matches(parts)) return;
      await extractor.add(entry, parts, body, mapped);
    });
    summary = await extractor.finish();
  } finally {
    await cleanup(box, tmp, signal);
  }

  return { ...summary, path: local };
}

/**
 * Write one local file of `size` bytes to `path` in the sandbox. Providers with file streams take
 * it as one stream; otherwise a file larger than one buffered part travels as parts that the
 * sandbox joins, so no file is too big to copy. Returns the bytes written.
 */
export async function uploadFile(
  box: SandboxHandle<true>,
  sandbox: string,
  local: string,
  size: number,
  path: string,
  overwrite: boolean,
  signal: AbortSignal,
): Promise<number> {
  if (box.supports("writeFileStream"))
    return box.writeFileStream(path, createReadStream(local), { overwrite, signal });

  if (size <= PartBytes) {
    const bytes = new Uint8Array(await readFile(local));
    await box.writeFile(path, bytes, { overwrite, signal });

    return bytes.byteLength;
  }

  const [tmp] = await step(
    box,
    sandbox,
    scripts.stage(),
    signal,
    (stderr) => new CliError("REMOTE_FAILED", `Could not prepare the copy: ${stderr}`),
  );

  if (!tmp?.startsWith("/"))
    throw new CliError("INVALID_RESPONSE", "The sandbox did not report a staging folder");
  let sent = 0;

  try {
    await writeParts(parts(createReadStream(local), PartBytes), async (index, bytes) => {
      await box.writeFile(partName(tmp, index), bytes, {
        overwrite: true,
        maxBytes: PartBytes,
        signal,
      });
      sent += bytes.byteLength;
    });
  } catch (cause) {
    await cleanup(box, tmp, signal);
    throw cause;
  }

  await step(box, sandbox, scripts.join(tmp, path, overwrite), signal, (stderr, exitCode) =>
    exitCode === Exists
      ? new CliError(
          "CONFLICT",
          `${path} already exists in sandbox ${sandbox}`,
          "drop --no-clobber to overwrite it",
        )
      : new CliError("REMOTE_FAILED", `Could not write ${path}: ${stderr}`),
  );

  return sent;
}

/**
 * The bytes of one sandbox file, in order. Providers with file streams stream it; otherwise a
 * file too large for one buffered read is split in the sandbox and read part by part.
 */
export async function* fileChunks(
  box: SandboxHandle<true>,
  sandbox: string,
  path: string,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  if (box.supports("readFileStream")) {
    yield* box.readFileStream(path, { signal });

    return;
  }

  try {
    yield await box.readFile(path, { maxBytes: PartBytes, signal });

    return;
  } catch (cause) {
    if (!(cause instanceof BeachsideError) || cause.code !== "OUTPUT_CAPACITY") throw cause;
  }

  const [tmp, ...names] = await step(
    box,
    sandbox,
    scripts.split(path),
    signal,
    (stderr, exitCode) =>
      exitCode === NoSource
        ? new CliError("NOT_FOUND", `${path} is not a file in sandbox ${sandbox}`)
        : new CliError("REMOTE_FAILED", `Could not split ${path} for copying: ${stderr}`),
  );

  if (!tmp?.startsWith("/") || names.some((name) => !/^part\.[a-z0-9]+$/.test(name)))
    throw new CliError("INVALID_RESPONSE", "The sandbox did not report the file parts");

  try {
    for (const name of names.sort())
      yield await box.readFile(`${tmp}/${name}`, { maxBytes: PartBytes, signal });
  } finally {
    await cleanup(box, tmp, signal);
  }
}

/**
 * Save streamed bytes as the local file `local`. With `noClobber` the file is created exclusively;
 * otherwise the bytes go to a sibling temporary file that replaces `local` only once complete, so
 * a failed copy leaves the old file as it was. Returns the bytes written.
 */
export async function saveLocalFile(
  chunks: AsyncIterable<Uint8Array>,
  local: string,
  noClobber: boolean,
): Promise<number> {
  let bytes = 0;

  async function* counted() {
    for await (const chunk of chunks) {
      bytes += chunk.byteLength;
      yield chunk;
    }
  }

  if (noClobber) {
    let created = false;
    const out = createWriteStream(local, { flags: "wx" });
    out.once("open", () => {
      created = true;
    });

    try {
      await pipeline(counted(), out);
    } catch (cause) {
      if (created) await rm(local, { force: true });

      if (cause instanceof Error && "code" in cause && cause.code === "EEXIST")
        throw new CliError(
          "CONFLICT",
          `${local} already exists`,
          "drop --no-clobber to overwrite it",
        );
      throw cause;
    }

    return bytes;
  }

  // A symlink keeps working: the copy replaces the file it points to, as a direct write would.
  const link = (await lstat(local).catch(() => null))?.isSymbolicLink();
  const target = link ? await realpath(local).catch(() => null) : local;

  // A dangling link has no file to replace beside; write through it as before.
  if (!target) {
    await pipeline(counted(), createWriteStream(local, { flags: "w" }));

    return bytes;
  }

  const part = join(
    dirname(target),
    `.${basename(target)}.beachside-${crypto.randomUUID().slice(0, 8)}.part`,
  );

  try {
    await pipeline(counted(), createWriteStream(part, { flags: "wx" }));
    const existing = await stat(target).catch(() => null);

    if (existing?.isFile()) await chmod(part, existing.mode & 0o7777);
    await rename(part, target);
  } catch (cause) {
    await rm(part, { force: true });
    throw cause;
  }

  return bytes;
}
