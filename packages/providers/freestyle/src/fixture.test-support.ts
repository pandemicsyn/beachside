import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json } from "@beachside/adapter";
import { z } from "zod";

/**
 * Deterministic Freestyle public API (v5) stand-in behind the official SDK's `fetch` option.
 * The real SDK builds every request and parses every response; this fixture only answers.
 * Commands run through the local `sh`, so the guest wrapper is exercised byte for byte, and
 * stdout/stderr come back as lossy UTF-8 text the way Freestyle documents them.
 */

type FixtureVm = {
  id: string;
  slug: string | null;
  account: string;
  state: string;
  snapshotId: string;
  ttlSeconds: number | null;
  idleTimeoutSeconds: number | null;
  metadata: Record<string, string>;
  createdAt: string;
  polls: number;
  files: Map<string, Uint8Array>;
  tls: { id: string; domain: string; port: number }[];
};

type Call = { method: string; path: string; query: URLSearchParams; headers: Headers; body?: Json };

const Body = z
  .object({
    snapshotId: z.string().nullable().optional(),
    slug: z.string().nullable().optional(),
    ttlSeconds: z.number().nullable().optional(),
    idleTimeoutSeconds: z.number().nullable().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    tls: z
      .object({
        rules: z.array(
          z.object({ domain: z.string(), destination: z.object({ port: z.number() }) }),
        ),
      })
      .optional(),
    command: z.string().default(""),
    stdin: z.string().optional(),
    timeoutMs: z.number().optional(),
  })
  .default({ command: "" });

export type CommandResult = { statusCode: number | null; stdout: string; stderr: string };

const accounts = new Map([
  ["fixture-main", "acct_main"],
  ["fixture-alt", "acct_alt"],
]);

/** Sizes from the SDK's `BaseSnapshotId` documentation. */
const SIZES = new Map([
  ["freestyle/ubuntu-sm", { cpu: 2, memory: 4096, storage: 16_384 }],
  ["freestyle/ubuntu", { cpu: 4, memory: 8192, storage: 32_768 }],
  ["freestyle/ubuntu-lg", { cpu: 8, memory: 16_384, storage: 65_536 }],
  ["freestyle/ubuntu-xl", { cpu: 16, memory: 32_768, storage: 131_072 }],
  ["freestyle/ubuntu-2xl", { cpu: 32, memory: 65_536, storage: 131_072 }],
]);

function json(status: number, body: Json): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function error(status: number, code: string): Response {
  return json(status, { code, message: `${code} happened` });
}

function view(vm: FixtureVm) {
  return {
    id: vm.id,
    state: vm.state,
    slug: vm.slug,
    resources: SIZES.get(vm.snapshotId) ?? { cpu: 4, memory: 8192, storage: 32_768 },
    snapshotId: vm.snapshotId,
    ttlSeconds: vm.ttlSeconds,
    idleTimeoutSeconds: vm.idleTimeoutSeconds,
    metadata: vm.metadata,
    vpcs: [],
    networks: [],
    createdAt: vm.createdAt,
    updatedAt: vm.createdAt,
  };
}

/** The SDK sends JSON as a string and file bytes as a Uint8Array. */
const RequestBody = z.union([z.string(), z.instanceof(Uint8Array)]).optional();

function bytesOf(body: BodyInit | null | undefined): Uint8Array {
  const parsed = RequestBody.parse(body ?? undefined);

  if (parsed === undefined) return new Uint8Array();

  return parsed instanceof Uint8Array ? parsed : new TextEncoder().encode(parsed);
}

