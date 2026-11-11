import { afterEach } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { Beachside } from "beachside";
import { createArchilAdapter } from "./adapter";
import type { Json } from "@beachside/adapter";
import type { ServerWebSocket, Subprocess } from "bun";
import { z } from "zod";

/**
 * Deterministic Archil control plane and process runtime. HTTP answers the REST API the
 * adapter calls; the WebSocket speaks `archil.connect.v1` to the official SDK's `Sandbox`.
 * Commands run through the local `sh`, so output frames carry the real bytes.
 */

type Frame = { stream: 1 | 2; offset: number; data: Uint8Array };

type FixtureProcess = {
  id: string;
  child: Subprocess<"pipe", "pipe", "pipe">;
  frames: Frame[];
  cursor: number;
  exit?: { status: string; exit_code?: number };
  sockets: Set<ServerWebSocket<SocketData>>;
  killed: boolean;
  timedOut: boolean;
};

export type FixtureSandbox = {
  id: string;
  account: string;
  name: string;
  status: string;
  vcpu: number;
  memory: number;
  maxTtl: number;
  idleTtl: number;
  image: string;
  env: Record<string, string>;
  network: Json | undefined;
  managed: boolean;
  mounts: Json[];
  createdAt: string;
  checkpoint?: string;
  previousCheckpoint?: string;
  parent?: string;
  polls: number;
  processes: Map<string, FixtureProcess>;
  ports: Set<number>;
};

type FixtureDisk = {
  id: string;
  account: string;
  name: string;
  status: string;
  /** Reads left before an accepted delete removes the disk (Archil deletes asynchronously). */
  removeAfter?: number;
};

type FixtureImage = { id: string; source: string; status: string; polls: number };

type SocketData = { sandbox: string; process?: string };

export type Call = { method: string; path: string; body?: Json };

const accounts = new Map([
  ["fixture-main", "acct_main"],
  ["fixture-alt", "acct_alt"],
]);

