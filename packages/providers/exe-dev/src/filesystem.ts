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
import { quote } from "./exec";
import type { GuestRunner } from "./process";

/**
 * exe.dev has no file API: every file operation is a guest command over `ssh`, whose request
 * body is at most 64 KB and has no stdin. Operations run through this finite helper (the one
 * the boxd and Freestyle adapters use); Python 3 is an image prerequisite, never installed.
 * Paths are arguments, never program text. Writes stage base64 chunks into a private file
 * beside the target and publish it with an atomic rename, or a hard link when the target must
 * not be replaced. Reads return raw bytes on stdout and their receipt on stderr, which exe.dev
 * streams separately.
 */
export const FILESYSTEM_HELPER = String.raw`
import os,sys,json,stat,errno,ctypes,tempfile,shutil,base64
op,p,q,flag,stage,data_arg=sys.argv[1:7]
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
 elif op=='append':
  fd=os.open(p,os.O_WRONLY|os.O_NOFOLLOW)
  with os.fdopen(fd,'r+b') as f:
   f.seek(0,2)
   if f.tell()!=int(q): raise OSError(errno.EINVAL,'unexpected staging size')
   data=base64.b64decode(data_arg,validate=True)
   if len(data)>65536: raise OSError(errno.EFBIG,'chunk bound exceeded')
   f.write(data)
  result={'bytesWritten':len(data)}
 elif op=='read':
  fd=os.open(p,os.O_RDONLY|os.O_NONBLOCK)
  with os.fdopen(fd,'rb') as f:
   st=os.fstat(f.fileno())
   if not stat.S_ISREG(st.st_mode): raise OSError(errno.EINVAL,'regular file required')
   f.seek(int(q));data=f.read(int(stage))
  sys.stdout.buffer.write(data);sys.stdout.flush()
  sys.stderr.write(json.dumps({'ok':True,'value':{'total':st.st_size}}));sys.exit(0)
 elif op=='reserve':
  parents(p);fd=os.open(p,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)
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
 print(json.dumps({'ok':False,'code':code,'effect':'applied' if published else 'possible' if (created and os.path.lexists(stage)) or (op in ('mkdir','remove') and overwrite) else 'none','temporaryPaths':[stage] if created and os.path.lexists(stage) else []}),file=sys.stderr if op=='read' else sys.stdout)
`;

/** Raw bytes appended per staging request, so the encoded chunk fits one 64 KB request. */
export const STAGE_CHUNK_BYTES = 32 * 1024;

/** Bytes read per streamed range request. */
export const READ_CHUNK_BYTES = 4 * 1024 * 1024;

const Failure = z.object({
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
});

const Receipt = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.json() }),
  Failure,
]);

const ReadReceipt = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    value: z.object({ total: z.number().int().nonnegative().safe() }),
  }),
  Failure,
]);

const reads = new Set(["stat", "list", "exists"]);

const text = new TextDecoder();

