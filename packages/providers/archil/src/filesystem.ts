import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import {
  AdapterError,
  AdapterFilesystemError,
  type DirectoryResult,
  type FileStat,
  type FileTransferContext,
  type ReadContext,
} from "@beachside/adapter";
import { z } from "zod";
import { quote } from "./shell";

/**
 * Archil has no native file API for sandboxes; the official SDK moves files through shell
 * helpers on the process connection. Metadata, listings, no-clobber publishing, copy and move
 * run through this finite Python 3 helper in the guest (an image prerequisite, never
 * installed). Paths are arguments, never
 * program text. A streamed write sends all bytes on one process's stdin into a private file
 * beside the target, then publishes it with an atomic rename, or a hard link when the target
 * must not be replaced.
 */
export const FILESYSTEM_HELPER = String.raw`
import os,sys,json,stat,errno,ctypes,tempfile,shutil
op,p,q,flag,stage=sys.argv[1:6]
published=False
created=False
overwrite=flag=='true'
def kind(s):
 return 'symlink' if stat.S_ISLNK(s.st_mode) else 'file' if stat.S_ISREG(s.st_mode) else 'directory' if stat.S_ISDIR(s.st_mode) else 'unknown'
def rename(a,b):
 if overwrite: os.replace(a,b)
 else:
  libc=ctypes.CDLL(None,use_errno=True)
  fn=getattr(libc,'renameat2',None)
  if fn is None: raise OSError(errno.ENOSYS,'renameat2 unavailable')
  if fn(-100,os.fsencode(a),-100,os.fsencode(b),1)!=0:
   e=ctypes.get_errno();raise OSError(e,os.strerror(e))
def publish(a,b):
 global published
 if overwrite and os.path.lexists(b) and not stat.S_ISREG(os.lstat(b).st_mode): raise OSError(errno.EINVAL,'regular destination required')
 if overwrite: os.replace(a,b);published=True
 else:
  os.link(a,b,follow_symlinks=False);published=True;os.unlink(a)
def parents(path):
 os.makedirs(os.path.dirname(path) or '/',exist_ok=True)
def regular(path):
 s=os.lstat(path)
 if not stat.S_ISREG(s.st_mode): raise OSError(errno.EINVAL,'regular file required')
try:
 result={}
 if op=='list':
  entries=[]; names=0
  with os.scandir(p) as it:
   for e in it:
    names+=len(e.name.encode('utf-8'))
    if len(entries)>=1024 or names>65536: raise OSError(errno.EFBIG,'directory bound exceeded')
    try: t=kind(e.stat(follow_symlinks=False))
    except FileNotFoundError: t='unknown'
    entries.append({'name':e.name,'type':t})
  entries.sort(key=lambda e:e['name'])
  result={'entries':entries,'completeness':'complete'}
 elif op=='stat':
  s=os.stat(p) if overwrite else os.lstat(p)
  result={'type':kind(s),'sizeBytes':s.st_size,'modifiedAt':s.st_mtime,'mode':stat.S_IMODE(s.st_mode)}
 elif op=='mkdir':
  try:
   if overwrite: os.makedirs(p,exist_ok=True)
   else: os.mkdir(p)
  except FileExistsError:
   if not os.path.isdir(p): raise OSError(errno.EINVAL,'existing entry is not a directory')
 elif op=='remove':
  try:
   s=os.lstat(p)
   if stat.S_ISDIR(s.st_mode):
    if overwrite: shutil.rmtree(p)
    else: os.rmdir(p)
   else: os.unlink(p)
  except FileNotFoundError: pass
 elif op=='exists':
  try: os.lstat(p);result={'exists':True}
  except FileNotFoundError: result={'exists':False}
 elif op=='receive':
  parents(p);fd=os.open(p,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600);created=True;stage=p
  n=0
  with os.fdopen(fd,'wb') as f:
   while True:
    b=sys.stdin.buffer.read(1048576)
    if not b: break
    f.write(b);n+=len(b)
   f.flush();os.fchmod(f.fileno(),0o644);os.fsync(f.fileno())
  result={'bytesWritten':n}
 elif op=='publish':
  regular(p)
  try: publish(p,q);published=True
  finally:
   # A refused publish leaves nothing behind: the staged bytes are this attempt's own.
   if not published and os.path.lexists(p): os.unlink(p)
 elif op=='copy':
  regular(p)
  if overwrite and os.path.lexists(q) and not stat.S_ISREG(os.lstat(q).st_mode): raise OSError(errno.EINVAL,'regular destination required')
  parents(stage);fd=os.open(stage,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);created=True
  try:
   src=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
   with os.fdopen(src,'rb') as inp,os.fdopen(fd,'wb') as out:
    if not stat.S_ISREG(os.fstat(inp.fileno()).st_mode): raise OSError(errno.EINVAL,'regular file required')
    shutil.copyfileobj(inp,out,65536)
   publish(stage,q);published=True
  finally:
   if created and os.path.lexists(stage): os.unlink(stage)
 elif op=='move':
  os.lstat(p);rename(p,q)
 print(json.dumps({'ok':True,'value':result},ensure_ascii=True))
except OSError as e:
 code='NOT_FOUND' if e.errno==errno.ENOENT else 'CONFLICT' if e.errno in (errno.EEXIST,errno.ENOTEMPTY) else 'FORBIDDEN' if e.errno in (errno.EACCES,errno.EPERM) else 'CAPACITY' if e.errno in (errno.EFBIG,errno.ENOSPC) else 'UNSUPPORTED' if e.errno in (errno.EXDEV,errno.ENOSYS,errno.EOPNOTSUPP) else 'INVALID_ARGUMENT'
 print(json.dumps({'ok':False,'code':code,'effect':'applied' if published else 'possible' if (created and os.path.lexists(stage)) or (op in ('mkdir','remove') and overwrite) else 'none','temporaryPaths':[stage] if created and os.path.lexists(stage) else []}))
`;