export function freestyleFixture() {
  const vms = new Map<string, FixtureVm>();
  const calls: Call[] = [];
  const effects = { create: 0, destroy: 0, release: 0, exec: 0, write: 0, pause: 0, start: 0 };
  const commands: string[] = [];
  const workdir = mkdtempSync(join(tmpdir(), "beachside-freestyle-fixture-"));
  let sequence = 0;
  let loseNextCreate = false;
  let holdNextCreate = false;
  let releaseHeld: (() => void) | undefined;
  let held: Promise<void> | undefined;
  let createFault: Response | undefined;
  let commandFault: Response | "lost" | undefined;
  let commandOverride: ((command: string) => CommandResult) | undefined;
  /** Polls a VM needs before it reports `running` after create or start. */
  let bootPolls = 0;
  /** Answer the next create as a background request that finishes on its first poll. */
  let backgroundNextCreate = false;
  const background = new Map<string, Response>();

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const raw = bytesOf(init?.body);
    const isJson = headers.get("content-type") === "application/json";
    const parsed = isJson ? z.json().parse(JSON.parse(new TextDecoder().decode(raw))) : undefined;
    const body = Body.parse(parsed);
    const path = url.pathname;
    calls.push({ method, path, query: url.searchParams, headers, body: parsed });

    if (url.origin !== "https://api.freestyle.sh" || init?.redirect !== "error")
      throw new Error(`Fixture refused ${url.origin} without redirect: error`);
    const account = accounts.get(headers.get("authorization")?.replace("Bearer ", "") ?? "");

    if (!account) return error(401, "UNAUTHORIZED");
    init?.signal?.throwIfAborted();

    const stored = path.match(/^\/v5\/background-requests\/([^/]+)$/);

    if (method === "GET" && stored) {
      const response = background.get(stored[1] ?? "");

      return response ? response.clone() : error(404, "NOT_FOUND");
    }

    if (method === "GET" && path === "/v5/vms") {
      const slug = url.searchParams.get("slug");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const offset = Number(url.searchParams.get("offset") ?? 0);

      const all = [...vms.values()].filter(
        (vm) => vm.account === account && (slug === null || vm.slug === slug),
      );

      return json(200, {
        vms: all.slice(offset, offset + limit).map(view),
        totalCount: all.length,
        runningCount: all.filter((vm) => vm.state === "running").length,
        startingCount: 0,
        pausingCount: 0,
        pausedCount: 0,
        stoppedCount: 0,
      });
    }

    if (method === "POST" && path === "/v5/vms") {
      const fault = createFault;
      createFault = undefined;

      if (fault) return fault;

      if (
        body.slug &&
        [...vms.values()].some((vm) => vm.account === account && vm.slug === body.slug)
      )
        return error(409, "SLUG_TAKEN");
      effects.create++;
      const id = `vm${++sequence}`;

      const vm: FixtureVm = {
        id,
        slug: body.slug ?? null,
        account,
        state: bootPolls > 0 ? "starting" : "running",
        snapshotId: body.snapshotId ?? "freestyle/ubuntu",
        ttlSeconds: body.ttlSeconds ?? null,
        idleTimeoutSeconds: body.idleTimeoutSeconds ?? null,
        metadata: body.metadata ?? {},
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        polls: 0,
        files: new Map(),
        tls: (body.tls?.rules ?? []).map((rule) => ({
          id: `tls${++sequence}`,
          domain: rule.domain,
          port: rule.destination.port,
        })),
      };

      vms.set(id, vm);

      if (loseNextCreate) {
        loseNextCreate = false;
        throw new TypeError("fetch failed");
      }

      if (holdNextCreate) {
        holdNextCreate = false;
        await held;
      }

      const result = json(200, { ...view(vm), firewallRules: [], tlsRules: [] });

      if (backgroundNextCreate) {
        backgroundNextCreate = false;
        const requestId = `bg${++sequence}`;
        background.set(requestId, result);

        return new Response(JSON.stringify({ requestId }), {
          status: 202,
          headers: {
            "content-type": "application/json",
            "x-freestyle-background-request-id": requestId,
          },
        });
      }

      return result;
    }

    if (method === "GET" && path === "/v5/tls") {
      const vm = vms.get(url.searchParams.get("vmId") ?? "");

      const rules =
        vm && vm.account === account
          ? vm.tls.map((rule) => ({
              id: rule.id,
              accountId: account,
              action: "allow",
              domain: rule.domain,
              protocol: "http",
              source: { public: true },
              destination: { vmId: vm.id, port: rule.port },
              dependencies: [{ kind: "vm", id: vm.id }],
              createdAt: vm.createdAt,
              updatedAt: vm.createdAt,
            }))
          : [];

      return json(200, { rules, totalCount: rules.length });
    }

    const match = path.match(/^\/v5\/vms\/([^/]+)(?:\/(.+))?$/);

    if (!match) return error(404, "NOT_FOUND");
    const [, id = "", rest] = match;
    const vm = vms.get(id);

    if (!vm || vm.account !== account) return error(404, "VM_NOT_FOUND");

    if (method === "GET" && rest === undefined) {
      if (vm.state === "starting" && ++vm.polls >= bootPolls) vm.state = "running";

      if (vm.state === "pausing") vm.state = "paused";

      return json(200, view(vm));
    }

    if (method === "DELETE" && rest === undefined) {
      effects.destroy++;
      vms.delete(id);

      return new Response(null, { status: 204 });
    }

    if (method === "PATCH" && rest === undefined) {
      if (body.ttlSeconds !== undefined) vm.ttlSeconds = body.ttlSeconds;

      return json(200, view(vm));
    }

    if (method === "POST" && rest === "pause") {
      if (vm.state !== "running") return error(409, "VM_NOT_RUNNING");
      effects.pause++;
      vm.state = "pausing";

      return json(200, view(vm));
    }

    if (method === "POST" && rest === "start") {
      effects.start++;
      vm.state = bootPolls > 0 ? "starting" : "running";
      vm.polls = 0;

      return json(200, view(vm));
    }

    if (method === "POST" && rest === "exec-await") {
      const fault = commandFault;
      commandFault = undefined;

      if (fault instanceof Response) return fault;

      if (vm.state !== "running") return error(409, "VM_NOT_RUNNING");
      effects.exec++;
      commands.push(body.command);
      const override = commandOverride?.(body.command);
      let result: CommandResult;

      if (override) result = override;
      else {
        const run = Bun.spawnSync(["sh", "-c", body.command], {
          cwd: workdir,
          stdin: body.stdin === undefined ? "ignore" : Buffer.from(body.stdin, "base64"),
        });

        result = {
          statusCode: run.exitCode,
          // Freestyle documents lossy UTF-8 text for both streams.
          stdout: new TextDecoder().decode(run.stdout),
          stderr: new TextDecoder().decode(run.stderr),
        };
      }

      if (fault === "lost") throw new TypeError("fetch failed");

      return json(200, result);
    }

    const file = url.searchParams.get("path") ?? "";

    if (method === "GET" && rest === "fs/read") {
      // Wrapper output lives on the local disk because the wrapper ran through the local sh.
      if (/^\/tmp\/beachside-exec\.[A-Za-z0-9]{8}\/std(?:out|err)$/.test(file))
        try {
          return new Response(new Uint8Array(readFileSync(file)));
        } catch {
          return error(404, "FILE_NOT_FOUND");
        }

      const bytes = vm.files.get(file);

      return bytes ? new Response(new Uint8Array(bytes)) : error(404, "FILE_NOT_FOUND");
    }

    if (method === "PUT" && rest === "fs/write") {
      const sha256 = createHash("sha256").update(raw).digest("hex");

      if (url.searchParams.get("sha256") !== sha256) return error(400, "CHECKSUM_MISMATCH");
      effects.write++;
      vm.files.set(file, new Uint8Array(raw));

      return new Response(null, { status: 204 });
    }

    if (method === "GET" && rest === "fs/dir") {
      const prefix = file.endsWith("/") ? file : `${file}/`;

      const names = new Map<string, string>();

      for (const key of vm.files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const [name = "", ...deeper] = key.slice(prefix.length).split("/");
        names.set(name, deeper.length ? "directory" : "file");
      }

      return json(200, {
        entries: [...names].map(([name, kind]) => ({ name, kind })),
      });
    }

    return error(404, "NOT_FOUND");
  };

  return {
    fetch,
    calls,
    effects,
    commands,
    vms,
    workdir,
    count: (method: string, pattern: RegExp) =>
      calls.filter((call) => call.method === method && pattern.test(call.path)).length,
    setBootPolls(value: number) {
      bootPolls = value;
    },
    backgroundNextCreate() {
      backgroundNextCreate = true;
    },
    failNextCreate(response: Response) {
      createFault = response;
    },
    failNextCommand(response: Response | "lost") {
      commandFault = response;
    },
    overrideCommands(handler: ((command: string) => CommandResult) | undefined) {
      commandOverride = handler;
    },
    loseNextCreateResponse() {
      loseNextCreate = true;
    },
    holdNextCreateResponse() {
      holdNextCreate = true;
      held = new Promise((resolve) => {
        releaseHeld = resolve;
      });
    },
    releaseHeldCreateResponse() {
      releaseHeld?.();
    },
    error,
    close() {
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}