function json(status: number, data: Json): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function failure(status: number, code: string, message = `${code} happened`): Response {
  return new Response(JSON.stringify({ success: false, error: message, code }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function frame(value: Frame): Uint8Array {
  const bytes = new Uint8Array(9 + value.data.byteLength);
  bytes[0] = value.stream;
  new DataView(bytes.buffer).setBigUint64(1, BigInt(value.offset));
  bytes.set(value.data, 9);

  return bytes;
}

const Text = z.string().optional();

const Count = z.number().optional();

const Body = z
  .looseObject({
    name: Text,
    vcpu_count: Count,
    mem_size_mib: Count,
    max_ttl_seconds: Count,
    idle_ttl_seconds: Count,
    base_image: Text,
    image_id: Text,
    env: z.record(z.string(), z.string()).optional(),
    network: z.json().optional(),
    mounts: z.array(z.json()).optional(),
    checkpoint: Text,
    timeout: Count,
    port: Count,
    source: Text,
  })
  .default({});

type Body = z.infer<typeof Body>;

const MountRef = z.looseObject({ disk_id: Text });

const Message = z.looseObject({
  type: z.string(),
  process_id: Text,
  offset: Count,
});

const StartMessage = z.looseObject({
  command: z.string(),
  cwd: z.string().nullish(),
  env: z.record(z.string(), z.string()).nullish(),
  timeout_seconds: z.number().nullish(),
});

type StartMessage = z.infer<typeof StartMessage>;

export function archilFixture(options: { plan?: "free" | "developer" } = {}) {
  const sandboxes = new Map<string, FixtureSandbox>();
  const disks = new Map<string, FixtureDisk>();
  const images = new Map<string, FixtureImage>();
  const tokens = new Map<string, string>();
  const calls: Call[] = [];
  const effects = { create: 0, destroy: 0, fork: 0 };
  let plan = options.plan ?? "developer";
  let loseNextCreate = false;
  /** Network the next created sandbox reports instead of the one its create asked for. */
  let nextNetwork: Json | undefined;
  let failNextFork = false;
  let held: { release: () => void; promise: Promise<void> } | undefined;
  let holdNext = false;
  let checkpoints = 0;

  const view = (box: FixtureSandbox): Json => {
    const wire = {
      sandbox_id: box.id,
      name: box.name,
      status: box.status,
      vcpu_count: box.vcpu,
      mem_size_mib: box.memory,
      max_ttl_seconds: box.maxTtl,
      idle_ttl_seconds: box.idleTtl,
      max_concurrent_execs: 32,
      base_image: box.image,
      enable_service_ingress: false,
      mounts: box.mounts,
      created_at: box.createdAt,
      last_active_at: box.createdAt,
    };

    return box.checkpoint ? { ...wire, checkpoint: box.checkpoint } : wire;
  };

  const owned = (account: string, id: string) => {
    const box = sandboxes.get(id);

    return box && box.account === account ? box : undefined;
  };

  const advance = (box: FixtureSandbox) => {
    if (box.status === "pending" && ++box.polls > 1) box.status = "running";
  };

  const disconnect = (box: FixtureSandbox) => {
    for (const proc of box.processes.values())
      for (const socket of proc.sockets) socket.close(1001, "paused");
  };

  const terminate = (box: FixtureSandbox) => {
    for (const proc of box.processes.values()) {
      proc.killed = true;
      proc.child.kill(9);
    }

    disconnect(box);
    box.processes.clear();
  };

  const checkpoint = (box: FixtureSandbox) => {
    box.previousCheckpoint = box.checkpoint;
    box.checkpoint = `cp-${++checkpoints}`;
  };

  const launch = (
    account: string,
    name: string,
    body: Body,
    from?: FixtureSandbox,
  ): FixtureSandbox => {
    const box: FixtureSandbox = {
      id: randomUUID(),
      account,
      name,
      status: "pending",
      vcpu: from?.vcpu ?? body.vcpu_count ?? 1,
      memory: from?.memory ?? body.mem_size_mib ?? 2048,
      maxTtl: from?.maxTtl ?? body.max_ttl_seconds ?? 86_400,
      idleTtl: from?.idleTtl ?? body.idle_ttl_seconds ?? 1800,
      image: from?.image ?? body.base_image ?? body.image_id ?? "node:24-bookworm",
      env: from?.env ?? body.env ?? {},
      network: from ? from.network : (nextNetwork ?? body.network),
      managed: from ? from.managed : plan === "free",
      mounts: from ? [] : (body.mounts ?? []),
      createdAt: new Date().toISOString(),
      parent: from?.id,
      polls: 0,
      processes: new Map(),
      ports: new Set(),
    };

    sandboxes.set(box.id, box);

    return box;
  };

  const route = async (request: Request, port: number): Promise<Response> => {
    const url = new URL(request.url);
    const key = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const account = accounts.get(key);

    if (!account) return new Response("Unauthorized", { status: 401 });

    const text = await request.text();
    const body = Body.parse(text ? JSON.parse(text) : undefined);
    const parts = url.pathname.split("/").filter(Boolean).slice(1);
    const method = request.method;

    if (parts[0] === "sandboxes") {
      if (parts.length === 1 && method === "GET")
        return json(200, {
          sandboxes: [...sandboxes.values()].flatMap((box) => {
            if (box.account !== account) return [];
            advance(box);

            return [view(box)];
          }),
        });

      if (parts.length === 1 && method === "POST") {
        const name = body.name ?? "";

        if ([...sandboxes.values()].some((box) => box.account === account && box.name === name))
          return failure(409, "sandbox_name_conflict");

        if (body.network !== undefined && plan === "free")
          return failure(403, "sandbox_network_plan_required", "Network policies need a paid plan");

        if (body.image_id !== undefined && images.get(body.image_id)?.status !== "ready")
          return failure(409, "image_not_ready");

        effects.create++;

        const launched = launch(account, name, body);
        nextNetwork = undefined;

        return json(202, view(launched));
      }

      const box = owned(account, parts[1] ?? "");

      if (!box) return failure(404, "sandbox_not_found");
      const action = parts[2];

      if (!action && method === "GET") {
        advance(box);

        return json(200, view(box));
      }

      if (!action && method === "DELETE") {
        // Archil checks the state first, then forks (as the live service does).
        if (!["stopped", "exited", "failed"].includes(box.status))
          return failure(409, "sandbox_not_stopped", "The sandbox must be stopped");

        const children = [...sandboxes.values()].filter((child) => child.parent === box.id);

        if (children.length)
          return failure(
            409,
            "sandbox_has_children",
            `The sandbox has ${children.length} child disks that must be deleted first`,
          );

        sandboxes.delete(box.id);
        effects.destroy++;

        return json(200, null);
      }

      if (action === "pause") {
        if (box.status !== "running") return failure(409, "sandbox_not_running");
        checkpoint(box);
        box.status = "paused";
        disconnect(box);

        return json(200, view(box));
      }

      if (action === "resume") {
        if (box.status !== "paused") return failure(409, "sandbox_not_paused");
        box.status = "running";

        return json(200, view(box));
      }

      if (action === "stop") {
        if (box.status !== "running" && box.status !== "paused")
          return failure(409, "sandbox_not_running");
        checkpoint(box);
        terminate(box);
        box.status = "stopped";

        return json(200, view(box));
      }

      if (action === "start") {
        if (box.status !== "stopped" && box.status !== "paused")
          return failure(409, "sandbox_running");
        terminate(box);
        box.status = "running";

        return json(200, view(box));
      }

      if (action === "fork") {
        const name = body.name ?? "";

        if (failNextFork) {
          failNextFork = false;

          return failure(503, "no_capacity");
        }

        if (
          [...sandboxes.values()].some((other) => other.account === account && other.name === name)
        )
          return failure(409, "sandbox_name_conflict");

        if (box.mounts.length && box.status !== "stopped")
          return failure(409, "sandbox_fork_mounted");

        if (
          body.checkpoint !== undefined &&
          body.checkpoint !== box.checkpoint &&
          body.checkpoint !== box.previousCheckpoint
        )
          return failure(409, "sandbox_fork_checkpoint");

        effects.fork++;

        return json(202, view(launch(account, name, body, box)));
      }

      if (action === "timeout") {
        if (body.timeout !== undefined) box.maxTtl = body.timeout;

        return json(200, view(box));
      }

      if (action === "network") {
        if (method === "GET")
          return json(200, box.managed ? { managed: true } : (box.network ?? {}));

        return failure(405, "method_not_allowed");
      }

      if (action === "ports" && method === "PUT") {
        box.ports.add(Number(parts[3]));

        return json(200, {
          port: Number(parts[3]),
          hostname: `${parts[3]}-${box.id}.fixture.archil.dev`,
        });
      }

      if (action === "port-tokens" && method === "POST")
        return json(201, {
          id: randomUUID(),
          port: body.port ?? 0,
          hostname: `${body.port ?? 0}-${box.id}.fixture.archil.dev`,
          token: `porttok-${randomUUID()}`,
          created_at: new Date().toISOString(),
        });

      if (action === "connections" && method === "POST") {
        if (box.status !== "running") return failure(409, "sandbox_not_running");
        const token = randomUUID();
        tokens.set(token, box.id);

        return json(200, {
          url: `ws://127.0.0.1:${port}/ws`,
          endpoint: `ws://127.0.0.1:${port}/ws`,
          token,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        });
      }
    }

    if (parts[0] === "images") {
      if (parts.length === 1 && method === "POST") {
        const source = body.source ?? "";
        const id = createHash("sha256").update(source).digest("hex");
        const image = images.get(id) ?? { id, source, status: "building", polls: 0 };
        images.set(id, image);

        return json(202, imageView(image));
      }

      const image = images.get(parts[1] ?? "");

      if (!image) return failure(404, "image_not_found");

      if (image.status === "building" && ++image.polls > 1)
        image.status = image.source.startsWith("fail/") ? "failed" : "ready";

      return json(200, imageView(image));
    }

    if (parts[0] === "disks") {
      if (parts.length === 1 && method === "GET")
        return json(
          200,
          [...disks.values()].flatMap((disk) =>
            disk.account === account &&
            (!url.searchParams.get("name") || disk.name === url.searchParams.get("name"))
              ? [diskView(disk)]
              : [],
          ),
        );

      if (parts.length === 1 && method === "POST") {
        const name = body.name ?? "";

        const existing = [...disks.values()].find(
          (disk) => disk.account === account && disk.name === name,
        );

        const disk = existing ?? {
          id: `dsk-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
          account,
          name,
          status: "available",
        };

        disks.set(disk.id, disk);

        // Idempotent by name: 201 only when this request made the disk.
        return json(existing ? 200 : 201, {
          diskId: disk.id,
          authorizedUsers: [{ type: "token", token: "disk-secret-token" }],
        });
      }

      const disk = disks.get(parts[1] ?? "");

      if (!disk || disk.account !== account) return failure(404, "disk_not_found");

      if (method === "GET" && disk.removeAfter !== undefined && --disk.removeAfter < 0) {
        disks.delete(disk.id);

        return failure(404, "disk_not_found");
      }

      if (method === "GET") return json(200, diskView(disk));

      if (method === "DELETE") {
        const mounted = [...sandboxes.values()].some((box) =>
          box.mounts.some((mount) => MountRef.safeParse(mount).data?.disk_id === disk.id),
        );

        if (mounted) return failure(409, "disk_in_use");
        disk.removeAfter = 2;

        return json(200, null);
      }
    }

    return failure(404, "route_not_found");
  };

  const imageView = (image: FixtureImage): Json => ({
    image_id: image.id,
    source: image.source,
    private: false,
    status: image.status,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  });

  const diskView = (disk: FixtureDisk): Json => ({
    id: disk.id,
    name: disk.name,
    organization: disk.account,
    status: disk.status,
    provider: "aws",
    region: "aws-us-east-1",
    createdAt: new Date(0).toISOString(),
    sandboxDisk: false,
    allowSandboxMount: true,
  });

  const send = (socket: ServerWebSocket<SocketData>, value: Json) =>
    socket.send(JSON.stringify(value));

  const replay = (socket: ServerWebSocket<SocketData>, proc: FixtureProcess, offset: number) => {
    for (const item of proc.frames)
      if (item.offset + item.data.byteLength > offset) socket.send(frame(item));

    if (proc.exit) send(socket, { type: "exit", ...proc.exit, cursor: proc.cursor });
  };

  const start = (socket: ServerWebSocket<SocketData>, message: StartMessage) => {
    const box = sandboxes.get(socket.data.sandbox);

    if (!box || box.status !== "running") {
      send(socket, { type: "error", error: "sandbox_not_running", message: "not running" });

      return;
    }

    const child = Bun.spawn(["sh", "-c", message.command], {
      cwd: message.cwd ?? undefined,
      env: {
        ...process.env,
        ...box.env,
        ...message.env,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const proc: FixtureProcess = {
      id: randomUUID(),
      child,
      frames: [],
      cursor: 0,
      sockets: new Set([socket]),
      killed: false,
      timedOut: false,
    };

    box.processes.set(proc.id, proc);
    socket.data.process = proc.id;
    send(socket, { type: "started", process_id: proc.id });

    const timeout = message.timeout_seconds;

    if (timeout !== undefined && timeout !== null)
      setTimeout(() => {
        if (proc.exit) return;
        proc.timedOut = true;
        child.kill(9);
      }, timeout * 1000);

    const pump = async (stream: ReadableStream<Uint8Array>, id: 1 | 2) => {
      const reader = stream.getReader();

      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        const chunk = next.value;
        const item = { stream: id, offset: proc.cursor, data: chunk.slice() };
        proc.cursor += chunk.byteLength;
        proc.frames.push(item);

        for (const viewer of proc.sockets) viewer.send(frame(item));
      }
    };

    void Promise.all([pump(child.stdout, 1), pump(child.stderr, 2), child.exited]).then(
      ([, , code]) => {
        proc.exit = proc.timedOut
          ? { status: "timed_out" }
          : proc.killed
            ? { status: "cancelled" }
            : child.signalCode
              ? // Archil reports a signalled process as exit code -1.
                { status: "failed", exit_code: -1 }
              : { status: code === 0 ? "completed" : "failed", exit_code: code };

        for (const viewer of proc.sockets)
          send(viewer, { type: "exit", ...proc.exit, cursor: proc.cursor });
      },
    );
  };

  const findProcess = (sandbox: string, id: string) => sandboxes.get(sandbox)?.processes.get(id);

  const server = Bun.serve<SocketData>({
    port: 0,
    fetch(request, bun) {
      const url = new URL(request.url);

      if (url.pathname === "/ws") {
        const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
          .split(",")
          .map((value) => value.trim());

        const token = protocols.find((value) => value.startsWith("archil.token."))?.slice(13);
        const sandbox = token ? tokens.get(token) : undefined;

        if (!sandbox || !protocols.includes("archil.connect.v1"))
          return new Response("forbidden", { status: 403 });
        tokens.delete(token ?? "");

        return bun.upgrade(request, {
          data: { sandbox },
          headers: { "Sec-WebSocket-Protocol": "archil.connect.v1" },
        })
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      }

      return route(request, bun.port ?? 0);
    },
    websocket: {
      message(socket, message) {
        if (message instanceof Uint8Array) {
          const proc = findProcess(socket.data.sandbox, socket.data.process ?? "");

          // The child may already have exited; a late frame must not crash the fixture.
          try {
            proc?.child.stdin.write(message);
            void Promise.resolve(proc?.child.stdin.flush()).catch(() => undefined);
          } catch {
            // Writing to an exited child raises EPIPE; ignore it like a closed pipe.
          }

          return;
        }

        const raw = JSON.parse(message);
        const parsed = Message.parse(raw);

        if (parsed.type === "start") start(socket, StartMessage.parse(raw));
        else if (parsed.type === "attach") {
          const proc = findProcess(socket.data.sandbox, parsed.process_id ?? "");

          if (!proc) {
            send(socket, { type: "error", error: "process_not_found", message: "unknown process" });
            socket.close(1000);

            return;
          }

          socket.data.process = proc.id;
          proc.sockets.add(socket);
          send(socket, { type: "attached", process_id: proc.id });
          replay(socket, proc, parsed.offset ?? 0);
        } else if (parsed.type === "kill" || parsed.type === "resize") {
          const proc = findProcess(socket.data.sandbox, parsed.process_id ?? "");

          if (parsed.type === "kill" && proc && !proc.exit) {
            proc.killed = true;
            proc.child.kill(9);
          }

          send(socket, { type: parsed.type === "kill" ? "killed" : "resized" });
        } else if (parsed.type === "close_stdin") {
          const proc = findProcess(socket.data.sandbox, socket.data.process ?? "");

          void Promise.resolve(proc?.child.stdin.end()).catch(() => undefined);
        }
      },
      close(socket) {
        findProcess(socket.data.sandbox, socket.data.process ?? "")?.sockets.delete(socket);
      },
    },
  });

  const baseUrl = `http://127.0.0.1:${server.port}`;

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const text = z.string().safeParse(init?.body).data;
    const call: Call = { method: init?.method ?? "GET", path: url.pathname };

    if (text) call.body = z.json().parse(JSON.parse(text));
    calls.push(call);

    const isCreate =
      call.method === "POST" && /^\/api\/sandboxes(\/[^/]+\/fork)?$/.test(url.pathname);

    const response = await globalThis.fetch(input, init);

    if (isCreate && loseNextCreate) {
      loseNextCreate = false;
      throw new TypeError("fetch failed");
    }

    if (isCreate && holdNext) {
      holdNext = false;
      await held?.promise;
    }

    return response;
  };

  return {
    baseUrl,
    fetch,
    calls,
    effects,
    sandboxes,
    disks,
    images,
    setPlan(value: "free" | "developer") {
      plan = value;
    },
    loseNextCreateResponse() {
      loseNextCreate = true;
    },
    reportNextNetwork(value: Json) {
      nextNetwork = value;
    },
    failNextFork() {
      failNextFork = true;
    },
    holdNextCreateResponse() {
      let release!: () => void;

      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });

      held = { release, promise };
      holdNext = true;
    },
    releaseHeldCreateResponse() {
      held?.release();
    },
    close() {
      for (const box of sandboxes.values()) terminate(box);
      void server.stop(true);
    },
  };
}

export type ArchilFixture = ReturnType<typeof archilFixture>;

const fixtures: ArchilFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

/** A fixture and an adapter on it; fixtures close after each test. */
export function setup(options: Parameters<typeof archilFixture>[0] = {}) {
  const fixture = archilFixture(options);
  fixtures.push(fixture);

  const adapter = createArchilAdapter({
    fetch: fixture.fetch,
    pollIntervalMs: 1,
    settleSeconds: 2,
  });

  const connect = (
    config: Partial<z.input<typeof adapter.config>> = {},
    credentials: z.input<typeof adapter.credentials> = { apiKey: "fixture-main" },
  ) =>
    Beachside.connect({
      adapter,
      config: { region: "aws-us-east-1", baseUrl: fixture.baseUrl, ...config },
      credentials,
    });

  return { fixture, adapter, connect };
}