export function filesystem(run: GuestRunner) {
  const command = (
    op: string,
    path: string,
    destination: string,
    flag: boolean,
    stage: string,
    data: string,
  ) =>
    ["python3", "-c", FILESYSTEM_HELPER, op, path, destination, String(flag), stage, data]
      .map(quote)
      .join(" ");

  const rejected = (receipt: z.infer<typeof Failure>, path: string, destination: string) =>
    new AdapterFilesystemError(receipt.code, "exe.dev filesystem request rejected", {
      effect: receipt.effect,
      source: path,
      destination: destination || path,
      temporaryPaths: receipt.temporaryPaths,
    });

  const helper = async (
    op: string,
    path: string,
    destination: string,
    flag: boolean,
    ctx: ReadContext,
    stage = "",
    data?: Uint8Array,
  ) => {
    ctx.signal.throwIfAborted();

    const uncertain = () =>
      new AdapterFilesystemError(
        "UNAVAILABLE",
        "exe.dev filesystem response was not confirmed; do not replay",
        {
          effect: "possible",
          source: path,
          destination: destination || path,
          temporaryPaths: stage ? [stage] : [],
        },
      );

    let receipt: z.infer<typeof Receipt>;

    try {
      const result = await run(
        command(
          op,
          path,
          destination,
          flag,
          stage,
          data ? Buffer.from(data).toString("base64") : "",
        ),
        { ...ctx, deadline: Math.min(ctx.deadline, Date.now() + 60_000) },
      );

      receipt = Receipt.parse(JSON.parse(text.decode(result.stdout)));
    } catch (error) {
      if (ctx.signal.aborted) throw ctx.signal.reason;

      if (!reads.has(op)) throw uncertain();

      if (error instanceof AdapterError) throw error;
      throw new AdapterError(
        "UNAVAILABLE",
        "exe.dev filesystem helper failed; Python 3 is required in the VM",
      );
    }

    if (!receipt.ok) throw rejected(receipt, path, destination);

    return receipt.value;
  };

  /** One bounded range read: raw bytes from stdout, the file's length from the receipt. */
  const readRange = async (path: string, offset: number, length: number, ctx: ReadContext) => {
    ctx.signal.throwIfAborted();
    let result;

    try {
      result = await run(
        command("read", path, String(offset), false, String(length), ""),
        ctx,
        length,
      );
    } catch (error) {
      if (ctx.signal.aborted) throw ctx.signal.reason;

      if (error instanceof AdapterError) throw error;
      throw new AdapterError("UNAVAILABLE", "exe.dev file read failed");
    }

    let receipt: z.infer<typeof ReadReceipt>;

    try {
      receipt = ReadReceipt.parse(JSON.parse(text.decode(result.stderr)));
    } catch {
      throw new AdapterError(
        "UNAVAILABLE",
        "exe.dev filesystem helper failed; Python 3 is required in the VM",
      );
    }

    if (!receipt.ok) throw rejected(receipt, path, "");

    if (result.stdout.length > length)
      throw new AdapterError("UNAVAILABLE", "exe.dev file range is malformed");

    return { bytes: result.stdout, total: receipt.value.total };
  };

  const staging = (path: string) => posix.join(posix.dirname(path), `.beachside-${randomUUID()}`);

  const write = async (
    path: string,
    bytes: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    overwrite: boolean,
    ctx: FileTransferContext,
    stage = staging(path),
  ) => {
    let count = 0;
    ctx.retain?.({ temporaryPaths: [stage] });

    try {
      await helper("reserve", stage, "", false, ctx);

      // Keep the correlated stage on uncertain input or transport failure; nothing replays.
      for await (const input of bytes)
        for (let offset = 0; offset < input.length; offset += STAGE_CHUNK_BYTES) {
          ctx.signal.throwIfAborted();
          const chunk = input.subarray(offset, offset + STAGE_CHUNK_BYTES);

          const ack = z
            .object({ bytesWritten: z.number().int() })
            .parse(
              await helper(
                "append",
                stage,
                String(count),
                false,
                { ...ctx, deadline: Date.now() + 60_000 },
                "",
                chunk,
              ),
            );

          if (ack.bytesWritten !== chunk.length)
            throw new AdapterFilesystemError("UNAVAILABLE", "exe.dev staging byte count differs", {
              effect: "possible",
              source: stage,
              destination: path,
              temporaryPaths: [stage],
            });
          count += chunk.length;
          ctx.retain?.({ temporaryPaths: [stage], bytesTransferred: count });
        }

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
    /** Stage bytes into a fresh private guest file and return its path (exec stdin). */
    async stage(bytes: Uint8Array, ctx: FileTransferContext) {
      const path = `/tmp/.beachside-stdin-${randomUUID()}`;
      await write(path, [bytes], false, ctx, `${path}.part`);

      return path;
    },
    /** A whole file up to `limit` bytes; longer files are refused. */
    async readAll(path: string, limit: number, ctx: ReadContext) {
      const { bytes, total } = await readRange(path, 0, limit + 1, ctx);

      if (bytes.length > limit || total > limit)
        throw new AdapterError("CAPACITY", "exe.dev file exceeds the read bound");

      return bytes;
    },
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
    /** Range reads, one chunk per pull, so the file is never held whole. */
    read(path: string, ctx: ReadContext) {
      let offset = 0;
      const cancellation = new AbortController();
      const signal = AbortSignal.any([ctx.signal, cancellation.signal]);

      return new ReadableStream<Uint8Array>(
        {
          cancel() {
            cancellation.abort();
          },
          async pull(controller) {
            try {
              const { bytes, total } = await readRange(path, offset, READ_CHUNK_BYTES, {
                signal,
                deadline: Date.now() + 120_000,
              });

              offset += bytes.length;

              if (bytes.length) controller.enqueue(bytes);

              if (offset >= total || bytes.length < READ_CHUNK_BYTES) controller.close();
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
    throw new AdapterError("UNAVAILABLE", "exe.dev directory response is invalid");

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
    throw new AdapterError("UNAVAILABLE", "exe.dev metadata response is invalid");

  return { ...result.data, modifiedAt: new Date(result.data.modifiedAt * 1000).toISOString() };
}

export const Exists = z.object({ exists: z.boolean() });