const reads = new Set(["stat", "list", "exists"]);

const Receipt = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.json() }),
  z.object({
    ok: z.literal(false),
    code: z.enum([
      "NOT_FOUND",
      "CONFLICT",
      "FORBIDDEN",
      "CAPACITY",
      "UNSUPPORTED",
      "INVALID_ARGUMENT",
    ]),
    effect: z.enum(["none", "possible", "applied"]),
    temporaryPaths: z.array(z.string()),
  }),
]);

/**
 * One finite guest command: its stdout as text when it exits 0, an error otherwise. `stdin`
 * streams to the command and is closed after the last chunk.
 */
export type GuestRunner = (
  command: string,
  ctx: ReadContext,
  stdin?: AsyncIterable<Uint8Array>,
) => Promise<string>;

/** Pull-driven download: `write` is awaited before the next chunk is requested. */
export type Downloader = (
  path: string,
  write: (chunk: Uint8Array) => Promise<void>,
  signal: AbortSignal,
) => Promise<void>;

export function filesystem(run: GuestRunner, download: Downloader) {
  const helper = async (
    op: string,
    path: string,
    destination: string,
    flag: boolean,
    ctx: ReadContext,
    stage = "",
    stdin?: AsyncIterable<Uint8Array>,
  ) => {
    ctx.signal.throwIfAborted();

    const command = ["python3", "-c", FILESYSTEM_HELPER, op, path, destination, String(flag), stage]
      .map(quote)
      .join(" ");

    const uncertain = () =>
      new AdapterFilesystemError(
        "UNAVAILABLE",
        "Archil filesystem response was not confirmed; do not replay",
        {
          effect: "possible",
          source: path,
          destination: destination || path,
          temporaryPaths: stage ? [stage] : [],
        },
      );

    let receipt: z.infer<typeof Receipt>;

    try {
      const stdout = await run(
        command,
        stdin ? ctx : { ...ctx, deadline: Math.min(ctx.deadline, Date.now() + 60_000) },
        stdin,
      );

      receipt = Receipt.parse(JSON.parse(stdout));
    } catch (error) {
      if (ctx.signal.aborted) throw ctx.signal.reason;

      if (!reads.has(op)) throw uncertain();

      if (error instanceof AdapterError) throw error;
      throw new AdapterError(
        "UNAVAILABLE",
        "Archil filesystem helper failed; Python 3 is required in the sandbox image",
      );
    }

    if (!receipt.ok)
      throw new AdapterFilesystemError(receipt.code, "Archil filesystem request rejected", {
        effect: receipt.effect,
        source: path,
        destination: destination || path,
        temporaryPaths: receipt.temporaryPaths,
      });

    return receipt.value;
  };

  const staging = (path: string) => posix.join(posix.dirname(path), `.beachside-${randomUUID()}`);

  const write = async (
    path: string,
    bytes: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    overwrite: boolean,
    ctx: FileTransferContext,
  ) => {
    const stage = staging(path);
    let count = 0;
    ctx.retain?.({ temporaryPaths: [stage] });

    try {
      async function* counted() {
        for await (const input of bytes) {
          ctx.signal.throwIfAborted();
          count += input.length;
          yield input;
          ctx.retain?.({ temporaryPaths: [stage], bytesTransferred: count });
        }
      }

      // One process receives every byte on stdin into a private stage beside the target.
      const received = await helper("receive", stage, "", false, ctx, "", counted());

      if (z.object({ bytesWritten: z.number().int() }).parse(received).bytesWritten !== count)
        throw new AdapterFilesystemError("UNAVAILABLE", "Archil staging byte count differs", {
          effect: "possible",
          source: stage,
          destination: path,
          temporaryPaths: [stage],
        });

      await helper("publish", stage, path, overwrite, { ...ctx, deadline: Date.now() + 60_000 });
      ctx.retain?.({ effect: "applied", temporaryPaths: [], bytesTransferred: count });

      return { bytesWritten: count };
    } catch (error) {
      if (error instanceof AdapterFilesystemError) {
        if (error.details.effect === "applied")
          ctx.retain?.({ effect: "applied", temporaryPaths: [stage], bytesTransferred: count });

        throw new AdapterFilesystemError(error.code, error.message, {
          ...error.details,
          source: stage,
          destination: path,
          temporaryPaths: [stage],
          bytesTransferred: count,
        });
      }

      throw error;
    }
  };

  return {
    helper,
    write,
    async transfer(
      op: "copy" | "move",
      source: string,
      destination: string,
      overwrite: boolean,
      ctx: FileTransferContext,
    ) {
      const stage = op === "copy" ? staging(destination) : "";
      ctx.retain?.({ temporaryPaths: stage ? [stage] : [] });
      await helper(op, source, destination, overwrite, ctx, stage);
      ctx.retain?.({ effect: "applied", temporaryPaths: [] });

      return { acknowledged: true as const };
    },
    /** A pull-driven download: the next chunk is requested only after the reader takes one. */
    read(path: string, ctx: ReadContext) {
      const cancellation = new AbortController();
      const signal = AbortSignal.any([ctx.signal, cancellation.signal]);
      let next: ((chunk: Uint8Array | null) => void) | undefined;
      let failed: ((error: Error) => void) | undefined;
      let wanted: (() => void) | undefined;
      let started = false;
      let ended: { error?: Error } | undefined;

      const start = () => {
        started = true;

        void download(
          path,
          (chunk) =>
            new Promise<void>((resolve) => {
              wanted = resolve;
              next?.(chunk);
            }),
          signal,
        ).then(
          () => {
            ended = {};
            next?.(null);
          },
          (error: Error) => {
            ended = { error };
            failed?.(error);
          },
        );
      };

      return new ReadableStream<Uint8Array>(
        {
          cancel() {
            cancellation.abort();
            wanted?.();
          },
          async pull(controller) {
            try {
              const chunk = await new Promise<Uint8Array | null>((resolve, reject) => {
                next = resolve;
                failed = reject;

                if (ended) {
                  if (ended.error) reject(ended.error);
                  else resolve(null);
                } else if (!started) start();
                else {
                  const resume = wanted;
                  wanted = undefined;
                  resume?.();
                }
              });

              if (chunk === null) controller.close();
              else controller.enqueue(chunk);
            } catch (error) {
              controller.error(error);
            }
          },
        },
        { highWaterMark: 0 },
      );
    },
  };
}

const Directory = z.object({
  entries: z.array(
    z.object({ name: z.string(), type: z.enum(["file", "directory", "symlink", "unknown"]) }),
  ),
  completeness: z.literal("complete"),
});

export function directoryValue(value: z.infer<ReturnType<typeof z.json>>): DirectoryResult {
  const parsed = Directory.safeParse(value);

  if (!parsed.success)
    throw new AdapterError("UNAVAILABLE", "Archil directory response is invalid");

  return { ...parsed.data, observedAt: new Date().toISOString() };
}

export function statValue(value: z.infer<ReturnType<typeof z.json>>): FileStat {
  const result = z
    .object({
      type: z.enum(["file", "directory", "symlink", "unknown"]),
      sizeBytes: z.number().int().nonnegative().safe(),
      modifiedAt: z.number(),
      mode: z.number().int().nonnegative(),
    })
    .safeParse(value);

  if (!result.success || Math.abs(result.data.modifiedAt * 1000) > 8_640_000_000_000_000)
    throw new AdapterError("UNAVAILABLE", "Archil metadata response is invalid");

  return { ...result.data, modifiedAt: new Date(result.data.modifiedAt * 1000).toISOString() };
}

export const Exists = z.object({ exists: z.boolean() });
